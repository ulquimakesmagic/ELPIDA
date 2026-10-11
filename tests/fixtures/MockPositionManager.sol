// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../../contracts/evm/src/ElpidaV3FeeLocker.sol";
interface IMockPositionReceiver {function onERC721Received(address,address,uint256,bytes calldata) external returns(bytes4);}
contract MockPositionManager is IV3FeePositionManager {
    address public a;address public b;address public owner;int24 public lo;int24 public hi;
    uint128 public liquidity=1000;uint128 public owed0;uint128 public owed1;
    constructor(address a_,address b_){a=a_;b=b_;}
    function deliver(address target,int24 l,int24 h) external {
        owner=target;lo=l;hi=h;
        require(IMockPositionReceiver(target).onERC721Received(msg.sender,address(0),1,"")==bytes4(0x150b7a02),"receiver");
    }
    function accrue(uint128 x,uint128 y) external {owed0+=x;owed1+=y;}
    function ownerOf(uint256) external view returns(address){return owner;}
    function positions(uint256) external view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128){return(0,address(0),a,b,3000,lo,hi,liquidity,0,0,owed0,owed1);}
    function collect(CollectParams calldata p) external returns(uint256 x,uint256 y){require(msg.sender==owner,"owner");x=owed0;y=owed1;owed0=0;owed1=0;require(IFeeToken(a).transfer(p.recipient,x),"a");require(IFeeToken(b).transfer(p.recipient,y),"b");}
    function decreaseLiquidity() external {require(msg.sender==owner,"owner");liquidity=0;}
}
contract RejectNativeFees {receive() external payable {revert("reject");}}
