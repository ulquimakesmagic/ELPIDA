// Public testnet RPCs limit how fast one visitor may call them (Base Sepolia: "25/second request limit reached",
// code -32007). Loading a wallet's view of a network makes dozens of reads at once, so a few were refused and one
// refusal failed the whole read: the trade panel then said the wallet "could not read this network" (ITACHI, 24 Oct).
// This provider starts at most `perSecond` requests a second and retries a refused one with backoff. Reads only:
// transactions are signed and sent by the wallet, not through here.
import { JsonRpcProvider } from '/vendor/ethers.js';

const LIMITED = new Set([-32005, -32007, -32029, -32090, 429]);
/** A rate-limit refusal, as public RPCs report it in a JSON-RPC error (HTTP 200) or as HTTP 429. */
export const isRateLimited = error => LIMITED.has(Number(error?.code)) || /rate limit|request limit|too many requests/i.test(String(error?.message ?? ''));

// Only replay read-only simulations that failed without revert bytes. Never broadcast or guess gas.
export async function recoverEmptySimulation(payload, original, {urls=[],chainId,request=rpcRead,now=()=>Math.floor(Date.now()/1000)}={}) {
  const e=original?.error;
  if(!['eth_call','eth_estimateGas'].includes(payload?.method)||Number(e?.code)!==3||(e.data!=null&&e.data!=='0x'))return original;
  for(const url of urls.slice(0,3))try{
    if(!/^https:\/\//.test(url))continue;
    const chain=await request(url,{jsonrpc:'2.0',id:payload.id,method:'eth_chainId',params:[]});
    if(chain.error||BigInt(chain.result)!==BigInt(chainId))continue;
    const head=await request(url,{jsonrpc:'2.0',id:payload.id,method:'eth_getBlockByNumber',params:['latest',false]});
    const timestamp=Number(BigInt(head.result?.timestamp??0)),age=now()-timestamp;
    if(head.error||age < -30||age>120)continue;
    // Some public nodes silently cap simulations below graduation's pool/NFT creation cost.
    // Use the verified head's block gas limit as a simulation ceiling, never as a transaction gas guess.
    const ceiling=head.result?.gasLimit;
    if(!/^0x[0-9a-f]+$/i.test(ceiling??'')||BigInt(ceiling)<=0n)continue;
    const simulation={...payload,params:[{...payload.params[0],gas:payload.params[0].gas??ceiling},...payload.params.slice(1)]};
    const response=await request(url,simulation);
    if(response.id!==payload.id)continue;
    if(!response.error&&typeof response.result==='string'&&/^0x[0-9a-f]*$/i.test(response.result)){
      if(payload.method==='eth_estimateGas'&&(!/^0x[0-9a-f]+$/i.test(response.result)||BigInt(response.result)<=0n||BigInt(response.result)>BigInt(ceiling)))continue;
      return response;
    }
    // A useful revert is evidence, not a reason to try to force the transaction through.
    if(response.error?.data&&response.error.data!=='0x')return response;
  }catch{/* Wrong-chain, stale, malformed or unavailable endpoints cannot provide a fallback. */}
  return original;
}
async function rpcRead(url,payload){
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(['eth_call','eth_estimateGas'].includes(payload.method)?15000:5000)});
  if(!response.ok)throw new Error('Simulation RPC unavailable.');
  return response.json();
}

export class PacedJsonRpcProvider extends JsonRpcProvider {
  constructor(request, network, options = {}, { perSecond = 12, retries = 4, backoffMs = 400, fallbacks = [], sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    super(request, network, options);
    this.simulationFallback={urls:fallbacks,chainId:network?.chainId??network};
    this.pace = { gap: 1000 / perSecond, next: 0, retries, backoffMs, sleep };
  }
  async #slot() {
    const now = Date.now(), at = Math.max(now, this.pace.next);
    this.pace.next = at + this.pace.gap;
    if (at > now) await this.pace.sleep(at - now);
  }
  async _send(payload) {
    for (let attempt = 0; ; attempt++) {
      await this.#slot();
      let results;
      try { results = await super._send(payload); }
      catch (error) {
        if (attempt < this.pace.retries && (isRateLimited(error) || Number(error?.response?.statusCode) === 429)) { await this.pace.sleep(this.pace.backoffMs * 2 ** attempt); continue; }
        throw error;
      }
      if (attempt < this.pace.retries && results.some(r => r?.error && isRateLimited(r.error))) { await this.pace.sleep(this.pace.backoffMs * 2 ** attempt); continue; }
      const requests=Array.isArray(payload)?payload:[payload];
      return Promise.all(results.map(result=>{const original=requests.find(p=>p.id===result.id);return recoverEmptySimulation(original,result,this.simulationFallback);}));
    }
  }
}
