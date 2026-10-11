// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaToken.sol";
import "./ElpidaDexCurve.sol";
interface ILaunchDecimals { function decimals() external view returns (uint8); }

/// @notice Launchpad with Uniswap v3 graduation, native pricing. NOT AUDITED.
/// @dev Creation fees are always paid in the chain's native coin, whatever the pair. Native pairs use the
/// treasury-set starting virtual reserve; xStock and paired-token pairs use team-approved templates in
/// that asset. `setPricing` changes the fee and the native template for future launches only.
contract ElpidaDexFactory {
    address public immutable treasury;
    uint256 public launchFee;
    uint256 public nativeVirtualQuote;
    uint256 public constant VIRTUAL_TOKEN = uint256(800_000_000 ether) * 800_000_000 ether / (600_000_000 ether);
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MODEL_VERSION = 7;
    uint256 public constant METADATA_VERSION = 1;
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
    event PricingSet(uint256 launchFee,uint256 nativeVirtualQuote);
    constructor(address treasury_,uint256 launchFee_,uint256 nativeVirtualQuote_,address adapter_) {
        require(treasury_ != address(0), "zero address");
        require(adapter_.code.length > 0, "adapter config");
        treasury = treasury_; migrationAdapter = adapter_; _setPricing(launchFee_,nativeVirtualQuote_);
    }
    /// Treasury only: creation fee (wei) and starting virtual native reserve (wei) for future launches.
    function setPricing(uint256 launchFee_,uint256 nativeVirtualQuote_) external {
        require(msg.sender == treasury, "owner only"); _setPricing(launchFee_,nativeVirtualQuote_);
    }
    function _setPricing(uint256 launchFee_,uint256 nativeVirtualQuote_) private {
        require(nativeVirtualQuote_ > 0, "native template");
        launchFee = launchFee_; nativeVirtualQuote = nativeVirtualQuote_; emit PricingSet(launchFee_,nativeVirtualQuote_);
    }
    function _takeFee(uint256 firstBuyValue) private {
        uint256 fee = launchFee;
        require(msg.value == fee + firstBuyValue, "native value");
        if (fee > 0) { (bool ok,) = treasury.call{value:fee}(""); require(ok, "launch fee"); }
    }
    function _uri(string calldata uri) private pure {
        bytes memory value=bytes(uri);require(value.length>=16&&value.length<=128,"metadata URI length");
        require(value[0]=='i'&&value[1]=='p'&&value[2]=='f'&&value[3]=='s'&&value[4]==':'&&value[5]=='/'&&value[6]=='/',"IPFS URI required");
    }
    // Team-approved, immutable quote templates (xStocks, graduated Elpida tokens). The fee stays native.
    function approveQuote(address asset,uint256 virtualQuote_,address adapter_) external {
        require(msg.sender==treasury&&asset.code.length>0&&virtualQuote_>0&&approvedQuotes[asset].adapter==address(0),"quote approval");
        uint8 d=ILaunchDecimals(asset).decimals();require(d>=6&&d<=18,"quote decimals");
        require(adapter_.code.length>0&&ElpidaV3MigrationAdapter(adapter_).usdc()==asset,"quote adapter");
        approvedQuotes[asset]=QuoteTemplate(virtualQuote_,adapter_);emit QuoteApproved(asset,virtualQuote_,adapter_);
    }
    /// Native pair: msg.value = creation fee + first buy.
    function launch(string calldata name_,string calldata symbol_,uint256 firstBuy,uint256 minOut,address reward) external payable returns (address,address) {
        return _launch(name_,symbol_,firstBuy,minOut,reward);
    }
    function launchWithMetadata(string calldata name_,string calldata symbol_,uint256 firstBuy,uint256 minOut,address reward,string calldata uri) external payable returns (address token,address curve) {
        _uri(uri);(token,curve)=_launch(name_,symbol_,firstBuy,minOut,reward);tokenMetadataURI[token]=uri;emit MetadataPublished(token,uri);
    }
    /// Paired launch: msg.value = creation fee; the first buy is pulled in the approved asset.
    function launchPaired(string calldata name_,string calldata symbol_,address asset,uint256 firstBuy,uint256 minOut,address reward) external payable returns(address token,address curve){
        return _launchPaired(name_,symbol_,asset,firstBuy,minOut,reward);
    }
    function launchPairedWithMetadata(string calldata name_,string calldata symbol_,address asset,uint256 firstBuy,uint256 minOut,address reward,string calldata uri) external payable returns(address token,address curve){
        _uri(uri);(token,curve)=_launchPaired(name_,symbol_,asset,firstBuy,minOut,reward);tokenMetadataURI[token]=uri;emit MetadataPublished(token,uri);
    }
    function _launchPaired(string calldata name_,string calldata symbol_,address asset,uint256 firstBuy,uint256 minOut,address reward) private returns(address token,address curve){
        require(!entered,"reentrancy");entered=true;QuoteTemplate memory template=approvedQuotes[asset];require(template.adapter!=address(0)&&firstBuy>0&&reward!=address(0),"pair/buy/reward");
        _takeFee(0);
        IERC20Minimal q=IERC20Minimal(asset);uint256 beforeBalance=q.balanceOf(address(this));require(q.transferFrom(msg.sender,address(this),firstBuy),"pair funding");require(q.balanceOf(address(this))-beforeBalance==firstBuy,"unsupported quote");
        ElpidaToken t=new ElpidaToken(name_,symbol_,TOKEN_SUPPLY,address(this));ElpidaDexCurve c=new ElpidaDexCurve(asset,address(t),address(this),treasury,reward,template.virtualQuote,VIRTUAL_TOKEN,template.adapter);
        require(t.transfer(address(c),TOKEN_SUPPLY),"token seed");require(q.approve(address(c),firstBuy),"pair approval");c.initialBuy(msg.sender,firstBuy,minOut);require(q.approve(address(c),0),"cleanup");
        token=address(t);curve=address(c);isElpidaToken[token]=true;emit Launched(msg.sender,token,curve,firstBuy,false);emit CustomPair(token,asset);entered=false;
    }
    function _launch(string calldata name_,string calldata symbol_,uint256 firstBuy,uint256 minOut,address reward) private returns (address,address) {
        require(!entered, "reentrancy"); entered = true;
        require(firstBuy > 0 && reward != address(0), "buy/reward required");
        _takeFee(firstBuy);
        ElpidaToken t = new ElpidaToken(name_,symbol_,TOKEN_SUPPLY,address(this));
        ElpidaDexCurve c = new ElpidaDexCurve(address(0),address(t),address(this),treasury,reward,nativeVirtualQuote,VIRTUAL_TOKEN,migrationAdapter);
        require(t.transfer(address(c),TOKEN_SUPPLY), "token seed");
        c.initialBuy{value:firstBuy}(msg.sender,firstBuy,minOut);
        isElpidaToken[address(t)] = true; emit Launched(msg.sender,address(t),address(c),firstBuy,true);
        entered = false; return (address(t),address(c));
    }
}
