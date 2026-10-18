import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {Contract, Wallet, Transaction, keccak256, parseEther, ZeroAddress} from 'ethers';

const abi=['function factory() view returns(address)','function token() view returns(address)','function complete() view returns(bool)','function pool() view returns(address)','function graduate() returns(address)'];
const factoryAbi=['function MODEL_VERSION() view returns(uint256)','function isElpidaToken(address) view returns(bool)'];
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();

// One funded, testnet-only signer. Persist the signed transaction BEFORE broadcasting:
// retries (including process restarts) rebroadcast exactly the same nonce and bytes.
export class GraduationKeeper {
 constructor({provider,signer,candidates,path,chainId=84532,factory,maxCost=parseEther('0.001'),dailyBudget=parseEther('0.01'),now=Date.now,contract=(address,abi,runner)=>new Contract(address,abi,runner),log=console.log}){
  if(chainId!==84532||!path||!factory||maxCost<=0n||dailyBudget<maxCost)throw new Error('Invalid testnet graduation configuration');
  Object.assign(this,{provider,signer,candidates,chainId,factory,maxCost,dailyBudget,now,contract,log});
  this.state={enabled:true,state:'starting',chainId,factory};
  this.db=new DatabaseSync(path);
  this.db.exec(`PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS graduation_tx(hash TEXT PRIMARY KEY,raw TEXT NOT NULL,curve TEXT NOT NULL,created INTEGER NOT NULL,cost TEXT NOT NULL,status TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS graduation_retry(curve TEXT PRIMARY KEY,after INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS graduation_lock(id INTEGER PRIMARY KEY,owner TEXT,expires INTEGER);
   INSERT OR IGNORE INTO graduation_lock VALUES(1,'',0);`);
  this.owner=crypto.randomUUID();
 }
 status(){return {...this.state};}
 start(){this.tick();this.timer=setInterval(()=>this.tick(),15000);this.timer.unref();return this;}
 async tick(){
  if(this.running||this.stopping)return;
  // A shared journal also prevents overlapping workers from allocating different nonces.
  const lease=this.db.prepare('UPDATE graduation_lock SET owner=?,expires=? WHERE id=1 AND expires<?').run(this.owner,this.now()+300000,this.now());
  if(!lease.changes)return;
  this.running=true;
  try{
   if(Number((await this.provider.getNetwork()).chainId)!==this.chainId)throw new Error('chain_mismatch');
   const factory=this.contract(this.factory,factoryAbi,this.provider);
   if(await factory.MODEL_VERSION()!==10n)throw new Error('factory_mismatch');
   const address=await this.signer.getAddress();this.state.address=address;
   const pending=this.db.prepare("SELECT * FROM graduation_tx WHERE status='pending' ORDER BY created LIMIT 1").get();
   if(pending){delete this.state.reason;await this.reconcile(pending);return;}
   const rows=await this.candidates();
   this.state.checkedAt=new Date(this.now()).toISOString();
   if(!rows.some(row=>row.complete&&!row.graduated&&same(row.factory,this.factory))){
    this.state={...this.state,state:'watching'};delete this.state.reason;
   }
   for(const row of rows){
    if(!row.complete||row.graduated||!same(row.factory,this.factory))continue;
    const retry=this.db.prepare('SELECT after FROM graduation_retry WHERE curve=?').get(row.curve);
    if(retry?.after>this.now())continue;
    delete this.state.reason;this.state.state='checking';
    this.state.curve=row.curve;
    try{
     const curve=this.contract(row.curve,abi,this.signer);
     if(!same(await curve.factory(),this.factory)||!same(await curve.token(),row.address)||!await factory.isElpidaToken(row.address))throw new Error('origin_mismatch');
     if(!await curve.complete()||await curve.pool()!==ZeroAddress)continue;
     const gas=(await curve.graduate.estimateGas())*120n/100n;
     if(gas>15000000n)throw new Error('gas_limit');
     const fees=await this.provider.getFeeData(),price=fees.maxFeePerGas??fees.gasPrice;
     if(!price||price<=0n)throw new Error('gas_unavailable');
     const cost=gas*price;
     if(cost>this.maxCost)throw new Error('cost_limit');
     const spent=this.db.prepare('SELECT cost FROM graduation_tx WHERE created>?').all(this.now()-86400000).reduce((n,r)=>n+BigInt(r.cost),0n);
     if(spent+cost>this.dailyBudget)throw new Error('daily_budget');
     if(await this.provider.getBalance(address)<cost)throw new Error('needs_gas');
     // Never allocate a nonce when this dedicated wallet has an unknown pending tx.
     if(await this.provider.getTransactionCount(address,'pending')!==await this.provider.getTransactionCount(address,'latest'))throw new Error('signer_busy');
     const tx=await this.signer.populateTransaction({...await curve.graduate.populateTransaction(),gasLimit:gas,
      ...(fees.maxFeePerGas?{maxFeePerGas:price,maxPriorityFeePerGas:fees.maxPriorityFeePerGas??0n}:{gasPrice:price})});
     if(Number(tx.chainId)!==this.chainId||!same(tx.to,row.curve)||BigInt(tx.value??0)!==0n)throw new Error('transaction_mismatch');
     const raw=await this.signer.signTransaction(tx),hash=keccak256(raw);
     this.db.exec('BEGIN IMMEDIATE');
     try{
      const lock=this.db.prepare('SELECT owner,expires FROM graduation_lock WHERE id=1').get();
      if(lock.owner!==this.owner||lock.expires<=this.now())throw new Error('lease_expired');
      this.db.prepare("INSERT INTO graduation_tx VALUES(?,?,?,?,?,'pending')").run(hash,raw,row.curve,this.now(),String(cost));
      this.db.exec('COMMIT');
     }catch(error){this.db.exec('ROLLBACK');throw error;}
     await this.reconcile({hash,raw,curve:row.curve});return;
    }catch(error){
     this.db.prepare('INSERT OR REPLACE INTO graduation_retry VALUES(?,?)').run(row.curve,this.now()+60000);
     this.state={...this.state,state:'retrying',reason:safeReason(error),checkedAt:new Date(this.now()).toISOString()};
     this.log(JSON.stringify({event:'graduation_retry',curve:row.curve,reason:this.state.reason}));
    }
   }
  }catch(error){this.state={...this.state,state:'retrying',reason:safeReason(error)};}
  finally{this.db.prepare('UPDATE graduation_lock SET expires=0 WHERE id=1 AND owner=?').run(this.owner);this.running=false;}
 }
 async reconcile(row){
  const tx=Transaction.from(row.raw);
  if(Number(tx.chainId)!==this.chainId||!same(tx.from,await this.signer.getAddress())||!same(tx.to,row.curve)||tx.value!==0n||tx.data!==new Contract(row.curve,abi).interface.encodeFunctionData('graduate')||keccak256(row.raw)!==row.hash)throw new Error('journal_mismatch');
  const receipt=await this.provider.getTransactionReceipt(row.hash);
  if(receipt){
   // Do not finalize a receipt until two confirmations; recheck its canonical block.
   if((await this.provider.getBlock(receipt.blockNumber))?.hash!==receipt.blockHash||await this.provider.getBlockNumber()<receipt.blockNumber+1)return;
   this.db.prepare('UPDATE graduation_tx SET status=? WHERE hash=?').run(receipt.status===1?'confirmed':'failed',row.hash);
   if(receipt.status!==1)this.db.prepare('INSERT OR REPLACE INTO graduation_retry VALUES(?,?)').run(row.curve,this.now()+60000);
   this.state={...this.state,state:receipt.status===1?'graduated':'retrying',curve:row.curve,transaction:row.hash};return;
  }
  this.state={...this.state,state:'submitted',curve:row.curve,transaction:row.hash};
  if(row.created&&this.now()-row.created>300000)this.state.reason='transaction_delayed';
  // If the nonce was consumed by another transaction, stop for operator review.
  if(await this.provider.getTransactionCount(tx.from,'latest')>tx.nonce)throw new Error('nonce_conflict');
  try{await this.provider.broadcastTransaction(row.raw);}catch{this.state.reason='broadcast_pending';}
 }
 async close(){this.stopping=true;clearInterval(this.timer);while(this.running)await new Promise(r=>setTimeout(r,25));this.db.close();}
}
function safeReason(error){return ['chain_mismatch','factory_mismatch','origin_mismatch','gas_limit','gas_unavailable','cost_limit','daily_budget','needs_gas','signer_busy','transaction_mismatch','journal_mismatch','nonce_conflict'].includes(error.message)?error.message:'rpc_or_simulation_failed';}

