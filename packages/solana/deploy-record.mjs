// The published deployment record (deployments/solana-<cluster>.json) holds only public addresses. When a deploy or
// upgrade runs from a checkout without the local deploy state (a fresh clone, another folder), the test pair mints
// come from that record, so the run reuses them instead of creating duplicate test tokens.
export function publishedTestAssets(record) {
  return Object.fromEntries((record?.pairs ?? []).filter(p => p.test && p.key && p.mint).map(p => [p.key, p.mint]));
}

/** Test mints to reuse: the local deploy state first, then the published record for the same program. */
export function savedTestAssets(state, record, programId) {
  if (state?.testAssets && Object.keys(state.testAssets).length) return state.testAssets;
  return record?.programId === programId ? publishedTestAssets(record) : {};
}
