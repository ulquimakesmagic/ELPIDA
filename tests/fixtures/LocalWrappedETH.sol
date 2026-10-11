// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
/// Test-only wrapping fixture; never deployed on a public network.
contract LocalWrappedETH is ERC20 {
 constructor() ERC20("Local wrapped ETH","WETH") {}
 receive() external payable { deposit(); }
 function deposit() public payable { _mint(msg.sender,msg.value); }
 function withdraw(uint256 value) external { _burn(msg.sender,value); (bool ok,)=msg.sender.call{value:value}("");require(ok,"withdraw"); }
}
