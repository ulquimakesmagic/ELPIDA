// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
interface INativeLaunchFactory {function deployer() external view returns(address);function isElpidaToken(address) external view returns(bool);function MODEL_VERSION() external view returns(uint256);}
interface INativeCurve {function factory() external view returns(address);function token() external view returns(address);function quote() external view returns(address);function pool() external view returns(address);function MODEL_VERSION() external view returns(uint256);function buy(uint256,uint256) external payable returns(uint256);function sell(uint256,uint256) external returns(uint256);}
interface INativeV3Factory {function getPool(address,address,uint24) external view returns(address);}
interface INativeV3Pool {function fee() external view returns(uint24);function liquidity() external view returns(uint128);}
interface INativeWrapped {function deposit() external payable;function withdraw(uint256) external;}
interface INativeSwapRouter {
 struct ExactInputSingleParams {address tokenIn;address tokenOut;uint24 fee;address recipient;uint256 amountIn;uint256 amountOutMinimum;uint160 sqrtPriceLimitX96;}
 function factory() external view returns(address);function WETH9() external view returns(address);
 function exactInputSingle(ExactInputSingleParams calldata) external payable returns(uint256);
}
/// @notice Atomic native access to standard Model 10 ERC-20 pairs, including after V3 graduation. NOT AUDITED.
/// No owner, arbitrary calls, rescue function, mutable destinations or router fee. Outputs go only to msg.sender.
contract ElpidaNativeTradeRouter is ReentrancyGuard {
 using SafeERC20 for IERC20;
 uint256 public constant VERSION=1;
 address public immutable launchFactory;
 address public immutable curveDeployer;
 address public immutable swapRouter;
 address public immutable v3Factory;
 address public immutable wrappedNative;
 struct Trade {address curve;uint64 curveNonce;uint24 conversionFee;uint256 amount;uint256 pairMinimum;uint256 minimum;uint256 deadline;}
 event NativeTrade(address indexed trader,address indexed token,address indexed curve,bool buy,uint256 nativeAmount,uint256 tokenAmount);
 constructor(address factory_,address router_,address v3Factory_,address wrapped_) {
  require(factory_.code.length>0&&router_.code.length>0&&v3Factory_.code.length>0&&wrapped_.code.length>0,"deployment");
  require(INativeLaunchFactory(factory_).MODEL_VERSION()==10,"model");
  require(INativeSwapRouter(router_).factory()==v3Factory_&&INativeSwapRouter(router_).WETH9()==wrapped_,"DEX identity");
  address deployer=INativeLaunchFactory(factory_).deployer();require(deployer.code.length>0&&INativeCurve(deployer).factory()==factory_,"deployer");
  launchFactory=factory_;curveDeployer=deployer;swapRouter=router_;v3Factory=v3Factory_;wrappedNative=wrapped_;
 }
 receive() external payable {require(msg.sender==wrappedNative,"wrapped only");}
 /// The factory's immutable deployer creates a token then its curve at consecutive CREATE nonces.
 /// Proving both addresses prevents callers substituting a contract that merely spoofs curve getters.
 function createdAddress(uint64 nonce) public view returns(address) {
  bytes memory encoded;
  if(nonce==0)encoded=abi.encodePacked(hex"d694",curveDeployer,hex"80");
  else if(nonce<128)encoded=abi.encodePacked(hex"d694",curveDeployer,bytes1(uint8(nonce)));
  else {uint64 n=nonce;uint8 len;while(n>0){len++;n>>=8;}bytes memory value=new bytes(len);n=nonce;for(uint256 i=len;i>0;i--){value[i-1]=bytes1(uint8(n));n>>=8;}encoded=abi.encodePacked(bytes1(uint8(0xd6+len)),hex"94",curveDeployer,bytes1(uint8(0x80+len)),value);}
  return address(uint160(uint256(keccak256(encoded))));
 }
 function market(address curve,uint64 nonce) public view returns(address token,address asset,address pool) {
  require(nonce>=2&&nonce%2==0&&createdAddress(nonce)==curve,"curve proof");
  INativeCurve c=INativeCurve(curve);token=c.token();require(createdAddress(nonce-1)==token&&INativeLaunchFactory(launchFactory).isElpidaToken(token),"token proof");
  require(c.factory()==launchFactory&&c.MODEL_VERSION()==10,"curve identity");asset=c.quote();require(asset!=address(0)&&asset!=wrappedNative&&asset!=token&&asset.code.length>0,"standard pair");
  pool=c.pool();if(pool!=address(0))require(INativeV3Factory(v3Factory).getPool(token,asset,INativeV3Pool(pool).fee())==pool,"market pool");
 }
 function _deadline(Trade calldata t) private view {require(t.amount>0&&t.pairMinimum>0&&t.minimum>0&&block.timestamp<=t.deadline,"amount/minimum/deadline");}
 function _swap(address from,address to,uint24 fee,uint256 amount,uint256 minimum) private {
  address pool=INativeV3Factory(v3Factory).getPool(from,to,fee);require(pool!=address(0)&&INativeV3Pool(pool).liquidity()>0,"route liquidity");
  uint256 beforeOut=IERC20(to).balanceOf(address(this));IERC20(from).forceApprove(swapRouter,amount);
  INativeSwapRouter(swapRouter).exactInputSingle(INativeSwapRouter.ExactInputSingleParams(from,to,fee,address(this),amount,minimum,0));
  IERC20(from).forceApprove(swapRouter,0);require(IERC20(to).balanceOf(address(this))>=beforeOut+minimum,"route output");
 }
 function _refund(address asset,uint256 beforeBalance) private returns(uint256 amount) {
  uint256 balance=IERC20(asset).balanceOf(address(this));require(balance>=beforeBalance,"prior balance");amount=balance-beforeBalance;if(amount>0)IERC20(asset).safeTransfer(msg.sender,amount);
 }
 function _native(uint256 beforeWrapped) private returns(uint256 amount) {
  uint256 balance=IERC20(wrappedNative).balanceOf(address(this));require(balance>=beforeWrapped,"prior wrapped");amount=balance-beforeWrapped;
  if(amount>0){INativeWrapped(wrappedNative).withdraw(amount);(bool ok,)=msg.sender.call{value:amount}("");require(ok,"native delivery");}
 }
 function buy(Trade calldata t) external payable nonReentrant returns(uint256 output) {
  _deadline(t);require(msg.value==t.amount,"native amount");(address token,address asset,address pool)=market(t.curve,t.curveNonce);
  uint256 beforeToken=IERC20(token).balanceOf(address(this));uint256 beforeAsset=IERC20(asset).balanceOf(address(this));uint256 beforeWrapped=IERC20(wrappedNative).balanceOf(address(this));
  INativeWrapped(wrappedNative).deposit{value:msg.value}();_swap(wrappedNative,asset,t.conversionFee,t.amount,t.pairMinimum);
  uint256 input=IERC20(asset).balanceOf(address(this))-beforeAsset;
  if(pool==address(0)){IERC20(asset).forceApprove(t.curve,input);INativeCurve(t.curve).buy(input,t.minimum);IERC20(asset).forceApprove(t.curve,0);}
  else _swap(asset,token,INativeV3Pool(pool).fee(),input,t.minimum);
  output=IERC20(token).balanceOf(address(this))-beforeToken;require(output>=t.minimum,"token output");_refund(token,beforeToken);_refund(asset,beforeAsset);
  uint256 refunded=_native(beforeWrapped);require(refunded<=t.amount,"native refund");emit NativeTrade(msg.sender,token,t.curve,true,t.amount-refunded,output);
 }
 function sell(Trade calldata t) external nonReentrant returns(uint256 output) {
  _deadline(t);(address token,address asset,address pool)=market(t.curve,t.curveNonce);
  uint256 beforeToken=IERC20(token).balanceOf(address(this));uint256 beforeAsset=IERC20(asset).balanceOf(address(this));uint256 beforeWrapped=IERC20(wrappedNative).balanceOf(address(this));
  IERC20(token).safeTransferFrom(msg.sender,address(this),t.amount);require(IERC20(token).balanceOf(address(this))==beforeToken+t.amount,"unsupported token");
  if(pool==address(0)){IERC20(token).forceApprove(t.curve,t.amount);INativeCurve(t.curve).sell(t.amount,t.pairMinimum);IERC20(token).forceApprove(t.curve,0);}
  else _swap(token,asset,INativeV3Pool(pool).fee(),t.amount,t.pairMinimum);
  uint256 input=IERC20(asset).balanceOf(address(this))-beforeAsset;require(input>=t.pairMinimum,"pair output");_swap(asset,wrappedNative,t.conversionFee,input,t.minimum);
  output=IERC20(wrappedNative).balanceOf(address(this))-beforeWrapped;require(output>=t.minimum,"native output");_refund(asset,beforeAsset);_refund(token,beforeToken);_native(beforeWrapped);
  emit NativeTrade(msg.sender,token,t.curve,false,output,t.amount);
 }
}
