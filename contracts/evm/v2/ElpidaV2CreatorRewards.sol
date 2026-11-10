// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface ICreatorRewardsHook {
    function launchOf(address token) external view returns (address quote, address creatorVault, uint64 launchedAt, uint16 feeBps, bool graduated, int24 upperTick, int24 lowerTick, uint128 liquidityBonus, uint128 accrued);
}
interface ICreatorRewardsRouter {
    function buy(address token, uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline) external payable returns (uint256);
}
interface ICreatorRewardsSwap {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}
interface ICreatorRewardsWrapped { function deposit() external payable; function withdraw(uint256) external; }

/// @notice ELPIDA V2 creator rewards (NOT AUDITED; local chains and test networks only). The creator vault of one V2
/// token whose creator chose a holder strategy at launch; the hook pays the creator's 30% straight in.
///
/// The strategy and its settings are fixed here for good:
///  - HOLDERS: the fees are paid to the token's holders in rounds;
///  - REWARD_TOKEN: the fees are swapped into a reward asset (Uniswap v3), which is paid to holders;
///  - BUYBACK: the fees buy the token back (the V2 router, so the token's own fee applies), and the tokens vest to
///    holders linearly over `vesting` seconds from each round.
/// The operator (the server keeper) can only: swap fees not yet promised, once at least `threshold` has gathered, into
/// the strategy's payout asset, with a minimum output; and post a round's Merkle root, covered by funds not yet promised.
/// It cannot send money anywhere else. Anyone may pay any listed wallet with its proof. `minimumHolding` is the
/// snapshot rule the keeper applies (published here so anyone can check a round).
contract ElpidaV2CreatorRewards {
    uint256 public constant CREATOR_REWARDS_VERSION = 1;
    uint8 public constant HOLDERS = 0;
    uint8 public constant REWARD_TOKEN = 1;
    uint8 public constant BUYBACK = 2;

    address public immutable operator;
    address public immutable hook;
    address public immutable router;
    address public immutable swapRouter;
    address public immutable wrappedNative;
    uint24 public immutable poolFee;
    uint8 public immutable mode;
    /// REWARD_TOKEN only: what holders are paid in (address(0) for the native coin).
    address public immutable rewardAsset;
    /// Fees (in the token's pair asset, base units) that must gather before a round.
    uint256 public immutable threshold;
    /// Token base units a wallet must hold at the snapshot to be paid.
    uint256 public immutable minimumHolding;
    /// BUYBACK only: how long each round's tokens take to vest.
    uint64 public immutable vesting;

    /// Set once by `bind`, from the hook's own record: the launched token and its pair asset (address(0): native).
    address public token;
    address public feeAsset;

    struct Round { address asset; bytes32 root; uint128 total; uint128 claimed; uint32 recipients; uint64 postedAt; uint64 vesting; }
    Round[] public rounds;
    mapping(address asset => uint256) public reserved;
    mapping(bytes32 leaf => uint256) public paidOf;
    bool private entered;

    event Bound(address indexed token, address indexed feeAsset);
    event Swapped(address indexed assetIn, address indexed assetOut, uint256 amountIn, uint256 amountOut);
    event RootPosted(uint256 indexed round, address indexed asset, bytes32 root, uint256 total, uint256 recipients, uint256 vesting, string manifestURI);
    event Claimed(uint256 indexed round, address indexed asset, address indexed account, uint256 amount);
    event ClaimFailed(uint256 indexed round, address indexed asset, address indexed account, uint256 amount);

    error OnlyOperator();
    error NotBound();
    error BadTerms();
    error NotFunded();
    error BelowThreshold();
    error BadProof();
    error Reentrancy();

    modifier nonReentrant() { if (entered) revert Reentrancy(); entered = true; _; entered = false; }
    modifier onlyOperator() { if (msg.sender != operator) revert OnlyOperator(); _; }

    constructor(address operator_, address hook_, address router_, address swapRouter_, address wrappedNative_, uint24 poolFee_, uint8 mode_, address rewardAsset_, uint256 threshold_, uint256 minimumHolding_, uint64 vesting_) {
        if (operator_ == address(0) || hook_ == address(0) || mode_ > BUYBACK || threshold_ == 0) revert BadTerms();
        if (mode_ == BUYBACK && (router_ == address(0) || vesting_ == 0 || vesting_ > 3650 days)) revert BadTerms();
        if (mode_ == REWARD_TOKEN && (swapRouter_ == address(0) || wrappedNative_ == address(0) || poolFee_ == 0)) revert BadTerms();
        if (mode_ != BUYBACK && vesting_ != 0) revert BadTerms();
        operator = operator_; hook = hook_; router = router_; swapRouter = swapRouter_; wrappedNative = wrappedNative_; poolFee = poolFee_;
        mode = mode_; rewardAsset = rewardAsset_; threshold = threshold_; minimumHolding = minimumHolding_; vesting = vesting_;
    }

    receive() external payable {}

    /// Anyone may bind this vault to the token whose creator vault it is (read from the hook), once.
    function bind(address token_) external {
        if (token != address(0)) revert BadTerms();
        (address quote, address vault,,,,,,,) = ICreatorRewardsHook(hook).launchOf(token_);
        if (vault != address(this)) revert BadTerms();
        if (mode == REWARD_TOKEN && (rewardAsset == quote || rewardAsset == token_)) revert BadTerms();
        token = token_; feeAsset = quote;
        emit Bound(token_, quote);
    }

    /// What holders are paid in under this strategy.
    function payoutAsset() public view returns (address) {
        if (token == address(0)) revert NotBound();
        return mode == HOLDERS ? feeAsset : mode == REWARD_TOKEN ? rewardAsset : token;
    }

    /// Funds of `asset` not yet promised to a round.
    function available(address asset) public view returns (uint256) { return _balance(asset) - reserved[asset]; }

    function roundCount() external view returns (uint256) { return rounds.length; }

    /// The leaf for one payout. Binds the chain and this vault, so a proof works nowhere else (same form as the V2
    /// distributor's, so the same list builder serves both).
    function leaf(uint256 round, address asset, address account, uint256 amount) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), round, asset, account, amount))));
    }

    /// REWARD_TOKEN and BUYBACK: swaps `amountIn` of unpromised fees (at least the threshold) into the payout asset,
    /// receiving at least `minOut`. The proceeds stay here for the next round.
    function swap(uint256 amountIn, uint256 minOut) external onlyOperator nonReentrant returns (uint256 out) {
        if (token == address(0)) revert NotBound();
        if (mode == HOLDERS || minOut == 0) revert BadTerms();
        if (amountIn < threshold) revert BelowThreshold();
        if (amountIn > available(feeAsset)) revert NotFunded();
        address outAsset = payoutAsset();
        uint256 before = _balance(outAsset);
        if (mode == BUYBACK) {
            if (feeAsset == address(0)) ICreatorRewardsRouter(router).buy{value: amountIn}(token, amountIn, minOut, address(this), block.timestamp);
            else { _approve(feeAsset, router, amountIn); ICreatorRewardsRouter(router).buy(token, amountIn, minOut, address(this), block.timestamp); _approve(feeAsset, router, 0); }
        } else {
            address tokenIn = feeAsset == address(0) ? wrappedNative : feeAsset;
            address tokenOut = outAsset == address(0) ? wrappedNative : outAsset;
            if (feeAsset == address(0)) ICreatorRewardsWrapped(wrappedNative).deposit{value: amountIn}();
            _approve(tokenIn, swapRouter, amountIn);
            uint256 got = ICreatorRewardsSwap(swapRouter).exactInputSingle(ICreatorRewardsSwap.ExactInputSingleParams(tokenIn, tokenOut, poolFee, address(this), amountIn, minOut, 0));
            _approve(tokenIn, swapRouter, 0);
            if (outAsset == address(0)) ICreatorRewardsWrapped(wrappedNative).withdraw(got);
        }
        out = _balance(outAsset) - before;
        if (out < minOut) revert BadTerms();
        emit Swapped(feeAsset, outAsset, amountIn, out);
    }

    /// Posts the next round in the payout asset: its Merkle root and total, covered by unpromised funds. A HOLDERS round
    /// pays at least the threshold. BUYBACK rounds vest over `vesting` from now.
    function postRound(bytes32 root, uint256 total, uint32 recipients, string calldata manifestURI) external onlyOperator returns (uint256 round) {
        address asset = payoutAsset();
        if (root == bytes32(0) || total == 0 || recipients == 0 || total > type(uint128).max) revert BadTerms();
        if (mode == HOLDERS && total < threshold) revert BelowThreshold();
        if (total > available(asset)) revert NotFunded();
        round = rounds.length;
        uint64 v = mode == BUYBACK ? vesting : 0;
        rounds.push(Round(asset, root, uint128(total), 0, recipients, uint64(block.timestamp), v));
        reserved[asset] += total;
        emit RootPosted(round, asset, root, total, recipients, v, manifestURI);
    }

    /// What `amount` of `round` has vested by now.
    function vested(uint256 round, uint256 amount) public view returns (uint256) {
        Round storage r = rounds[round];
        if (r.vesting == 0 || block.timestamp >= r.postedAt + r.vesting) return amount;
        return amount * (block.timestamp - r.postedAt) / r.vesting;
    }

    /// Pays `account` what has vested of its amount in `round` and was not paid yet. Anyone may call. A failed transfer
    /// stays claimable.
    function claim(uint256 round, address account, uint256 amount, bytes32[] calldata proof) external nonReentrant returns (uint256) {
        return _claim(round, account, amount, proof);
    }

    struct Payout { address account; uint256 amount; bytes32[] proof; }

    function claimMany(uint256 round, Payout[] calldata payouts) external nonReentrant returns (uint256 total) {
        for (uint256 i = 0; i < payouts.length; i++) total += _claim(round, payouts[i].account, payouts[i].amount, payouts[i].proof);
    }

    function _claim(uint256 round, address account, uint256 amount, bytes32[] calldata proof) private returns (uint256 due) {
        if (round >= rounds.length) revert BadTerms();
        Round storage r = rounds[round];
        bytes32 l = leaf(round, r.asset, account, amount);
        if (!MerkleProof.verifyCalldata(proof, r.root, l)) revert BadProof();
        due = vested(round, amount) - paidOf[l];
        if (due == 0) return 0;
        paidOf[l] += due; r.claimed += uint128(due); reserved[r.asset] -= due;
        if (_send(r.asset, account, due)) { emit Claimed(round, r.asset, account, due); return due; }
        paidOf[l] -= due; r.claimed -= uint128(due); reserved[r.asset] += due;
        emit ClaimFailed(round, r.asset, account, due);
        return 0;
    }

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

    function _approve(address asset, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || (ret.length != 0 && !(ret.length >= 32 && abi.decode(ret, (bool))))) revert BadTerms();
    }
}
