// Publishes the source of every token launched on an ELPIDA V2 launchpad on the chain's explorer (Malik, 22 November
// 2026: "add the automatic per token verification job to the keeper"), so BaseScan, BscScan and the scanners that read
// them stop calling Elpida tokens "unverified".
//
// Every V2 token is the same contract (contracts/evm/v2/ElpidaV2Token.sol), created by the factory with CREATE2 from
// abi.encode(name, symbol, 1,000,000,000 × 10^18, hook). It has no immutables, so its code on chain is exactly the
// compiler's deployed bytecode. The job builds that bytecode from this checkout's sources with LF and with CRLF line
// endings (the factory may have been built on Windows, where git checks out CRLF: the metadata hash differs), uses
// whichever matches the chain, and submits the same Standard JSON input scripts/v2-explorer-verify.mjs submits for the
// launchpad. Constructor arguments come from the token itself (name, symbol) and the launchpad record (hook).
// It never sends a transaction. Etherscan chains need ELPIDA_EXPLORER_API_KEY (Etherscan API V2, one key for every
// chain). Blockscout chains (Robinhood Chain, 24 November 2026) work without a key, slowly (rate limits); a Blockscout
// PRO key (proapi_…) in ELPIDA_BLOCKSCOUT_API_KEY makes them reliable.
import { AbiCoder, Contract, getAddress } from 'ethers';
import { createRequire } from 'node:module';
import { standardInput, submit, isVerified, needsApiKey } from '../../scripts/v2-explorer-verify.mjs';

const require = createRequire(import.meta.url);
export const TOKEN_CONTRACT = 'contracts/evm/v2/ElpidaV2Token.sol:ElpidaV2Token';
export const TOKEN_SUPPLY = 1_000_000_000n * 10n ** 18n;
const TOKEN = ['function name() view returns(string)', 'function symbol() view returns(string)'];
const EOLS = ['lf', 'crlf'];

/** The ElpidaV2Token runtime bytecode (lowercase hex with 0x) built with `eol` line endings. */
export function tokenRuntime(eol, compile = input => JSON.parse(require('solc-0.8.26').compile(JSON.stringify(input)))) {
  const out = compile(standardInput(TOKEN_CONTRACT, { eol }));
  const errors = (out.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors[0].formattedMessage);
  const [file, name] = TOKEN_CONTRACT.split(':');
  return '0x' + out.contracts[file][name].evm.deployedBytecode.object.toLowerCase();
}

/** The constructor arguments the factory used (abi-encoded, no 0x). */
export const tokenArgs = (name, symbol, hook) => AbiCoder.defaultAbiCoder().encode(['string', 'string', 'uint256', 'address'], [name, symbol, TOKEN_SUPPLY, getAddress(hook)]).slice(2);

export class TokenVerifier {
  /**
   * `apiKey`: Etherscan API V2 (Etherscan chains are skipped without it). `blockscoutKey`: optional, for Blockscout
   * chains. `perTick`: tokens submitted per chain per run (the free tier allows a few calls a
   * second; each verification is about ten). `retryAfter`: seconds before a failed token is tried again.
   */
  constructor({ apiKey = '', blockscoutKey = '', fetch: fetchImpl = fetch, sleep, runtime = tokenRuntime, perTick = 5, blockscoutPerTick = 2, retryAfter = 6 * 3600, maxAttempts = 5 }) {
    Object.assign(this, { apiKey, blockscoutKey, fetchImpl, sleep, runtime, perTick, blockscoutPerTick, retryAfter, maxAttempts });
    this.built = new Map();
  }

  /** The key for this chain's explorer ('' for keyless Blockscout), or null when the chain can't be verified. */
  keyFor(chainId) { return needsApiKey(chainId) ? (this.apiKey || null) : (this.blockscoutKey || ''); }
  supports(chainId) { return this.keyFor(chainId) !== null; }

  runtimeFor(eol) { if (!this.built.has(eol)) this.built.set(eol, this.runtime(eol)); return this.built.get(eol); }

  /** Which line ending this checkout must use to match `code`, or null when neither build matches (another commit). */
  eolFor(code) {
    const c = String(code).toLowerCase();
    return EOLS.find(e => this.runtimeFor(e) === c) ?? null;
  }

  /**
   * One run for one chain. `tokens`: [{ address }] launched on this chain's V2 launchpad. `state`: { get, set } (the
   * keeper's store). Returns { submitted: [{ address, ok, detail }], pending } where pending counts tokens left for later.
   */
  async run({ chainId, provider, hook, tokens, state, now }) {
    const apiKey = this.keyFor(chainId);
    if (apiKey === null) return { submitted: [], pending: 0 };
    const perTick = needsApiKey(chainId) || this.blockscoutKey ? this.perTick : this.blockscoutPerTick;
    const key = a => `verify:${chainId}:${String(a).toLowerCase()}`;
    const due = tokens.filter(t => {
      const s = state.get(key(t.address), null);
      // Right after launch the explorer may not have the contract yet: the first two retries come after 2 minutes.
      return !s || (!s.ok && !s.gaveUp && now - (s.at ?? 0) >= ((s.attempts ?? 1) < 3 ? Math.min(120, this.retryAfter) : this.retryAfter));
    });
    const submitted = [];
    for (const t of due.slice(0, perTick)) {
      const address = getAddress(String(t.address).toLowerCase()), prev = state.get(key(address), null), attempts = (prev?.attempts ?? 0) + 1;
      let result;
      try {
        if (await isVerified({ fetch: this.fetchImpl, sleep: this.sleep, chainId, apiKey, address })) result = { ok: true, detail: 'already verified' };
        else {
          const eol = this.eolFor(await provider.getCode(address));
          if (!eol) result = { ok: false, detail: 'the code on chain is not an ElpidaV2Token built from this checkout', final: true };
          else {
            const c = new Contract(address, TOKEN, provider), [name, symbol] = await Promise.all([c.name(), c.symbol()]);
            result = await submit({ fetch: this.fetchImpl, sleep: this.sleep, chainId, apiKey, input: standardInput(TOKEN_CONTRACT, { eol }),
              job: { address, contractName: TOKEN_CONTRACT, eol, args: tokenArgs(name, symbol, hook) } });
          }
        }
      } catch (e) { result = { ok: false, detail: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) }; }
      state.set(key(address), { ok: result.ok, detail: result.detail, at: now, attempts, gaveUp: !result.ok && (result.final || attempts >= this.maxAttempts) });
      submitted.push({ address, ok: result.ok, detail: result.detail });
    }
    return { submitted, pending: Math.max(0, due.length - submitted.length) };
  }
}
