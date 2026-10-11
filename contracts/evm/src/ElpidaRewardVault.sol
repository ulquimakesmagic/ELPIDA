// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
interface IRewardCurve { function buy(uint256,uint256) external payable returns(uint256); function token() external view returns(address); function quote() external view returns(address); }
interface IRewardWrapped {function deposit() external payable;function withdraw(uint256) external;}
interface IRewardRouter {struct Swap {address tokenIn;address tokenOut;uint24 fee;address recipient;uint256 amountIn;uint256 amountOutMinimum;uint160 sqrtPriceLimitX96;}function exactInputSingle(Swap calldata) external payable returns(uint256);}
/// @notice Local-test reward treasury. Executor/verifier are trusted; do not deploy as permissionless production automation.
contract ElpidaRewardVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable executor;
    address public immutable verifier;
    address public mainToken;
    address public mainCurve;
    address public sourceAsset;
    address public dexRouter;
    address public wrappedNative;
    struct Recipient { bytes32 identity; address wallet; uint16 bps; }
    struct Grant { address asset; address recipient; uint256 total; uint256 claimed; uint64 start; uint64 duration; }
    Recipient[] public recipients;
    Grant[] public grants;
    mapping(address=>uint256) public accounted;
    mapping(address=>uint256) public strategyBalance;
    mapping(bytes32=>mapping(address=>uint256)) public identityBalance;
    mapping(address=>mapping(address=>uint256)) public claimable;
    mapping(bytes32=>address) public verifiedWallet;
    event Synced(address indexed asset,uint256 amount);
    event IdentityBound(bytes32 indexed identity,address indexed wallet);
    event Paid(address indexed asset,address indexed recipient,uint256 amount);
    event Epoch(uint256 indexed snapshotBlock,address indexed asset,uint256 amount,uint256 recipients);
    event Converted(address indexed input,address indexed output,uint256 spent,uint256 received);
    constructor(address executor_,address verifier_,bytes32[] memory identities,address[] memory wallets,uint16[] memory splits) {
        require(executor_!=address(0)&&verifier_!=address(0),"authority"); executor=executor_;verifier=verifier_;
        require(identities.length==wallets.length&&wallets.length==splits.length&&splits.length<=12,"recipients");
        uint256 sum;
        for(uint256 i;i<splits.length;i++){require(splits[i]>0&&(wallets[i]!=address(0)||identities[i]!=bytes32(0)),"recipient");
            for(uint256 j;j<i;j++)require(!(wallets[i]==wallets[j]&&identities[i]==identities[j]),"duplicate");
            recipients.push(Recipient(identities[i],wallets[i],splits[i]));sum+=splits[i];}
        require(sum==0||sum==10000,"allocation total");
    }
    receive() external payable {}
    function initialize(address token,address curve,address asset) external {require(msg.sender==executor&&mainToken==address(0)&&token.code.length>0&&curve.code.length>0,"init");mainToken=token;mainCurve=curve;sourceAsset=asset;}
    function configureDex(address router,address wrapped) external {require(msg.sender==executor&&dexRouter==address(0)&&router.code.length>0&&wrapped.code.length>0,"dex config");dexRouter=router;wrappedNative=wrapped;}
    function unwrapFees(uint256 amount) external nonReentrant {require(msg.sender==executor&&sourceAsset==address(0)&&amount>0,"unwrap");require(IERC20(wrappedNative).balanceOf(address(this))-accounted[wrappedNative]>=amount,"unallocated only");IRewardWrapped(wrappedNative).withdraw(amount);}
    function balance(address asset) public view returns(uint256){return asset==address(0)?address(this).balance:IERC20(asset).balanceOf(address(this));}
    function sync(address asset) external nonReentrant {
        uint256 current=balance(asset);require(current>=accounted[asset],"unsupported asset");uint256 amount=current-accounted[asset];accounted[asset]=current;
        if(recipients.length==0)strategyBalance[asset]+=amount;
        else {uint256 allocated;for(uint256 i;i<recipients.length;i++){Recipient memory r=recipients[i];uint256 share=i+1==recipients.length?amount-allocated:amount*r.bps/10000;allocated+=share;
            if(r.wallet!=address(0))claimable[r.wallet][asset]+=share;else identityBalance[r.identity][asset]+=share;}}
        emit Synced(asset,amount);
    }
    function bindIdentity(bytes32 identity,address wallet) external {require(msg.sender==verifier&&identity!=bytes32(0)&&wallet!=address(0)&&verifiedWallet[identity]==address(0),"verification");verifiedWallet[identity]=wallet;emit IdentityBound(identity,wallet);}
    function claimIdentity(bytes32 identity,address asset) external nonReentrant {address wallet=verifiedWallet[identity];require(wallet!=address(0),"unverified");uint256 amount=identityBalance[identity][asset];identityBalance[identity][asset]=0;_pay(asset,wallet,amount);}
    function claim(address recipient,address asset) external nonReentrant {uint256 amount=claimable[recipient][asset];claimable[recipient][asset]=0;_pay(asset,recipient,amount);}
    // No arbitrary calldata. Swap only through a same-chain curve and verify actual received tokens.
    function convert(address asset,address output,address curve,uint256 amount,uint256 minimum) external nonReentrant returns(uint256 received) {
        require(msg.sender==executor&&amount>0&&minimum>0&&strategyBalance[asset]>=amount&&curve.code.length>0&&output.code.length>0,"conversion");
        require(asset==sourceAsset&&output!=asset&&IRewardCurve(curve).token()==output&&IRewardCurve(curve).quote()==asset,"route assets");
        uint256 beforeOutput=IERC20(output).balanceOf(address(this));strategyBalance[asset]-=amount;accounted[asset]-=amount;
        if(asset!=address(0))IERC20(asset).forceApprove(curve,amount);
        IRewardCurve(curve).buy{value:asset==address(0)?amount:0}(amount,minimum);
        if(asset!=address(0))IERC20(asset).forceApprove(curve,0);
        received=IERC20(output).balanceOf(address(this))-beforeOutput;require(received>=minimum,"received");
        strategyBalance[output]+=received;accounted[output]+=received;emit Converted(asset,output,amount,received);
    }
    function convertDex(address asset,address output,uint256 amount,uint256 minimum) external nonReentrant returns(uint256 received){
        require(msg.sender==executor&&dexRouter!=address(0)&&asset!=output&&minimum>0&&amount>0&&strategyBalance[asset]>=amount,"dex conversion");
        uint256 beforeOutput=balance(output);strategyBalance[asset]-=amount;accounted[asset]-=amount;
        address input=asset==address(0)?wrappedNative:asset;address target=output==address(0)?wrappedNative:output;
        if(asset==address(0))IRewardWrapped(wrappedNative).deposit{value:amount}();IERC20(input).forceApprove(dexRouter,amount);
        uint256 out=IRewardRouter(dexRouter).exactInputSingle(IRewardRouter.Swap(input,target,10000,address(this),amount,minimum,0));IERC20(input).forceApprove(dexRouter,0);
        if(output==address(0))IRewardWrapped(wrappedNative).withdraw(out);
        received=balance(output)-beforeOutput;require(received>=minimum,"received");strategyBalance[output]+=received;accounted[output]+=received;emit Converted(asset,output,amount,received);
    }
    // Trusted local snapshot publisher. Production requires independently verifiable roots and a funded keeper.
    function distribute(address asset,address[] calldata holders,uint256[] calldata amounts,uint64 duration,uint256 snapshotBlock) external nonReentrant {
        require(msg.sender==executor&&holders.length==amounts.length&&holders.length>0&&holders.length<=64&&snapshotBlock<block.number,"epoch");
        uint256 total;
        for(uint256 i;i<holders.length;i++){require(holders[i]!=address(0)&&amounts[i]>0,"holder");total+=amounts[i];}
        require(total<=strategyBalance[asset],"budget");strategyBalance[asset]-=total;
        for(uint256 i;i<holders.length;i++){
            if(duration>0)grants.push(Grant(asset,holders[i],amounts[i],0,uint64(block.timestamp),duration));
            else if(asset==address(0)){accounted[asset]-=amounts[i];(bool ok,)=holders[i].call{value:amounts[i]}("");if(!ok){accounted[asset]+=amounts[i];claimable[holders[i]][asset]+=amounts[i];}}
            else {accounted[asset]-=amounts[i];IERC20(asset).safeTransfer(holders[i],amounts[i]);}
        }
        emit Epoch(snapshotBlock,asset,total,holders.length);
    }
    function grantCount() external view returns(uint256){return grants.length;}
    function claimVested(uint256 id) external nonReentrant {Grant storage g=grants[id];uint256 elapsed=block.timestamp-g.start;uint256 vested=elapsed>=g.duration?g.total:g.total*elapsed/g.duration;uint256 amount=vested-g.claimed;g.claimed=vested;_pay(g.asset,g.recipient,amount);}
    function _pay(address asset,address recipient,uint256 amount) private {if(amount==0)return;accounted[asset]-=amount;if(asset==address(0)){(bool ok,)=recipient.call{value:amount}("");require(ok,"payout");}else IERC20(asset).safeTransfer(recipient,amount);emit Paid(asset,recipient,amount);}
}
