// The server's private RPC for one network, rotating to the next configured URL or Alchemy key when the current one is
// used up (packages/core/mainnets.mjs serverRpcUrls; Malik, 25 Nov 2026). Used by the V2 keeper, which keeps one
// provider for its whole life, so the rotation has to happen inside the provider.
import { FetchRequest, JsonRpcProvider } from 'ethers';
import { serverRpcUrl, serverRpcUrls, rotateServerRpc, rpcExhausted } from '../../packages/core/mainnets.mjs';

export class RotatingRpcProvider extends JsonRpcProvider {
  constructor(net, env = {}, network, options) {
    super(serverRpcUrl(net, env), network, options);
    this.net = net; this.env = env; this.log = options?.log ?? null;
  }
  /** Every request goes to the network's current RPC, so a rotation by any caller takes effect at once. */
  _getConnection() {
    const req = new FetchRequest(serverRpcUrl(this.net, this.env));
    // ethers retries a 429 on the same URL for a long time; with somewhere else to go, move on at the first one.
    if (serverRpcUrls(this.net, this.env).length > 1) req.setThrottleParams({ maxAttempts: 1 });
    return req;
  }
  async _send(payload) {
    const tries = serverRpcUrls(this.net, this.env).length;
    for (let i = 0; ; i++) {
      const url = serverRpcUrl(this.net, this.env);
      let result;
      try { result = await super._send(payload); } catch (e) {
        if (i >= tries - 1 || !rpcExhausted(e) || !rotateServerRpc(this.net, this.env, url)) throw e;
        this.rotated(i); continue;
      }
      // A JSON-RPC error inside a 200 answer (Alchemy's monthly cap, for example) rotates too.
      const used = Array.isArray(result) && result.some(r => r?.error && rpcExhausted(r.error));
      if (used && i < tries - 1 && rotateServerRpc(this.net, this.env, url)) { this.rotated(i); continue; }
      return result;
    }
  }
  /** Logs the move by position only: the URLs hold API keys. */
  rotated(i) { this.log?.({ event: 'server_rpc_rotated', network: this.net.key, to: (i + 1) % serverRpcUrls(this.net, this.env).length + 1, of: serverRpcUrls(this.net, this.env).length }); }
}
