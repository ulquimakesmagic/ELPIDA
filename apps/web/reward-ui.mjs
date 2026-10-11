import {normalizeRewardPolicy} from './reward-policy.mjs';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const pretty=value=>Number(value).toLocaleString('en-US',{maximumFractionDigits:6});
const names={creator:'Creator wallets',holders:'Distribute trading fees',paired:'Buy reward token for holders',buyback:'Buy back & vest',exclusive:'Wallet, X & website allocations'};
export function createRewardUI({api,toast,currentMode,refresh}) {
 const root=document.querySelector('#reward-config'),dashboard=document.querySelector('#reward-dashboard');let data={rows:[],assets:[]};
 root.innerHTML=`<h3>04 <span>Creator rewards</span></h3><p>Decide where your creator share goes. The protocol share and locked liquidity stay separate.</p>
 <label>Reward strategy<select id="reward-mode"><option value="creator">Accrue to creator wallets</option><option value="holders">Distribute trading fees to holders</option><option value="paired">Buy another token for holders</option><option value="buyback">Buy back this token & vest to holders</option><option value="exclusive">Allocate to wallets, X profiles or websites</option></select></label>
 <p id="reward-description" class="reward-callout"></p><div id="reward-automation-fields" hidden><div class="launch-row"><label>Distribution threshold<input id="reward-threshold" type="number" min="0.000001" step="any" value="1"><small>Amount in the curve's trading asset, after the creator fee split.</small></label><label>Minimum main-token holding<input id="reward-minimum" type="number" min="0" step="any" value="1000"><small>Liquidity contracts and treasury balances are excluded.</small></label></div></div>
 <label id="reward-asset-field" hidden>Reward token<select id="reward-asset"></select><small>Choose the reward asset separately from your trading pair. A pair-token reward is paid directly when fees already arrive in that token.</small></label>
 <label id="reward-vesting-field" hidden>Linear vesting duration (days)<input id="reward-vesting" type="number" min="1" max="3650" value="30"><small>Bought tokens unlock gradually for the snapshot's eligible holders.</small></label>
 <div id="reward-recipient-fields"><div id="reward-recipients"></div><button type="button" id="reward-add" class="secondary-button">+ Add recipient</button><p id="reward-total" role="status"></p></div>
 <p id="reward-availability" class="metadata-storage-note"></p>`;
 const $=id=>document.getElementById(id);
 function addRecipient(kind='wallet',target='',percent=100){
  const row=el('div',undefined,'reward-recipient');const type=el('select');type.setAttribute('aria-label','Recipient type');for(const [value,label] of [['wallet','Wallet'],['x','X profile'],['domain','Website domain']]){const o=el('option',label);o.value=value;type.append(o);}type.value=kind;
  const dest=el('input');dest.value=target;dest.setAttribute('aria-label','Reward recipient');dest.placeholder='Empty = creator wallet';
  const share=el('input');share.type='number';share.min='0.01';share.max='100';share.step='0.01';share.value=percent;share.setAttribute('aria-label','Allocation percent');
  const remove=el('button','Remove');remove.type='button';remove.className='quiet-link';remove.addEventListener('click',()=>{row.remove();update();});
  type.addEventListener('change',()=>{dest.placeholder=type.value==='x'?'@community':type.value==='domain'?'community.org':'Empty = creator wallet';update();});
  row.append(type,dest,share,remove);$('reward-recipients').append(row);row.addEventListener('input',update);update();
 }
 function update(){
  const mode=$('reward-mode').value,automated=['holders','paired','buyback'].includes(mode);
  $('reward-automation-fields').hidden=!automated;$('reward-asset-field').hidden=mode!=='paired';$('reward-vesting-field').hidden=mode!=='buyback';$('reward-recipient-fields').hidden=automated;
  $('reward-description').textContent={creator:'Creator fees accrue in the treasury. Each configured wallet can receive its allocation.',holders:'When the threshold is reached, eligible holders receive the fees in their original asset. Payouts are weighted by eligible holdings.',paired:'At the threshold, creator fees buy the selected reward token and distribute it to eligible holders of your main token.',buyback:'At the threshold, creator fees buy your main token and create linear vesting allocations for eligible holders.',exclusive:'Fees accumulate for each recipient. Wallet payouts use their configured address; X and website allocations stay in escrow until ownership is verified.'}[mode];
  for(const row of $('reward-recipients').children)row.firstChild.disabled=mode==='creator';
  const sum=[...$('reward-recipients').children].reduce((n,r)=>n+Number(r.children[2].value),0);$('reward-total').textContent=`${sum.toFixed(2)}% allocated · must total 100%`;$('reward-total').className=Math.abs(sum-100)<0.00001?'reward-total':'inline-error';
  $('reward-availability').textContent=$('launch-chain').value==='local'?'Local test: treasury, threshold processing, holder payouts and vesting use real test contracts. TEST-STOCK is a simulated asset.':'Advanced reward strategies are available in the local test environment. Public testnets currently support one creator wallet; shared reward contracts and verification services require deployment.';
  $('reward-add').disabled=$('reward-recipients').children.length>=12;
 }
 function policy(){const chain=$('launch-chain').value;return normalizeRewardPolicy({mode:$('reward-mode').value,threshold:$('reward-threshold').value,minimumHolding:$('reward-minimum').value,vestingDays:$('reward-vesting').value,rewardToken:$('reward-asset').value,recipients:[...$('reward-recipients').children].map(row=>({kind:row.children[0].value,target:row.children[1].value,percent:row.children[2].value}))},chain);}
 async function load(){data=await api('rewards');const previous=$('reward-asset').value;const quotePrevious=$('launch-quote-token').value;$('launch-quote-token').replaceChildren();for(const a of data.assets.filter(a=>a.pairEligible)){const option=el('option',a.symbol);option.value=a.address;$('launch-quote-token').append(option);}if([...$('launch-quote-token').options].some(o=>o.value===quotePrevious))$('launch-quote-token').value=quotePrevious;$('reward-asset').replaceChildren();for(const a of data.assets){const option=el('option',a.symbol);option.value=a.address;$('reward-asset').append(option);}if([...$('reward-asset').options].some(o=>o.value===previous))$('reward-asset').value=previous;render();}
 function button(label,action){const b=el('button',label,'secondary-button');b.type='button';b.addEventListener('click',async()=>{b.disabled=true;try{await action();await load();await refresh();}catch(e){toast(e.reason??e.shortMessage??e.message);}finally{b.disabled=false;}});return b;}
 function render(){
  dashboard.replaceChildren();dashboard.append(el('h2','Reward treasuries'),el('p',currentMode()==='local'?'Local test contracts · allocations are locked at launch · automated processing runs while this server is running.':'Public testnet rewards use the existing fixed creator wallet. Advanced treasuries below belong to the local test environment.','muted'));
  if(currentMode()!=='local')return;
  dashboard.append(button('Process accrued rewards',async()=>toast((await api('reward-process',{})).message)));
  if(!data.rows.length){dashboard.append(el('p','Create a token with a reward strategy to start a treasury.','muted'));return;}
  for(const row of data.rows){
   const card=el('article',undefined,'reward-treasury');card.append(el('h3',`${row.symbol} · ${names[row.policy.mode]}`),el('p',row.status,'reward-callout'),el('p',`Treasury ${row.vault}`,'reward-address'));
   for(const a of row.balances)card.append(el('p',`${pretty(a.held)} ${a.symbol} held · ${pretty(a.strategy)} available for automation`));
   if(!row.recipients.length)card.append(el('p',`Threshold ${row.policy.threshold} · minimum holding ${row.policy.minimumHolding} · ${row.epochs} distribution rounds`,'muted'));
   for(const recipient of row.recipients){const box=el('div',undefined,'reward-beneficiary');box.append(el('strong',`${recipient.bps/100}% → ${recipient.kind==='x'?'@':''}${recipient.target}`),el('p',recipient.verified?`Verified payout wallet: ${recipient.verified}`:'Unverified · fees remain in treasury','muted'));
    if(!recipient.verified&&recipient.kind==='domain')box.append(button('Verify website ownership',async()=>openDomain(row,recipient)));
    if(!recipient.verified&&recipient.kind==='x')box.append(button('Link X account',async()=>openDomain(row,recipient)));
    for(const a of recipient.balances){box.append(el('p',`${pretty(a.claimable)} ${a.symbol} allocated`));if(recipient.verified&&Number(a.claimable)>0)box.append(button(`Claim ${a.symbol}`,async()=>toast((await api('reward-claim',{token:row.token,index:recipient.index,asset:a.asset})).message)));}card.append(box);
   }
   for(const event of row.events.slice(0,5))card.append(el('p',`Snapshot block ${event.snapshot} · ${event.holders} eligible holders · ${event.mode==='buyback'?'vesting created':'paid automatically'}`,'muted'));
   for(const grant of row.grants){card.append(el('p',`Vesting: ${pretty(grant.total)} tokens for ${grant.recipient} · ${pretty(grant.claimed)} claimed · ${Math.round(grant.duration/86400)} days`,'muted'));card.append(button('Claim unlocked tokens',async()=>toast((await api('reward-claim',{token:row.token,grant:grant.index})).message)));}
   dashboard.append(card);
  }
 }
 function openDomain(row,recipient){
  const dialog=$('reward-verify-dialog');$('reward-verify-title').textContent=`Verify ${recipient.kind==='x'?'@':''}${recipient.target}`;$('reward-request-challenge').textContent=recipient.kind==='x'?'Get wallet challenge':'Get DNS challenge';$('reward-submit-proof').textContent=recipient.kind==='x'?'Continue with X':'Verify DNS & wallet';$('reward-dns-details').replaceChildren();$('reward-verify-error').textContent='';$('reward-verify-wallet').value='';$('reward-verify-signature').value='';let challenge;
  $('reward-request-challenge').onclick=async()=>{try{challenge=await api('reward-challenge',{token:row.token,index:recipient.index,wallet:$('reward-verify-wallet').value});$('reward-dns-details').replaceChildren(el('p',recipient.kind==='x'?'Sign this payout-wallet message, then authenticate the allocated X profile.':'Add this DNS TXT record, then sign the message with your payout wallet:'),...(recipient.kind==='domain'?[el('code',challenge.name),el('pre',challenge.txt)]:[]),el('pre',challenge.message));}catch(e){$('reward-verify-error').textContent=e.message;}};
  $('reward-sign-challenge').onclick=async()=>{try{if(!challenge)throw new Error('Request your challenge first.');if(!window.ethereum)throw new Error('Use a wallet-enabled browser to sign, or paste your wallet signature below.');const accounts=await window.ethereum.request({method:'eth_requestAccounts'});if(accounts[0].toLowerCase()!==$('reward-verify-wallet').value.toLowerCase())throw new Error('Connect the payout wallet entered above.');const hex='0x'+[...new TextEncoder().encode(challenge.message)].map(n=>n.toString(16).padStart(2,'0')).join('');$('reward-verify-signature').value=await window.ethereum.request({method:'personal_sign',params:[hex,accounts[0]]});}catch(e){$('reward-verify-error').textContent=e.message;}};
  $('reward-submit-proof').onclick=async()=>{try{if(!challenge)throw new Error('Request your challenge first.');if(recipient.kind==='x'){const result=await api('reward-x-start',{nonce:challenge.nonce,signature:$('reward-verify-signature').value});const url=new URL(result.url);if(url.origin!=='https://x.com')throw new Error('Invalid X authentication destination.');location.assign(url.href);return;}toast((await api('reward-verify',{nonce:challenge.nonce,signature:$('reward-verify-signature').value})).message);dialog.close();await load();}catch(e){$('reward-verify-error').textContent=e.message;}};
  dialog.showModal();
 }
 $('reward-mode').addEventListener('change',()=>{if($('reward-mode').value==='creator')for(const r of $('reward-recipients').children)r.firstChild.value='wallet';update();});$('reward-add').addEventListener('click',()=>addRecipient('wallet','',0));$('launch-chain').addEventListener('change',update);
 function reset(){ $('reward-mode').value='creator';$('reward-threshold').value='1';$('reward-minimum').value='1000';$('reward-vesting').value='30';$('reward-recipients').replaceChildren();addRecipient();update(); }
 reset();load().catch(e=>toast(e.message));return {policy,reset,load,render,update,quote:()=>data.assets.find(a=>a.address.toLowerCase()===$('launch-quote-token').value.toLowerCase())};
}
