// ELPIDA V2 on Solana (S3): payout lists for the trader-airdrop and holder-reward distributors of the Solana program.
// Same idea as packages/core/v2-rounds.mjs on EVM: the keeper builds a list, posts its Merkle root with `post_v2_root`,
// publishes the list, and anyone can pay any leaf with `claim_v2`. The leaf binds the program, the distributor kind,
// the round, the asset and the position in the list, so a proof works nowhere else and each leaf pays once.
import { keccak256, getBytes, concat } from 'ethers';

const enc = s => new TextEncoder().encode(s);
const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(v), true); return b; };
const u64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
const keyBytes = k => (k instanceof Uint8Array ? k : k.toBytes());
const keccak = bytes => getBytes(keccak256(bytes));
const less = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] < b[i]; return true; };
const pair = (a, b) => (less(a, b) ? keccak(concat([a, b])) : keccak(concat([b, a])));

/** The program's `v2_leaf`: keccak(keccak("elpida-v2" | program | kind | round | asset | index | account | amount)). */
export function solanaPayoutLeaf({ programId, kind, round, asset }, { index, account, amount }) {
  return keccak(keccak(concat([enc('elpida-v2'), keyBytes(programId), Uint8Array.of(kind), u32(round), keyBytes(asset), u32(index), keyBytes(account), u64(amount)])));
}

/** The program's `verify_proof` (sorted pairs). */
export function verifySolanaProof(proof, root, leaf) {
  let node = leaf;
  for (const p of proof) node = pair(node, getBytes(p));
  return node.every((b, i) => b === getBytes(root)[i]);
}

/**
 * Builds one round's list for one asset. `payouts`: [[account, amount]] (accounts are PublicKeys; amounts in base
 * units, all positive, each account once). Returns { root, total, recipients, rows: [{ index, account, amount, proof }] }.
 */
export function buildSolanaRound({ programId, kind, round, asset }, payouts) {
  const rows = [...payouts].map(([account, amount], index) => ({ index, account, amount: BigInt(amount) }));
  if (!rows.length) throw new Error('A round needs at least one payout.');
  const seen = new Set();
  for (const r of rows) {
    if (r.amount <= 0n) throw new Error('Payouts must be positive.');
    const k = r.account.toBase58();
    if (seen.has(k)) throw new Error(`Duplicate payee ${k}.`);
    seen.add(k);
  }
  const leaves = rows.map(r => solanaPayoutLeaf({ programId, kind, round, asset }, r));
  const layers = [leaves];
  while (layers.at(-1).length > 1) {
    const prev = layers.at(-1), next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? pair(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }
  const proofOf = index => {
    const proof = [];
    let i = index;
    for (const layer of layers.slice(0, -1)) {
      const sibling = i ^ 1;
      if (sibling < layer.length) proof.push(layer[sibling]);
      i >>= 1;
    }
    return proof;
  };
  return {
    root: layers.at(-1)[0],
    total: rows.reduce((t, r) => t + r.amount, 0n),
    recipients: rows.length,
    rows: rows.map(r => ({ ...r, proof: proofOf(r.index) })),
  };
}
