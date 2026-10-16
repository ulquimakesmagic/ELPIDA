// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/utils/math/Math.sol";
interface IUsdFeed {
    function decimals() external view returns(uint8);
    function latestRoundData() external view returns(uint80,int256,uint256,uint256,uint80);
}
interface IUsdFeeToken {
    function decimals() external view returns(uint8);
    function transferFrom(address,address,uint256) external returns(bool);
    function balanceOf(address) external view returns(uint256);
}
/// @notice Immutable-after-configuration USD pricing. Browser/server prices cannot authorize fees.
abstract contract ElpidaUsdPricing {
    error PricingFixed(); error OracleConfiguration(); error OracleUnavailable(); error InvalidOracleRound(); error StaleOraclePrice(); error FeeQuoteMoved(); error UsdcUnavailable(); error FeeTransferFailed(); error FeeRefundFailed();
    IUsdFeed public usdFeed;
    address public feeUsdc;
    uint256 public maxPriceAge;
    event UsdPricingConfigured(address feed,uint256 maxAge,address usdc);
    event LaunchFeePaid(address indexed payer,address indexed asset,uint256 amount,uint256 priceUpdatedAt);
    function pricingOwner() internal view virtual returns(address);
    // Retain constructor compatibility with previous deployment scripts; these amounts never price launches.
    function _legacyPricing(uint256,uint256) internal view {
        if(!(address(usdFeed)==address(0)))revert PricingFixed();
    }
    function configureUsdPricing(address feed,uint256 maxAge,address usdc) external {
        if(!(msg.sender==pricingOwner()&&address(usdFeed)==address(0)))revert PricingFixed();
        if(!(feed.code.length>0&&maxAge>0&&maxAge<=1 days))revert OracleConfiguration();
        if(!(IUsdFeed(feed).decimals()<=18))revert OracleConfiguration();
        if(usdc!=address(0))if(!(usdc.code.length>0&&IUsdFeeToken(usdc).decimals()==6))revert OracleConfiguration();
        usdFeed=IUsdFeed(feed);maxPriceAge=maxAge;feeUsdc=usdc;
        price();emit UsdPricingConfigured(feed,maxAge,usdc);
    }
    function price() public view returns(uint256 answer,uint256 updatedAt,uint8 decimals) {
        if(!(address(usdFeed)!=address(0)))revert OracleUnavailable();
        (uint80 round,int256 value,,uint256 timestamp,uint80 answered)=usdFeed.latestRoundData();
        if(!(value>0&&round>0&&answered>=round&&timestamp>0&&timestamp<=block.timestamp))revert InvalidOracleRound();
        if(!(block.timestamp-timestamp<=maxPriceAge))revert StaleOraclePrice();
        return(uint256(value),timestamp,usdFeed.decimals());
    }
    function nativeUsdAmount(uint256 dollars) public view returns(uint256) {
        (uint256 answer,,uint8 d)=price();
        return Math.mulDiv(dollars*1 ether,10**d,answer,Math.Rounding.Ceil);
    }
    function launchFee() public view returns(uint256){return nativeUsdAmount(10);}
    /// Model 8 default ($5,000 start, 16x curve). Model 10 overrides it with its own start and 10/9 shape.
    function nativeVirtualQuote() public view virtual returns(uint256){return Math.mulDiv(nativeUsdAmount(5000),16,15,Math.Rounding.Ceil);}
    function _chargeLaunchFee(uint256 firstBuyValue,bool inUsdc) internal {
        if(address(usdFeed)==address(0))revert OracleUnavailable();
        uint256 fee=launchFee();uint256 requiredValue=firstBuyValue+(inUsdc?0:fee);
        if(!(msg.value>=requiredValue))revert FeeQuoteMoved();
        uint256 timestamp;
        if(address(usdFeed)!=address(0))(,timestamp,)=price();
        if(inUsdc){
            if(!(feeUsdc!=address(0)))revert UsdcUnavailable();
            IUsdFeeToken coin=IUsdFeeToken(feeUsdc);uint256 beforeBalance=coin.balanceOf(pricingOwner());
            if(!(coin.transferFrom(msg.sender,pricingOwner(),10_000_000)))revert FeeTransferFailed();
            if(!(coin.balanceOf(pricingOwner())==beforeBalance+10_000_000))revert FeeTransferFailed();
            emit LaunchFeePaid(msg.sender,feeUsdc,10_000_000,timestamp);
        }else{
            (bool ok,)=pricingOwner().call{value:fee}("");if(!(ok))revert FeeTransferFailed();
            emit LaunchFeePaid(msg.sender,address(0),fee,timestamp);
        }
        uint256 refund=msg.value-requiredValue;
        if(refund>0){(bool ok,)=msg.sender.call{value:refund}("");if(!(ok))revert FeeRefundFailed();}
    }
}
