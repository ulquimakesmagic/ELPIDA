import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getAddress, parseUnits } from 'ethers';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

export const CIRCLE_NETWORKS = Object.freeze({
  'base-sepolia': { blockchain: 'BASE-SEPOLIA', name: 'Base Sepolia', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
  'ethereum-sepolia': { blockchain: 'ETH-SEPOLIA', name: 'Ethereum Sepolia', usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
});
export class FundingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const reject = (status, message) => { throw new FundingError(status, message); };
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? '');

// This is an operator-only test utility, never a public custodial wallet service.
export function createCircleFunding({ env = process.env, path = null, clientFactory = initiateDeveloperControlledWalletsClient, now = Date.now } = {}) {
  const enabled = /^TEST_API_KEY:/.test(env.CIRCLE_API_KEY ?? '') && /^[a-f0-9]{64}$/i.test(env.CIRCLE_ENTITY_SECRET ?? '') && (env.ELPIDA_CIRCLE_ADMIN_TOKEN?.length ?? 0) >= 32;
  let client, store, queue = Promise.resolve(), windowStart = now(), requests = 0;
  const status = () => ({ enabled, networks: Object.entries(CIRCLE_NETWORKS).map(([key, net]) => ({ key, name: net.name })), reason: enabled ? null : 'Add a Circle test API key, registered entity secret and Elpida funding access code on the server.' });
  async function save() {
    if (!path) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path + '.tmp', JSON.stringify(store), { mode: 0o600 });
    await rename(path + '.tmp', path);
  }
  async function load() {
    if (store) return;
    try { store = path ? JSON.parse(await readFile(path, 'utf8')) : null; }
    catch (error) { if (error.code !== 'ENOENT') reject(503, 'Circle wallet record is unreadable. Restore it before continuing.'); }
    store ??= { walletSetId: env.CIRCLE_WALLET_SET_ID || null, setKey: randomUUID(), wallets: {}, walletKeys: {}, transfers: {}, drips: {} };
    if (env.CIRCLE_WALLET_SET_ID && store.walletSetId && env.CIRCLE_WALLET_SET_ID !== store.walletSetId) reject(503, 'Configured Circle wallet set differs from the saved record.');
    await save();
  }
  async function walletFor(key, net, create = false) {
    if (!store.walletSetId && create) {
      const result = await client.createWalletSet({ name: 'Elpida test funding', idempotencyKey: store.setKey });
      store.walletSetId = result.data?.walletSet?.id;
      if (!store.walletSetId) reject(502, 'Circle did not return a wallet set. Retry the same operation.');
      await save();
    }
    if (!store.wallets[key] && create) {
      const existing = (await client.listWallets({ walletSetId: store.walletSetId, blockchain: net.blockchain, pageSize: 50 })).data?.wallets?.find(w => w.accountType === 'EOA');
      if (existing) store.wallets[key] = existing.id;
      else {
        store.walletKeys[key] ??= randomUUID(); await save();
        const result = await client.createWallets({ walletSetId: store.walletSetId, blockchains: [net.blockchain], count: 1, accountType: 'EOA', idempotencyKey: store.walletKeys[key] });
        store.wallets[key] = result.data?.wallets?.[0]?.id;
      }
      await save();
    }
    if (!store.wallets[key]) reject(409, 'Prepare the Circle test wallet first.');
    const w = (await client.getWallet({ id: store.wallets[key] })).data?.wallet;
    if (!w || w.blockchain !== net.blockchain || w.walletSetId !== store.walletSetId || w.accountType !== 'EOA') reject(409, 'Circle wallet does not match this test network and wallet set.');
    return w;
  }
  async function perform(body) {
    const net = CIRCLE_NETWORKS[body.network];
    if (!net) reject(400, 'Choose Base Sepolia or Ethereum Sepolia.');
    if (!['prepare', 'balance', 'drip', 'send', 'transaction'].includes(body.action)) reject(400, 'Unknown Circle funding action.');
    await load(); client ??= clientFactory({ apiKey: env.CIRCLE_API_KEY, entitySecret: env.CIRCLE_ENTITY_SECRET });
    const w = await walletFor(body.network, net, body.action === 'prepare');
    if (body.action === 'prepare') return { wallet: { id: w.id, address: w.address, network: body.network }, walletSetId: store.walletSetId };
    if (body.action === 'balance') {
      const balances = (await client.getWalletTokenBalance({ id: w.id, includeAll: true, pageSize: 50 })).data?.tokenBalances ?? [];
      return { balances: balances.filter(b => b.token?.blockchain === net.blockchain && (b.token.isNative || b.token.tokenAddress?.toLowerCase() === net.usdc.toLowerCase())).map(b => ({ symbol: b.token.isNative ? 'ETH' : 'USDC', amount: b.amount })) };
    }
    if (body.action === 'drip') {
      if (store.drips[body.network] && now() - store.drips[body.network] < 2 * 60 * 60 * 1000) reject(429, 'Test funds were already requested. Circle may require a two-hour cooldown.');
      await client.requestTestnetTokens({ address: w.address, blockchain: net.blockchain, native: true, usdc: true });
      store.drips[body.network] = now(); await save();
      return { message: 'Circle accepted the faucet request. Refresh balances after the transfers settle.' };
    }
    if (body.action === 'transaction') {
      if (!Object.values(store.transfers).some(t => t.id === body.id && t.network === body.network)) reject(404, 'This transaction is not in the funding record.');
      const tx = (await client.getTransaction({ id: body.id })).data?.transaction;
      return { transaction: { id: tx?.id, state: tx?.state, hash: tx?.txHash ?? null } };
    }
    if (!uuid(body.requestId)) reject(400, 'A valid transfer request ID is required.');
    if (!['ETH', 'USDC'].includes(body.asset)) reject(400, 'Only test ETH and USDC can be sent.');
    let destination, amount;
    try { destination = getAddress(body.destination); amount = parseUnits(body.amount, body.asset === 'ETH' ? 18 : 6); } catch { reject(400, 'Enter a valid wallet address and amount with the correct decimals.'); }
    if (destination.toLowerCase() === w.address.toLowerCase() || amount <= 0n || amount > parseUnits(body.asset === 'ETH' ? '0.1' : '100', body.asset === 'ETH' ? 18 : 6)) reject(400, 'Send to another wallet, up to 0.1 test ETH or 100 test USDC per transfer.');
    const fingerprint = JSON.stringify([body.network, body.asset, destination, amount.toString()]);
    const previous = store.transfers[body.requestId];
    if (previous && previous.fingerprint !== fingerprint) reject(409, 'This request ID belongs to different transfer details.');
    if (previous?.id) return { transaction: { id: previous.id, state: 'SUBMITTED' } };
    // Only preflight a new request. An uncertain request must retain its key and be retried unchanged,
    // even if its original transfer has already reduced the current balance.
    if (!previous) {
      const balances = (await client.getWalletTokenBalance({ id: w.id, includeAll: true, pageSize: 50 })).data?.tokenBalances ?? [];
      const native = balances.find(b => b.token?.blockchain === net.blockchain && b.token.isNative);
      const usdc = balances.find(b => b.token?.blockchain === net.blockchain && b.token.tokenAddress?.toLowerCase() === net.usdc.toLowerCase());
      const nativeAmount = parseUnits(native?.amount ?? '0', 18);
      if (!nativeAmount) reject(400, 'The Circle wallet has no test ETH for gas. Click Request test ETH + USDC, then refresh Circle balances until funds arrive.');
      const available = body.asset === 'ETH' ? nativeAmount : parseUnits(usdc?.amount ?? '0', 6);
      if (amount > available) reject(400, `Circle wallet balance is ${body.asset === 'ETH' ? native.amount : usdc?.amount ?? '0'} ${body.asset}. Request test funds first or lower the amount.`);
      if (body.asset === 'ETH' && amount === nativeAmount) reject(400, 'Leave some test ETH in the Circle wallet for transfer gas. Lower the amount instead of sending its entire balance.');
    }
    store.transfers[body.requestId] = { fingerprint, network: body.network }; await save();
    const result = await client.createTransaction({ walletAddress: w.address, blockchain: net.blockchain, tokenAddress: body.asset === 'USDC' ? net.usdc : '', destinationAddress: destination, amount: [body.amount], fee: { type: 'level', config: { feeLevel: 'MEDIUM' } }, idempotencyKey: body.requestId });
    if (!result.data?.id) reject(502, 'Transfer response is uncertain. Retry with the same request ID.');
    store.transfers[body.requestId].id = result.data.id; await save();
    return { transaction: { id: result.data.id, state: result.data.state } };
  }
  async function execute(authorization, body) {
    if (!enabled) reject(503, status().reason);
    const expected = Buffer.from('Bearer ' + env.ELPIDA_CIRCLE_ADMIN_TOKEN), supplied = Buffer.from(authorization ?? '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) reject(401, 'Enter the Elpida funding access code.');
    if (now() - windowStart >= 60000) { windowStart = now(); requests = 0; }
    if (++requests > 30) reject(429, 'Too many funding requests. Wait one minute before trying again.');
    // Serialize writes and wallet creation so concurrent requests cannot create duplicate wallets.
    const task = queue.then(() => perform(body)); queue = task.catch(() => {});
    try { return await task; } catch (error) {
      if (error instanceof FundingError) throw error;
      const statusCode = error.status ?? error.response?.status;
      if (statusCode === 429) reject(429, 'Circle request limit reached. Wait before requesting again.');
      if ([401, 403].includes(statusCode)) reject(502, body.action === 'drip' ? `Circle denied faucet API access. Use the Circle Console faucet with wallet ID ${store?.wallets?.[body.network] ?? '(prepare a wallet first)'}, then refresh balances here.` : 'Circle denied access. Check the test API key, its Wallets permissions and IP restrictions on the server.');
      if (statusCode === 400) reject(502, `Circle rejected the request${Number.isInteger(error.code) ? ' (code ' + error.code + ')' : ''}. Check Circle Console for details. If this was a transfer, keep the same request ID when retrying.`);
      reject(502, 'Circle could not complete this request. Check server credentials and wallet balances. For an uncertain transfer, retry with the same request ID.');
    }
  }
  return { status, execute };
}
