// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaToken.sol";
import "./ElpidaDexCurve.sol";
import "./ElpidaUsdPricing.sol";
interface ILaunchDecimals { function decimals() external view returns (uint8); }

/// @notice Creates model 10 tokens and curves. Kept separate from the factory so the factory's runtime code
/// stays well under the EIP-170 size limit. Only the factory that deployed it can call `create`.
contract ElpidaDexCurveDeployer {
    address public immutable factory;
    constructor() { factory = msg.sender; }
    function create(string calldata name_, string calldata symbol_, address quote_, address treasury_, address reward_, uint256 virtualQuote_, uint256 virtualToken_, address adapter_, uint256 grace_) external returns (address token, address curve) {
        require(msg.sender == factory, "factory only");
        ElpidaToken t = new ElpidaToken(name_, symbol_, 1_000_000_000 ether, factory);
        ElpidaDexCurve c = new ElpidaDexCurve(quote_, address(t), factory, treasury_, reward_, virtualQuote_, virtualToken_, adapter_, grace_);
        return (address(t), address(c));
    }
}

/// @notice Model 10 launchpad: oracle-priced $10 launch fee (or 10 USDC), a $startFdvUsd -> 10x virtual curve with
/// anti-snipe fees, and Uniswap v3 graduation into permanently locked liquidity. NOT AUDITED.
/// @dev Native curves snapshot the starting FDV at creation using the fixed USD oracle. Metadata is set only in the
/// launch transaction; there is no setter.
contract ElpidaDexFactory is ElpidaUsdPricing {
    address public immutable treasury;
    /// 1B x 10/9 (6-decimal Solana value scaled to 18 decimals).
    uint256 public constant VIRTUAL_TOKEN = 1_111_111_111_111_111 * 1e12;
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MODEL_VERSION = 10;
    uint256 public constant METADATA_VERSION = 1;
    /// Starting FDV in whole US dollars: 5000 on mainnet, 50 on test-sized testnet deployments.
    uint256 public immutable startFdvUsd;
    /// Seconds before a completed but ungraduated curve can be reopened (24 h on mainnet).
    uint256 public immutable graduationGrace;
    ElpidaDexCurveDeployer public immutable deployer;
    mapping(address => string) public tokenMetadataURI;
    event MetadataPublished(address indexed token,string uri);
    /// Migration adapter for native pairs (wraps to WETH on graduation).
    address public immutable migrationAdapter;
    bool private entered;
    mapping(address => bool) public isElpidaToken;
    struct QuoteTemplate { uint256 virtualQuote; address adapter; }
    mapping(address=>QuoteTemplate) public approvedQuotes;
    event QuoteApproved(address indexed asset,uint256 virtualQuote,address adapter);
    event CustomPair(address indexed token,address indexed quote);
    event Launched(address indexed creator,address indexed token,address indexed curve,uint256 firstBuy,bool nativePair);
    constructor(address treasury_,address adapter_,uint256 startFdvUsd_,uint256 graduationGrace_) {
        require(treasury_ != address(0), "zero address");
        require(adapter_.code.length > 0, "adapter config");
        require(startFdvUsd_ >= 1 && startFdvUsd_ <= 1_000_000, "start FDV");
        require(graduationGrace_ >= 60 && graduationGrace_ <= 7 days, "grace");
        treasury = treasury_; migrationAdapter = adapter_; startFdvUsd = startFdvUsd_; graduationGrace = graduationGrace_;
        deployer = new ElpidaDexCurveDeployer();
    }
    function pricingOwner() internal view override returns(address){return treasury;}
    /// Deprecated compatibility endpoint. Manual repricing is disabled.
    function setPricing(uint256,uint256) external view {
        require(msg.sender == treasury, "owner only"); revert PricingFixed();
    }
    /// Native virtual reserve for a new curve: the starting FDV times 10/9, at the current oracle price.
    function nativeVirtualQuote() public view override returns(uint256){return Math.mulDiv(nativeUsdAmount(startFdvUsd),10,9,Math.Rounding.Ceil);}
    function _uri(string calldata uri) private pure {
        bytes memory value=bytes(uri);require(value.length>=16&&value.length<=128,"metadata URI length");
        require(value[0]=='i'&&value[1]=='p'&&value[2]=='f'&&value[3]=='s'&&value[4]==':'&&value[5]=='/'&&value[6]=='/',"IPFS URI required");
    }
    // Team-approved, immutable quote templates (USDC, xStocks, graduated Elpida tokens). The fee stays native or 10 USDC.
    function approveQuote(address asset,uint256 virtualQuote_,address adapter_) external {
        require(msg.sender==treasury&&asset.code.length>0&&virtualQuote_>0&&approvedQuotes[asset].adapter==address(0),"quote approval");
        uint8 d=ILaunchDecimals(asset).decimals();require(d>=6&&d<=18,"quote decimals");
        require(adapter_.code.length>0&&ElpidaV3MigrationAdapter(adapter_).usdc()==asset,"quote adapter");
        approvedQuotes[asset]=QuoteTemplate(virtualQuote_,adapter_);emit QuoteApproved(asset,virtualQuote_,adapter_);
    }
    /// Native pair: msg.value = creation fee + first buy.
    function launch(string calldata name_,string calldata symbol_,uint256 firstBuy,uint256 minOut,address reward) external payable returns (address,address) {
        return _launch(name_,symbol_,firstBuy,minOut,reward,false);
    }
    function launchWithMetadata(string calldata name_,string calldata symbol_,uint256 firstBuy,uint256 minOut,address reward,string calldata uri) external payable returns (address token,address curve) {
        _uri(uri);(token,curve)=_launch(name_,symbol_,firstBuy,minOut,reward,false);_publish(token,uri);
    }
    /// Paired launch: msg.value = creation fee; the first buy is pulled in the approved asset.
    function launchPaired(string calldata name_,string calldata symbol_,address asset,uint256 firstBuy,uint256 minOut,address reward) external payable returns(address token,address curve){
        return _launchPaired(name_,symbol_,asset,firstBuy,minOut,reward,false);
    }
    function launchPairedWithMetadata(string calldata name_,string calldata symbol_,address asset,uint256 firstBuy,uint256 minOut,address reward,string calldata uri) external payable returns(address token,address curve){
        _uri(uri);(token,curve)=_launchPaired(name_,symbol_,asset,firstBuy,minOut,reward,false);_publish(token,uri);
    }
    function launchWithPayment(string calldata name_,string calldata symbol_,address asset,uint256 firstBuy,uint256 minOut,address reward,string calldata uri,bool inUsdc) external payable returns(address token,address curve){
        if(bytes(uri).length>0)_uri(uri);
        (token,curve)=asset==address(0)?_launch(name_,symbol_,firstBuy,minOut,reward,inUsdc):_launchPaired(name_,symbol_,asset,firstBuy,minOut,reward,inUsdc);
        if(bytes(uri).length>0)_publish(token,uri);
    }
    /// Metadata is written once, inside the launch transaction, for a token this factory just created.
    function _publish(address token,string calldata uri) private {tokenMetadataURI[token]=uri;emit MetadataPublished(token,uri);}
    function _launchPaired(string calldata name_,string calldata symbol_,address asset,uint256 firstBuy,uint256 minOut,address reward,bool inUsdc) private returns(address token,address curve){
        require(!entered,"reentrancy");entered=true;QuoteTemplate memory template=approvedQuotes[asset];require(template.adapter!=address(0)&&firstBuy>0&&reward!=address(0),"pair/buy/reward");
        _chargeLaunchFee(0,inUsdc);
        IERC20Minimal q=IERC20Minimal(asset);uint256 beforeBalance=q.balanceOf(address(this));require(q.transferFrom(msg.sender,address(this),firstBuy),"pair funding");require(q.balanceOf(address(this))-beforeBalance==firstBuy,"unsupported quote");
        (token,curve)=deployer.create(name_,symbol_,asset,treasury,reward,template.virtualQuote,VIRTUAL_TOKEN,template.adapter,graduationGrace);
        require(IERC20Minimal(token).transfer(curve,TOKEN_SUPPLY),"token seed");require(q.approve(curve,firstBuy),"pair approval");ElpidaDexCurve(curve).initialBuy(msg.sender,firstBuy,minOut);require(q.approve(curve,0),"cleanup");
        // A first buy larger than the whole curve is partially filled; return the unused quote to the creator.
        uint256 unused=q.balanceOf(address(this))-beforeBalance;if(unused>0)require(q.transfer(msg.sender,unused),"refund");
        isElpidaToken[token]=true;emit Launched(msg.sender,token,curve,firstBuy,false);emit CustomPair(token,asset);entered=false;
    }
    function _launch(string calldata name_,string calldata symbol_,uint256 firstBuy,uint256 minOut,address reward,bool inUsdc) private returns (address token,address curve) {
        require(!entered, "reentrancy"); entered = true;
        require(firstBuy > 0 && reward != address(0), "buy/reward required");
        _chargeLaunchFee(firstBuy,inUsdc);
        (token,curve)=deployer.create(name_,symbol_,address(0),treasury,reward,nativeVirtualQuote(),VIRTUAL_TOKEN,migrationAdapter,graduationGrace);
        require(IERC20Minimal(token).transfer(curve,TOKEN_SUPPLY), "token seed");
        ElpidaDexCurve(curve).initialBuy{value:firstBuy}(msg.sender,firstBuy,minOut);
        isElpidaToken[token] = true; emit Launched(msg.sender,token,curve,firstBuy,true);
        entered = false;
    }
}
