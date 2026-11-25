// ELPIDA V2 X and website allocations on test networks (contracts/evm/v2/ElpidaV2IdentityAllocation.sol). A creator can
// give part of their 30% to an X account or a website. That share is held until its owner proves control and signs for
// a payout wallet; then the V2 keeper, the allocation's verifier, binds that wallet (once). Websites prove control with a
// DNS TXT record at _elpida.<domain>; X accounts with X sign-in (when the server has an X app: ELPIDA_X_CLIENT_ID and
// ELPIDA_X_REDIRECT_URI); GitHub (EVM networks; Malik, 25 Nov 2026) with a public file: a repository ("github:owner/repo")
// with elpida-claim.txt on its default branch, an account ("github:owner") with a public gist. Only someone who can push
// to the repository, or sign in as the account, can publish either. The same rules as the local simulation
// (apps/api/reward-engine.mjs) for X and websites; GitHub rows are public-network only.
import { randomBytes, createPublicKey, verify as verifySignature } from 'node:crypto';
import * as web3 from '@solana/web3.js';
const { PublicKey } = web3;
import { decodeCreatorVault } from '../../packages/solana/client.mjs';
import { resolveTxt } from 'node:dns/promises';
import { Contract, ZeroAddress, getAddress, isAddress, verifyMessage } from 'ethers';
import { XVerification } from './x-verification.mjs';

const ALLOCATION = ['function IDENTITY_ALLOCATION_VERSION() view returns(uint256)', 'function verifier() view returns(address)', 'function rowCount() view returns(uint256)',
  'function row(uint256) view returns(string label,address wallet,uint16 share)', 'function bind(uint256,address)'];
const TEN_MINUTES = 600_000;
/** The file a repository owner adds to the repository's default branch to verify a GitHub repository allocation. */
export const GITHUB_CLAIM_FILE = 'elpida-claim.txt';
const GITHUB_OWNER = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/, GITHUB_REPO = /^[a-z0-9._-]{1,100}$/;
/** A GitHub allocation target: "owner" or "owner/repo", lowercase. */
export const githubTarget = t => { const [o, r, ...more] = String(t ?? '').split('/'); return !more.length && GITHUB_OWNER.test(o) && (r === undefined || (GITHUB_REPO.test(r) && !/^\.+$/.test(r))); };
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const solanaNetwork = n => String(n ?? '').startsWith('solana-');
/** An ed25519 signature (base64 or hex) of `message` by a Solana wallet (base58). */
function solanaSigned(message, signature, wallet) {
  try {
    const sig = /^[0-9a-f]{128}$/i.test(String(signature)) ? Buffer.from(signature, 'hex') : Buffer.from(String(signature ?? ''), 'base64');
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(new PublicKey(wallet).toBytes())]), format: 'der', type: 'spki' });
    return sig.length === 64 && verifySignature(null, Buffer.from(message), key, sig);
  } catch { return false; }
}

/** Where an owner lands after X sign-in: the token's claim page on the rewards screen (safe characters only). */
/**
 * The claim page with the X sign-in result for the page to show (Malik, 11 Nov: a proper page, not plain text):
 * `x=verified&handle=…&wallet=…` or `x=failed&reason=…`. Everything is URL-encoded; the page renders it as text.
 */
export const xResultLink = (back, result) => `${back}${back.includes('?') ? '&' : '?'}${new URLSearchParams(result.ok
  ? { x: 'verified', handle: String(result.handle ?? ''), wallet: String(result.wallet ?? '') }
  : { x: 'failed', reason: String(result.reason ?? 'X verification failed.').slice(0, 200) })}`;

export const claimLink = c => (c?.token && /^[a-z0-9-]{1,40}$/.test(String(c.network)) && (isAddress(c.token) || BASE58.test(String(c.token))) ? { back: `/#/rewards?claim=${isAddress(c.token) ? getAddress(c.token) : c.token}&network=${c.network}` } : { back: '/#/rewards' });

export class V2Identities {
  /** `signerFor(networkKey)`: the V2 keeper on that network as { signer, chainId }, or null. */
  /** `solanaKeeper()`: the Solana V2 keeper (operator of creator vaults; `bindCreatorRow`), or null. */
  /** `fetcher`: fetch for the GitHub checks; `githubToken` (optional, ELPIDA_GITHUB_TOKEN) lifts GitHub's 60-an-hour limit. */
  constructor({ signerFor, solanaKeeper = () => null, x = new XVerification(), dnsResolver = resolveTxt, now = () => Date.now(), fetcher = (...a) => fetch(...a), githubToken = process.env.ELPIDA_GITHUB_TOKEN }) {
    Object.assign(this, { signerFor, solanaKeeper, x, dnsResolver, now, fetcher, githubToken });
    this.challenges = new Map();
  }

