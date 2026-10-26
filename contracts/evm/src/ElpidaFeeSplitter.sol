// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFeeToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
    function transferFrom(address,address,uint256) external returns (bool);
    function approve(address,uint256) external returns (bool);
}
interface IBuybackPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,bytes calldata data) external returns (int256,int256);
}

/// @notice Prototype fee-only escrow. LP principal must live in a separate permanent locker.
/// @dev Immutable beneficiaries; no owner, upgrades or arbitrary withdrawal. NOT AUDITED.
contract ElpidaFeeSplitter {
    address public immutable treasury;
    address public immutable creator;
    /// Early-partner tiers: `buybackBps` (0, 1000 or 2000) of every fee deposit buys back and burns `token` through
    /// `pool`. The creator's 50% is unchanged; the burn share comes out of the treasury's half.
    address public immutable token;
    address public immutable pool;
    uint256 public immutable buybackBps;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// Largest share of the pool's quote balance one buyback may spend: 1%. With the pool's 1% swap fee, a sandwich
    /// around a buyback this small costs the attacker more in fees than it can take.
    uint256 public constant MAX_BUYBACK_DEPTH_BPS = 100;
    uint160 private constant MIN_PRICE_LIMIT = 4295128740; // TickMath.MIN_SQRT_RATIO + 1
    uint160 private constant MAX_PRICE_LIMIT = 1461446703485210103287273052203988822378723970341; // MAX_SQRT_RATIO - 1
    mapping(address => mapping(address => uint256)) public claimable;
    /// Quote-side burn share waiting for `buyback()`, per asset.
    mapping(address => uint256) public pendingBuyback;
    /// Tokens burned from LP fees: the token-side share at deposit, plus everything `buyback()` bought.
    uint256 public burned;
    bool private entered;
    address private paying;
    event FeesFunded(address indexed asset,uint256 amount,uint256 protocolShare,uint256 creatorShare);
    event FeesClaimed(address indexed asset,address indexed recipient,uint256 amount);
    event BuybackQueued(address indexed asset,uint256 amount);
    event BuybackBurned(address indexed asset,uint256 quoteSpent,uint256 tokensBurned);
    modifier guarded() { require(!entered,"reentrancy"); entered=true; _; entered=false; }
    constructor(address treasury_,address creator_,address token_,address pool_,uint256 buybackBps_) {
        require(treasury_!=address(0) && creator_!=address(0),"zero beneficiary");
        require(buybackBps_==0 || buybackBps_==1000 || buybackBps_==2000,"buyback share");
        require(buybackBps_==0 || (token_!=address(0) && pool_.code.length>0),"buyback pool");
        treasury=treasury_;creator=creator_;token=token_;pool=pool_;buybackBps=buybackBps_;
    }
    function depositToken(address asset,uint256 amount) external guarded {
        require(asset!=address(0) && amount>0,"asset/amount");
        uint256 beforeBalance=IFeeToken(asset).balanceOf(address(this));
        require(IFeeToken(asset).transferFrom(msg.sender,address(this),amount),"funding failed");
        require(IFeeToken(asset).balanceOf(address(this))-beforeBalance==amount,"unsupported token");
        _credit(asset,amount);
    }
    function depositNative() external payable guarded { require(msg.value>0,"amount");_credit(address(0),msg.value); }
    function _credit(address asset,uint256 amount) private {
        // Creator: 50% with any remainder, as always. Burn: buybackBps of ERC-20 deposits (pool fees are never native).
        uint256 c=amount-amount/2; uint256 b=asset==address(0)?0:amount*buybackBps/10000; uint256 p=amount-c-b;
        claimable[asset][treasury]+=p;claimable[asset][creator]+=c;
        emit FeesFunded(asset,amount,p,c);
        if(b==0)return;
        if(asset==token){burned+=b;require(IFeeToken(asset).transfer(DEAD,b),"burn");emit BuybackBurned(asset,0,b);}
        else {pendingBuyback[asset]+=b;emit BuybackQueued(asset,b);}
    }
    /// Swaps pending quote-side burn share for the token through the pool and sends it to the dead address. Anyone may
    /// call it. Each call spends at most 1% of the pool's quote balance; a larger backlog takes several calls.
    function buyback() external guarded returns(uint256 spent,uint256 tokensBurned){
        require(buybackBps>0,"no buyback");
        address t0=IBuybackPool(pool).token0();address q=t0==token?IBuybackPool(pool).token1():t0;
        uint256 pending=pendingBuyback[q];uint256 cap=IFeeToken(q).balanceOf(pool)*MAX_BUYBACK_DEPTH_BPS/10000;
        spent=pending<cap?pending:cap;require(spent>0,"nothing to buy back");
        bool zeroForOne=q==t0;paying=q;
        (int256 d0,int256 d1)=IBuybackPool(pool).swap(DEAD,zeroForOne,int256(spent),zeroForOne?MIN_PRICE_LIMIT:MAX_PRICE_LIMIT,"");
        paying=address(0);
        int256 paid=zeroForOne?d0:d1;int256 got=zeroForOne?d1:d0;
        require(paid>0 && uint256(paid)<=spent && got<0,"buyback swap");
        spent=uint256(paid);pendingBuyback[q]=pending-spent;tokensBurned=uint256(-got);burned+=tokensBurned;
        emit BuybackBurned(q,spent,tokensBurned);
    }
    function uniswapV3SwapCallback(int256 amount0,int256 amount1,bytes calldata) external {_payPool(amount0,amount1);}
    function pancakeV3SwapCallback(int256 amount0,int256 amount1,bytes calldata) external {_payPool(amount0,amount1);}
    /// Pays the pool only during this splitter's own buyback, and never more than the pending burn share.
    function _payPool(int256 amount0,int256 amount1) private {
        require(msg.sender==pool && paying!=address(0),"callback");
        int256 owed=amount0>0?amount0:amount1;require(owed>0 && uint256(owed)<=pendingBuyback[paying],"callback amount");
        require(IFeeToken(paying).transfer(pool,uint256(owed)),"buyback payment");
    }
    // Anyone can trigger payout, but only to the fixed beneficiary. A failing beneficiary cannot block the other.
    function claim(address asset,address recipient) external guarded {
        require(recipient==treasury || recipient==creator,"beneficiary");
        uint256 amount=claimable[asset][recipient];claimable[asset][recipient]=0;
        if(amount==0)return;
        if(asset==address(0)){(bool ok,)=recipient.call{value:amount}("");require(ok,"native payout");}
        else require(IFeeToken(asset).transfer(recipient,amount),"token payout");
        emit FeesClaimed(asset,recipient,amount);
    }
}
