// Feed addresses are a trusted deployment configuration, never user-entered browser prices.
// Confirm network, asset, heartbeat and proxy ownership before configuring additional feeds.
const address=/^0x[a-fA-F0-9]{40}$/;
export function usdOracles(env=process.env){
  const defaults={'base-sepolia':{feed:'0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',maxAge:1500,usdc:'0x036CbD53842c5426634e7929541eC2318f3dCF7e'},'bnb-testnet':{feed:'0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526',maxAge:3900},'ethereum-sepolia':{feed:'0x694AA1769357215DE4FAC081bf1f309aDC325306',maxAge:3900,usdc:'0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'}};
  return Object.fromEntries(['base-sepolia','ethereum-sepolia','bnb-testnet','robinhood-testnet'].map(key=>{
    const prefix='ELPIDA_'+key.replaceAll('-','_').toUpperCase(),d=defaults[key]??{};
    const feed=env[prefix+'_USD_FEED']??d.feed,usdc=env[prefix+'_USDC']??d.usdc;
    const maxAge=Number(env[prefix+'_USD_MAX_AGE']??d.maxAge??3600);
    return [key,{feed:address.test(feed??'')?feed:null,usdc:address.test(usdc??'')?usdc:null,maxAge:Number.isInteger(maxAge)&&maxAge>0&&maxAge<=86400?maxAge:3600,available:address.test(feed??''),source:'Chainlink-compatible on-chain feed'}];
  }));
}
