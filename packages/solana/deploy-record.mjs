// The published deployment record (deployments/solana-<cluster>.json) holds only public addresses. When a deploy or
// upgrade runs from a checkout without the local deploy state (a fresh clone, another folder), the test pair mints
// come from that record, so the run reuses them instead of creating duplicate test tokens.
export function publishedTestAssets(record) {
  return Object.fromEntries((record?.pairs ?? []).filter(p => p.test && p.key && p.mint).map(p => [p.key, p.mint]));
}

/**
 * Test mints to reuse, per pair key: the published record's (what the hosted site lists) for the same program, then
 * this machine's deploy state for keys the record does not have. A run never replaces a published test mint: on
 * 5 November 2026 a run whose local state lacked the tTSLAon key created a second tTSLAon instead of reusing it.
 */
export function savedTestAssets(state, record, programId) {
  const published = record?.programId === programId ? publishedTestAssets(record) : {};
  return { ...(state?.testAssets ?? {}), ...published };
}

/** The deploy state's test mints after a run: this run's pairs, keeping keys a run without that pair did not touch. */
export function mergedTestAssets(previous, pairs) {
  return { ...(previous ?? {}), ...Object.fromEntries(pairs.filter(p => p.test && p.key && p.mint).map(p => [p.key, p.mint])) };
}
