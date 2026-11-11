// ELPIDA V2 X and website allocations on test networks (contracts/evm/v2/ElpidaV2IdentityAllocation.sol). A creator can
// give part of their 30% to an X account or a website. That share is held until its owner proves control and signs for
// a payout wallet; then the V2 keeper, the allocation's verifier, binds that wallet (once). Websites prove control with a
// DNS TXT record at _elpida.<domain>; X accounts with X sign-in (when the server has an X app: ELPIDA_X_CLIENT_ID and
// ELPIDA_X_REDIRECT_URI). The same rules as the local simulation (apps/api/reward-engine.mjs).
import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { Contract, ZeroAddress, getAddress, isAddress, verifyMessage } from 'ethers';
import { XVerification } from './x-verification.mjs';

const ALLOCATION = ['function IDENTITY_ALLOCATION_VERSION() view returns(uint256)', 'function verifier() view returns(address)', 'function rowCount() view returns(uint256)',
  'function row(uint256) view returns(string label,address wallet,uint16 share)', 'function bind(uint256,address)'];
const TEN_MINUTES = 600_000;

/** Where an owner lands after X sign-in: the token's claim page on the rewards screen (safe characters only). */
/**
 * The claim page with the X sign-in result for the page to show (Malik, 11 Nov: a proper page, not plain text):
 * `x=verified&handle=…&wallet=…` or `x=failed&reason=…`. Everything is URL-encoded; the page renders it as text.
 */
export const xResultLink = (back, result) => `${back}${back.includes('?') ? '&' : '?'}${new URLSearchParams(result.ok
  ? { x: 'verified', handle: String(result.handle ?? ''), wallet: String(result.wallet ?? '') }
  : { x: 'failed', reason: String(result.reason ?? 'X verification failed.').slice(0, 200) })}`;

export const claimLink = c => (c?.token && /^[a-z0-9-]{1,40}$/.test(String(c.network)) && isAddress(c.token) ? { back: `/#/rewards?claim=${getAddress(c.token)}&network=${c.network}` } : { back: '/#/rewards' });

export class V2Identities {
  /** `signerFor(networkKey)`: the V2 keeper on that network as { signer, chainId }, or null. */
  constructor({ signerFor, x = new XVerification(), dnsResolver = resolveTxt, now = () => Date.now() }) {
    Object.assign(this, { signerFor, x, dnsResolver, now });
    this.challenges = new Map();
  }

  get xEnabled() { return this.x.enabled; }

  /** The allocation row, checked: an Elpida identity allocation whose verifier is this server's keeper on `network`. */
  async row(network, vault, index) {
    const keeper = this.signerFor(String(network ?? ''));
    if (!keeper) throw new Error('The Elpida V2 keeper is not running on this network, so ownership cannot be verified yet.');
    if (!isAddress(vault) || !Number.isInteger(index) || index < 0 || index > 7) throw new Error('Choose an allocation of a V2 token.');
    const c = new Contract(getAddress(vault), ALLOCATION, keeper.signer);
    try { if ((await c.IDENTITY_ALLOCATION_VERSION()) !== 1n) throw new Error(); } catch { throw new Error('That is not an Elpida allocation contract.'); }
    if ((await c.verifier()).toLowerCase() !== (await keeper.signer.getAddress()).toLowerCase()) throw new Error('This allocation is verified by another server.');
    if (index >= Number(await c.rowCount())) throw new Error('Allocation not found.');
    const r = await c.row(index), [kind, ...rest] = String(r.label).split(':'), target = rest.join(':');
    if (!['x', 'domain'].includes(kind) || !target) throw new Error('Wallet allocations need no verification.');
    return { contract: c, chainId: keeper.chainId, kind, target, wallet: r.wallet };
  }

