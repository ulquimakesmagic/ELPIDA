export const REWARD_MODES = ['creator','holders','paired','buyback','exclusive'];
export function normalizeRewardPolicy(input = {}, chain = 'local') {
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { throw new Error('Invalid reward configuration.'); } }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid reward configuration.');
  const mode = input.mode ?? 'creator';
  if (!REWARD_MODES.includes(mode)) throw new Error('Choose a creator reward strategy.');
  const decimal = (value, fallback, positive = false) => {
    const s = String(value ?? fallback);
    if (!/^\d{1,18}(\.\d{1,6})?$/.test(s) || (positive && Number(s) <= 0)) throw new Error('Reward amounts must be positive numbers with at most six decimal places.');
    return s;
  };
  const threshold = decimal(input.threshold,'1',true), minimumHolding = decimal(input.minimumHolding,'1000');
  const minimumHoldingUsd = decimal(input.minimumHoldingUsd,'0');
  if (Number(minimumHoldingUsd) > 100000) throw new Error('The USD minimum cannot exceed $100,000.');
  const vestingDays = Number(input.vestingDays ?? 30);
  if (!Number.isInteger(vestingDays) || vestingDays < 1 || vestingDays > 3650) throw new Error('Vesting must be between 1 and 3,650 days.');
  const rewardToken = String(input.rewardToken ?? '').toLowerCase();
  if (mode === 'paired' && !/^0x[0-9a-f]{40}$/.test(rewardToken)) throw new Error('Choose an approved reward token on this chain.');
  const recipients = mode === 'creator' || mode === 'exclusive' ? (input.recipients ?? [{kind:'wallet',target:'',percent:100}]) : [];
  if (!Array.isArray(recipients) || recipients.length > 12 || ((mode === 'creator' || mode === 'exclusive') && !recipients.length)) throw new Error('Add between one and twelve recipients.');
  const seen = new Set();
  const normalized = recipients.map(row => {
    const kind = String(row.kind ?? 'wallet');
    let target = String(row.target ?? '').trim();
    if (!['wallet','x','domain'].includes(kind)) throw new Error('Supported recipients are wallets, X accounts and website domains.');
    if (kind === 'wallet' && target && !(chain.startsWith('solana') ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(target) : /^0x[0-9a-fA-F]{40}$/.test(target)) ) throw new Error('Enter a wallet address for the selected chain.');
    if (kind === 'wallet' && /^0x0{40}$/i.test(target)) throw new Error('The zero wallet cannot receive rewards.');
    if (kind === 'x') { target = target.replace(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i,'').replace(/^@/,'').replace(/\/$/,'').toLowerCase(); if (!/^[a-z0-9_]{1,15}$/.test(target)) throw new Error('Enter a valid X handle.'); }
    if (kind === 'domain') { target = target.replace(/^https:\/\//i,'').replace(/\/$/,'').toLowerCase(); if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(target)) throw new Error('Enter a website domain, such as community.org.'); }
    const percent = row.percent ?? Number(row.bps)/100;
    const bps = Math.round(Number(percent) * 100);
    if (!Number.isFinite(Number(percent)) || Math.abs(Number(percent)*100-bps)>0.000001 || bps <= 0 || bps > 10000) throw new Error('Each allocation must be greater than zero, with at most two decimal places.');
    const key = kind+':'+target.toLowerCase(); if (seen.has(key)) throw new Error('Each recipient can appear only once.'); seen.add(key);
    return {kind,target,bps};
  });
  if (normalized.length && normalized.reduce((n,r)=>n+r.bps,0) !== 10000) throw new Error('Creator reward allocations must total exactly 100%.');
  return {version:1,mode,threshold,minimumHolding,minimumHoldingUsd,vestingDays,rewardToken,recipients:normalized};
}
// Largest-remainder allocation conserves every base unit, with stable address tie breaking.
export function holderDistribution(budget, holdings, minimum, excluded = []) {
  const deny = new Set(excluded.map(a=>a.toLowerCase()));
  const combined = new Map();
  for (const h of holdings) { const address=h.address.toLowerCase(), balance=BigInt(h.balance); if(balance<0n)throw new Error('Negative holder balance.'); combined.set(address,(combined.get(address)??0n)+balance); }
  const rows = [...combined].filter(([address,balance])=>balance>0n&&balance>=minimum&&!deny.has(address)).map(([address,balance])=>({address,balance}));
  const total = rows.reduce((n,r)=>n+r.balance,0n);
  if (budget<0n)throw new Error('Negative reward budget.');
  if (!total) return [];
  for(const row of rows){row.amount=budget*row.balance/total;row.remainder=budget*row.balance%total;}
  let dust=budget-rows.reduce((n,r)=>n+r.amount,0n);
  rows.sort((a,b)=>a.remainder===b.remainder?a.address.localeCompare(b.address):a.remainder>b.remainder?-1:1);
  for(let i=0;dust>0n;i++,dust--)rows[i].amount++;
  return rows.filter(r=>r.amount>0n).map(({address,amount})=>({address,amount}));
}

/** A normalized recipient's share in basis points (normalizeRewardPolicy returns `bps`; drafts carry `percent`). */
export const recipientBps = r => (r.bps != null ? Number(r.bps) : Math.round(Number(r.percent) * 100));
