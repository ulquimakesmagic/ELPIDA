// Wallet signs, public RPC reads (22 Oct 2026). ethers' wallet signer asks the WALLET's RPC to estimate gas before the
// wallet window opens, then polls the wallet's RPC for the transaction and its receipt. When a wallet's RPC for a
// testnet is slow or broken (seen with Zerion on Ethereum Sepolia), the window never opens and nothing is reported.
// This signer keeps every signature and submission in the wallet but does the estimate and all reads through the
// chain's public RPC, which the page already uses for everything else. It also says so when the wallet is slow.
import { AbstractSigner, getCreateAddress } from '/vendor/ethers.js';

// Empty revert bytes can mean a node's simulation gas cap was hit. Never let a wallet
// replace that unresolved simulation with its small default gas limit (graduation creates a pool).
const isRevert = error => error?.code === 'CALL_EXCEPTION';

export class PublicRpcSigner extends AbstractSigner {
  /**
   * @param walletSigner  ethers JsonRpcSigner from the wallet's BrowserProvider (signs and submits)
   * @param provider      JsonRpcProvider on the chain's public RPC (estimates and reads)
   * @param options.onSlow  called once with a hint when the wallet has not answered after `slowMs`
   */
  constructor(walletSigner, provider, { onSlow = () => {}, slowMs = 20000, findMs = 90000, pollMs = 1500, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    super(provider);
    this.walletSigner = walletSigner; this.onSlow = onSlow; this.slowMs = slowMs; this.findMs = findMs; this.pollMs = pollMs; this.sleep = sleep;
  }
  connect() { throw new Error('PublicRpcSigner is bound to one wallet and one RPC.'); }
  getAddress() { return this.walletSigner.getAddress(); }
  signMessage(message) { return this.slow(this.walletSigner.signMessage(message)); }
  signTypedData(domain, types, value) { return this.slow(this.walletSigner.signTypedData(domain, types, value)); }
  signTransaction() { throw new Error('Browser wallets submit transactions themselves; use sendTransaction.'); }

  /** Shows a hint if the wallet has not answered in time; never cancels the request. */
  async slow(pending, message = 'Still waiting for your wallet. If no wallet window opened, open the wallet extension: an earlier request may be waiting there, or reconnect the wallet.') {
    const timer = setTimeout(() => this.onSlow(message), this.slowMs);
    try { return await pending; } finally { clearTimeout(timer); }
  }

  /** Fills the gas limit from the public RPC (with 20% headroom), so the wallet can open straight away. */
  async withGasLimit(tx) {
    if (tx.gasLimit != null) return tx;
    const from = await this.getAddress();
    try { return { ...tx, gasLimit: (await this.provider.estimateGas({ ...tx, from })) * 120n / 100n }; }
    catch (error) {
      if (isRevert(error)) throw error;    // a revert or unresolved simulation must stop before the wallet opens
      throw Object.assign(new Error('The network could not verify the transaction gas. No wallet request was sent. Refresh and retry.'), { code: 'GAS_ESTIMATE_UNAVAILABLE', cause: error });
    }
  }

  /**
   * Watches the public RPC for `prepared` sent by `from` at or after `nonce` (3 November 2026). Trust Wallet often
   * signs and broadcasts but never returns the hash to the page, which left every step waiting forever. Once the
   * account's mined nonce moves past `nonce`, the block holding each new nonce is found and its transaction from this
   * account is compared with what was requested (recipient, data and value); a match is returned. Resolves to null
   * when `stop.done` is set; RPC errors only delay it.
   */
  async watchChain({ from, nonce, startBlock, prepared, stop }) {
    const p = this.provider, me = from.toLowerCase(), to = prepared.to == null ? null : String(prepared.to).toLowerCase();
    const data = String(prepared.data ?? '0x').toLowerCase(), value = BigInt(prepared.value ?? 0);
    const same = t => t && String(t.from).toLowerCase() === me && (t.to == null ? null : String(t.to).toLowerCase()) === to && String(t.data).toLowerCase() === data && BigInt(t.value ?? 0) === value;
    // The first block whose state shows the account past `n` holds nonce n; linear scan if history is unavailable.
    const blockOf = async (n, head) => {
      try {
        let lo = startBlock, hi = head;
        while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (Number(await p.getTransactionCount(from, mid)) > n) hi = mid; else lo = mid + 1; }
        return [lo];
      } catch { const all = []; for (let b = Math.max(startBlock, head - 2000); b <= head; b++) all.push(b); return all; }
    };
    let next = nonce;
    while (!stop.done) {
      await this.sleep(this.pollMs * 2);
      try {
        const mined = Number(await p.getTransactionCount(from, 'latest'));
        if (mined <= next) continue;
        const head = Number(await p.getBlockNumber());
        for (; next < mined && !stop.done; next++) {
          for (const b of await blockOf(next, head)) {
            const block = await p.getBlock(b, true);
            const txs = block?.prefetchedTransactions ?? [];
            const found = txs.find(t => String(t.from).toLowerCase() === me && Number(t.nonce) === next);
            if (found) { if (same(found)) return found; break; }
          }
        }
      } catch { /* a flaky public RPC only delays the watch */ }
    }
    return null;
  }

