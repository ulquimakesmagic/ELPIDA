import {Contract,ContractFactory,ZeroAddress,parseUnits,formatUnits,id,verifyMessage} from 'ethers';
import {randomBytes} from 'node:crypto';
import {resolveTxt} from 'node:dns/promises';
import {normalizeRewardPolicy,holderDistribution} from '../web/reward-policy.mjs';
import {XVerification} from './x-verification.mjs';
const dead='0x000000000000000000000000000000000000dead';
export class RewardEngine {
 constructor({compiled,provider,executor,verifier,quote,tokens,curveAbi,tokenAbi,dex}){
  Object.assign(this,{provider,executor,verifier,quote,tokens,curveAbi,tokenAbi,dex});this.artifact=compiled['contracts/evm/src/ElpidaRewardVault.sol'].ElpidaRewardVault;
  this.stockArtifact=compiled['tests/fixtures/MockRewardStock.sol'].MockRewardStock;this.records=new Map();this.challenges=new Map();this.events=[];this.xVerification=new XVerification();this.dnsResolver=resolveTxt;
 }
 async init(){this.stock=await new ContractFactory(this.stockArtifact.abi,this.stockArtifact.evm.bytecode.object,this.executor).deploy(this.quote.target);await this.stock.waitForDeployment();}
 assets(){return [...this.tokens.map(t=>({address:t.address,symbol:t.symbol,pairKind:'token',kind:'elpida',pair:t.pair,pairEligible:t.pair==='usdc'&&t.graduated===true,quoteAddress:t.quoteAddress||this.quote.target})),{address:this.stock.target,symbol:'TEST-STOCK',name:'Simulated stock (test only, not an issued xStock)',pairKind:'xstock',kind:'simulation',pair:'usdc',pairEligible:true,quoteAddress:this.quote.target}];}
 async prepare(input,owner,pair,source=this.quote.target){
  const policy=normalizeRewardPolicy(input,'local');
  if(policy.mode==='paired'){
   const asset=this.assets().find(a=>a.address.toLowerCase()===policy.rewardToken);if(!asset||(asset.address.toLowerCase()!==String(source).toLowerCase()&&asset.quoteAddress.toLowerCase()!==String(source).toLowerCase()))throw new Error('The reward token must use the same source asset as this launch. Simulated stocks require USDC.');
  }
  const recipients=policy.recipients.map(r=>({...r,target:r.target||owner}));
  const vault=await new ContractFactory(this.artifact.abi,this.artifact.evm.bytecode.object,this.executor).deploy(await this.executor.getAddress(),await this.verifier.getAddress(),recipients.map(r=>r.kind==='wallet'?'0x'+'0'.repeat(64):id(r.kind+':'+r.target)),recipients.map(r=>r.kind==='wallet'?r.target:ZeroAddress),recipients.map(r=>r.bps));await vault.waitForDeployment();
  return {policy:{...policy,recipients},vault,events:[],status:'Accumulating fees',epochs:0};
 }
 async attach(record,prepared,block){prepared.token=record.address;prepared.block=block;this.records.set(record.address,prepared);await(await prepared.vault.initialize(record.address,record.curve,record.pair==='native'?ZeroAddress:(record.quoteAddress||this.quote.target))).wait();if(this.dex)await(await prepared.vault.configureDex(this.dex.v3.router.target,this.dex.v3.weth.target)).wait();record.rewardPolicy=prepared.policy;record.rewardVault=prepared.vault.target;}
 async holders(record,snapshot){
  const token=new Contract(record.address,this.tokenAbi,this.provider);
  const logs=await token.queryFilter(token.filters.Transfer(),this.records.get(record.address).block,snapshot);
  const owners=new Set();for(const log of logs){owners.add(log.args.from.toLowerCase());owners.add(log.args.to.toLowerCase());}
  const excluded=[ZeroAddress,dead,...this.tokens.flatMap(t=>[t.address,t.curve,t.rewardVault].filter(Boolean))];
  for(const t of this.tokens){const pool=await new Contract(t.curve,this.curveAbi,this.provider).pool();excluded.push(pool);}
  const balances=await Promise.all([...owners].map(async address=>({address,balance:await token.balanceOf(address,{blockTag:snapshot})})));
  return {balances,excluded};
 }
 async process(record){
  const r=this.records.get(record.address);if(!r)return;
  const source=record.pair==='native'?ZeroAddress:(record.quoteAddress||this.quote.target),d=record.quoteDecimals,v=r.vault;
  const ownCurve=new Contract(record.curve,this.curveAbi,this.executor);
  if(await ownCurve.creatorFees()>0n||await ownCurve.protocolFees()>0n)await(await ownCurve.withdrawFees()).wait();
  const graduated=await ownCurve.pool()!==ZeroAddress;
  if(graduated&&this.dex){const locker=new Contract(await ownCurve.locker(),this.dex.lockerAbi,this.executor);await(await locker.collectFees()).wait();const splitter=new Contract(await ownCurve.feeSplitter(),this.dex.splitterAbi,this.executor);for(const asset of [record.address,record.pair==='native'?this.dex.v3.weth.target:(record.quoteAddress||this.quote.target)])await(await splitter.claim(asset,v.target)).wait();if(record.pair==='native'){const wrapped=await this.dex.v3.weth.balanceOf(v.target);if(wrapped>0n)await(await v.unwrapFees(wrapped)).wait();}}
  for(const asset of [source,record.address])if(await v.balance(asset)>await v.accounted(asset))await(await v.sync(asset)).wait();
  if(!r.policy.recipients.length&&graduated&&this.dex){const tokenFees=await v.strategyBalance(record.address);if(tokenFees>0n){const out=await this.dexQuote(record.address,source,tokenFees);if(out>0n)await(await v.convertDex(record.address,source,tokenFees,out*9950n/10000n||1n)).wait();}}

  if(r.policy.recipients.length){r.status='Allocated · identity fees stay locked until verified';return;}
  const amount=await v.strategyBalance(source),threshold=parseUnits(r.policy.threshold,d);
  if(amount<threshold){r.status='Accumulating fees toward threshold';return;}
  const snapshot=await this.provider.getBlockNumber();const {balances,excluded}=await this.holders(record,snapshot);
  if(!holderDistribution(amount,balances,parseUnits(r.policy.minimumHolding,18),excluded).length){r.status='Waiting for eligible holders';return;}
  let asset=source,budget=amount;
  if((r.policy.mode==='paired'&&r.policy.rewardToken!==source.toLowerCase())||r.policy.mode==='buyback'){
   asset=r.policy.mode==='buyback'?record.address:r.policy.rewardToken;
   const target=this.tokens.find(t=>t.address===asset);let route,out;
   if(asset.toLowerCase()===this.stock.target.toLowerCase()){route=this.stock.target;out=amount*10n**12n/120n;}
   else {if(!target)throw new Error('Reward market missing.');const curve=new Contract(target.curve,this.curveAbi,this.provider);if(await curve.pool()!==ZeroAddress&&this.dex){route='dex';out=await this.dexQuote(source,asset,amount);}else if(await curve.complete()){r.status='Conversion paused · migrate the completed reward market first';return;}else{route=target.curve;[out]=await curve.quoteBuy(amount);}}
   if(out===0n){r.status='Waiting for a larger conversion amount';return;}
   await(await (route==='dex'?v.convertDex(source,asset,amount,out*9950n/10000n||1n):v.convert(source,asset,route,amount,out*9950n/10000n||1n))).wait();budget=await v.strategyBalance(asset);
  }
  const allocations=holderDistribution(budget,balances,parseUnits(r.policy.minimumHolding,18),excluded);
  for(let i=0;i<allocations.length;i+=64){const batch=allocations.slice(i,i+64);await(await v.distribute(asset,batch.map(h=>h.address),batch.map(h=>h.amount),r.policy.mode==='buyback'?r.policy.vestingDays*86400:0,snapshot)).wait();}
  r.epochs++;r.status=r.policy.mode==='buyback'?'Buyback distributed into linear vesting':'Holder distribution completed';
  r.events.unshift({snapshot,asset,budget:budget.toString(),holders:allocations.length,mode:r.policy.mode,at:Date.now()});r.events.splice(50);
 }
 async dexQuote(input,output,amount){const wrapped=this.dex.v3.weth.target;const result=await this.dex.v3.quoter.quoteExactInputSingle.staticCall({tokenIn:input===ZeroAddress?wrapped:input,tokenOut:output===ZeroAddress?wrapped:output,amountIn:amount,fee:10000,sqrtPriceLimitX96:0});return result[0];}
 async tick(){for(const record of this.tokens){if(!this.records.has(record.address))continue;try{await this.process(record);}catch(error){this.records.get(record.address).status='Waiting · '+(error.shortMessage??error.message);}}}
 async dashboard(){
  const rows=[];
  for(const t of this.tokens){const r=this.records.get(t.address);if(!r)continue;const source=t.pair==='native'?ZeroAddress:(t.quoteAddress||this.quote.target),assets=[source,t.address,...r.events.map(e=>e.asset)];
   const balances=await Promise.all([...new Set(assets)].map(async asset=>{const decimals=asset===ZeroAddress?18:asset.toLowerCase()===this.quote.target.toLowerCase()?6:18;return {asset,symbol:asset===ZeroAddress?'ETH':asset.toLowerCase()===this.quote.target.toLowerCase()?'USDC':asset.toLowerCase()===this.stock.target.toLowerCase()?'TEST-STOCK':this.tokens.find(x=>x.address===asset)?.symbol??'Token',decimals,held:formatUnits(await r.vault.balance(asset),decimals),strategy:formatUnits(await r.vault.strategyBalance(asset),decimals)};}));
   const recipients=await Promise.all(r.policy.recipients.map(async(recipient,index)=>{const identity=id(recipient.kind+':'+recipient.target);const verified=recipient.kind==='wallet'?recipient.target:await r.vault.verifiedWallet(identity);return {...recipient,index,verified:verified!==ZeroAddress?verified:null,balances:await Promise.all(balances.map(async a=>({...a,claimable:formatUnits(recipient.kind==='wallet'?await r.vault.claimable(recipient.target,a.asset):await r.vault.identityBalance(identity,a.asset),a.decimals)})))};}));
   const grants=[];for(let i=0;i<Number(await r.vault.grantCount());i++){const g=await r.vault.grants(i);grants.push({index:i,asset:g.asset,recipient:g.recipient,total:formatUnits(g.total,18),claimed:formatUnits(g.claimed,18),start:Number(g.start),duration:Number(g.duration)});}
   rows.push({token:t.address,symbol:t.symbol,vault:r.vault.target,policy:r.policy,status:r.status,epochs:r.epochs,events:r.events,balances,recipients,grants});
  }return {localOnly:true,xVerificationConfigured:this.xVerification.enabled,assets:this.assets(),rows};
 }
 record(token){const record=this.records.get(String(token).toLowerCase());if(!record)throw new Error('Reward treasury not found.');return record;}
 async challenge({token,index,wallet}){
  const record=this.record(token),recipient=record.policy.recipients[Number(index)];
  if(!recipient||recipient.kind==='wallet')throw new Error('Select an identity allocation.');
  if(!/^0x[0-9a-fA-F]{40}$/.test(wallet)||wallet===ZeroAddress)throw new Error('Connect a valid claim wallet.');
  if(recipient.kind==='x'&&!this.xVerification.enabled)throw new Error('X OAuth verification is not configured. These fees remain in escrow.');
  const nonce=randomBytes(24).toString('hex'),expires=Date.now()+600000,txt=`elpida-claim=${nonce};wallet=${wallet.toLowerCase()};vault=${record.vault.target.toLowerCase()}`;
  const message=`Elpida ${recipient.kind} reward claim\nChain: 31337\nVault: ${record.vault.target}\nIdentity: ${recipient.target}\nWallet: ${wallet.toLowerCase()}\nNonce: ${nonce}\nExpires: ${expires}`;
  this.challenges.set(nonce,{token:token.toLowerCase(),index:Number(index),wallet:wallet.toLowerCase(),expires,txt,message});return {nonce,expires,message,name:`_elpida.${recipient.target}`,txt};
 }
 async startX({nonce,signature}){const c=this.challenges.get(nonce);if(!c||c.expires<Date.now())throw new Error('Verification challenge expired.');const r=this.record(c.token),recipient=r.policy.recipients[c.index];if(recipient.kind!=='x'||verifyMessage(c.message,signature).toLowerCase()!==c.wallet)throw new Error('A matching payout wallet signature is required.');const result=this.xVerification.begin({...c,target:recipient.target});this.challenges.delete(nonce);return result;}
 async finishX(params){const c=await this.xVerification.complete(params),r=this.record(c.token);await(await r.vault.connect(this.verifier).bindIdentity(id('x:'+c.target),c.wallet)).wait();r.policy.recipients[c.index].xUserId=c.xUserId;return {message:'X ownership verified and payout wallet bound.'};}
 async verify({nonce,signature}){
  const c=this.challenges.get(nonce);if(!c||c.expires<Date.now())throw new Error('Verification challenge expired.');
  if(verifyMessage(c.message,signature).toLowerCase()!==c.wallet)throw new Error('The claim wallet signature does not match.');
  const r=this.record(c.token),recipient=r.policy.recipients[c.index];
  if(recipient.kind!=='domain')throw new Error('Use X authentication for social profile verification.');
  const records=await this.dnsResolver(`_elpida.${recipient.target}`);if(!records.some(row=>row.join('')===c.txt))throw new Error('The required DNS TXT record is not visible yet.');
  await(await r.vault.connect(this.verifier).bindIdentity(id(recipient.kind+':'+recipient.target),c.wallet)).wait();this.challenges.delete(nonce);return {message:'Domain ownership verified. Rewards are bound to your signed wallet.'};
 }
 async claim({token,index,asset,grant}){
  const r=this.record(token);if(grant!==undefined)await(await r.vault.claimVested(Number(grant))).wait();
  else {const row=r.policy.recipients[Number(index)];if(!row)throw new Error('Recipient not found.');await(await(row.kind==='wallet'?r.vault.claim(row.target,asset):r.vault.claimIdentity(id(row.kind+':'+row.target),asset))).wait();}
  return {message:'Rewards paid to the configured recipient.'};
 }
}
