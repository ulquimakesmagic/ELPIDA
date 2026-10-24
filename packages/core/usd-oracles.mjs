// Feed addresses are a trusted deployment configuration, never user-entered browser prices.
// Confirm network, asset, heartbeat and proxy ownership before configuring additional feeds.
import { testnets } from './networks.mjs';
const address=/^0x[a-fA-F0-9]{40}$/;
// A test chain without Chainlink uses its registered ElpidaRelayFeed (networks.mjs `relay`), labelled as relayed.
const relayed=Object.fromEntries(testnets.filter(n=>n.relay?.feed).map(n=>[n.key,{feed:n.relay.feed,maxAge:n.relay.maxAge,source:`Chainlink ETH / USD relayed from ${n.relay.source.network} (testnet relay)`}]));
export function usdOracles(env=process.env){
  const defaults={'base-sepolia':{feed:'0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',maxAge:1500,usdc:'0x036CbD53842c5426634e7929541eC2318f3dCF7e'},'bnb-testnet':{feed:'0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526',maxAge:3900},'ethereum-sepolia':{feed:'0x694AA1769357215DE4FAC081bf1f309aDC325306',maxAge:3900,usdc:'0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'}};
  return Object.fromEntries(['base-sepolia','ethereum-sepolia','bnb-testnet','robinhood-testnet'].map(key=>{
    const prefix='ELPIDA_'+key.replaceAll('-','_').toUpperCase(),d=defaults[key]??relayed[key]??{};
    const feed=env[prefix+'_USD_FEED']??d.feed,usdc=env[prefix+'_USDC']??d.usdc;
    const maxAge=Number(env[prefix+'_USD_MAX_AGE']??d.maxAge??3600);
    return [key,{feed:address.test(feed??'')?feed:null,usdc:address.test(usdc??'')?usdc:null,maxAge:Number.isInteger(maxAge)&&maxAge>0&&maxAge<=86400?maxAge:3600,available:address.test(feed??''),source:d.source??'Chainlink-compatible on-chain feed'}];
  }));
}

// Solana: the program verifies a Pyth PriceUpdateV2 account on-chain (owner, full verification, feed id,
// age and confidence) and charges the $10 fee in SOL or USDC. The sponsored SOL/USD account is the
// shard-0 feed PDA, the same address on mainnet and devnet. Starting FDV is in USD with 6 decimals:
// mainnet uses the agreed $5,000; devnet is test sized ($50) so a curve can be completed with faucet SOL.
// Localnet tests load a crafted account at the same address.
export const SOLANA_ORACLES = Object.freeze({
  mainnet: { priceAccount: '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE', feedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', maxAgeSecs: 120, maxConfBps: 200, feeUsdE6: '10000000', startFdvUsdE6: '5000000000', usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  devnet: { priceAccount: '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE', feedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', maxAgeSecs: 300, maxConfBps: 300, feeUsdE6: '10000000', startFdvUsdE6: '50000000', usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
  localnet: { priceAccount: '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE', feedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', maxAgeSecs: 3600, maxConfBps: 300, feeUsdE6: '10000000', startFdvUsdE6: '50000000', usdcMint: null },
});
