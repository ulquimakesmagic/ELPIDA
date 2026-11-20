// Pyth's public Hermes API (https://hermes.pyth.network): the latest signed price updates for feed ids. The update data is
// signed by Pyth's publishers and verified by Pyth Core on chain, so relaying it through this server cannot alter it.
// Used by the launch page (push a fresh stock price just before a Pyth-priced launch) and scripts/ondo-pyth-feeds.mjs.
export const HERMES = 'https://hermes.pyth.network';
export const PYTH_ID = /^(0x)?[0-9a-fA-F]{64}$/;
export const pythHex = id => (String(id).startsWith('0x') ? String(id) : `0x${id}`).toLowerCase();

export async function hermesJson(fetchImpl, path) {
  const r = await fetchImpl(`${HERMES}${path}`, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Hermes ${path.split('?')[0]}: HTTP ${r.status}`);
  return r.json();
}

/** Hermes' latest signed update for 1 to 100 feed ids: { data: ['0x…'], parsed: Map(id → { price, conf, expo, publishTime }) }. */
export async function latestUpdate(ids, { fetchImpl = fetch } = {}) {
  if (!ids.length || ids.length > 100 || !ids.every(i => PYTH_ID.test(String(i)))) throw new Error('1 to 100 Pyth feed ids');
  const j = await hermesJson(fetchImpl, `/v2/updates/price/latest?encoding=hex&parsed=true&${ids.map(i => `ids[]=${pythHex(i)}`).join('&')}`);
  const data = (j?.binary?.data ?? []).map(d => `0x${String(d).replace(/^0x/, '')}`);
  if (!data.length || !data.every(d => /^0x[0-9a-fA-F]+$/.test(d) && d.length <= 200_000)) throw new Error('Hermes returned no update');
  const parsed = new Map((j.parsed ?? []).map(p => [pythHex(p.id), { price: BigInt(p.price.price), conf: BigInt(p.price.conf), expo: Number(p.price.expo), publishTime: Number(p.price.publish_time) }]));
  return { data, parsed };
}
