export function filterTrades(rows,side='all'){
 if(!['all','buy','sell'].includes(side))throw new Error('Choose All, Buys or Sells.');
 return side==='all'?rows:rows.filter(row=>row.side===side);
}
