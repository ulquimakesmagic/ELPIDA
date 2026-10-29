// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice TESTNET-ONLY stand-in for an Ondo Global Markets stock token (for example NVDAon). It has no value, is not
/// issued by Ondo or anyone else, and must never be deployed to mainnet. Anyone can mint up to FAUCET_LIMIT per call.
///
/// It reproduces the two issuer controls that ELPIDA's mainnet-fork rehearsal exercised on real NVDAon
/// (docs/ONDO_RESTRICTION_REHEARSAL.md): a token-wide pause and a per-account blocklist. Like the real token's
/// transfer hook, every transfer (including mints from the faucet) checks the sender, the recipient and, when
/// distinct, the spender. That lets testnets show how curves, pools and fee claims behave when the issuer restricts
/// the stock. `referenceFeed` points at its test total-return price feed (ElpidaTestStockFeed).
contract ElpidaTestOndoStock {
    string public name;
    string public symbol;
    /// Read by the launchpad UI and indexer: this asset stands in for a tokenized stock.
    string public constant pairKind = "xstock";
    /// Which issuer model it imitates. Real Ondo tokens do not expose this; it marks the test asset as such.
    string public constant stockProvider = "ondo-test";
    uint8 public constant decimals = 18;
    uint256 public immutable FAUCET_LIMIT;
    /// The test issuer: the launchpad treasury that deployed it. It can pause the token and block accounts.
    address public immutable controller;
    /// USD per whole raw token, total return (ElpidaTestStockFeed).
    address public immutable referenceFeed;
    uint256 public totalSupply;
    bool public paused;
    mapping(address => bool) public blocked;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event PauseChanged(bool paused);
    event BlockChanged(address indexed account, bool blocked);

    error NotController();

    constructor(string memory name_, string memory symbol_, uint256 faucetWhole, address referenceFeed_) {
        require(faucetWhole > 0 && referenceFeed_.code.length > 0, "test stock config");
        name = name_; symbol = symbol_; FAUCET_LIMIT = faucetWhole * 1e18; controller = msg.sender; referenceFeed = referenceFeed_;
    }

    modifier onlyController() { if (msg.sender != controller) revert NotController(); _; }

    /// Test issuer pause: every transfer reverts while it is on, as with the real token's pause manager.
    function setPaused(bool paused_) external onlyController { paused = paused_; emit PauseChanged(paused_); }
    /// Test issuer blocklist: transfers to, from or spent by a blocked account revert.
    function setBlocked(address account, bool blocked_) external onlyController { blocked[account] = blocked_; emit BlockChanged(account, blocked_); }

    function faucet(uint256 amount) external {
        require(amount > 0 && amount <= FAUCET_LIMIT, "faucet limit");
        _check(address(0), msg.sender, msg.sender);
        totalSupply += amount; balanceOf[msg.sender] += amount;
        emit Transfer(address(0), msg.sender, amount);
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount); return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount, msg.sender); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "allowance");
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        _move(from, to, amount, msg.sender); return true;
    }
    function _check(address from, address to, address spender) internal view {
        require(!paused, "token paused");
        require(!blocked[from] && !blocked[to] && !blocked[spender], "account blocked");
    }
    function _move(address from, address to, uint256 amount, address spender) internal {
        require(to != address(0), "zero recipient");
        _check(from, to, spender);
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount; balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
