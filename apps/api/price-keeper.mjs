// Display prices never authorize a payment. EVM factories independently validate their USD oracle.
import { Interface } from 'ethers';
import { evmTestnets } from '../../packages/core/networks.mjs';
import { usdOracles } from '../../packages/core/usd-oracles.mjs';
const oracleAbi=new Interface(['function decimals() view returns(uint8)','function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
export const PRICE_MAX_AGE = 180;
export const CHAIN_ASSET = Object.freeze({local:'ETH','base-sepolia':'ETH','ethereum-sepolia':'ETH','bnb-testnet':'BNB','robinhood-testnet':'ETH','solana-devnet':'SOL','solana-localnet':'SOL','solana-mainnet':'SOL'});
export function validatePrice(value, now = Date.now()/1000) {
  const usd=Number(value?.usd), updatedAt=Number(value?.updatedAt);
  if(!Number.isFinite(usd)||usd<=0||!Number.isSafeInteger(updatedAt)||updatedAt<=0||updatedAt>now+5||now-updatedAt>(value.maxAge??PRICE_MAX_AGE))throw new Error('Price is unavailable or stale.');
  return {...value,usd,updatedAt};
}
export class PriceKeeper {
  constructor({fetcher=fetch,now=()=>Date.now()/1000,pythApiKey=process.env.PYTH_API_KEY,oracles=usdOracles()}={}){this.fetcher=fetcher;this.now=now;this.pythApiKey=pythApiKey;this.oracles=oracles;this.values={};this.chainValues={};this.ids={};this.lastAttempt=-Infinity;}
  async json(url){const headers=url.startsWith('https://pyth.dourolabs.app/')?{Authorization:'Bearer '+this.pythApiKey}:undefined;const r=await this.fetcher(url,{headers,signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error('Price source unavailable');return r.json();}
  async readOracle(net){
    const oracle=this.oracles[net.key];if(!oracle?.available)return;
    const r=await this.fetcher(net.rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(['latestRoundData','decimals'].map((name,i)=>({id:i,jsonrpc:'2.0',method:'eth_call',params:[{to:oracle.feed,data:oracleAbi.encodeFunctionData(name)},'latest']}))),signal:AbortSignal.timeout(8000)});
    if(!r.ok)throw new Error('RPC unavailable');const data=await r.json();
    const round=oracleAbi.decodeFunctionResult('latestRoundData',data.find(x=>x.id===0)?.result),d=Number(oracleAbi.decodeFunctionResult('decimals',data.find(x=>x.id===1)?.result)[0]);
    if(round[0]<=0n||round[1]<=0n||round[4]<round[0]||d>18)throw new Error('Invalid oracle');
    this.chainValues[net.key]=validatePrice({usd:Number(round[1])/10**d,updatedAt:Number(round[3]),source:'On-chain USD oracle',feed:oracle.feed,maxAge:oracle.maxAge,referenceOnly:false},this.now());
  }
  async refresh(){
    if(this.pending)return this.pending;
    if(this.now()-this.lastAttempt<30)return this.snapshot();
    this.lastAttempt=this.now();
    this.pending=(async()=>{
      await Promise.allSettled(['ETH','BNB','SOL'].map(async symbol=>{
        if(!this.pythApiKey)throw new Error('Pyth API key not configured');
        if(!this.ids[symbol]){
          const feeds=await this.json(`https://pyth.dourolabs.app/hermes/v2/price_feeds?query=${symbol}%2FUSD&asset_type=crypto`);
          const feed=feeds.find(f=>f.attributes?.symbol===`Crypto.${symbol}/USD`);
          if(!feed||!/^([a-f0-9]{64}|0x[a-f0-9]{64})$/i.test(feed.id))throw new Error('Feed identity unavailable');this.ids[symbol]=feed.id;
        }
        const data=await this.json(`https://pyth.dourolabs.app/hermes/v2/updates/price/latest?ids[]=${this.ids[symbol]}`);
        const item=data.parsed?.find(p=>p.id.replace(/^0x/,'')===this.ids[symbol].replace(/^0x/,'')),p=item?.price;
        if(!p||!Number.isInteger(p.expo)||p.expo< -18||p.expo>0||!Number.isFinite(Number(p.conf))||p.conf==null||Number(p.conf)<0||Number(p.conf)/Number(p.price)>.02)throw new Error('Uncertain price');
        this.values[symbol]=validatePrice({usd:Number(p.price)*10**p.expo,updatedAt:p.publish_time,source:'Pyth Hermes',symbol},this.now());
      }));
      // Independent fallback; retain the upstream timestamp, never fabricate freshness.
      const missing=['ETH','BNB','SOL'].filter(s=>{try{validatePrice(this.values[s],this.now());return false;}catch{return true;}});
      if(missing.length){try{
        const names={ETH:'ethereum',BNB:'binancecoin',SOL:'solana'};
        const data=await this.json(`https://api.coingecko.com/api/v3/simple/price?ids=${missing.map(s=>names[s]).join(',')}&vs_currencies=usd&include_last_updated_at=true`);
        for(const s of missing){try{this.values[s]=validatePrice({symbol:s,usd:data[names[s]]?.usd,updatedAt:data[names[s]]?.last_updated_at,source:'CoinGecko'},this.now());}catch{}}
      }catch{}}
      await Promise.allSettled(evmTestnets.map(net=>this.readOracle(net)));
      return this.snapshot();
    })();
    try{return await this.pending;}finally{this.pending=null;}
  }
  snapshot(){
    return Object.fromEntries(Object.entries(CHAIN_ASSET).map(([chain,symbol])=>{
      const value=this.chainValues[chain]??this.values[symbol];let fresh=false;try{validatePrice(value,this.now());fresh=true;}catch{}
      return [chain,{symbol,maxAge:PRICE_MAX_AGE,referenceOnly:true,...value,status:fresh?'fresh':value?'stale':'unavailable'}];
    }));
  }
}
