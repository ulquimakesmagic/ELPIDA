// Vanity Solana mint addresses (D9): a small server-side pool of pre-ground mint keypairs whose base58
// address ends in a fixed suffix ("hope"). Operator-side only; never exposed to browsers.
//
// - Keys are ground in a worker thread and stored encrypted at rest (AES-256-GCM, key from
//   ELPIDA_VANITY_KEY, the public key as associated data). Plaintext never touches disk or logs.
// - A launch reserves one key for one wallet (rate limited per wallet and per client address). The key
//   leaves the stored pool at reservation, so it is single use whatever happens next.
// - The server partially signs only a message that is an Elpida `launch` for that wallet with that mint,
//   whose other instructions never reference the mint. The secret is destroyed right after signing, or
//   when the reservation expires unused.
// - With no key configured, an empty pool or a rate limit, the caller falls back to a random mint.
import { createCipheriv, createDecipheriv, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign as edSign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

export const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const LAUNCH_DISCRIMINATOR = Buffer.from([153, 241, 93, 225, 22, 69, 74, 61]);
const LAUNCH_MINT_INDEX = 4, LAUNCH_CREATOR_INDEX = 0;
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
/** A Solana address: 32-44 base58 characters that decode to exactly 32 bytes. */
export const validAddress = text => typeof text === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text) && (() => { try { return base58(decodeBase58(text)) === text; } catch { return false; } })();

/** The value a base58 string's last characters encode: N mod 58^len must equal it. */
export function suffixTarget(suffix) {
  if (!suffix || [...suffix].some(c => !BASE58.includes(c))) throw new Error('Vanity suffix must use base58 characters (no 0, O, I or l).');
  return { modulus: 58 ** suffix.length, target: [...suffix].reduce((n, c) => n * 58 + BASE58.indexOf(c), 0) };
}

/** True when the 32-byte key's base58 form ends in the suffix (big-endian N mod 58^k, exact in doubles). */
export function endsWith(pubkey, { modulus, target }) {
  let r = 0;
  for (const byte of pubkey) r = (r * 256 + byte) % modulus;
  return r === target;
}

export function base58(bytes) {
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = ''; while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

/** Grinds one keypair whose address ends in `suffix`. Returns { seed, pubkey } (32 bytes each) or null after `maxTries`. */
export function grind(suffix, maxTries = Infinity) {
  const goal = suffixTarget(suffix);
  for (let i = 0; i < maxTries; i++) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
    const pubkey = publicKey.subarray(publicKey.length - 32);
    if (endsWith(pubkey, goal)) return { seed: Buffer.from(privateKey.subarray(privateKey.length - 32)), pubkey: Buffer.from(pubkey) };
  }
  return null;
}

/** Reads the 32-byte encryption key from hex or base64, or null when unset or malformed. */
export function vanityKey(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const bytes = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  return bytes.length === 32 ? bytes : null;
}

export function seal(key, seed, pubkey) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(pubkey);
  const data = Buffer.concat([cipher.update(seed), cipher.final()]);
  return { pubkey: base58(pubkey), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function open(key, entry) {
  const pubkey = decodeBase58(entry.pubkey);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
  decipher.setAAD(pubkey); decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  const seed = Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]);
  if (seed.length !== 32) throw new Error('Corrupt vanity key.');
  return { seed, pubkey };
}

export function decodeBase58(text) {
  let n = 0n; for (const c of text) { const i = BASE58.indexOf(c); if (i < 0) throw new Error('Invalid base58.'); n = n * 58n + BigInt(i); }
  const bytes = []; while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of text) { if (c !== '1') break; bytes.unshift(0); }
  if (bytes.length > 32) throw new Error('Invalid public key.');
  return Buffer.from([...Array(32 - bytes.length).fill(0), ...bytes]);
}

