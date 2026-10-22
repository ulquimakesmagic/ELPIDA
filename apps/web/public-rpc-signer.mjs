// Wallet signs, public RPC reads (22 Oct 2026). ethers' wallet signer asks the WALLET's RPC to estimate gas before the
// wallet window opens, then polls the wallet's RPC for the transaction and its receipt. When a wallet's RPC for a
// testnet is slow or broken (seen with Zerion on Ethereum Sepolia), the window never opens and nothing is reported.
// This signer keeps every signature and submission in the wallet but does the estimate and all reads through the
// chain's public RPC, which the page already uses for everything else. It also says so when the wallet is slow.
import { AbstractSigner } from '/vendor/ethers.js';

const isRevert = error => error?.code === 'CALL_EXCEPTION' && error.data != null;

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
  async slow(pending) {
    const timer = setTimeout(() => this.onSlow('Still waiting for your wallet. If no wallet window opened, open the wallet extension: an earlier request may be waiting there, or reconnect the wallet.'), this.slowMs);
    try { return await pending; } finally { clearTimeout(timer); }
  }

  /** Fills the gas limit from the public RPC (with 20% headroom), so the wallet can open straight away. */
  async withGasLimit(tx) {
    if (tx.gasLimit != null) return tx;
    const from = await this.getAddress();
    try { return { ...tx, gasLimit: (await this.provider.estimateGas({ ...tx, from })) * 120n / 100n }; }
    catch (error) {
      if (isRevert(error)) throw error;    // it would revert on-chain too: report it before the wallet opens
      return tx;                            // public RPC trouble: let the wallet estimate, as before
    }
  }

  async sendTransaction(tx) {
    const hash = await this.slow(this.walletSigner.sendUncheckedTransaction(await this.withGasLimit(tx)));
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
