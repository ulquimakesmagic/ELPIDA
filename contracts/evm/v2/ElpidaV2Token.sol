// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice ELPIDA V2.0 launch token (PROTOTYPE, NOT AUDITED). Fixed supply minted once to the launch hook, plus a
/// holder-initiated `burn` that really reduces `totalSupply` (V2.0 spec §14.5: a transfer to a dead address is not a
/// burn). Nobody can mint, pause, tax or move another holder's tokens; there is no owner.
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
        require(bytes(name_).length > 0 && bytes(name_).length <= 64, "name");
        require(_validTicker(bytes(symbol_)), "ticker");
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
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) {
            require(approved >= amount, "allowance");
            allowance[from][msg.sender] = approved - amount;
        }
        _transfer(from, to, amount); return true;
    }

    /// Destroys `amount` of the caller's own tokens and reduces the total supply by the same amount.
    function burn(uint256 amount) external {
        uint256 balance = balanceOf[msg.sender]; require(balance >= amount, "balance");
        unchecked { balanceOf[msg.sender] = balance - amount; totalSupply -= amount; }
        emit Transfer(msg.sender, address(0), amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "zero recipient");
        uint256 balance = balanceOf[from]; require(balance >= amount, "balance");
        unchecked { balanceOf[from] = balance - amount; }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    /// V2.0 spec §6.2: 1-10 ASCII letters or digits. Tickers are not unique.
    function _validTicker(bytes memory s) private pure returns (bool) {
        if (s.length == 0 || s.length > 10) return false;
        for (uint256 i = 0; i < s.length; i++) {
            bytes1 c = s[i];
            if (!((c >= "0" && c <= "9") || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z"))) return false;
        }
        return true;
    }
}