  /** A signed claim for one X or website allocation: the message to sign and, for a website, the DNS record to add. */
  async challenge({ network, vault, index, wallet, token }) {
    index = Number(index);
    if (!isAddress(wallet) || wallet === ZeroAddress) throw new Error('Connect the wallet that should receive this share.');
    const row = await this.row(network, vault, index);
    if (row.wallet !== ZeroAddress) throw new Error('This allocation already pays a verified wallet.');
    if (row.kind === 'x' && !this.x.enabled) throw new Error('X sign-in is not set up on this server yet. This share stays held until it is.');
    const now = this.now();
    for (const [k, c] of this.challenges) if (c.expires < now) this.challenges.delete(k);
    if (this.challenges.size > 1000) throw new Error('Too many verification requests right now. Try again in a few minutes.');
    const nonce = randomBytes(24).toString('hex'), expires = now + TEN_MINUTES, w = getAddress(wallet).toLowerCase(), v = getAddress(vault).toLowerCase();
    const txt = `elpida-claim=${nonce};wallet=${w};vault=${v}`;
    const message = `Elpida ${row.kind} reward claim\nChain: ${row.chainId}\nVault: ${getAddress(vault)}\nIdentity: ${row.target}\nWallet: ${w}\nNonce: ${nonce}\nExpires: ${expires}`;
    // The token (optional) only shapes the link back to its claim page after X sign-in.
    this.challenges.set(nonce, { network: String(network), vault: getAddress(vault), index, wallet: w, kind: row.kind, target: row.target, expires, txt, message, token: isAddress(token) ? getAddress(token) : null });
    return { nonce, expires, message, kind: row.kind, target: row.target, ...(row.kind === 'domain' ? { name: `_elpida.${row.target}`, txt } : {}) };
  }

  claim(nonce, signature, kind) {
    const c = this.challenges.get(String(nonce ?? ''));
    if (!c || c.expires < this.now()) throw new Error('This verification expired. Start again.');
    if (c.kind !== kind) throw new Error(kind === 'domain' ? 'Use X sign-in for an X account.' : 'Use the DNS check for a website.');
    let signer = ''; try { signer = verifyMessage(c.message, String(signature ?? '')).toLowerCase(); } catch { signer = ''; }
    if (signer !== c.wallet) throw new Error('The signature does not match the payout wallet.');
    return c;
  }

  /** Website: the TXT record must be visible; then the keeper binds the signed wallet. */
  async verifyDomain({ nonce, signature }) {
    const c = this.claim(nonce, signature, 'domain');
    let records = [];
    try { records = await this.dnsResolver(`_elpida.${c.target}`); } catch { records = []; }
    if (!records.some(r => r.join('') === c.txt)) throw new Error(`The TXT record at _elpida.${c.target} is not visible yet. DNS changes can take a few minutes.`);
    await this.bind(c); this.challenges.delete(String(nonce));
    return { message: `${c.target} verified. Its share now pays ${c.wallet}.` };
  }

  /** X: after the signature, the owner signs in to X; the callback finishes it. Returns { url, cookie }. */
  startX({ nonce, signature }) {
    const c = this.claim(nonce, signature, 'x');
    this.challenges.delete(String(nonce));
    return this.x.begin({ ...c, target: c.target.replace(/^@/, '').toLowerCase() });
  }

  owns(state) { return !!state && this.x.sessions?.has?.(state); }
  /** The claim page this X sign-in started from, read before finishing (so a failure still returns there). */
  backFor(state) { const s = this.x.sessions?.get?.(state); return claimLink(s?.claim ?? s).back; }

  async finishX(params) {
    const c = await this.x.complete(params);
    await this.bind(c);
    return { message: `@${c.target} verified. Its share now pays ${c.wallet}.`, handle: c.target, wallet: c.wallet, ...claimLink(c) };
  }

  async bind(c) {
    const row = await this.row(c.network, c.vault, c.index);
    if (row.wallet !== ZeroAddress) throw new Error('This allocation already pays a verified wallet.');
    await (await row.contract.bind(c.index, c.wallet)).wait();
  }
}
