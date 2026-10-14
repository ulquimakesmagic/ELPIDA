import {parseUnits,formatUnits} from 'ethers';
const units=v=>parseUnits(typeof v==='number'?v.toFixed(18):String(v??'0'),18);
// Weighted-average cost in the trading-pair asset. Never reconstruct historical USD prices.
export function positionSummary({trades,balance,price,supply,untrackedTransfers=false}){
 let held=0n,cost=0n,realized=0n,unknown=untrackedTransfers;
 for(const t of trades){const n=units(t.tokenAmount),q=units(t.quoteAmount);if(n<=0n||q<0n||t.accountBasis&&String(t.sender).toLowerCase()!==String(t.account).toLowerCase()){unknown=true;continue;}
  if(t.side==='buy'){held+=n;cost+=q;}else if(t.side==='sell'){if(n>held){unknown=true;held=0n;cost=0n;continue;}const removed=held?cost*n/held:0n;held-=n;cost-=removed;realized+=q-removed;}
 }
 const actual=units(balance),spot=units(typeof price==='string'&&/^\d+\.\d+$/.test(price)?price.replace(/(\.\d{18})\d+$/, '$1'):price),total=units(supply);if(actual!==held)unknown=true;
 const value=actual*spot/10n**18n,average=held?cost*10n**18n/held:0n,pnl=value-cost;
 return {balance:String(balance),supplyShare:total?formatUnits(actual*10n**18n/total,18):null,valueQuote:formatUnits(value,18),basisKnown:!unknown&&held>0n,averageEntryPrice:!unknown&&held?formatUnits(average,18):null,entryMarketCapQuote:!unknown&&held?formatUnits(average*total/10n**18n,18):null,costQuote:!unknown&&held?formatUnits(cost,18):null,unrealizedQuote:!unknown&&held?formatUnits(pnl,18):null,unrealizedPercent:!unknown&&cost?formatUnits(pnl*10000n/cost,2):null,realizedQuote:!unknown?formatUnits(realized,18):null,reason:unknown?'Transfers, incomplete history or router execution prevent a reliable cost basis.':held?'Weighted-average indexed execution cost; network gas excluded.':'No open position.'};
}
