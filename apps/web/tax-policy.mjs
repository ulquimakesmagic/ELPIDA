export function percentBps(value,max=10){
 const text=String(value??'0').trim();
 if(!/^\d+(?:\.\d{1,2})?$/.test(text))throw new Error('Use a percentage with at most two decimal places.');
 const [whole,frac='']=text.split('.'),bps=Number(whole)*100+Number(frac.padEnd(2,'0'));
 if(!Number.isSafeInteger(bps)||bps>max*100)throw new Error(`Tax cannot exceed ${max}%.`);
 return bps;
}
export function taxPolicy({buy='0',sell='0',recipients=[],owner}={}){
 const buyBps=percentBps(buy),sellBps=percentBps(sell);
 if(!buyBps&&!sellBps)return null;
 if(!recipients.length||recipients.length>8)throw new Error('Choose one to eight creator wallets.');
 const addresses=[],shares=[];
 for(const row of recipients){
  const address=String(row.target||owner||'').trim().toLowerCase();
  if(row.kind!=='wallet'||!/^0x[0-9a-f]{40}$/.test(address)||/^0x0{40}$/.test(address)||addresses.includes(address))throw new Error('Tax allocations require distinct EVM wallet addresses.');
  const share=percentBps(row.percent,100);if(!share)throw new Error('Each allocation must be positive.');
  addresses.push(address);shares.push(share);
 }
 if(shares.reduce((a,b)=>a+b,0)!==10000)throw new Error('Creator allocations must total 100%.');
 return {buyBps,sellBps,recipients:addresses,shares};
}