export function configuredGraduationKeeper({env,publicIndex,path}){
 if(!env.ELPIDA_GRADUATION_KEY_FILE)return {status:()=>({enabled:false,state:'not_configured',factory:publicIndex?.entries.get('base-sepolia')?.net.shared?.factory??null}),close:async()=>{}};
 if(env.RAILWAY_ENVIRONMENT_ID&&!env.RAILWAY_VOLUME_MOUNT_PATH)throw new Error('Graduation requires a persistent Railway volume');
 const entry=publicIndex.entries.get('base-sepolia');
 if(!entry||!path)throw new Error('Graduation requires a persistent Base Sepolia index');
 let signer;
 try{signer=new Wallet(readFileSync(env.ELPIDA_GRADUATION_KEY_FILE,'utf8').trim(),entry.provider);}
 catch{throw new Error('Graduation signer secret file is unavailable or invalid');}
 return new GraduationKeeper({provider:entry.provider,signer,path,factory:entry.net.shared.factory,
  maxCost:parseEther(env.ELPIDA_GRADUATION_MAX_COST_ETH??'0.001'),dailyBudget:parseEther(env.ELPIDA_GRADUATION_DAILY_BUDGET_ETH??'0.01'),
  candidates:()=>{if(!entry.validated||entry.error||!(Date.now()-Date.parse(entry.lastSuccess)<180000))throw new Error('index_unavailable');return publicIndex.listings('base-sepolia');}}).start();
}