  get xEnabled() { return this.x.enabled; }

  /** The allocation row, checked: an Elpida identity allocation whose verifier is this server's keeper on `network`. */
  async row(network, vault, index) {
    if (solanaNetwork(network)) return this.solanaRow(vault, index);
    const keeper = this.signerFor(String(network ?? ''));
    if (!keeper) throw new Error('The Elpida V2 keeper is not running on this network, so ownership cannot be verified yet.');
    if (!isAddress(vault) || !Number.isInteger(index) || index < 0 || index > 7) throw new Error('Choose an allocation of a V2 token.');
    const c = new Contract(getAddress(vault), ALLOCATION, keeper.signer);
    try { if ((await c.IDENTITY_ALLOCATION_VERSION()) !== 1n) throw new Error(); } catch { throw new Error('That is not an Elpida allocation contract.'); }
    if ((await c.verifier()).toLowerCase() !== (await keeper.signer.getAddress()).toLowerCase()) throw new Error('This allocation is verified by another server.');
    if (index >= Number(await c.rowCount())) throw new Error('Allocation not found.');
    const r = await c.row(index), [kind, ...rest] = String(r.label).split(':'), target = rest.join(':');
    if (!['x', 'domain', 'github'].includes(kind) || !target) throw new Error('Wallet allocations need no verification.');
    if (kind === 'github' && !githubTarget(target)) throw new Error('That GitHub allocation is not a valid account or repository.');
    return { contract: c, chainId: keeper.chainId, kind, target, wallet: r.wallet };
  }

  /** Solana: an X or website row of a creator vault (`vault`: the token's mint) operated by this server's keeper. */
  async solanaRow(mint, index) {
    const keeper = this.solanaKeeper();
    if (!keeper?.enabled) throw new Error('The Elpida keeper is not running on Solana, so ownership cannot be verified yet.');
    if (!BASE58.test(String(mint ?? '')) || !Number.isInteger(index) || index < 0 || index > 7) throw new Error('Choose an allocation of a V2 token.');
    const v = decodeCreatorVault((await keeper.connection.getAccountInfo(keeper.client.creatorVaultFor(new PublicKey(mint))))?.data, web3);
    if (!v || v.mode !== 0) throw new Error('That token has no allocation vault.');
    if (!v.operator.equals(keeper.payer.publicKey)) throw new Error('This allocation is verified by another server.');
    const r = v.rows.find(x => x.index === index);
    if (!r) throw new Error('Allocation not found.');
    const [kind, ...rest] = r.label.split(':'), target = rest.join(':');
    if (!['x', 'domain'].includes(kind) || !target) throw new Error('Wallet allocations need no verification.');
    return { solana: true, mint, chainId: 'solana', kind, target, wallet: r.wallet ? r.wallet.toBase58() : ZeroAddress };
  }

  /** A signed claim for one X or website allocation: the message to sign and, for a website, the DNS record to add. */
  async challenge({ network, vault, index, wallet, token }) {
    index = Number(index);
    const sol = solanaNetwork(network);
    if (sol ? !BASE58.test(String(wallet ?? '')) : !isAddress(wallet) || wallet === ZeroAddress) throw new Error('Connect the wallet that should receive this share.');
    const row = await this.row(network, vault, index);
    if (row.wallet !== ZeroAddress) throw new Error('This allocation already pays a verified wallet.');
    if (row.kind === 'x' && !this.x.enabled) throw new Error('X sign-in is not set up on this server yet. This share stays held until it is.');
    const now = this.now();
    for (const [k, c] of this.challenges) if (c.expires < now) this.challenges.delete(k);
    if (this.challenges.size > 1000) throw new Error('Too many verification requests right now. Try again in a few minutes.');
    const nonce = randomBytes(24).toString('hex'), expires = now + TEN_MINUTES, w = sol ? String(wallet) : getAddress(wallet).toLowerCase(), v = sol ? String(vault) : getAddress(vault).toLowerCase();
    const txt = `elpida-claim=${nonce};wallet=${w};vault=${v}`;
    const message = `Elpida ${row.kind} reward claim\nChain: ${sol ? network : row.chainId}\nVault: ${sol ? vault : getAddress(vault)}\nIdentity: ${row.target}\nWallet: ${w}\nNonce: ${nonce}\nExpires: ${expires}`;
    // The token (optional) only shapes the link back to its claim page after X sign-in.
    this.challenges.set(nonce, { network: String(network), vault: sol ? String(vault) : getAddress(vault), index, wallet: w, kind: row.kind, target: row.target, expires, txt, message, token: sol ? (BASE58.test(String(token ?? '')) ? String(token) : null) : isAddress(token) ? getAddress(token) : null });
    return { nonce, expires, message, kind: row.kind, target: row.target, ...(row.kind === 'domain' ? { name: `_elpida.${row.target}`, txt } : {}),
      ...(row.kind === 'github' ? (row.target.includes('/') ? { file: GITHUB_CLAIM_FILE, url: `https://github.com/${row.target}`, txt } : { gist: true, url: 'https://gist.github.com', txt }) : {}) };
  }

