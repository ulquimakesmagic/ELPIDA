// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaToken.sol";
import "./ElpidaBetaCurve.sol";

/// @notice Basic launchpad (no DEX graduation), verified USD launch pricing. NOT AUDITED.
/// @dev Native curves snapshot the verified $5,000 starting FDV at creation. The $10 fee
/// is converted by the fixed USD oracle at execution; USDC is an independent payment option.
import "./ElpidaUsdPricing.sol";
contract ElpidaBetaFactory is ElpidaUsdPricing {
    address public immutable treasury;
    uint256 public constant VIRTUAL_TOKEN = uint256(800_000_000 ether) * 800_000_000 ether / (600_000_000 ether);
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MODEL_VERSION = 8;
    bool private entered;
    mapping(address => bool) public isElpidaToken;
    event Launched(address indexed creator,address indexed token,address indexed curve,uint256 firstBuy,bool nativePair);
    event PricingSet(uint256 launchFee,uint256 nativeVirtualQuote);
    constructor(address treasury_,uint256 launchFee_,uint256 nativeVirtualQuote_) {
        require(treasury_ != address(0), "zero address");
        treasury = treasury_; _setPricing(launchFee_,nativeVirtualQuote_);
    }
    function pricingOwner() internal view override returns(address){return treasury;}
    function OPTIONAL_CREATOR_BUY_VERSION() external pure returns(uint256){return 1;}
    /// Deprecated compatibility endpoint. Manual repricing is disabled.
    function setPricing(uint256,uint256) external view {
        require(msg.sender == treasury, "owner only"); revert PricingFixed();
    }
    function _setPricing(uint256 launchFee_,uint256 nativeVirtualQuote_) private {
        require(nativeVirtualQuote_ > 0, "native template");
        _legacyPricing(launchFee_,nativeVirtualQuote_); emit PricingSet(launchFee_,nativeVirtualQuote_);
    }
    /// msg.value must be exactly the creation fee plus the first buy, so a fee change in between reverts.
    function launch(string calldata name_,string calldata symbol_,uint256 firstBuy,uint256 minOut,address reward) external payable returns (address,address) {
        return _launch(name_,symbol_,firstBuy,minOut,reward,false);
    }
    function launchWithPayment(string calldata name_,string calldata symbol_,address asset,uint256 firstBuy,uint256 minOut,address reward,string calldata uri,bool inUsdc) external payable returns(address,address){
        if(asset!=address(0)||bytes(uri).length!=0)revert OracleConfiguration();
        return _launch(name_,symbol_,firstBuy,minOut,reward,inUsdc);
    }
    function _launch(string calldata name_,string calldata symbol_,uint256 firstBuy,uint256 minOut,address reward,bool inUsdc) private returns(address,address){
        require(!entered, "reentrancy"); entered = true;
        require(reward != address(0), "reward required");
        _chargeLaunchFee(firstBuy,inUsdc);
        ElpidaToken t = new ElpidaToken(name_,symbol_,TOKEN_SUPPLY,address(this));
        ElpidaBetaCurve c = new ElpidaBetaCurve(address(0),address(t),address(this),treasury,reward,nativeVirtualQuote(),VIRTUAL_TOKEN);
        require(t.transfer(address(c),TOKEN_SUPPLY), "token seed");
        if(firstBuy>0)c.initialBuy{value:firstBuy}(msg.sender,firstBuy,minOut);
        else require(minOut==0,"empty first buy");
        isElpidaToken[address(t)] = true; emit Launched(msg.sender,address(t),address(c),firstBuy,true);
        entered = false; return (address(t),address(c));
    }
}
