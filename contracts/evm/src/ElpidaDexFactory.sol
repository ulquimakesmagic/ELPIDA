// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaToken.sol";
import "./ElpidaDexCurve.sol";
interface ILaunchDecimals { function decimals() external view returns (uint8); }
contract ElpidaDexFactory {
    IERC20Minimal public immutable usdc;
    address public immutable treasury;
    uint8 public immutable quoteDecimals;
    uint256 public immutable LAUNCH_FEE;
    uint256 public immutable VIRTUAL_QUOTE;
    uint256 public immutable NATIVE_VIRTUAL_QUOTE;
    uint256 public constant VIRTUAL_TOKEN = uint256(800_000_000 ether) * 800_000_000 ether / (600_000_000 ether);
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MODEL_VERSION = 5;
    uint256 public constant METADATA_VERSION = 1;
    mapping(address => string) public tokenMetadataURI;
    event MetadataPublished(address indexed token,string uri);
    address public immutable migrationAdapter;
    bool private entered;
    mapping(address => bool) public isElpidaToken;
    struct QuoteTemplate { uint256 virtualQuote; address adapter; }
    mapping(address=>QuoteTemplate) public approvedQuotes;
    event QuoteApproved(address indexed asset,uint256 virtualQuote,address adapter);
    event CustomPair(address indexed token,address indexed quote);
    event Launched(address indexed creator,address indexed token,address indexed curve,uint256 firstBuy,bool nativePair);
    constructor(address usdc_,address treasury_,uint256 nativeVirtualQuote_,address adapter_) {
        require(usdc_ != address(0) && treasury_ != address(0), "zero address");
        uint8 d = ILaunchDecimals(usdc_).decimals(); require(d >= 6 && d <= 18, "quote decimals");
        require(adapter_.code.length>0 && ElpidaV3MigrationAdapter(adapter_).usdc()==usdc_,"adapter config");migrationAdapter=adapter_;
        usdc = IERC20Minimal(usdc_); treasury = treasury_; quoteDecimals = d;
        require(nativeVirtualQuote_ > 0, "native template");
        LAUNCH_FEE = 10 * uint256(10)**d; VIRTUAL_QUOTE = 5000 * uint256(10)**d * VIRTUAL_TOKEN / TOKEN_SUPPLY;
        NATIVE_VIRTUAL_QUOTE = nativeVirtualQuote_;
    }
    function launch(string calldata name_,string calldata symbol_,bool nativePair,uint256 firstBuy,uint256 minOut,address reward) external payable returns (address,address) {
        return _launch(name_,symbol_,nativePair,firstBuy,minOut,reward);
    }
    // Team-approved, immutable quote templates. Creation fees remain USDC regardless of trading pair.
    function approveQuote(address asset,uint256 virtualQuote_,address adapter_) external {
        require(msg.sender==treasury&&asset!=address(usdc)&&asset.code.length>0&&virtualQuote_>0&&approvedQuotes[asset].adapter==address(0),"quote approval");
        uint8 d=ILaunchDecimals(asset).decimals();require(d>=6&&d<=18,"quote decimals");
        require(adapter_.code.length>0&&ElpidaV3MigrationAdapter(adapter_).usdc()==asset,"quote adapter");
        approvedQuotes[asset]=QuoteTemplate(virtualQuote_,adapter_);emit QuoteApproved(asset,virtualQuote_,adapter_);
    }
    function launchPairedWithMetadata(string calldata name_,string calldata symbol_,address asset,uint256 firstBuy,uint256 minOut,address reward,string calldata uri) external returns(address token,address curve){
        bytes memory value=bytes(uri);require(value.length>=16&&value.length<=128,"metadata URI length");require(value[0]=='i'&&value[1]=='p'&&value[2]=='f'&&value[3]=='s'&&value[4]==':'&&value[5]=='/'&&value[6]=='/',"IPFS URI required");
        (token,curve)=launchPaired(name_,symbol_,asset,firstBuy,minOut,reward);tokenMetadataURI[token]=uri;emit MetadataPublished(token,uri);
    }
    function launchPaired(string memory name_,string memory symbol_,address asset,uint256 firstBuy,uint256 minOut,address reward) public returns(address token,address curve){
        require(!entered,"reentrancy");entered=true;QuoteTemplate memory template=approvedQuotes[asset];require(template.adapter!=address(0)&&firstBuy>0&&reward!=address(0),"pair/buy/reward");
        uint256 feeBefore=usdc.balanceOf(address(this));require(usdc.transferFrom(msg.sender,address(this),LAUNCH_FEE),"launch fee funding");require(usdc.balanceOf(address(this))-feeBefore==LAUNCH_FEE,"unsupported fee asset");require(usdc.transfer(treasury,LAUNCH_FEE),"launch fee");
        IERC20Minimal q=IERC20Minimal(asset);uint256 beforeBalance=q.balanceOf(address(this));require(q.transferFrom(msg.sender,address(this),firstBuy),"pair funding");require(q.balanceOf(address(this))-beforeBalance==firstBuy,"unsupported quote");
        ElpidaToken t=new ElpidaToken(name_,symbol_,TOKEN_SUPPLY,address(this));ElpidaDexCurve c=new ElpidaDexCurve(asset,address(t),address(this),treasury,reward,template.virtualQuote,VIRTUAL_TOKEN,template.adapter);
        require(t.transfer(address(c),TOKEN_SUPPLY),"token seed");require(q.approve(address(c),firstBuy),"pair approval");c.initialBuy(msg.sender,firstBuy,minOut);require(q.approve(address(c),0),"cleanup");
        token=address(t);curve=address(c);isElpidaToken[token]=true;emit Launched(msg.sender,token,curve,firstBuy,false);emit CustomPair(token,asset);entered=false;
    }
    function launchWithMetadata(string calldata name_,string calldata symbol_,bool nativePair,uint256 firstBuy,uint256 minOut,address reward,string calldata uri) external payable returns (address token,address curve) {
        bytes memory value=bytes(uri);
        require(value.length>=16 && value.length<=128,"metadata URI length");
        require(value[0]=='i' && value[1]=='p' && value[2]=='f' && value[3]=='s' && value[4]==':' && value[5]=='/' && value[6]=='/',"IPFS URI required");
        (token,curve)=_launch(name_,symbol_,nativePair,firstBuy,minOut,reward);
        tokenMetadataURI[token]=uri;
        emit MetadataPublished(token,uri);
    }
    function _launch(string calldata name_,string calldata symbol_,bool nativePair,uint256 firstBuy,uint256 minOut,address reward) private returns (address,address) {
        require(!entered, "reentrancy"); entered = true;
        require(firstBuy > 0 && reward != address(0), "buy/reward required");
        require(msg.value == (nativePair ? firstBuy : 0), "native value");
        uint256 funding = LAUNCH_FEE + (nativePair ? 0 : firstBuy);
        uint256 beforeBalance = usdc.balanceOf(address(this));
        require(usdc.transferFrom(msg.sender,address(this),funding), "funding failed");
        require(usdc.balanceOf(address(this)) - beforeBalance == funding, "unsupported quote");
        require(usdc.transfer(treasury,LAUNCH_FEE), "launch fee");
        ElpidaToken t = new ElpidaToken(name_,symbol_,TOKEN_SUPPLY,address(this));
        ElpidaDexCurve c = new ElpidaDexCurve(nativePair ? address(0) : address(usdc),address(t),address(this),treasury,reward,nativePair ? NATIVE_VIRTUAL_QUOTE : VIRTUAL_QUOTE,VIRTUAL_TOKEN,migrationAdapter);
        require(t.transfer(address(c),TOKEN_SUPPLY), "token seed");
        if (nativePair) c.initialBuy{value:firstBuy}(msg.sender,firstBuy,minOut);
        else {
            require(usdc.approve(address(c),firstBuy), "approval"); c.initialBuy(msg.sender,firstBuy,minOut);
            require(usdc.approve(address(c),0), "approval cleanup");
        }
        isElpidaToken[address(t)] = true; emit Launched(msg.sender,address(t),address(c),firstBuy,nativePair);
        entered = false; return (address(t),address(c));
    }
}
