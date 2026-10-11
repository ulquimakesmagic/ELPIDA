// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
/// @notice Local-only simulated wrapped stock; NOT issued by xStocks and has no economic value.
contract MockRewardStock is ERC20 {
    using SafeERC20 for IERC20;
    IERC20 public immutable quote;
    constructor(address quote_) ERC20("Simulated wrapped stock (test only)","TEST-STOCK") { quote=IERC20(quote_); }
    function token() external view returns(address){return address(this);}
    /// Trading-pair kind read by the launchpad UI and indexer (see packages/core/pairs.mjs).
    function pairKind() external pure returns(string memory){return "xstock";}
    function buy(uint256 amount,uint256 minimum) external payable returns(uint256 out) {
        require(msg.value==0,"USDC only");out=amount*1e12/120;require(out>=minimum&&out>0,"slippage");quote.safeTransferFrom(msg.sender,address(this),amount);_mint(msg.sender,out);
    }
}
