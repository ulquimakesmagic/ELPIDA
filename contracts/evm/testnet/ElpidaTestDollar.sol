// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice TESTNET-ONLY payout stablecoin for test chains without an official test USD stablecoin (BNB Chain testnet:
/// no Circle USDC; Robinhood Chain testnet: no official test USDG). Elpida's V2 rewards there are converted into it and
/// paid in it. Anyone can mint up to 1,000 per call. It has no value, is not USDC or USDG, and must never be deployed to
/// mainnet. The name says so.
contract ElpidaTestDollar {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public constant FAUCET_LIMIT = 1_000 * 10 ** 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    /// `ticker`: "USDC" or "USDG"; the token is named "Elpida Test <ticker> (no value)" with symbol "t<ticker>".
    constructor(string memory ticker) {
        bytes32 t = keccak256(bytes(ticker));
        require(t == keccak256("USDC") || t == keccak256("USDG"), "ticker");
        require(block.chainid != 1 && block.chainid != 56 && block.chainid != 8453 && block.chainid != 4663, "testnets only");
        name = string.concat("Elpida Test ", ticker, " (no value)");
        symbol = string.concat("t", ticker);
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
        if (approved != type(uint256).max) { require(approved >= amount, "allowance"); allowance[from][msg.sender] = approved - amount; }
        _move(from, to, amount); return true;
    }
    function _move(address from, address to, uint256 amount) private {
        require(to != address(0), "zero address");
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount; balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
