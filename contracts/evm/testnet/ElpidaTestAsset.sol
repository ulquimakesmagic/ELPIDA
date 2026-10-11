// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice TESTNET-ONLY pair asset (a simulated xStock or a test paired token). It has no value, is not
/// issued by anyone, and must never be deployed to mainnet. Anyone can mint up to FAUCET_LIMIT per call.
/// `pairKind` tells the launchpad UI which trading-pair kind it stands in for ("xstock" or "token").
contract ElpidaTestAsset {
    string public name;
    string public symbol;
    string public pairKind;
    uint8 public immutable decimals;
    uint256 public immutable FAUCET_LIMIT;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(string memory name_, string memory symbol_, string memory pairKind_, uint8 decimals_, uint256 faucetWhole) {
        require(decimals_ >= 6 && decimals_ <= 18 && faucetWhole > 0, "test asset config");
        require(keccak256(bytes(pairKind_)) == keccak256("xstock") || keccak256(bytes(pairKind_)) == keccak256("token"), "pair kind");
        name = name_; symbol = symbol_; pairKind = pairKind_; decimals = decimals_; FAUCET_LIMIT = faucetWhole * 10 ** decimals_;
    }
    function faucet(uint256 amount) external {
        require(amount > 0 && amount <= FAUCET_LIMIT, "faucet limit");
        totalSupply += amount; balanceOf[msg.sender] += amount;
        emit Transfer(address(0), msg.sender, amount);
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount); return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "allowance");
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        _move(from, to, amount); return true;
    }
    function _move(address from, address to, uint256 amount) internal {
        require(to != address(0), "zero recipient");
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount; balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
