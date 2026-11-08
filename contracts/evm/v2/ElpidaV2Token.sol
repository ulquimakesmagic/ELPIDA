// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice ELPIDA V2 token: fixed 1B supply minted once to the V2 hook, and a real `burn` that reduces `totalSupply`
/// (spec §14.5: a transfer to a dead address is not a burn). No owner, no fees, no mint after construction.
contract ElpidaV2Token {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(string memory name_, string memory symbol_, uint256 supply_, address recipient) {
        require(bytes(name_).length > 0 && bytes(symbol_).length > 0, "metadata");
        require(supply_ > 0 && recipient != address(0), "supply/recipient");
        name = name_; symbol = symbol_; totalSupply = supply_;
        balanceOf[recipient] = supply_;
        emit Transfer(address(0), recipient, supply_);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount); return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount); return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spend(from, amount);
        _transfer(from, to, amount); return true;
    }

    /// Destroys `amount` of the caller's tokens: the total supply goes down by the same amount.
    function burn(uint256 amount) external { _burn(msg.sender, amount); }

    /// Destroys `amount` of `from`'s tokens within the caller's allowance (for a flywheel vault that buys and burns).
    function burnFrom(address from, uint256 amount) external { _spend(from, amount); _burn(from, amount); }

    function _spend(address from, uint256 amount) private {
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) {
            require(approved >= amount, "allowance");
            allowance[from][msg.sender] = approved - amount;
        }
    }

    function _burn(address from, uint256 amount) private {
        uint256 balance = balanceOf[from]; require(balance >= amount, "balance");
        unchecked { balanceOf[from] = balance - amount; totalSupply -= amount; }
        emit Transfer(from, address(0), amount);
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(to != address(0), "zero recipient");
        uint256 balance = balanceOf[from]; require(balance >= amount, "balance");
        unchecked { balanceOf[from] = balance - amount; }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
