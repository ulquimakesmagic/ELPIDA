// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaFeeSplitter.sol";

interface IV3FeePositionManager {
    struct CollectParams {uint256 tokenId;address recipient;uint128 amount0Max;uint128 amount1Max;}
    function ownerOf(uint256 tokenId) external view returns(address);
    function positions(uint256 tokenId) external view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128);
    function collect(CollectParams calldata params) external returns(uint256,uint256);
}

/// @notice Prototype permanent custody of one full-range v3 position, with fee-only collection.
/// @dev Trusted migration adapter must transfer a freshly minted position, with no principal already owed.
/// Manager and adapter must be verified per chain. NOT AUDITED; connected to model 5 test graduation.
contract ElpidaV3FeeLocker {
    IV3FeePositionManager public immutable manager;
    address public immutable adapter;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable lower;
    int24 public immutable upper;
    ElpidaFeeSplitter public immutable splitter;
    uint256 public tokenId;
    bool public locked;
    bool private entered;
    event PositionLocked(uint256 indexed tokenId,uint128 liquidity);
    event PositionFeesCollected(uint256 indexed tokenId,uint256 amount0,uint256 amount1);
    constructor(address manager_,address adapter_,address token0_,address token1_,uint24 fee_,int24 spacing_,address treasury_,address creator_) {
        require(manager_.code.length>0 && adapter_!=address(0),"manager/adapter");
        require(token0_!=address(0) && token0_<token1_,"pair order");
        require(spacing_>0 && spacing_<=16384 && fee_>0,"fee/spacing");
        manager=IV3FeePositionManager(manager_);adapter=adapter_;token0=token0_;token1=token1_;fee=fee_;
        lower=(-887272 / spacing_)*spacing_;upper=(887272 / spacing_)*spacing_;
        splitter=new ElpidaFeeSplitter(treasury_,creator_);
    }
    function onERC721Received(address operator,address from,uint256 id,bytes calldata) external returns(bytes4) {
        require(msg.sender==address(manager) && operator==adapter && (from==adapter || from==address(0)) && !locked && !entered,"position source");
        require(manager.ownerOf(id)==address(this),"position owner");
        (,address approved,address a,address b,uint24 f,int24 lo,int24 hi,uint128 liquidity,,,uint128 owed0,uint128 owed1)=manager.positions(id);
        require(approved==address(0) && a==token0 && b==token1 && f==fee && lo==lower && hi==upper && liquidity>0,"position config");
        require(owed0==0 && owed1==0,"fresh position required");
        locked=true;tokenId=id;emit PositionLocked(id,liquidity);return this.onERC721Received.selector;
    }
    function collectFees() external returns(uint256 amount0,uint256 amount1) {
        require(locked && !entered,"locked/reentrancy");entered=true;
        require(manager.ownerOf(tokenId)==address(this),"position owner");
        (amount0,amount1)=manager.collect(IV3FeePositionManager.CollectParams(tokenId,address(this),type(uint128).max,type(uint128).max));
        _fund(token0,amount0);_fund(token1,amount1);
        emit PositionFeesCollected(tokenId,amount0,amount1);entered=false;
    }
    function _fund(address asset,uint256 amount) private {
        if(amount==0)return;
        require(IFeeToken(asset).approve(address(splitter),0),"clear approval");
        require(IFeeToken(asset).approve(address(splitter),amount),"fee approval");
        splitter.depositToken(asset,amount);
        require(IFeeToken(asset).approve(address(splitter),0),"clear approval");
    }
    // Deliberately no NFT transfer, approval, decreaseLiquidity, burn, rescue or upgrade entry point.
}
