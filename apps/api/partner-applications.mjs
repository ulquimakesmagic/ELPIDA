import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createPublicKey, verify } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { verifyMessage, Interface, getAddress, Contract } from 'ethers';
import { PublicKey } from '@solana/web3.js';

// Early-partner applications (docs/DESIGN_PARTNER_TIERS.md section 3). A dev applies from the footer form and signs
// one free message per launching wallet to prove they control it. Operators review applications in the admin panel.
// Approving records the tier and expiry here and prepares the factory's setPartner call, which only the treasury
// wallet can sign: nothing in this module holds a key or sends a transaction, and the chain stays the source of
// truth for whether a wallet is a partner. Applications are never public. Contact details are kept to a minimum and
// erased from rejected applications after RETAIN_REJECTED_DAYS.

export const TIERS = { partner: 1000, elite: 2000 };
export const TERMS_VERSION = 1;
const CHALLENGE_TTL = 15 * 60 * 1000;
const MAX_CHALLENGES = 500;
const MAX_APPLICATIONS = 2000;
const RETAIN_REJECTED_DAYS = 180;
const MAX_WINDOW_DAYS = 180; // the factory's MAX_PARTNER_WINDOW
const EVM = /^0x[0-9a-fA-F]{40}$/;
const registryAbi = ['function setPartner(address creator,uint16 buybackBps,uint64 expiresAt)', 'function partners(address) view returns (uint16 buybackBps,uint64 expiresAt)', 'function PARTNER_TIERS_VERSION() pure returns (uint256)'];
export const registry = new Interface(registryAbi);

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** A wallet in canonical form for its kind, or throws. EVM addresses are lower-cased; Solana keys are base58. */
export function walletOf(kind, address) {
  if (kind === 'evm') { if (!EVM.test(String(address ?? ''))) throw fail('Enter a valid EVM wallet address.'); return String(address).toLowerCase(); }
  if (kind === 'solana') { try { const key = new PublicKey(String(address ?? '')); return key.toBase58(); } catch { throw fail('Enter a valid Solana wallet address.'); } }
  throw fail('Unknown wallet kind.');
}

