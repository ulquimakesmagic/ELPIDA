// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaV2TaxMigrationAdapter.sol";
interface IV2SwapPair {function token0() external view returns(address);function getReserves() external view returns(uint112,uint112,uint32);function swap(uint256,uint256,address,bytes calldata) external;}
interface IWithdrawWrapped {function deposit() external payable;function withdraw(uint256) external;}

/// @notice Single-hop, exact-input router for the configured V2 fee. Quotes and
/// minimum output use the recipient's actual balance change, including token tax.
contract ElpidaV2TaxRouter {
    address public immutable factory;
    address public immutable weth;
    uint16 public immutable poolFeeBps;
    bool private entered;
    constructor(address factory_,address weth_,uint16 fee_){require(factory_.code.length>0&&weth_.code.length>0&&fee_>0&&fee_<=100,"router config");factory=factory_;weth=weth_;poolFeeBps=fee_;}
    receive() external payable {require(msg.sender==weth,"wrapped only");}
    function quote(uint256 amount,uint256 reserveIn,uint256 reserveOut) public view returns(uint256){uint256 net=amount*(10000-poolFeeBps);return net*reserveOut/(reserveIn*10000+net);}
    function swap(address tokenIn,address tokenOut,uint256 amount,uint256 minOut,bool unwrap,uint256 deadline) external payable returns(uint256 received){
        require(!entered&&block.timestamp<=deadline&&amount>0&&minOut>0&&tokenIn!=tokenOut,"swap params");entered=true;
        address pair=IV2TaxFactory(factory).getPair(tokenIn,tokenOut);require(pair!=address(0),"pair unavailable");
        require(!unwrap||tokenOut==weth,"unwrap asset");
        bool first=IV2SwapPair(pair).token0()==tokenIn;
        (uint112 a,uint112 b,)=IV2SwapPair(pair).getReserves();
        uint256 reserveIn=first?a:b;
        if(msg.value>0){require(tokenIn==weth&&msg.value==amount,"native input");IWithdrawWrapped(weth).deposit{value:amount}();require(IERC20Minimal(weth).transfer(pair,amount),"input");}
        else require(IERC20Minimal(tokenIn).transferFrom(msg.sender,pair,amount),"input");
        uint256 actual=IERC20Minimal(tokenIn).balanceOf(pair)-reserveIn;
        uint256 out=quote(actual,reserveIn,first?b:a);
        address recipient=unwrap?address(this):msg.sender;
        uint256 beforeBalance=IERC20Minimal(tokenOut).balanceOf(recipient);
        IV2SwapPair(pair).swap(first?0:out,first?out:0,recipient,"");
        received=IERC20Minimal(tokenOut).balanceOf(recipient)-beforeBalance;require(received>=minOut,"slippage");
        if(unwrap){IWithdrawWrapped(weth).withdraw(received);(bool ok,)=msg.sender.call{value:received}("");require(ok,"native payout");}
        entered=false;
    }
}
