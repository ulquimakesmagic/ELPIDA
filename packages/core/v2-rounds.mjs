// ELPIDA V2.0 reward rounds: the schedule the distributor contract keeps (calendar months in UTC, or fixed periods),
// the countdown the site shows, and the Merkle payout lists the keeper posts. Browser-safe apart from `ethers`.
import { AbiCoder, concat, getAddress, keccak256, toUtf8Bytes, ZeroAddress } from 'ethers';

const DAY = 86_400;
const coder = AbiCoder.defaultAbiCoder();

/** A distributor's schedule: `period` 0 for calendar months (genesis the 1st of a month, 00:00 UTC) or seconds. */
export function schedule({ period, genesis }) {
  period = Number(period); genesis = Number(genesis);
  if (!Number.isInteger(genesis) || genesis % DAY) throw new Error('Rounds start at 00:00 UTC.');
  if (period === 0 && new Date(genesis * 1000).getUTCDate() !== 1) throw new Error('Monthly rounds start on the 1st.');
  if (period !== 0 && period < DAY) throw new Error('Rounds last at least a day.');
  const g = new Date(genesis * 1000), genesisMonth = g.getUTCFullYear() * 12 + g.getUTCMonth();
  const start = round => {
    if (!Number.isInteger(round) || round < 0) throw new Error('Invalid round.');
    if (period) return genesis + round * period;
    const index = genesisMonth + round;
    return Date.UTC(Math.floor(index / 12), index % 12, 1) / 1000;
  };
  const roundAt = time => {
    if (time < genesis) return null;
    if (period) return Math.floor((time - genesis) / period);
    const d = new Date(time * 1000);
    return d.getUTCFullYear() * 12 + d.getUTCMonth() - genesisMonth;
  };
  return { period, genesis, start, end: round => start(round + 1), roundAt };
}

/** What the countdown shows at `now` (seconds): the round in progress, when it ends, and the time left. */
export function countdown(s, now) {
  const round = s.roundAt(now);
  if (round === null) return { started: false, startsAt: s.genesis, secondsLeft: s.genesis - now };
  const endsAt = s.end(round), left = Math.max(0, endsAt - now);
  return { started: true, round, startedAt: s.start(round), endsAt, secondsLeft: left,
    days: Math.floor(left / DAY), hours: Math.floor(left % DAY / 3600), minutes: Math.floor(left % 3600 / 60), seconds: left % 60,
    progress: (now - s.start(round)) / (endsAt - s.start(round)) };
}

/** The distributor's leaf (ElpidaV2Distributor.leaf): bound to the chain and the distributor. */
export function payoutLeaf({ chainId, distributor, round, asset }, { account, amount }) {
  return keccak256(concat([keccak256(coder.encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256'],
    [BigInt(chainId), getAddress(distributor), BigInt(round), getAddress(asset), getAddress(account), BigInt(amount)]))]));
}

const pairHash = (a, b) => keccak256(concat(a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]));

/**
 * Builds a round's payout list for one asset: root, total, proofs, and a hash of the whole list (publish the list;
 * anyone can recompute the root). `payouts`: Map or [[account, amount]] in the asset's base units.
 */
export function buildRound({ chainId, distributor, round, asset = ZeroAddress }, payouts) {
  const rows = [...(payouts instanceof Map ? payouts.entries() : payouts)]
    .map(([account, amount]) => ({ account: getAddress(account), amount: BigInt(amount) }))
    .filter(r => r.amount > 0n)
    .sort((a, b) => a.account.toLowerCase().localeCompare(b.account.toLowerCase()));
  if (!rows.length) throw new Error('A round needs at least one payout.');
  for (let i = 1; i < rows.length; i++) if (rows[i].account === rows[i - 1].account) throw new Error(`${rows[i].account} listed twice.`);
  const config = { chainId: String(chainId), distributor: getAddress(distributor), round: Number(round), asset: getAddress(asset) };
  const layers = [rows.map(r => payoutLeaf(config, r))];
  while (layers.at(-1).length > 1) {
    const cur = layers.at(-1), next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? pairHash(cur[i], cur[i + 1]) : cur[i]);
    layers.push(next);
  }
  const entries = rows.map((r, index) => {
    const proof = [];
    for (let level = 0, i = index; level < layers.length - 1; level++, i >>= 1) if ((i ^ 1) < layers[level].length) proof.push(layers[level][i ^ 1]);
    return { account: r.account, amount: String(r.amount), proof };
  });
  const total = rows.reduce((a, r) => a + r.amount, 0n);
  const manifest = { ...config, root: layers.at(-1)[0], total: String(total), recipients: rows.length, entries };
  return { ...manifest, manifestHash: keccak256(toUtf8Bytes(JSON.stringify(manifest))) };
}

export function verifyPayout(manifest, entry) {
  let hash = payoutLeaf(manifest, entry);
  for (const sibling of entry.proof) hash = pairHash(hash, sibling);
  return hash.toLowerCase() === manifest.root.toLowerCase();
}

/**
 * Public distribution statistics for a posted round (what the analytics page shows): recipients, total, median,
 * smallest and largest payout, the top 1%'s share, and how many payouts fall in each band (in the asset's base units,
 * with `unit` = one display unit, e.g. 10n ** 18n).
 */
export function roundStats(amounts, unit = 10n ** 18n) {
  const a = amounts.map(BigInt).filter(x => x > 0n).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  if (!a.length) return { recipients: 0, total: 0n, median: 0n, smallest: 0n, largest: 0n, top1Share: 0, bands: [] };
  const total = a.reduce((s, x) => s + x, 0n), n = a.length;
  const median = n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2n;
  const top = a.slice(n - Math.max(1, Math.floor(n / 100))).reduce((s, x) => s + x, 0n);
  // Bands relative to one display unit: under 0.001, 0.001–0.01, 0.01–0.1, 0.1–1, 1 and above.
  const edges = [unit / 1000n, unit / 100n, unit / 10n, unit];
  const labels = ['< 0.001', '0.001–0.01', '0.01–0.1', '0.1–1', '≥ 1'];
  const counts = labels.map(() => 0);
  for (const x of a) counts[edges.findIndex(e => x < e) === -1 ? 4 : edges.findIndex(e => x < e)]++;
  return { recipients: n, total, median, smallest: a[0], largest: a[n - 1], top1Share: Number(top * 10_000n / total) / 10_000,
    bands: labels.map((label, i) => ({ label, count: counts[i] })) };
}
