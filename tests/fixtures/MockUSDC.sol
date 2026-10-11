// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Test-only quote asset. Never use this as a production USDC deployment.
contract MockUSDC {
    uint8 public decimals = 6;
    function setDecimals(uint8 value) external { decimals = value; }
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failTransfers;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setFailTransfers(bool value) external { failTransfers = value; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        move(msg.sender, to, amount); return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        move(from, to, amount); return true;
    }
    function move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount; balanceOf[to] += amount;
    }
}
