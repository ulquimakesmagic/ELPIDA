// Public testnet RPCs limit how fast one visitor may call them (Base Sepolia: "25/second request limit reached",
// code -32007). Loading a wallet's view of a network makes dozens of reads at once, so a few were refused and one
// refusal failed the whole read: the trade panel then said the wallet "could not read this network" (ITACHI, 24 Oct).
// This provider starts at most `perSecond` requests a second and retries a refused one with backoff. Reads only:
// transactions are signed and sent by the wallet, not through here.
import { JsonRpcProvider } from '/vendor/ethers.js';

const LIMITED = new Set([-32005, -32007, -32029, -32090, 429]);
/** A rate-limit refusal, as public RPCs report it in a JSON-RPC error (HTTP 200) or as HTTP 429. */
export const isRateLimited = error => LIMITED.has(Number(error?.code)) || /rate limit|request limit|too many requests/i.test(String(error?.message ?? ''));

export class PacedJsonRpcProvider extends JsonRpcProvider {
  constructor(request, network, options = {}, { perSecond = 12, retries = 4, backoffMs = 400, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    super(request, network, options);
    this.pace = { gap: 1000 / perSecond, next: 0, retries, backoffMs, sleep };
  }
  async #slot() {
    const now = Date.now(), at = Math.max(now, this.pace.next);
    this.pace.next = at + this.pace.gap;
    if (at > now) await this.pace.sleep(at - now);
  }
  async _send(payload) {
    for (let attempt = 0; ; attempt++) {
      await this.#slot();
      let results;
      try { results = await super._send(payload); }
      catch (error) {
        if (attempt < this.pace.retries && (isRateLimited(error) || Number(error?.response?.statusCode) === 429)) { await this.pace.sleep(this.pace.backoffMs * 2 ** attempt); continue; }
        throw error;
      }
      if (attempt < this.pace.retries && results.some(r => r?.error && isRateLimited(r.error))) { await this.pace.sleep(this.pace.backoffMs * 2 ** attempt); continue; }
      return results;
    }
  }
}
