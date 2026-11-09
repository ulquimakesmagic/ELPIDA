// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface IConvertRouter {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

interface IWrappedNative { function withdraw(uint256) external; }

/// @notice ELPIDA V2.0 reward distributor (NOT AUDITED; local chains and test networks only). One per chain and purpose:
/// the trader airdrop (calendar-month rounds) and holder rewards (fixed rounds, e.g. weekly). The V2 hook pays the
/// fee share straight in; nothing else funds it, and its money can only go to the wallets in a published round.
///
/// A round's schedule is fixed here, so anyone can see when it ends. After it ends the operator (the keeper) posts the
/// round's Merkle root for each payout asset, with the round's total, which must be covered by funds not yet promised
/// to an earlier round. Then anyone may pay any listed wallet with its proof (the keeper pushes them; a wallet can
/// also claim itself). A payment that fails (a paused stock, a wallet that refuses) stays claimable. What a round
/// leaves unclaimed for CLAIM_WINDOW_ROUNDS rounds goes back to the pool for later rounds, never to anyone else.
/// The operator cannot move funds: it can only post a root once per round and asset, and (holder rewards only) convert
/// unpromised USDC into the native coin through the chain's Uniswap v3 router, the proceeds staying here (Malik,
/// 9 November: holders of USDC-paired tokens are paid in the native coin).
contract ElpidaV2Distributor {
    uint256 public constant VERSION = 1;
    uint256 public constant CLAIM_WINDOW_ROUNDS = 12;
    address public immutable operator;
    /// 0: calendar months (UTC). Otherwise the round length in seconds.
    uint256 public immutable period;
    /// Start of round 0 (for calendar months, the first of a month at 00:00 UTC).
    uint256 public immutable genesis;
    uint256 private immutable genesisMonth;
    /// What this distributor pays, for people reading it on an explorer: "trader-airdrop" or "holder-rewards".
    string public purpose;
    /// Holder rewards only: the one asset that may be converted (USDC), the Uniswap v3 router and the wrapped native
    /// coin. Zero when conversion is off.
    address public immutable convertible;
    address public immutable swapRouter;
    address public immutable wrappedNative;

    struct Round {
        bytes32 root;
        uint128 total;
        uint128 claimed;
        uint32 recipients;
        uint64 postedAt;
        bool expired;
    }

    mapping(uint256 round => mapping(address asset => Round)) public rounds;
    /// Posted but not yet paid or expired, per asset.
    mapping(address asset => uint256) public reserved;
    mapping(bytes32 leaf => bool) public paid;
    bool private entered;

    event RootPosted(uint256 indexed round, address indexed asset, bytes32 root, uint256 total, uint256 recipients, string manifestURI);
    event Claimed(uint256 indexed round, address indexed asset, address indexed account, uint256 amount);
    event ClaimFailed(uint256 indexed round, address indexed asset, address indexed account, uint256 amount);
    event Expired(uint256 indexed round, address indexed asset, uint256 returnedToPool);
    event Received(address indexed from, uint256 amount);
    event Converted(address indexed asset, uint256 amountIn, uint256 nativeOut);

    error OnlyOperator();
    error RoundNotOver();
    error AlreadyPosted();
    error NotFunded();
    error BadProof();
    error AlreadyPaid();
    error RoundClosed();
    error NotStarted();
    error BadTerms();
    error Reentrancy();

    modifier nonReentrant() { if (entered) revert Reentrancy(); entered = true; _; entered = false; }

    constructor(address operator_, uint256 period_, uint256 genesis_, string memory purpose_, address convertible_, address swapRouter_, address wrappedNative_) {
        if (operator_ == address(0) || genesis_ % 1 days != 0 || bytes(purpose_).length == 0) revert BadTerms();
        if ((convertible_ == address(0)) != (swapRouter_ == address(0)) || (swapRouter_ == address(0)) != (wrappedNative_ == address(0))) revert BadTerms();
        convertible = convertible_; swapRouter = swapRouter_; wrappedNative = wrappedNative_;
        if (period_ == 0) {
            (uint256 y, uint256 m, uint256 d) = _civil(genesis_ / 1 days);
            if (d != 1) revert BadTerms();
            genesisMonth = y * 12 + m - 1;
        } else if (period_ < 1 days) revert BadTerms();
        operator = operator_; period = period_; genesis = genesis_; purpose = purpose_;
    }

    receive() external payable { emit Received(msg.sender, msg.value); }

    // ---- schedule ----

    function roundStart(uint256 round) public view returns (uint256) {
        if (period != 0) return genesis + round * period;
        uint256 index = genesisMonth + round;
        return _days(index / 12, index % 12 + 1, 1) * 1 days;
    }

    function roundEnd(uint256 round) public view returns (uint256) { return roundStart(round + 1); }

    function currentRound() public view returns (uint256) {
        if (block.timestamp < genesis) revert NotStarted();
        if (period != 0) return (block.timestamp - genesis) / period;
        (uint256 y, uint256 m,) = _civil(block.timestamp / 1 days);
        return y * 12 + m - 1 - genesisMonth;
    }

    /// Funds of `asset` not promised to any posted round: what the next root may distribute.
    function available(address asset) public view returns (uint256) {
        return _balance(asset) - reserved[asset];
    }

    /// The leaf for one payout. Binds the chain and this distributor, so a proof works nowhere else.
    function leaf(uint256 round, address asset, address account, uint256 amount) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), round, asset, account, amount))));
    }

    // ---- rounds ----

    function postRoot(uint256 round, address asset, bytes32 root, uint256 total, uint32 recipients, string calldata manifestURI) external {
        if (msg.sender != operator) revert OnlyOperator();
        if (block.timestamp < roundEnd(round)) revert RoundNotOver();
        Round storage r = rounds[round][asset];
        if (r.root != bytes32(0)) revert AlreadyPosted();
        if (root == bytes32(0) || total == 0 || recipients == 0 || total > type(uint128).max) revert BadTerms();
        if (total > available(asset)) revert NotFunded();
        r.root = root; r.total = uint128(total); r.recipients = recipients; r.postedAt = uint64(block.timestamp);
        reserved[asset] += total;
        emit RootPosted(round, asset, root, total, recipients, manifestURI);
    }

    /// Pays `account` its amount for `round` in `asset`. Anyone may call. Returns false (and keeps it claimable) if the
    /// transfer fails.
    function claim(uint256 round, address asset, address account, uint256 amount, bytes32[] calldata proof) external nonReentrant returns (bool) {
        return _claim(round, asset, account, amount, proof);
    }

    struct Payout { address account; uint256 amount; bytes32[] proof; }

    /// Pays many wallets of one round and asset; a failed transfer is skipped and stays claimable.
    function claimMany(uint256 round, address asset, Payout[] calldata payouts) external nonReentrant returns (uint256 ok) {
        for (uint256 i = 0; i < payouts.length; i++) if (_claim(round, asset, payouts[i].account, payouts[i].amount, payouts[i].proof)) ok++;
    }

    /// Converts `amountIn` of unpromised USDC into the native coin (Uniswap v3, pool fee `poolFee`), at least `minOut`.
    /// Operator only; the proceeds stay in this distributor for later rounds.
    function convertToNative(uint256 amountIn, uint256 minOut, uint24 poolFee) external nonReentrant returns (uint256 out) {
        if (msg.sender != operator) revert OnlyOperator();
        if (swapRouter == address(0) || minOut == 0) revert BadTerms();
        if (amountIn == 0 || amountIn > available(convertible)) revert NotFunded();
        if (!_approve(convertible, swapRouter, amountIn)) revert BadTerms();
        uint256 before = address(this).balance;
        out = IConvertRouter(swapRouter).exactInputSingle(IConvertRouter.ExactInputSingleParams(convertible, wrappedNative, poolFee, address(this), amountIn, minOut, 0));
        _approve(convertible, swapRouter, 0);
        IWrappedNative(wrappedNative).withdraw(out);
        if (address(this).balance - before != out) revert BadTerms();
        emit Converted(convertible, amountIn, out);
    }

    /// After CLAIM_WINDOW_ROUNDS more rounds, what a round left unclaimed returns to the pool for later rounds.
    function expire(uint256 round, address asset) external {
        Round storage r = rounds[round][asset];
        if (r.root == bytes32(0) || r.expired) revert BadTerms();
        if (currentRound() <= round + CLAIM_WINDOW_ROUNDS) revert RoundNotOver();
        r.expired = true;
        uint256 left = r.total - r.claimed;
        reserved[asset] -= left;
        emit Expired(round, asset, left);
    }

    function _claim(uint256 round, address asset, address account, uint256 amount, bytes32[] calldata proof) private returns (bool) {
        Round storage r = rounds[round][asset];
        if (r.root == bytes32(0) || r.expired) revert RoundClosed();
        bytes32 l = leaf(round, asset, account, amount);
        if (paid[l]) revert AlreadyPaid();
        if (!MerkleProof.verifyCalldata(proof, r.root, l)) revert BadProof();
        paid[l] = true; r.claimed += uint128(amount); reserved[asset] -= amount;
        if (_send(asset, account, amount)) { emit Claimed(round, asset, account, amount); return true; }
        paid[l] = false; r.claimed -= uint128(amount); reserved[asset] += amount;
        emit ClaimFailed(round, asset, account, amount);
        return false;
    }

    // ---- helpers ----

    function _balance(address asset) private view returns (uint256) {
        if (asset == address(0)) return address(this).balance;
        (bool ok, bytes memory ret) = asset.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        return ok && ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
    }

    function _send(address asset, address to, uint256 amount) private returns (bool ok) {
        if (asset == address(0)) { (ok,) = to.call{value: amount}(""); return ok; }
        if (asset.code.length == 0) return false;
        bytes memory ret;
        (ok, ret) = asset.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        return ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
    }

    function _approve(address asset, address spender, uint256 amount) private returns (bool ok) {
        bytes memory ret;
        (ok, ret) = asset.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        return ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
    }

    /// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm; years from 1970).
    function _days(uint256 y, uint256 m, uint256 d) private pure returns (uint256) {
        if (m <= 2) y -= 1;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
        return era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    }

    function _civil(uint256 z) private pure returns (uint256 y, uint256 m, uint256 d) {
        z += 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        d = doy - (153 * mp + 2) / 5 + 1;
        m = mp < 10 ? mp + 3 : mp - 9;
        y = yoe + era * 400 + (m <= 2 ? 1 : 0);
    }
}
