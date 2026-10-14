// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./ElpidaV3FeeLocker.sol";
interface IV3MigrationFactory {
    function getPool(address,address,uint24) external view returns(address);
    function feeAmountTickSpacing(uint24) external view returns(int24);
}
interface IV3MigrationManager {
    struct MintParams {address token0;address token1;uint24 fee;int24 tickLower;int24 tickUpper;uint256 amount0Desired;uint256 amount1Desired;uint256 amount0Min;uint256 amount1Min;address recipient;uint256 deadline;}
    function factory() external view returns(address);
    function WETH9() external view returns(address);
    function createAndInitializePoolIfNecessary(address,address,uint24,uint160) external payable returns(address);
    function mint(MintParams calldata) external payable returns(uint256,uint128,uint256,uint256);
    function safeTransferFrom(address,address,uint256) external;
}
interface IV3MigrationPool {
    function slot0() external view returns(uint160,int24,uint16,uint16,uint16,uint8,bool);
    function liquidity() external view returns(uint128);
    function swap(address,bool,int256,uint160,bytes calldata) external returns(int256,int256);
}
interface IWrappedMigrationAsset {function deposit() external payable;}
/// @notice Graduates a completed curve into a permanently locked full-range Uniswap v3 position. NOT AUDITED.
/// @dev If the pool already exists at a different price (for example, created by a griefer), the adapter
/// swaps it back to the curve's terminal price, spending at most MAX_REBALANCE_BPS of each migrating asset.
/// Whatever the swap spends stays in the pool. If the price still differs, migration reverts and the curve's
/// escape hatch applies.
contract ElpidaV3MigrationAdapter {
    struct Request {address token;address quote;uint256 tokenAmount;uint256 quoteAmount;address treasury;address creator;}
    struct Result {address pool;address locker;address splitter;uint256 positionId;uint256 tokenUsed;uint256 quoteUsed;}
    IV3MigrationManager public immutable manager;
    address public immutable dexFactory;
    address public immutable weth;
    address public immutable usdc;
    uint24 public immutable fee;
    /// Maximum share of each migrating asset the adapter may spend to correct a mispriced pool.
    uint256 public constant MAX_REBALANCE_BPS = 200;
    mapping(address=>Result) public migrations;
    bool private entered;
    address private repricePool;
    address private repriceAsset;
    uint256 private repriceBudget;
    event Migrated(address indexed curve,address indexed token,address indexed pool,address locker,address splitter,uint256 positionId,uint256 tokenUsed,uint256 quoteUsed);
    /// Pool-side deltas of the corrective swap: positive amounts were paid into the pool.
    event PoolRebalanced(address indexed pool,int256 amount0,int256 amount1);
    constructor(address manager_,address usdc_,uint24 fee_) {
        require(manager_.code.length>0 && usdc_.code.length>0,"deployment code");
        manager=IV3MigrationManager(manager_);dexFactory=manager.factory();weth=manager.WETH9();usdc=usdc_;fee=fee_;
        require(dexFactory.code.length>0 && weth.code.length>0 && IV3MigrationFactory(dexFactory).feeAmountTickSpacing(fee_)>0,"DEX config");
    }
    function migrate(Request calldata r) external payable returns(Result memory result) {
        require(!entered && migrations[msg.sender].pool==address(0),"reentrancy/repeat");entered=true;
        require(r.token.code.length>0 && r.tokenAmount>0 && r.quoteAmount>0 && r.treasury!=address(0) && r.creator!=address(0),"request");
        require(r.quote==address(0) || r.quote==usdc,"quote asset");
        address quoteAsset=r.quote==address(0)?weth:r.quote;
        require(r.token!=quoteAsset,"same asset");
        _pull(r.token,r.tokenAmount);
        if(r.quote==address(0)){require(msg.value==r.quoteAmount,"native value");IWrappedMigrationAsset(weth).deposit{value:msg.value}();}
        else {require(msg.value==0,"native value");_pull(quoteAsset,r.quoteAmount);}
        bool tokenFirst=r.token<quoteAsset;
        address a=tokenFirst?r.token:quoteAsset;address b=tokenFirst?quoteAsset:r.token;
        uint256 x=tokenFirst?r.tokenAmount:r.quoteAmount;uint256 y=tokenFirst?r.quoteAmount:r.tokenAmount;
        {
        uint160 expected=initialSqrtPrice(x,y);
        result.pool=manager.createAndInitializePoolIfNecessary(a,b,fee,expected);
        (uint256 mx,uint256 my)=_rebalance(result.pool,a,b,x,y,expected);
        result=_mint(r,result,a,b,mx,my);
        }
        result=_settle(result,a,b,x,y,tokenFirst);
        migrations[msg.sender]=result;
        emit Migrated(msg.sender,r.token,result.pool,result.locker,result.splitter,result.positionId,result.tokenUsed,result.quoteUsed);entered=false;
    }
    /// Refunds unused assets. Whatever is not refunded went into the pool (rebalancing swap or position).
    function _settle(Result memory result,address a,address b,uint256 x,uint256 y,bool tokenFirst) private returns(Result memory) {
        uint256 used0=x-_refund(a,x);uint256 used1=y-_refund(b,y);
        result.tokenUsed=tokenFirst?used0:used1;
        result.quoteUsed=tokenFirst?used1:used0;
        return result;
    }
    /// Returns the caller's unused `asset` (never more than it supplied) and reports the refunded amount.
    function _refund(address asset,uint256 supplied) private returns(uint256 amount) {
        amount=IFeeToken(asset).balanceOf(address(this));
        if(amount>supplied)amount=supplied;
        if(amount>0)require(IFeeToken(asset).transfer(msg.sender,amount),"refund");
    }
    /// Moves an existing pool to `expected`, spending at most MAX_REBALANCE_BPS of the input asset.
    /// Returns the asset amounts left for minting.
    function _rebalance(address pool,address a,address b,uint256 x,uint256 y,uint160 expected) private returns(uint256,uint256) {
        (uint160 actual,,,,,,)=IV3MigrationPool(pool).slot0();
        if(actual!=expected){
            // Price too high (token1 per token0): sell token0. Too low: sell token1.
            bool zeroForOne=actual>expected;
            uint256 budget=(zeroForOne?x:y)*MAX_REBALANCE_BPS/10000;
            if(budget==0)budget=1;
            repricePool=pool;repriceAsset=zeroForOne?a:b;repriceBudget=budget;
            // Pool deltas: positive amounts were paid in by the adapter, negative amounts were paid out to it.
            (int256 d0,int256 d1)=IV3MigrationPool(pool).swap(address(this),zeroForOne,int256(budget),expected,"");
            repricePool=address(0);repriceAsset=address(0);repriceBudget=0;
            x=d0>=0?x-uint256(d0):x+uint256(-d0);
            y=d1>=0?y-uint256(d1):y+uint256(-d1);
            if(d0!=0||d1!=0)emit PoolRebalanced(pool,d0,d1);
            (actual,,,,,,)=IV3MigrationPool(pool).slot0();
        }
        require((actual>expected?actual-expected:expected-actual)<=uint256(expected)/1_000_000,"pool price mismatch");
        return (x,y);
    }
    function _mint(Request calldata r,Result memory result,address a,address b,uint256 x,uint256 y) private returns(Result memory) {
        ElpidaV3FeeLocker locker=new ElpidaV3FeeLocker(address(manager),address(this),a,b,fee,IV3MigrationFactory(dexFactory).feeAmountTickSpacing(fee),r.treasury,r.creator);
        result.locker=address(locker);result.splitter=address(locker.splitter());
        _approve(a,x);_approve(b,y);
        uint256 used0;uint256 used1;
        // The price was verified in this transaction, so the position cannot be sandwiched. At least one side
        // must be almost fully deposited; a rebalanced pool leaves part of the other side as refundable dust.
        (result.positionId,,used0,used1)=manager.mint(IV3MigrationManager.MintParams(a,b,fee,locker.lower(),locker.upper(),x,y,0,0,address(this),block.timestamp));
        require(used0*10000>=x*9990 || used1*10000>=y*9990,"mint ratio");
        _approve(a,0);_approve(b,0);
        manager.safeTransferFrom(address(this),address(locker),result.positionId);
        require(locker.locked(),"position lock");
        result.tokenUsed=used0;result.quoteUsed=used1;return result;
    }
    /// Pays only the pool being rebalanced, only during a migration, only in the input asset and only up to the budget.
    function uniswapV3SwapCallback(int256 amount0,int256 amount1,bytes calldata) external {
        require(entered && repricePool!=address(0) && msg.sender==repricePool,"rebalance callback");
        uint256 owed=amount0>0?uint256(amount0):amount1>0?uint256(amount1):0;
        if(owed==0)return;
        require(owed<=repriceBudget,"rebalance budget");
        repriceBudget-=owed;
        require(IFeeToken(repriceAsset).transfer(msg.sender,owed),"rebalance payment");
    }
    function initialSqrtPrice(uint256 x,uint256 y) public pure returns(uint160) {
        uint256 root=y<=x?Math.sqrt(Math.mulDiv(y,uint256(1)<<192,x)):Math.sqrt(Math.mulDiv(x,uint256(1)<<192,y));
        uint256 p=y<=x?root:(uint256(1)<<192)/root;
        require(p>4295128739 && p<1461446703485210103287273052203988822378723970342,"price bounds");return uint160(p);
    }
    function _pull(address asset,uint256 amount) private {uint256 beforeBalance=IFeeToken(asset).balanceOf(address(this));require(IFeeToken(asset).transferFrom(msg.sender,address(this),amount),"funding");require(IFeeToken(asset).balanceOf(address(this))-beforeBalance==amount,"unsupported token");}
    function _approve(address asset,uint256 amount) private {require(IFeeToken(asset).approve(address(manager),0),"clear approval");if(amount>0)require(IFeeToken(asset).approve(address(manager),amount),"approval");}
}