/** Behind Railway's proxy the client address is the right-most X-Forwarded-For entry; elsewhere the socket. */
export function clientAddress(req, env = process.env) {
  const forwarded = String(req.headers?.['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return (env.RAILWAY_ENVIRONMENT_NAME && forwarded.length ? forwarded.at(-1) : req.socket?.remoteAddress) ?? 'unknown';
}

// Legacy (v0 header-free) Solana message parsing: header, account keys, blockhash, instructions.
function shortVec(buf, at) { let len = 0, size = 0; for (;;) { const b = buf[at + size]; len |= (b & 0x7f) << (7 * size); size++; if (!(b & 0x80)) return [len, size]; if (size > 3) throw new Error('Bad length.'); } }
export function parseLegacyMessage(bytes) {
  const buf = Buffer.from(bytes);
  if (buf[0] & 0x80) throw new Error('Only legacy launch messages can be signed.');
  let at = 3;
  const [keyCount, k1] = shortVec(buf, at); at += k1;
  const keys = []; for (let i = 0; i < keyCount; i++) { keys.push(base58(buf.subarray(at, at + 32))); at += 32; }
  at += 32; // recent blockhash
  const [ixCount, k2] = shortVec(buf, at); at += k2;
  const instructions = [];
  for (let i = 0; i < ixCount; i++) {
    const program = buf[at++];
    const [accountCount, k3] = shortVec(buf, at); at += k3;
    const accounts = [...buf.subarray(at, at + accountCount)]; at += accountCount;
    const [dataLen, k4] = shortVec(buf, at); at += k4;
    const data = buf.subarray(at, at + dataLen); at += dataLen;
    instructions.push({ program: keys[program], accounts: accounts.map(a => keys[a]), data });
  }
  if (at !== buf.length) throw new Error('Trailing bytes in message.');
  return { requiredSignatures: buf[0], keys, instructions };
}

export class VanityMintPool {
  constructor({ path, key, programId, suffix = 'hope', target = 3, ttlMs = 120_000, perWalletPerHour = 3, perAddressPerHour = 10, workers = 1, now = Date.now, autoStart = true, grindSuffix = suffix }) {
    this.path = path; this.key = key; this.programId = programId; this.suffix = suffix; this.grindSuffix = grindSuffix;
    this.target = target; this.ttlMs = ttlMs; this.perWallet = perWalletPerHour; this.perAddress = perAddressPerHour; this.workers = workers; this.now = now;
    this.reservations = new Map(); this.hits = new Map(); this.grinding = 0; this.stopped = false;
    this.enabled = Boolean(key && path && programId); this.autoGrind = autoStart;
    if (this.enabled) { suffixTarget(grindSuffix); this.load(); this.fill(); }
  }
  load() {
    try { this.stored = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')).keys ?? [] : []; }
    catch { this.stored = []; }
    // Drop entries this key cannot open (for example after a key rotation): they are unusable anyway.
    this.stored = this.stored.filter(entry => { try { return open(this.key, entry).seed.length === 32; } catch { return false; } });
  }
  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + '.tmp', JSON.stringify({ version: 1, suffix: this.suffix, keys: this.stored }), { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
  }
  add(seed, pubkey) { this.stored.push(seal(this.key, seed, pubkey)); this.save(); seed.fill(0); }
  status() { return { enabled: this.enabled, suffix: this.suffix, available: this.enabled ? this.stored.length : 0, grinding: this.grinding }; }
  /** Grinds in worker threads until `target` keys are stored (only when `autoStart`, the default). */
  fill() {
    if (!this.enabled || this.stopped || !this.autoGrind) return;
    while (this.grinding < this.workers && this.stored.length + this.grinding < this.target) {
      this.grinding++;
      // A grinder holds a few buffers at a time; a small heap keeps its garbage from growing the process.
      const worker = new Worker(new URL(import.meta.url), { workerData: { vanityGrind: this.grindSuffix }, resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8 } });
      worker.unref();
      worker.once('message', ({ seed, pubkey }) => { if (!this.stopped) this.add(Buffer.from(seed), Buffer.from(pubkey)); });
      worker.once('exit', () => { this.grinding--; this.current = this.current.filter(w => w !== worker); this.fill(); });
      worker.once('error', () => {});
      this.current = [...(this.current ?? []), worker];
    }
  }
  stop() { this.stopped = true; for (const w of this.current ?? []) w.terminate(); for (const r of this.reservations.values()) r.seed.fill(0); this.reservations.clear(); }
  limited(kind, id, max) {
    const key = `${kind}:${id}`, now = this.now(), recent = (this.hits.get(key) ?? []).filter(t => now - t < 3_600_000);
    if (recent.length >= max) return true;
    // Bounded memory without ever resetting live limits: drop only entries older than the window, and
    // refuse new identities while the table is still full.
    if (!this.hits.has(key) && this.hits.size >= 50_000) {
      for (const [k, times] of this.hits) if (!times.some(t => now - t < 3_600_000)) this.hits.delete(k);
      if (this.hits.size >= 50_000) return true;
    }
    recent.push(now); this.hits.set(key, recent);
    return false;
  }
  /** Unused reservations go back to the stored pool: their key never signed anything. */
  expire() {
    const now = this.now();
    for (const [id, r] of this.reservations) if (r.expiresAt <= now) {
      this.reservations.delete(id);
      if (this.enabled && !this.stopped) { this.stored.push(seal(this.key, r.seed, decodeBase58(r.mint))); this.save(); }
      r.seed.fill(0);
    }
  }
  /** One key for one wallet's launch, or a fallback reason. The key leaves the stored pool now (single use). */
  reserve({ wallet, address }) {
    this.expire();
    if (!this.enabled) return { fallback: true, reason: 'Vanity mint addresses are not configured on this server.' };
    if (!validAddress(wallet)) return { fallback: true, reason: 'Invalid wallet.' };
    if (!this.stored.length) { this.fill(); return { fallback: true, reason: `No "${this.suffix}" address is ready yet; a random mint address is used.` }; }
    if (this.limited('wallet', wallet, this.perWallet) || this.limited('address', address, this.perAddress)) return { fallback: true, reason: 'Vanity address limit reached for now; a random mint address is used.' };
    const entry = this.stored.shift(); this.save(); this.fill();
    let opened; try { opened = open(this.key, entry); } catch { return { fallback: true, reason: 'A stored vanity key could not be opened; a random mint address is used.' }; }
    const id = randomUUID(), expiresAt = this.now() + this.ttlMs;
    this.reservations.set(id, { wallet, mint: entry.pubkey, seed: opened.seed, expiresAt });
    return { id, mint: entry.pubkey, expiresAt };
  }
  /**
   * Partially signs a launch message with the reserved mint key, then destroys the key. The message must
   * be an Elpida `launch` by the reserving wallet with this mint, and no other instruction may use the mint.
   */
  sign({ id, wallet, message }) {
    this.expire();
    const r = this.reservations.get(id);
    if (!r || r.wallet !== wallet) throw Object.assign(new Error('This vanity reservation expired or belongs to another wallet. Launch again.'), { status: 400 });
    const bytes = Buffer.from(String(message ?? ''), 'base64');
    if (!bytes.length || bytes.length > 1232) throw Object.assign(new Error('Invalid launch message.'), { status: 400 });
    let parsed; try { parsed = parseLegacyMessage(bytes); } catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
    const signerKeys = parsed.keys.slice(0, parsed.requiredSignatures);
    if (signerKeys[0] !== wallet || !signerKeys.includes(r.mint)) throw Object.assign(new Error('The launch must be paid by your wallet and signed by the reserved mint.'), { status: 400 });
    // A durable-nonce message (System AdvanceNonceAccount) would never expire; only recent-blockhash launches are signed.
    if (parsed.instructions.some(ix => ix.program === SYSTEM_PROGRAM && ix.data.length >= 4 && ix.data.readUInt32LE(0) === 4)) throw Object.assign(new Error('Durable-nonce launches cannot use a reserved mint address.'), { status: 400 });
    const uses = parsed.instructions.filter(ix => ix.accounts.includes(r.mint) || ix.program === r.mint);
    const launch = uses.length === 1 && uses[0].program === this.programId && uses[0].data.subarray(0, 8).equals(LAUNCH_DISCRIMINATOR) ? uses[0] : null;
    if (!launch || launch.accounts[LAUNCH_MINT_INDEX] !== r.mint || launch.accounts[LAUNCH_CREATOR_INDEX] !== wallet) throw Object.assign(new Error('The reserved mint can only sign an Elpida launch for your wallet.'), { status: 400 });
    const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, r.seed]), format: 'der', type: 'pkcs8' });
    const signature = edSign(null, bytes, privateKey);
    r.seed.fill(0); this.reservations.delete(id);
    return { mint: r.mint, signature: signature.toString('base64') };
  }
}

// Worker entry: grind one key and post it back.
if (!isMainThread && workerData?.vanityGrind) {
  const found = grind(workerData.vanityGrind);
  parentPort.postMessage({ seed: found.seed, pubkey: found.pubkey });
}