/** Clean and check the form fields. Returns the stored shape or throws a message safe to show. */
export function cleanApplication(body) {
  const text = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
  const handle = (v, re, what) => { const s = text(v, 40).replace(/^@/, ''); if (s && !re.test(s)) throw fail(`Enter a valid ${what}.`); return s; };
  const x = handle(body.x, /^[A-Za-z0-9_]{1,15}$/, 'X handle');
  const telegram = handle(body.telegram, /^[A-Za-z0-9_]{5,32}$/, 'Telegram username');
  if (!x && !telegram) throw fail('Give an X handle or a Telegram username so we can reach you.');
  const email = text(body.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Enter a valid email address, or leave it empty.');
  const tier = String(body.tier ?? 'partner');
  if (!TIERS[tier]) throw fail('Choose the Partner or Elite tier.');
  const pitch = text(body.pitch, 1200);
  if (pitch.length < 20) throw fail('Tell us about your project in at least a sentence.');
  const links = (Array.isArray(body.links) ? body.links : String(body.links ?? '').split(/\s+/)).map(l => text(l, 200)).filter(Boolean);
  if (links.length > 5) throw fail('Add at most five links.');
  for (const l of links) { let u; try { u = new URL(l); } catch { throw fail(`Not a link: ${l.slice(0, 60)}`); } if (u.protocol !== 'https:') throw fail('Links must start with https://.'); }
  if (body.acceptTerms !== true) throw fail('Accept the partner terms to apply.');
  return { x, telegram, email, tier, pitch, links };
}

/** The setPartner call for one EVM chain: `to` is the factory, `data` the calldata. Ending a partnership is (0, 0). */
export function registrationCall(factory, creator, buybackBps, expiresAt) {
  return { to: factory, value: '0', data: registry.encodeFunctionData('setPartner', [getAddress(creator), buybackBps, buybackBps ? BigInt(expiresAt) : 0n]) };
}

export class PartnerApplications {
  constructor({ path = ':memory:', host = 'elpida', now = () => Date.now(), random = n => randomBytes(n).toString('hex') } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path); this.host = host; this.now = now; this.random = random;
    this.db.exec(`CREATE TABLE IF NOT EXISTS partner_challenges(nonce TEXT PRIMARY KEY, kind TEXT NOT NULL, wallet TEXT NOT NULL, message TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS partner_applications(id TEXT PRIMARY KEY, created INTEGER NOT NULL, status TEXT NOT NULL, evm TEXT, solana TEXT,
        x TEXT, telegram TEXT, email TEXT, tier TEXT NOT NULL, pitch TEXT, links TEXT NOT NULL, terms INTEGER NOT NULL,
        decided INTEGER, decided_by TEXT, approved_tier TEXT, buyback_bps INTEGER, expires_at INTEGER, chains TEXT, notes TEXT NOT NULL DEFAULT '[]');
      CREATE INDEX IF NOT EXISTS partner_applications_status ON partner_applications(status, created);`);
    this.purge();
  }

  /** A single-use message for one wallet. */
  challenge({ kind, address }) {
    const wallet = walletOf(kind, address), now = this.now();
    this.db.prepare('DELETE FROM partner_challenges WHERE expires<?').run(now);
    if (this.db.prepare('SELECT COUNT(*) AS n FROM partner_challenges').get().n >= MAX_CHALLENGES) throw fail('Applications are busy. Try again in a few minutes.', 429);
    const nonce = this.random(16), expires = now + CHALLENGE_TTL;
    const message = `Elpida partner application\nSite: ${this.host}\nWallet: ${wallet}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\n\nSigning proves you control the wallet that will launch. It costs nothing and sends no transaction.`;
    this.db.prepare('INSERT INTO partner_challenges VALUES(?,?,?,?,?)').run(nonce, kind, wallet, message, expires);
    return { nonce, message, expires, wallet };
  }

  /** Check one wallet proof and consume its challenge. Returns the canonical wallet. */
  #prove(kind, proof) {
    const wallet = walletOf(kind, proof?.address), nonce = String(proof?.nonce ?? '');
    const c = this.db.prepare('SELECT * FROM partner_challenges WHERE nonce=?').get(nonce);
    this.db.prepare('DELETE FROM partner_challenges WHERE nonce=?').run(nonce);
    if (!c || c.expires < this.now() || c.kind !== kind || c.wallet !== wallet) throw fail('Your wallet signature expired. Sign again.');
    let ok = false;
    try {
      if (kind === 'evm') ok = verifyMessage(c.message, String(proof.signature ?? '')).toLowerCase() === wallet;
      else {
        const signature = Buffer.from(String(proof.signature ?? ''), 'base64');
        const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(wallet).toBuffer()]), format: 'der', type: 'spki' });
        ok = signature.length === 64 && verify(null, Buffer.from(c.message), key, signature);
      }
    } catch { ok = false; }
    if (!ok) throw fail(`The ${kind === 'evm' ? 'EVM' : 'Solana'} signature does not match that wallet.`, 401);
    return wallet;
  }

  /** Store an application. At least one launching wallet, each proven by its signature. One open application per wallet. */
  apply(body) {
    const form = cleanApplication(body ?? {});
    if (!body.evm && !body.solana) throw fail('Add at least one launching wallet and sign with it.');
    const evm = body.evm ? this.#prove('evm', body.evm) : null, solana = body.solana ? this.#prove('solana', body.solana) : null;
    const open = this.db.prepare(`SELECT id FROM partner_applications WHERE status IN ('pending','approved') AND ((evm IS NOT NULL AND evm=?) OR (solana IS NOT NULL AND solana=?))`).get(evm, solana);
    if (open) throw fail('This wallet already has an open application or partnership. We will reach out on X or Telegram.', 409);
    if (this.db.prepare('SELECT COUNT(*) AS n FROM partner_applications').get().n >= MAX_APPLICATIONS) throw fail('Applications are closed for now. Reach us on X or Telegram.', 503);
    const id = this.random(8), created = this.now();
    this.db.prepare(`INSERT INTO partner_applications(id,created,status,evm,solana,x,telegram,email,tier,pitch,links,terms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, created, 'pending', evm, solana, form.x, form.telegram, form.email, form.tier, form.pitch, JSON.stringify(form.links), TERMS_VERSION);
    return { id, status: 'pending', created };
  }

  row(id) { const r = this.db.prepare('SELECT * FROM partner_applications WHERE id=?').get(String(id ?? '')); return r ? shape(r) : null; }

  /** Applications for the admin panel, newest first, with open ones on top. */
  list({ status } = {}) {
    this.purge();
    const rows = status ? this.db.prepare('SELECT * FROM partner_applications WHERE status=? ORDER BY created DESC LIMIT 500').all(status)
      : this.db.prepare(`SELECT * FROM partner_applications ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created DESC LIMIT 500`).all();
    return rows.map(shape);
  }

  /**
   * An operator's decision. `approve` takes { tier, days, chains }: the expiry is fixed now, so every chain is
   * registered with the same date. `reject` and `end` close the application; `note` only adds a note. Every action
   * is recorded in the notes with the operator's address.
   */
  review(id, { decision, tier, days, chains, note } = {}, operator) {
    const r = this.db.prepare('SELECT * FROM partner_applications WHERE id=?').get(String(id ?? ''));
    if (!r) throw fail('Application not found.', 404);
    const now = this.now(), text = String(note ?? '').trim().slice(0, 500);
    const notes = JSON.parse(r.notes);
    const log = action => notes.push({ at: now, by: operator, action, ...(text ? { note: text } : {}) });
    if (decision === 'note') { if (!text) throw fail('Write a note.'); log('note'); }
    else if (decision === 'approve') {
      if (r.status !== 'pending') throw fail('Only a pending application can be approved.', 409);
      if (!TIERS[tier]) throw fail('Choose Partner or Elite.');
      const d = Number(days);
      if (!Number.isInteger(d) || d < 1 || d > MAX_WINDOW_DAYS) throw fail(`The window must be 1 to ${MAX_WINDOW_DAYS} days.`);
      const list = [...new Set((Array.isArray(chains) ? chains : []).map(String))].filter(k => /^[a-z0-9-]{2,40}$/.test(k));
      if (!list.length) throw fail('Choose at least one chain to register.');
      if (list.some(k => !k.startsWith('solana-')) && !r.evm) throw fail('This applicant gave no EVM wallet.');
      if (list.some(k => k.startsWith('solana-')) && !r.solana) throw fail('This applicant gave no Solana wallet.');
      const expiresAt = Math.floor(now / 1000) + d * 86400;
      log(`approve ${tier} ${d}d`);
      this.db.prepare('UPDATE partner_applications SET status=?,decided=?,decided_by=?,approved_tier=?,buyback_bps=?,expires_at=?,chains=?,notes=? WHERE id=?')
        .run('approved', now, operator, tier, TIERS[tier], expiresAt, JSON.stringify(list), JSON.stringify(notes), r.id);
      return this.row(r.id);
    } else if (decision === 'reject') {
      if (r.status !== 'pending') throw fail('Only a pending application can be rejected.', 409);
      log('reject');
      this.db.prepare('UPDATE partner_applications SET status=?,decided=?,decided_by=?,notes=? WHERE id=?').run('rejected', now, operator, JSON.stringify(notes), r.id);
      return this.row(r.id);
    } else if (decision === 'end') {
      if (r.status !== 'approved') throw fail('Only an active partnership can be ended.', 409);
      log('end');
      this.db.prepare('UPDATE partner_applications SET status=?,notes=? WHERE id=?').run('ended', JSON.stringify(notes), r.id);
      return this.row(r.id);
    } else throw fail('Unknown decision.');
    this.db.prepare('UPDATE partner_applications SET notes=? WHERE id=?').run(JSON.stringify(notes), r.id);
    return this.row(r.id);
  }

  /** Erase contact details and the pitch from applications rejected long ago; the decision record stays. */
  purge() {
    const cutoff = this.now() - RETAIN_REJECTED_DAYS * 86400 * 1000;
    this.db.prepare(`UPDATE partner_applications SET x=NULL,telegram=NULL,email=NULL,pitch=NULL,links='[]' WHERE status='rejected' AND decided<? AND pitch IS NOT NULL`).run(cutoff);
  }

  counts() { return Object.fromEntries(this.db.prepare('SELECT status, COUNT(*) AS n FROM partner_applications GROUP BY status').all().map(r => [r.status, r.n])); }
}

function shape(r) {
  return {
    id: r.id, created: r.created, status: r.status, evm: r.evm, solana: r.solana, x: r.x, telegram: r.telegram, email: r.email,
    tier: r.tier, pitch: r.pitch, links: JSON.parse(r.links), terms: r.terms, decided: r.decided, decidedBy: r.decided_by,
    approved: r.approved_tier ? { tier: r.approved_tier, buybackBps: r.buyback_bps, expiresAt: r.expires_at, chains: JSON.parse(r.chains ?? '[]') } : null,
    notes: JSON.parse(r.notes),
  };
}

/**
 * What each approved partner's wallet holds on chain, per EVM network: `registered` when the factory's record matches
 * the approval, `different` when it holds other terms, `none`, `unsupported` for a factory without the registry, or
 * `error`. Ended partnerships are checked too, so the panel can show a tier still waiting to be cleared.
 */
export async function registryStatus(applications, networks, { contract, timeoutMs = 8000, nowSeconds = () => Math.floor(Date.now() / 1000) } = {}) {
  const make = contract ?? ((address, provider) => new Contract(address, registryAbi, provider));
  const within = p => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('RPC timed out')), timeoutMs))]);
  const out = {};
  const supported = new Map();
  for (const n of networks) {
    if (!n.factory) { supported.set(n.key, 'No factory configured.'); continue; }
    try { await within(make(n.factory, n.provider).PARTNER_TIERS_VERSION()); supported.set(n.key, true); }
    catch (e) { supported.set(n.key, /CALL_EXCEPTION|BAD_DATA|revert|could not decode/i.test(`${e.code ?? ''} ${e.message ?? ''}`) ? 'unsupported' : String(e.shortMessage ?? e.message).slice(0, 120)); }
  }
  for (const a of applications) {
    if (!a.evm || !a.approved || !['approved', 'ended'].includes(a.status)) continue;
    out[a.id] = {};
    for (const n of networks) {
      if (!a.approved.chains.includes(n.key)) continue;
      const s = supported.get(n.key);
      if (s === 'unsupported') { out[a.id][n.key] = { state: 'unsupported' }; continue; }
      if (s !== true) { out[a.id][n.key] = { state: 'error', error: s }; continue; }
      try {
        const [bps, expiresAt] = await within(make(n.factory, n.provider).partners(a.evm));
        const live = Number(bps) > 0 && Number(expiresAt) > nowSeconds();
        const state = Number(bps) === 0 ? 'none' : Number(bps) === a.approved.buybackBps && Number(expiresAt) === a.approved.expiresAt ? 'registered' : 'different';
        out[a.id][n.key] = { state, live, buybackBps: Number(bps), expiresAt: Number(expiresAt) };
      } catch (e) { out[a.id][n.key] = { state: 'error', error: String(e.shortMessage ?? e.message).slice(0, 120) }; }
    }
  }
  return out;
}


/**
 * The Solana side: whether the deployed program has partner tiers (an empty `partner_tiers_version` simulated with
 * the treasury as fee payer), and each approved partner's `["partner", wallet]` record. Same states as EVM; an
 * older program reads as `unsupported`. `client` is createElpidaSolana; `now` in seconds.
 */
export async function solanaPartnerStatus(applications, { connection, web3, client, treasury, nowSeconds = () => Math.floor(Date.now() / 1000), timeoutMs = 8000 }) {
  const within = p => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('RPC timed out')), timeoutMs))]);
  let supported;
  try {
    const { blockhash } = await within(connection.getLatestBlockhash('confirmed'));
    const probe = new web3.Transaction({ feePayer: new web3.PublicKey(treasury), recentBlockhash: blockhash }).add(new web3.TransactionInstruction({ programId: client.programId, keys: [], data: Buffer.from([189, 128, 102, 138, 53, 239, 157, 14]) }));
    const { value } = await within(connection.simulateTransaction(probe));
    supported = value.err === null ? true : value.err?.InstructionError?.[1]?.Custom === 101 ? false : `Version check failed: ${JSON.stringify(value.err).slice(0, 80)}`;
  } catch (e) { supported = String(e.message).slice(0, 120); }
  const wanted = applications.filter(a => a.solana && a.approved && ['approved', 'ended'].includes(a.status) && a.approved.chains.some(k => k.startsWith('solana-')));
  const out = {};
  if (supported !== true) {
    for (const a of wanted) out[a.id] = supported === false ? { state: 'unsupported' } : { state: 'error', error: supported };
    return { supported, records: out };
  }
  try {
    const infos = wanted.length ? await within(connection.getMultipleAccountsInfo(wanted.map(a => client.partnerPda(a.solana)))) : [];
    wanted.forEach((a, i) => {
      const p = client.decodePartner(infos[i]?.data, nowSeconds());
      if (!p || p.buybackBps === 0) { out[a.id] = { state: 'none' }; return; }
      out[a.id] = { state: p.buybackBps === a.approved.buybackBps && p.expiresAt === a.approved.expiresAt ? 'registered' : 'different', live: p.live, buybackBps: p.buybackBps, expiresAt: p.expiresAt };
    });
  } catch (e) { for (const a of wanted) out[a.id] = { state: 'error', error: String(e.message).slice(0, 120) }; }
  return { supported, records: out };
}