  async sendTransaction(tx) {
    const prepared=await this.slow(this.withGasLimit(tx),'Checking transaction simulation and gas on this network. No wallet request has been sent yet.');
    // Snapshot the account before the wallet opens, so a send the wallet never reports can still be found on chain.
    let watch = null; const stop = { done: false };
    if (typeof this.provider.getTransactionCount === 'function' && typeof this.provider.getBlock === 'function') {
      try {
        const from = await this.getAddress();
        const [nonce, startBlock] = await Promise.all([this.provider.getTransactionCount(from, 'pending'), this.provider.getBlockNumber()]);
        watch = this.watchChain({ from, nonce: Number(nonce), startBlock: Number(startBlock), prepared, stop });
      } catch { watch = null; }
    }
    const wallet = this.slow(this.walletSigner.sendUncheckedTransaction(prepared));
    let hash;
    try {
      const first = await Promise.race([wallet.then(h => ({ hash: h })), ...(watch ? [watch.then(found => found ? { found } : new Promise(() => {}))] : [])]);
      if (first.found) { wallet.catch(() => {}); this.onSlow('Your wallet did not report back, but the transaction is on chain. Continuing…'); return first.found; }
      hash = first.hash;
    } finally { stop.done = true; }
    // The wallet broadcast it; find it on the public RPC (propagation takes a few seconds).
    for (const started = Date.now(); ;) {
      const found = await this.provider.getTransaction(hash).catch(() => null);
      if (found) return found;
      if (Date.now() - started > this.findMs) {
        const fromWallet = await this.walletSigner.provider.getTransaction(hash).catch(() => null);
        if (fromWallet) return fromWallet;
        throw Object.assign(new Error(`Your wallet sent transaction ${hash}, but the network has not shown it yet. Check it on the explorer before trying again.`), { hash });
      }
      await this.sleep(this.pollMs);
    }
  }
}

/** Persist a setup transaction before waiting. A timeout never resubmits it. */
/**
 * Deploys one setup contract, or resumes it. The transaction hash is saved before waiting, so a closed page resumes the
 * same deployment instead of sending a duplicate. With `from` (the sender) and `matches(address)` (does a contract at
 * this address look like this step?) it also recovers from wallets that misbehave (2 November 2026: Trust Wallet on
 * Ethereum Sepolia showed setup steps as pending that the network never received, and slow sends led to duplicates):
 * - a send interrupted before its hash was saved: the contract this wallet created since then is found and reused;
 * - a transaction replaced in the wallet (speed up or cancel): the contract at its nonce is reused, or the step reopens;
 * - a transaction the network never received: after `droppedAfterMs` the step reopens with an explanation.
 */
