// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaUsdPricing.sol";
import "./ElpidaTaxToken.sol";
import "./ElpidaTaxCurve.sol";
import "./ElpidaCreatorAllocation.sol";
import "./ElpidaV2TaxMigrationAdapter.sol";

library TaxLaunch {
    struct Params {string name;string symbol;address asset;uint256 firstBuy;uint256 minOut;string uri;bool feeInUsdc;uint16 buyTaxBps;uint16 sellTaxBps;address[] recipients;uint16[] shares;}
}
contract ElpidaTaxTokenDeployer {
    address public immutable parent;
    constructor(){parent=msg.sender;}
    function create(TaxLaunch.Params calldata p,address factory,address treasury) external returns(address token,address allocation){
        require(msg.sender==parent,"parent only");
        allocation=address(new ElpidaCreatorAllocation(p.recipients,p.shares));
        token=address(new ElpidaTaxToken(p.name,p.symbol,factory,treasury,allocation,p.buyTaxBps,p.sellTaxBps));
    }
}
contract ElpidaTaxCurveDeployer {
    address public immutable parent;
    constructor(){parent=msg.sender;}
    function create(ElpidaTaxCurve.Domain calldata domain) external returns(address){require(msg.sender==parent,"parent only");return address(new ElpidaTaxCurve(domain));}
}
contract ElpidaTaxDeployer {
    address public immutable factory;
    ElpidaTaxTokenDeployer public immutable tokenDeployer;
    ElpidaTaxCurveDeployer public immutable curveDeployer;
    constructor(){factory=msg.sender;tokenDeployer=new ElpidaTaxTokenDeployer();curveDeployer=new ElpidaTaxCurveDeployer();}
    function create(TaxLaunch.Params calldata p,address treasury,uint256 vq,address adapter,uint256 grace) external returns(address token,address curve,address allocation){
        require(msg.sender==factory,"factory only");
        (token,allocation)=tokenDeployer.create(p,factory,treasury);
        curve=curveDeployer.create(ElpidaTaxCurve.Domain(p.asset,token,factory,treasury,allocation,vq,1_111_111_111_111_111*1e12,adapter,grace,p.buyTaxBps,p.sellTaxBps));
    }
}

/// @notice Separate taxed-token deployment. Base fees 50/50; additional tax
/// 30/70. Canonical V2 migration is atomic with the final purchase. NOT AUDITED.
contract ElpidaTaxFactory is ElpidaUsdPricing {
    address public immutable treasury;
    address public immutable migrationAdapter;
    uint256 public immutable startFdvUsd;
    uint256 public immutable graduationGrace;
    uint256 public constant MODEL_VERSION=10;
    uint256 public constant OPTIONAL_CREATOR_BUY_VERSION=1;
    uint256 public constant TAX_VERSION=1;
    uint256 public constant VIRTUAL_TOKEN=1_111_111_111_111_111*1e12;
    ElpidaTaxDeployer public immutable deployer;
    mapping(address=>bool) public isElpidaToken;
    mapping(address=>string) public tokenMetadataURI;
    struct Template {uint256 virtualQuote;address adapter;}
    mapping(address=>Template) public approvedQuotes;
    bool private entered;
    event Launched(address indexed creator,address indexed token,address indexed curve,uint256 firstBuy,bool nativePair);
    event MetadataPublished(address indexed token,string uri);
    event TaxConfigured(address indexed token,uint16 buyTaxBps,uint16 sellTaxBps,address allocation);
    event CustomPair(address indexed token,address quote);
    event QuoteApproved(address indexed asset,uint256 virtualQuote,address adapter);
    constructor(address treasury_,address adapter_,uint256 fdv_,uint256 grace_){
        require(treasury_!=address(0)&&adapter_.code.length>0&&fdv_>=1&&fdv_<=1_000_000&&grace_>=60&&grace_<=7 days,"factory config");
        treasury=treasury_;migrationAdapter=adapter_;startFdvUsd=fdv_;graduationGrace=grace_;deployer=new ElpidaTaxDeployer();
    }
    function pricingOwner() internal view override returns(address){return treasury;}
    function automaticGraduation() external pure returns(bool){return true;}
    function nativeVirtualQuote() public view override returns(uint256){return Math.mulDiv(nativeUsdAmount(startFdvUsd),10,9,Math.Rounding.Ceil);}
    function approveQuote(address asset,uint256 vq,address adapter) external {
        require(msg.sender==treasury&&asset.code.length>0&&vq>0&&approvedQuotes[asset].adapter==address(0),"quote approval");
        require(adapter.code.length>0&&ElpidaV2TaxMigrationAdapter(adapter).usdc()==asset,"V2 adapter");
        approvedQuotes[asset]=Template(vq,adapter);emit QuoteApproved(asset,vq,adapter);
    }
    function launchTax(TaxLaunch.Params calldata p) external payable returns(address token,address curve){
        require(!entered,"reentrancy");entered=true;
        require(p.buyTaxBps<=1000&&p.sellTaxBps<=1000&&(p.buyTaxBps>0||p.sellTaxBps>0),"tax rates");
        require(bytes(p.name).length>0&&bytes(p.name).length<=40&&bytes(p.symbol).length>0&&bytes(p.symbol).length<=10,"name/symbol");
        bytes memory symbol=bytes(p.symbol);for(uint256 i;i<symbol.length;i++)require((symbol[i]>='A'&&symbol[i]<='Z')||(symbol[i]>='0'&&symbol[i]<='9'),"symbol");
        if(bytes(p.uri).length>0){bytes memory u=bytes(p.uri);require(u.length>=16&&u.length<=128&&u[0]=='i'&&u[1]=='p'&&u[2]=='f'&&u[3]=='s'&&u[4]==':'&&u[5]=='/'&&u[6]=='/',"IPFS URI");}
        bool native=p.asset==address(0);
        Template memory template=native?Template(nativeVirtualQuote(),migrationAdapter):approvedQuotes[p.asset];
        require(template.adapter!=address(0),"quote unavailable");
        _chargeLaunchFee(native?p.firstBuy:0,p.feeInUsdc);
        address allocation;
        (token,curve,allocation)=deployer.create(p,treasury,template.virtualQuote,template.adapter,graduationGrace);
        ElpidaTaxToken(token).bindCurve(curve);
        require(IERC20Minimal(token).transfer(curve,1_000_000_000 ether),"token seed");
        if(!native&&p.firstBuy>0){
            IERC20Minimal q=IERC20Minimal(p.asset);uint256 beforeBalance=q.balanceOf(address(this));
            require(q.transferFrom(msg.sender,address(this),p.firstBuy)&&q.balanceOf(address(this))-beforeBalance==p.firstBuy,"quote funding");
            require(q.approve(curve,p.firstBuy),"quote approval");
            ElpidaTaxCurve(curve).initialBuy(msg.sender,p.firstBuy,p.minOut);
            require(q.approve(curve,0),"clear approval");
            uint256 unused=q.balanceOf(address(this))-beforeBalance;if(unused>0)require(q.transfer(msg.sender,unused),"quote refund");
        }else ElpidaTaxCurve(curve).initialBuy{value:native?p.firstBuy:0}(msg.sender,p.firstBuy,p.minOut);
        isElpidaToken[token]=true;tokenMetadataURI[token]=p.uri;
        emit Launched(msg.sender,token,curve,p.firstBuy,native);emit TaxConfigured(token,p.buyTaxBps,p.sellTaxBps,allocation);
        if(!native)emit CustomPair(token,p.asset);if(bytes(p.uri).length>0)emit MetadataPublished(token,p.uri);entered=false;
    }
}
