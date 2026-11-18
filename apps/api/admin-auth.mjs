import { randomBytes, createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { PublicKey } from '@solana/web3.js';

// Operator sign-in for the read-only admin panel. The operator signs a one-time message with an allowed wallet: the
// treasury of a configured factory, or an address in ELPIDA_ADMIN_ADDRESSES (the owners of a Safe treasury, which
// cannot sign messages itself, or a Solana wallet, which signs with ed25519). No passwords are stored. Sessions live in memory, so a redeploy signs everyone out.

const CHALLENGE_TTL = 5 * 60 * 1000;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const MAX_CHALLENGES = 200;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A valid Solana wallet (base58 of a 32-byte key), as written: Solana addresses are case-sensitive. */
function solanaAddress(value) {
  if (!SOLANA.test(String(value ?? ''))) return null;
  try { return new PublicKey(value).toBase58() === value ? value : null; } catch { return null; }
}

/**
 * Parse ELPIDA_ADMIN_ADDRESSES (comma or space separated): EVM addresses in lower case and Solana wallets as written
 * (Malik, 18 Nov: a Solana admin). Anything else is ignored.
 */
export function parseAdminAddresses(value) {
  return [...new Set(String(value ?? '').split(/[\s,]+/).map(a => ADDRESS.test(a) ? a.toLowerCase() : solanaAddress(a)).filter(Boolean))];
}

/** Whether `signature` (base64, 64 bytes) is `wallet`'s ed25519 signature of the UTF-8 `message`. */
function solanaSigned(message, signature, wallet) {
  try {
    const sig = Buffer.from(String(signature ?? ''), 'base64');
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(new PublicKey(wallet).toBytes())]), format: 'der', type: 'spki' });
    return verifyEd25519(null, Buffer.from(message, 'utf8'), key, sig);
  } catch { return false; }
}

export class AdminAuth {
  constructor({ host = 'elpida', now = () => Date.now(), random = n => randomBytes(n).toString('hex') } = {}) {
    this.host = host; this.now = now; this.random = random;
    this.challenges = new Map(); this.sessions = new Map();
  }

  /** A single-use message to sign. The oldest outstanding challenge is dropped past a fixed limit. */
  challenge() {
    this.prune();
    while (this.challenges.size >= MAX_CHALLENGES) this.challenges.delete(this.challenges.keys().next().value);
    const nonce = this.random(16), expires = this.now() + CHALLENGE_TTL;
    const message = `Elpida operator sign-in\nSite: ${this.host}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\n\nSigning proves you control this wallet. It costs nothing and sends no transaction.`;
    this.challenges.set(nonce, { message, expires });
    return { nonce, message, expires };
  }

  /**
   * Verify a signed challenge. `isAllowed(address)` decides access for the recovered signer (sync or async), so slow
   * checks such as reading a factory's treasury only run after the signature is known to be valid. Returns { token,
   * address, expires } or throws with a message safe to show. The challenge is consumed whatever the outcome.
   */
  async signIn({ nonce, signature, address }, isAllowed) {
    const c = this.challenges.get(String(nonce ?? ''));
    this.challenges.delete(String(nonce ?? ''));
    if (!c || c.expires < this.now()) throw Object.assign(new Error('This sign-in request expired. Try again.'), { status: 400 });
    let signer;
    const solana = solanaAddress(address);
    if (solana) {
      if (!solanaSigned(c.message, signature, solana)) throw Object.assign(new Error('The signature does not match this wallet.'), { status: 401 });
      signer = solana;
    } else {
      if (!ADDRESS.test(String(address ?? ''))) throw Object.assign(new Error('Invalid wallet address.'), { status: 400 });
      try { signer = verifyMessage(c.message, String(signature ?? '')).toLowerCase(); } catch { throw Object.assign(new Error('The signature could not be read.'), { status: 400 }); }
      if (signer !== String(address).toLowerCase()) throw Object.assign(new Error('The signature does not match this wallet.'), { status: 401 });
    }
    let ok = false;
    try { ok = await isAllowed(signer); } catch { ok = false; }
    if (!ok) throw Object.assign(new Error('This wallet is not an Elpida operator. Use a factory treasury or an address in ELPIDA_ADMIN_ADDRESSES.'), { status: 403 });
    const token = this.random(32), expires = this.now() + SESSION_TTL;
    this.sessions.set(token, { address: signer, expires });
    return { token, address: signer, expires };
  }

  /** The session for a Cookie header, or null. */
  session(cookieHeader) {
    const token = String(cookieHeader ?? '').split(';').map(v => v.trim()).find(v => v.startsWith('elpida_admin='))?.slice(13) ?? '';
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expires < this.now()) { this.sessions.delete(token); return null; }
    return { token, ...s };
  }

  signOut(cookieHeader) { const s = this.session(cookieHeader); if (s) this.sessions.delete(s.token); return !!s; }

  prune() {
    const now = this.now();
    for (const [k, c] of this.challenges) if (c.expires < now) this.challenges.delete(k);
    for (const [k, s] of this.sessions) if (s.expires < now) this.sessions.delete(k);
  }
}

/** Set-Cookie value for a session; scoped to the admin API so no other route ever sees it. */
export function sessionCookie(token, { secure = false, maxAgeMs = SESSION_TTL } = {}) {
  return `elpida_admin=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`;
}
export const clearCookie = ({ secure = false } = {}) => `elpida_admin=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0${secure ? '; Secure' : ''}`;