  claim(nonce, signature, kind) {
    const c = this.challenges.get(String(nonce ?? ''));
    if (!c || c.expires < this.now()) throw new Error('This verification expired. Start again.');
    if (c.kind !== kind) throw new Error(c.kind === 'x' ? 'Use X sign-in for an X account.' : c.kind === 'github' ? 'Use the GitHub check for a GitHub account or repository.' : 'Use the DNS check for a website.');
    if (solanaNetwork(c.network)) { if (!solanaSigned(c.message, signature, c.wallet)) throw new Error('The signature does not match the payout wallet.'); return c; }
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

  /**
   * GitHub: the signed claim's line must be public. A repository: elpida-claim.txt on its default branch (only people who
   * can push to it can add it). An account: one of its newest public gists (only the account can create those).
   */
  async verifyGithub({ nonce, signature }) {
    const c = this.claim(nonce, signature, 'github');
    const found = c.target.includes('/') ? await this.githubRepoHas(c.target, c.txt) : await this.githubGistHas(c.target, c.txt);
    if (!found) throw new Error(c.target.includes('/')
      ? `${GITHUB_CLAIM_FILE} with the claim line is not visible on ${c.target}'s default branch yet. GitHub can take a few minutes to show a new commit.`
      : `No public gist of ${c.target} shows the claim line yet. Create the gist while signed in as ${c.target}, then check again.`);
    await this.bind(c); this.challenges.delete(String(nonce));
    return { message: `GitHub ${c.target} verified. Its share now pays ${c.wallet}.` };
  }

  async githubText(url) {
    const headers = { 'User-Agent': 'elpida-verifier', Accept: url.startsWith('https://api.github.com/') ? 'application/vnd.github+json' : 'text/plain' };
    if (this.githubToken && url.startsWith('https://api.github.com/')) headers.Authorization = `Bearer ${this.githubToken}`;
    let res; try { res = await this.fetcher(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) }); } catch { throw new Error('GitHub could not be reached. Try again in a minute.'); }
    if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests right now. Try again in a few minutes.');
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > 200_000 ? null : text;
  }

  async githubRepoHas(target, txt) {
    const text = await this.githubText(`https://raw.githubusercontent.com/${target}/HEAD/${GITHUB_CLAIM_FILE}`);
    return !!text && text.split(/\r?\n/).some(l => l.trim() === txt);
  }

  async githubGistHas(owner, txt) {
    const list = await this.githubText(`https://api.github.com/users/${owner}/gists?per_page=30`);
    let gists = []; try { gists = JSON.parse(list ?? '[]'); } catch { gists = []; }
    for (const g of Array.isArray(gists) ? gists : []) {
      if (String(g?.owner?.login ?? '').toLowerCase() !== owner || g?.public !== true) continue;
      for (const f of Object.values(g.files ?? {})) {
        const raw = String(f?.raw_url ?? '');
        if (!raw.startsWith('https://gist.githubusercontent.com/') || Number(f?.size ?? 0) > 20_000) continue;
        const text = await this.githubText(raw);
        if (text && text.split(/\r?\n/).some(l => l.trim() === txt)) return true;
      }
    }
    return false;
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
    if (row.solana) { await this.solanaKeeper().bindCreatorRow(c.vault, c.index, c.wallet); return; }
    await (await row.contract.bind(c.index, c.wallet)).wait();
  }
}
