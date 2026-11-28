import { h, errorText } from './ui.mjs';
import { chosenEvmWallet, evmWallets, requestEvmWallets, withWalletTimeout } from './wallet.mjs';

const chainId = '0x1863d';

export function adminEvmWallet() {
  requestEvmWallets();
  const wallets = evmWallets();
  const wallet = wallets.find(item => item.name === 'Zerion') ?? wallets.find(item => item.id === chosenEvmWallet()) ??
    (wallets.length === 1 ? wallets[0] : null);
  if (!wallet) throw new Error('Open this page inside Zerion’s app browser, or select a browser wallet in Elpida first.');
  return args => withWalletTimeout(wallet.provider.request(args), wallet.name);
}

async function elysiumWallet(address) {
  const ask = adminEvmWallet();
  const accounts = await ask({ method: 'eth_requestAccounts' });
  if (accounts[0]?.toLowerCase() !== address) throw new Error('Switch to the Safe owner account you signed in with.');
  const switchChain = () => ask({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  if (await ask({ method: 'eth_chainId' }) !== chainId) {
    try { await switchChain(); }
    catch (error) {
      if (error.code !== 4902 && error.data?.originalError?.code !== 4902) throw error;
      await ask({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: 'Elysium',
        nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: ['https://rpc.elysium.kinetiq.xyz'],
        blockExplorerUrls: ['https://elysiumexplore.com'] }] });
      if (await ask({ method: 'eth_chainId' }) !== chainId) await switchChain();
    }
  }
  return async request => {
    if (await ask({ method: 'eth_chainId' }) !== chainId) throw new Error('Select Elysium in your wallet first.');
    const active = await ask({ method: 'eth_accounts' });
    if (active[0]?.toLowerCase() !== address) throw new Error('Your wallet account changed. Switch back to the signed-in owner.');
    return ask(request);
  };
}

export function renderSafeWiring(ctx, { getJson, address }) {
  const root = h('section.tk-card.op-card.op-safe-wiring');
  const details = h('div.op-safe-details');
  const status = h('p.small.muted', { role: 'status', 'aria-live': 'polite' });
  const error = h('p.error-text', { role: 'alert' });
  const refresh = h('button.btn.btn-secondary', { type: 'button', on: { click: () => run(load) } }, 'Refresh status');
  let submittedHash;
  let action;
  let busy = false;

  async function run(operation) {
    if (busy) return;
    busy = refresh.disabled = true;
    if (action) action.disabled = true;
    error.textContent = '';
    try { await operation(); }
    catch (e) { status.textContent = ''; error.textContent = errorText(e); }
    finally { busy = refresh.disabled = false; if (action) action.disabled = false; }
  }

  const post = (path, body) => getJson(`admin/safe-wiring/${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': ctx.config.csrf }, body: JSON.stringify(body) });

  async function sign(batch) {
    status.textContent = 'Review the Safe signature request in your wallet.';
    const ask = await elysiumWallet(address);
    const signature = await ask({ method: 'eth_signTypedData_v4', params: [address, JSON.stringify(batch.typedData)] });
    await post('sign', { signature });
    await load();
  }

  async function execute() {
    status.textContent = 'Checking the Safe transaction on Elysium…';
    const ask = await elysiumWallet(address);
    const transaction = await post('prepare', {});
    status.textContent = 'Review the transaction and HYPE gas fee in your wallet.';
    const hash = await ask({ method: 'eth_sendTransaction', params: [transaction] });
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('The wallet did not return a transaction hash. Check its Activity before trying again.');
    submittedHash = hash;
    await load();
  }

  async function load() {
    const batch = await getJson('admin/safe-wiring');
    const pending = batch.state === 'pending';
    const count = batch.owners.filter(owner => owner.signed).length;
    const row = (label, value) => [h('dt', label), h('dd.mono', value)];
    action = null;
    if (pending && !submittedHash) {
      if (batch.typedData) action = h('button.btn-accent', { type: 'button', on: { click: () => run(() => sign(batch)) } }, 'Sign wiring batch');
      else if (count === batch.threshold) action = h('button.btn-accent', { type: 'button', on: { click: () => run(execute) } }, 'Execute Safe batch');
    }
    details.replaceChildren(...[
      h('dl.op-kv', row('Network', 'Elysium mainnet'), row('Safe', batch.safe), row('Factory', batch.factory), row('Safe transaction hash', batch.hash)),
      h('h3', 'Factory changes'), h('ol', batch.calls.map(call => h('li', call))),
      pending ? h('ul', batch.owners.map(owner => h('li', h('span.mono', owner.address), owner.signed ? ' · Signed' : ' · Awaiting signature'))) : null,
      submittedHash ? h('p.small', h('a', { href: `https://elysiumexplore.com/tx/${submittedHash}`, target: '_blank', rel: 'noopener noreferrer' }, 'View submitted transaction')) : null,
      h('div.op-safe-actions', action, refresh),
    ].filter(Boolean));
    status.textContent = !pending ? 'Safe wiring verified on Elysium.' : submittedHash ? 'Transaction submitted. Refresh after it confirms.' :
      `${count} of ${batch.threshold} signatures collected. ${count === batch.threshold ? 'One owner can execute the batch and pay gas in HYPE.' : 'Signing is free. Refresh here after the other owner signs.'}`;
  }

  details.append(refresh);
  root.append(h('h2.tk-h', 'Elysium Safe wiring'), details, status, error);
  status.textContent = 'Checking the Safe on Elysium…';
  queueMicrotask(() => run(load));
  return root;
}
