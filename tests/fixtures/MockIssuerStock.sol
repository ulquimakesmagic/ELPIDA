// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Test-only stand-in for an issuer-controlled tokenized stock: raw balances, a multiplier for display, and the issuer
// powers the real tokens have (block accounts, pause, burn from any account, change the multiplier). Not a real stock.
contract MockIssuerStock {
    string public constant symbol = "mSTK";
    string public constant name = "Simulated issuer-controlled stock (test only)";
    uint8 public constant decimals = 18;
    address public immutable issuer;
    uint256 public uiMultiplier = 1e18;
    bool public paused;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    constructor() { issuer = msg.sender; }
    modifier onlyIssuer() { require(msg.sender == issuer, "issuer only"); _; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function balanceOfUI(address a) external view returns (uint256) { return balanceOf[a] * uiMultiplier / 1e18; }
    function blockAccounts(address[] calldata list) external onlyIssuer { for (uint256 i; i < list.length; i++) blocked[list[i]] = true; }
    function unblockAccounts(address[] calldata list) external onlyIssuer { for (uint256 i; i < list.length; i++) blocked[list[i]] = false; }
    function pause() external onlyIssuer { paused = true; }
    function unpause() external onlyIssuer { paused = false; }
    function adminBurn(address from, uint256 amount) external onlyIssuer { require(balanceOf[from] >= amount, "balance"); balanceOf[from] -= amount; }
    function updateMultiplier(uint256 value) external onlyIssuer { uiMultiplier = value; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount; _move(from, to, amount); return true;
    }
    function _move(address from, address to, uint256 amount) private {
        require(!paused, "paused"); require(!blocked[from] && !blocked[to], "blocked");
        require(balanceOf[from] >= amount, "balance"); balanceOf[from] -= amount; balanceOf[to] += amount;
    }
}
