// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice ELPIDA V2 creator allocations to wallets, X accounts and websites (NOT AUDITED; local chains and test networks
/// only). The creator vault of one V2 token: the hook pays the creator's 30% in, and it is split by fixed shares
/// between up to 8 rows. A wallet row is paid to its wallet. An X or website row is held until its owner proves control
/// (a DNS TXT record for a website, X sign-in for an account) and the verifier (the Elpida server) binds the payout
/// wallet the owner signed for, once; nobody else, including the creator and the verifier, can take it. Anyone may pay
/// any row that has a wallet.
contract ElpidaV2IdentityAllocation {
    uint256 public constant IDENTITY_ALLOCATION_VERSION = 1;
    address public immutable verifier;

    struct Row { string label; address wallet; uint16 share; }
    Row[] private rowList;
    mapping(address asset => uint256) public accounted;
    mapping(address asset => mapping(uint256 row => uint256)) public claimable;
    bool private entered;

    event Allocated(address indexed asset, uint256 amount);
    event Bound(uint256 indexed row, string label, address indexed wallet);
    event Claimed(address indexed asset, uint256 indexed row, address indexed wallet, uint256 amount);

    error BadTerms();
    error OnlyVerifier();
    error Reentrancy();

    modifier guarded() { if (entered) revert Reentrancy(); entered = true; _; entered = false; }

    /// `labels[i]` is "wallet" for a wallet row (with `wallets[i]` set), or "x:<handle>" / "domain:<name>" for an identity
    /// row (with `wallets[i]` zero). Shares are basis points adding up to 10,000.
    constructor(address verifier_, string[] memory labels, address[] memory wallets, uint16[] memory shares) {
        uint256 n = labels.length;
        uint256 total;
        if (verifier_ == address(0) || n == 0 || n > 8 || wallets.length != n || shares.length != n) revert BadTerms();
        bool identity;
        for (uint256 i = 0; i < n; i++) {
            bytes memory l = bytes(labels[i]);
            bool isWallet = keccak256(l) == keccak256("wallet");
            if (shares[i] == 0 || l.length == 0 || l.length > 80 || isWallet != (wallets[i] != address(0))) revert BadTerms();
            for (uint256 j = 0; j < i; j++) if (keccak256(bytes(labels[j])) == keccak256(l) && !isWallet) revert BadTerms();
            identity = identity || !isWallet;
            total += shares[i];
            rowList.push(Row(labels[i], wallets[i], shares[i]));
        }
        if (total != 10_000 || !identity) revert BadTerms();
        verifier = verifier_;
    }

    receive() external payable {}

    function rowCount() external view returns (uint256) { return rowList.length; }
    function row(uint256 i) external view returns (string memory label, address wallet, uint16 share) { Row storage r = rowList[i]; return (r.label, r.wallet, r.share); }

    /// The verifier binds the payout wallet of an X or website row, once, after its owner proved control and signed for it.
    function bind(uint256 i, address wallet) external {
        if (msg.sender != verifier) revert OnlyVerifier();
        Row storage r = rowList[i];
        if (wallet == address(0) || r.wallet != address(0)) revert BadTerms();
        r.wallet = wallet;
        emit Bound(i, r.label, wallet);
    }

    /// Splits whatever of `asset` arrived since the last sync between the rows by their shares.
    function sync(address asset) public guarded { _sync(asset); }

    /// Pays row `i` its share of `asset`, to its wallet. Anyone may call; a row without a wallet keeps its share.
    function claim(address asset, uint256 i) external guarded returns (bool ok) {
        _sync(asset);
        Row storage r = rowList[i];
        uint256 amount = claimable[asset][i];
        if (amount == 0 || r.wallet == address(0)) return false;
        claimable[asset][i] = 0; accounted[asset] -= amount;
        ok = _send(asset, r.wallet, amount);
        if (!ok) { claimable[asset][i] = amount; accounted[asset] += amount; return false; }
        emit Claimed(asset, i, r.wallet, amount);
    }

    function _sync(address asset) private {
        uint256 held = _balance(asset);
        if (held <= accounted[asset]) return;
        uint256 amount = held - accounted[asset];
        uint256 assigned;
        accounted[asset] = held;
        uint256 n = rowList.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 part = i + 1 == n ? amount - assigned : amount * rowList[i].share / 10_000;
            assigned += part; claimable[asset][i] += part;
        }
        emit Allocated(asset, amount);
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
}
