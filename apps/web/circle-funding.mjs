import { h, field } from './ui.mjs';

export function circleFundingPanel({ config, csrf, connected }) {
  const section = h('section.tools-section', h('h4', 'Circle test funding'),
    h('p.small.muted', 'Get test USDC directly in your browser wallet from the public faucet. You also need test ETH for gas and native-paired purchases.'),
    h('a.link-button', { href: 'https://faucet.circle.com/', target: '_blank', rel: 'noopener noreferrer' }, 'Open Circle USDC faucet'));
  if (!config?.enabled) {
    section.append(h('p.hint', 'Circle wallet helper needs server setup. See docs/CIRCLE_TEST_FUNDING.md. The public USDC faucet is available now.'));
    section.append(h('a.link-button', { href: 'https://github.com/ulquimakesmagic/ELPIDA/blob/main/docs/CIRCLE_TEST_FUNDING.md', target: '_blank', rel: 'noopener noreferrer' }, 'Circle wallet setup instructions'));
    return section;
  }
  const network = h('select.select', config.networks.map(n => h('option', { value: n.key, selected: n.key === connected?.network }, n.name)));
  const code = h('input.input', { type: 'password', autocomplete: 'off' });
  const recipient = h('input.input', { value: connected?.address ?? '', placeholder: '0x…', spellcheck: false });
  const asset = h('select.select', h('option', { value: 'USDC' }, 'Test USDC'), h('option', { value: 'ETH' }, 'Test ETH'));
  const amount = h('input.input', { value: '10', inputMode: 'decimal' });
  const identity = h('div.stack');
  const output = h('div.stack', { role: 'status', 'aria-live': 'polite' });
  const buttons = []; let prepared = false, pendingTransfer = null, transactionId = null;
  async function request(body) {
    const response = await fetch('/api/circle/funding', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': csrf, Authorization: 'Bearer ' + code.value }, body: JSON.stringify({ network: network.value, ...body }) });
    const result = await response.json(); if (!response.ok) { const error = new Error(result.error ?? 'Circle request failed.'); error.status = response.status; throw error; } return result;
  }
  function button(label, action) {
    const b = h('button.btn.btn-secondary', { type: 'button', on: { click: async () => {
      buttons.forEach(b => b.disabled = true); [network, code, recipient, asset, amount].forEach(i => i.disabled = true); output.textContent = 'Working…';
      try { await action(); } catch (error) { output.textContent = error.message; }
      finally { buttons.forEach(b => b.disabled = false); [code, recipient, asset, amount].forEach(i => i.disabled = false); network.disabled = !!pendingTransfer; }
    } } }, label); buttons.push(b); return b;
  }
  const prepare = button('Prepare Circle test wallet', async () => {
    const result = await request({ action: 'prepare' }); prepared = true;
    identity.replaceChildren(h('p.small', `Circle wallet: ${result.wallet.address}`), h('p.small', `Wallet ID: ${result.wallet.id}`), h('p.hint', `Wallet set: ${result.walletSetId}. Save this as CIRCLE_WALLET_SET_ID on Railway.`));
    output.textContent = 'Circle wallet ready. Request test funds, then refresh balances before sending.';
  });
  const drip = button('Request test ETH + USDC', async () => { if (!prepared) throw new Error('Prepare the Circle wallet first.'); output.textContent = (await request({ action: 'drip' })).message; });
  const balance = button('Refresh Circle balances', async () => {
    const result = await request({ action: 'balance' }); output.textContent = result.balances.map(b => `${b.amount} ${b.symbol}`).join(' · ') || '0 ETH · 0 USDC. Click Request test ETH + USDC, then refresh after the faucet transfers settle.';
  });
  const send = button('Send test funds to this address', async () => {
    if (!prepared) throw new Error('Prepare the Circle wallet first.');
    if (connected?.address && connected.network !== network.value) throw new Error('Choose the same test network as your connected wallet.');
    const details = { network: network.value, asset: asset.value, amount: amount.value.trim(), destination: recipient.value.trim() };
    if (pendingTransfer && JSON.stringify(details) !== JSON.stringify(pendingTransfer.details)) throw new Error('Check the previous transfer status before changing its details. Retry unchanged details if its response was uncertain.');
    pendingTransfer ??= { details, requestId: crypto.randomUUID() };
    let result;
    try { result = await request({ action: 'send', ...details, requestId: pendingTransfer.requestId }); }
    catch (error) { if (error.status === 400) pendingTransfer = null; throw error; }
    transactionId = result.transaction.id;
    output.textContent = `Transfer ${result.transaction.state}: ${transactionId}. Check status before sending again.`;
  });
  const check = button('Check transfer status', async () => {
    if (!transactionId) throw new Error('Submit a transfer first. If the response was uncertain, retry unchanged details.');
    const tx = (await request({ action: 'transaction', id: transactionId })).transaction;
    output.textContent = `Transfer ${tx.state}${tx.hash ? ': ' + tx.hash : ''}.`;
    if (['COMPLETE', 'FAILED', 'CANCELLED', 'DENIED'].includes(tx.state)) pendingTransfer = null;
  });
  network.addEventListener('change', () => { prepared = false; identity.replaceChildren(); output.textContent = 'Prepare the wallet for the selected network.'; });
  asset.addEventListener('change', () => { amount.value = asset.value === 'ETH' ? '0.008' : '10'; });
  section.append(h('p.hint', 'Operator-only helper. Enter the Elpida funding access code, never your Circle API key or entity secret. Circle controls this test wallet; send its funds to your connected wallet to sign launches.'),
    field({ label: 'Circle test network', control: network }), field({ label: 'Funding access code', control: code }),
    h('div.wallet-choices', prepare, drip, balance), identity,
    h('a.link-button', { href: 'https://console.circle.com/faucet/circle-wallet', target: '_blank', rel: 'noopener noreferrer' }, 'Open Circle Console faucet'),
    h('p.hint', 'If the faucet API is denied, paste the Wallet ID above into Circle Console. Its current offer is 20 USDC and 0.01 test ETH; complete any human verification there. A transfer must leave ETH for gas.'),
    field({ label: 'Destination wallet address', control: recipient, hint: 'Confirm the address and network before sending. Maximum 0.1 test ETH or 100 test USDC per transfer.' }),
    field({ label: 'Test asset', control: asset }), field({ label: 'Amount to send', control: amount }),
    h('div.wallet-choices', send, check), output);
  return section;
}
