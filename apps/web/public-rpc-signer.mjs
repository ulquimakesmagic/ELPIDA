// Wallet signs, public RPC reads (22 Oct 2026). ethers' wallet signer asks the WALLET's RPC to estimate gas before the
// wallet window opens, then polls the wallet's RPC for the transaction and its receipt. When a wallet's RPC for a
// testnet is slow or broken (seen with Zerion on Ethereum Sepolia), the window never opens and nothing is reported.
// This signer keeps every signature and submission in the wallet but does the estimate and all reads through the
// chain's public RPC, which the page already uses for everything else. It also says so when the wallet is slow.
import { AbstractSigner } from '/vendor/ethers.js';

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

  async sendTransaction(tx) {
    const prepared=await this.slow(this.withGasLimit(tx),'Checking transaction simulation and gas on this network. No wallet request has been sent yet.');
    const hash = await this.slow(this.walletSigner.sendUncheckedTransaction(prepared));
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
export async function resumeSetupDeployment({ provider, storage, key, deploy, timeoutMs = 120000, pollMs = 2000, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  let record = JSON.parse(storage.getItem(key) ?? 'null');
  if (!record) {
    const contract = await deploy();
    const tx = contract.deploymentTransaction();
    record = { hash: tx.hash, address: contract.target };
    storage.setItem(key, JSON.stringify(record));
  }
  if (!/^0x[0-9a-f]{64}$/i.test(record.hash) || !/^0x[0-9a-f]{40}$/i.test(record.address)) throw new Error('Invalid saved setup transaction.');
  const started = Date.now();
  for (;;) {
    const receipt = await provider.getTransactionReceipt(record.hash);
    if (receipt) {
      if (Number(receipt.status) !== 1) throw new Error(`Setup transaction ${record.hash} failed. Inspect it before clearing the saved setup.`);
      if (String(receipt.contractAddress).toLowerCase() !== record.address.toLowerCase()) throw new Error('Setup receipt created a different contract.');
      if (await provider.getCode(record.address) === '0x') throw new Error('Confirmed setup contract has no code.');
      return record.address;
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`Setup transaction ${record.hash} is awaiting confirmation. Reopen setup to resume; do not deploy again.`);
    await sleep(pollMs);
  }
}
