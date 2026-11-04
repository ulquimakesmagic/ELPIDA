// Creator first purchase paid in the native coin on a non-native pair (3 November 2026). The native coin is swapped into
// the pair asset on the network's configured DEX in its own transaction, then the launch spends exactly what the swap
// delivered: two confirmations, any wallet. The swap is recorded before it is sent, so a wallet that signs but never
// answers the page (Trust Wallet, 2-3 November 2026), a closed page, or a launch that fails afterwards never converts
// twice: the next press finds the delivered amount on chain and reuses it.
//
// The delivered amount is read from the pool's own Swap event (recipient = this account), not from the pair asset's
// Transfer events, so it does not depend on how the asset reports transfers. Uniswap v3 and PancakeSwap v3 Swap
// events differ in topic but both start with amount0 and amount1 (packages/core/uniswap.mjs).
export const SWAP_TOPICS = Object.freeze([
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', // Uniswap v3
  '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83', // PancakeSwap v3 (two protocol-fee fields)
]);

export const conversionKey = ({ chainId, factory, account, asset }) =>
  `elpida:launch-conversion:v1:${chainId}:${String(factory).toLowerCase()}:${String(account).toLowerCase()}:${String(asset).toLowerCase()}`;

const topicOf = address => '0x' + String(address).slice(2).toLowerCase().padStart(64, '0');
const addressOf = topic => '0x' + String(topic).slice(26).toLowerCase();
const int256 = word => { const v = BigInt('0x' + word); return v >= 2n ** 255n ? v - 2n ** 256n : v; };

/** Pair asset that `pool` paid `account` in its Swap events among `logs`. `assetIsToken0`: the asset's side. */
export function deliveredBy(logs, { pool, account, assetIsToken0 }) {
  let total = 0n;
  for (const log of logs ?? []) {
    if (String(log.address).toLowerCase() !== String(pool).toLowerCase() || !SWAP_TOPICS.includes(log.topics?.[0]) || log.topics.length < 3) continue;
    if (addressOf(log.topics[2]) !== String(account).toLowerCase()) continue;
    const data = String(log.data).slice(2), amount = int256(data.slice(assetIsToken0 ? 0 : 64, assetIsToken0 ? 64 : 128));
    if (amount < 0n) total += -amount; // negative: the pool paid it out
  }
  return total;
}

/** The converted amount saved for this account and asset, or null. */
export function pendingConversion(storage, key) {
  try { const record = JSON.parse(storage.getItem(key) ?? 'null'); return record?.amount ? BigInt(record.amount) : null; } catch { return null; }
}

/**
 * Converts the native coin into the pair asset for a launch, or resumes an earlier conversion.
 * `quote()` returns a quoteNativePairConversion route ({ pool, tokenIn: wrapped native, minimum, ... }); `send(route)`
 * submits the swap and returns the transaction response ({ hash, wait() }). Returns { amount, reused, hash }.
 */
export async function convertForLaunch({ provider, storage, key, account, asset, quote, send, onSubmitted = () => {}, now = () => Date.now(), droppedAfterMs = 180000 }) {
  const save = record => storage.setItem(key, JSON.stringify(record));
  const clear = () => storage.removeItem(key);
  let record = null;
  try { record = JSON.parse(storage.getItem(key) ?? 'null'); } catch { clear(); }
  if (record?.amount) return { amount: BigInt(record.amount), reused: true, hash: record.hash ?? null };
  if (record?.intent) {
    const latest = Number(await provider.getTransactionCount(account, 'latest'));
    if (latest > record.nonce) {
      // Something was mined at that nonce. If it was the swap, the pool paid this account; reuse what it delivered.
      const logs = await provider.getLogs({ address: record.pool, topics: [SWAP_TOPICS, null, topicOf(account)], fromBlock: record.block, toBlock: 'latest' });
      const amount = deliveredBy(logs, { pool: record.pool, account, assetIsToken0: record.assetIsToken0 });
      if (amount > 0n) { save({ amount: amount.toString(), hash: record.hash ?? null, at: now() }); return { amount, reused: true, hash: record.hash ?? null }; }
      clear();
    } else if (now() - (record.at ?? 0) < droppedAfterMs) {
      throw new Error('Your wallet may still be sending the conversion. Check the wallet, wait a minute, then press again. Nothing was launched.');
    } else clear();
  }
  const route = await quote();
  const [nonce, block] = await Promise.all([provider.getTransactionCount(account, 'pending'), provider.getBlockNumber()]);
  const intent = { intent: true, nonce: Number(nonce), block: Number(block), pool: route.pool, assetIsToken0: BigInt(asset) < BigInt(route.tokenIn), at: now() };
  save(intent);
  let tx;
  try { tx = await send(route); } catch (error) { clear(); throw error; }
  save({ ...intent, hash: tx.hash });
  onSubmitted(tx.hash);
  const receipt = await tx.wait();
  if (!receipt || Number(receipt.status) !== 1) { clear(); throw new Error('The conversion did not succeed. Nothing was launched.'); }
  const amount = deliveredBy(receipt.logs, { pool: route.pool, account, assetIsToken0: intent.assetIsToken0 });
  if (amount <= 0n) { clear(); throw new Error('The conversion delivered nothing. Nothing was launched.'); }
  save({ amount: amount.toString(), hash: tx.hash, at: now() });
  return { amount, reused: false, hash: tx.hash };
}
