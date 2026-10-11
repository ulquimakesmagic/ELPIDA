// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
/// @notice Local-only simulated wrapped stock; NOT issued by xStocks and has no economic value.
/// Bought with the native coin at a fixed 0.04 per stock, like a curve whose quote is native.
contract MockRewardStock is ERC20 {
    uint256 public constant PRICE = 0.04 ether;
    constructor() ERC20("Simulated wrapped stock (test only)","TEST-STOCK") {}
    function token() external view returns(address){return address(this);}
    /// Native quote (address zero), so reward vaults can convert native fees into it.
    function quote() external pure returns(address){return address(0);}
    /// Trading-pair kind read by the launchpad UI and indexer (see packages/core/pairs.mjs).
    function pairKind() external pure returns(string memory){return "xstock";}
    function buy(uint256 amount,uint256 minimum) external payable returns(uint256 out) {
        require(msg.value==amount,"native value");out=amount*1e18/PRICE;require(out>=minimum&&out>0,"slippage");_mint(msg.sender,out);
    }
}