export async function resumeSetupDeployment({ provider, storage, key, deploy, from = null, matches = null, timeoutMs = 120000, pollMs = 2000, droppedAfterMs = 180000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now() }) {
  const save = r => storage.setItem(key, JSON.stringify(r));
  const clear = () => (storage.removeItem ? storage.removeItem(key) : storage.setItem(key, 'null'));
  const nonceOf = async tag => (from && provider.getTransactionCount ? Number(await provider.getTransactionCount(from, tag)) : null);
  const looksRight = async address => (await provider.getCode(address)) !== '0x' && (!matches || await matches(address).catch(() => false));
  // A contract this wallet created at a nonce at or after `start` that matches this step: reuse it.
  const adopt = async start => {
    if (!from || !matches || start == null) return null;
    const latest = await nonceOf('latest');
    for (let n = latest - 1; n >= start && n >= latest - 30; n--) { const address = getCreateAddress({ from, nonce: n }); if (await looksRight(address)) return address; }
    return null;
  };
  let record = JSON.parse(storage.getItem(key) ?? 'null');
  if (record?.adopted) {
    if (await provider.getCode(record.address) !== '0x') return record.address;
    clear(); record = null;
  }
  if (record && !record.hash) {
    const found = await adopt(record.nonce);
    if (found) { save({ hash: null, address: found, adopted: true }); return found; }
    if (now() - (record.at ?? 0) < droppedAfterMs) throw new Error('Your wallet may still be sending this setup step. Check the wallet, wait a minute, then press the button again.');
    clear(); record = null;
  }
  if (!record) {
    const nonce = await nonceOf('pending');
    if (from) save({ intent: true, nonce, at: now() });
    let contract;
    try { contract = await deploy(); } catch (error) { if (from) clear(); throw error; }
    const tx = contract.deploymentTransaction();
    record = { hash: tx.hash, address: contract.target, nonce: tx.nonce ?? nonce, from, at: now() };
    save(record);
  }
  if (!/^0x[0-9a-f]{64}$/i.test(record.hash) || !/^0x[0-9a-f]{40}$/i.test(record.address)) throw new Error('Invalid saved setup transaction.');
  if (record.at == null) { record.at = now(); save(record); } // records saved before this version start their clock now
  const started = now();
  for (;;) {
    const receipt = await provider.getTransactionReceipt(record.hash);
    if (receipt) {
      if (Number(receipt.status) !== 1) throw new Error(`Setup transaction ${record.hash} failed. Inspect it before clearing the saved setup.`);
      if (String(receipt.contractAddress).toLowerCase() !== record.address.toLowerCase()) throw new Error('Setup receipt created a different contract.');
      if (await provider.getCode(record.address) === '0x') throw new Error('Confirmed setup contract has no code.');
      return record.address;
    }
    if (now() - started >= timeoutMs) {
      const seen = provider.getTransaction ? await provider.getTransaction(record.hash).catch(() => undefined) : undefined;
      const sender = record.from ?? from;
      if (seen === null && sender) {
        const latest = record.nonce == null ? null : Number(await provider.getTransactionCount(sender, 'latest'));
        if (latest != null && latest > record.nonce) {
          // That nonce was used by another transaction (the wallet sped it up or replaced it).
          const at = getCreateAddress({ from: sender, nonce: record.nonce });
          if (await looksRight(at)) { save({ hash: null, address: at, adopted: true }); return at; }
          clear();
          throw new Error(`Setup transaction ${record.hash} was replaced in your wallet and deployed nothing. Press the button again to send this step again.`);
        }
        if (now() - record.at >= droppedAfterMs) {
          clear();
          throw new Error(`The network never received setup transaction ${record.hash}. Your wallet may show it as pending, but it was not broadcast. Press the button again to resend this step. If your wallet keeps it pending, cancel it there or use another wallet.`);
        }
      }
      throw new Error(`Setup transaction ${record.hash} is awaiting confirmation. Reopen setup to resume; do not deploy again.`);
    }
    await sleep(pollMs);
  }
}
