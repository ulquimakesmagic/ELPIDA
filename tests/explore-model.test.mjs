import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { isKothContender, kingOfTheHill, curveProgress, KOTH_PROGRESS, indexedActivity, activityOf, exploreModel, pageOf, pageButtons, trendingTokens, topCreators, feedRows, exploreStateFromHash, exploreHash, matchesQuery, overlayToken, tokenKey } from '../apps/web/discovery.mjs';

const now = 2000000000, ref = { status: 'fresh', usd: 2000, updatedAt: now };
const usdc = { status: 'fresh', usd: 1, updatedAt: now, maxAge: Number.MAX_SAFE_INTEGER };
const t = (address, extra = {}) => ({ address, network: 'base-sepolia', name: `Token ${address}`, symbol: address.toUpperCase(), pair: 'native', spotPrice: 0.000001, supply: 1e9, sold: 0, saleCap: 8e8, usdReference: ref, created: (now - 3600) * 1000, volume24h: 0, trades24h: 0, lastTradeAt: null, lastBuyAt: null, ...extra });

test('24h activity per token: volume, counts and the latest trade and buy, on EVM and Solana tables', () => {
  for (const column of ['address', 'mint']) {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE trades(${column} TEXT, timestamp INTEGER, data TEXT)`);
    const insert = db.prepare('INSERT INTO trades VALUES(?,?,?)');
    for (const [token, timestamp, side, quoteAmount] of [['a', now - 90000, 'buy', '5'], ['a', now - 600, 'buy', '0.5'], ['a', now - 60, 'sell', '0.25'], ['b', now - 100000, 'buy', '1']]) insert.run(token, timestamp, JSON.stringify({ side, quoteAmount, timestamp }));
    const activity = indexedActivity(db, now);
    assert.deepEqual(activityOf(activity, 'a'), { volume24h: 0.75, trades24h: 2, buys24h: 1, sells24h: 1, lastTradeAt: now - 60, lastBuyAt: now - 600 });
    // Traded before the window: no 24h volume, but the last trade and buy times remain.
    assert.deepEqual(activityOf(activity, 'b'), { volume24h: 0, trades24h: 0, buys24h: 0, sells24h: 0, lastTradeAt: now - 100000, lastBuyAt: now - 100000 });
    assert.deepEqual(activityOf(activity, 'never'), { volume24h: 0, trades24h: 0, buys24h: 0, sells24h: 0, lastTradeAt: null, lastBuyAt: null });
    db.close();
  }
});

test('trending ranks by dollar volume; pairs without a dollar price follow; tokens that did not trade are left out', () => {
  const tokens = [
    t('quiet'),
    t('small', { volume24h: 0.01, trades24h: 3 }),           // $20
    t('big', { volume24h: 1, trades24h: 1 }),                // $2,000
    t('stable', { pair: 'usdc', usdReference: usdc, volume24h: 500, trades24h: 2 }), // $500
    t('meme', { pair: 'token', usdReference: null, volume24h: 9e9, trades24h: 9 }),  // unknown dollars
  ];
  assert.deepEqual(trendingTokens(tokens, 10, now).map(x => x.address), ['big', 'stable', 'small', 'meme']);
  assert.deepEqual(trendingTokens([t('quiet')], 10, now), []);
});

test('Explore tabs, pair and chain filters, search and chip counts', () => {
  const tokens = [
    t('a', { volume24h: 1, lastBuyAt: now - 50, created: (now - 9000) * 1000, sold: 1e8 }),
    t('b', { pair: 'usdc', usdReference: usdc, spotPrice: 0.01, lastBuyAt: now - 10, created: (now - 100) * 1000, sold: 7e8 }),
    t('c', { network: 'solana-devnet', creator: 'So1anaCreator1111111111111111111111111111111', complete: true, sold: 8e8 }),
    t('d', { graduated: true, complete: true, sold: 8e8, created: (now - 50) * 1000 }),
  ];
  const ids = model => model.items.map(x => x.address);
  assert.deepEqual(ids(exploreModel(tokens, { tab: 'new' }, now)), ['d', 'b', 'c', 'a']);
  assert.deepEqual(ids(exploreModel(tokens, { tab: 'lastsale' }, now)), ['b', 'a', 'd', 'c']);
  // Market cap in dollars ($10M USDC pair first); equal caps fall back to a stable network:address order.
  assert.deepEqual(ids(exploreModel(tokens, { tab: 'marketcap' }, now)), ['b', 'a', 'd', 'c']);
  // King of the Hill: only 80%+ of the curve sold and not graduated; curves still trading first, then waiting migrations.
  assert.deepEqual(ids(exploreModel(tokens, { tab: 'koth' }, now)), ['b', 'c']);
  const usdcOnly = exploreModel(tokens, { pair: 'usdc' }, now);
  assert.deepEqual(ids(usdcOnly), ['b']);
  assert.deepEqual(usdcOnly.counts.pair, { all: 4, native: 3, usdc: 1, xstock: 0, token: 0 });
  assert.deepEqual(usdcOnly.counts.chain, { all: 1, 'base-sepolia': 1 });
  const solana = exploreModel(tokens, { chain: 'solana-devnet' }, now);
  assert.deepEqual(ids(solana), ['c']);
  assert.equal(solana.counts.pair.all, 1);
  assert.deepEqual(ids(exploreModel(tokens, { query: 'token b' }, now)), ['b']);
  assert.deepEqual(ids(exploreModel(tokens, { query: 'So1anaCreator1111111111111111111111111111111' }, now)), ['c'], 'a full creator address finds their launches');
  const named = t('0xabcdef', { name: 'Hope', symbol: 'HOPE' });
  assert.equal(matchesQuery(named, '0xa'), false, 'address search needs four characters');
  assert.equal(matchesQuery(named, '0xab'), true);
  assert.equal(matchesQuery(named, 'abcd'), false, 'addresses match from the start');
  assert.equal(matchesQuery(named, 'hop'), true);
});

test('pages clamp into range and page buttons collapse with gaps', () => {
  const items = Array.from({ length: 19 }, (_, i) => i);
  assert.deepEqual(pageOf(items, 3), { page: 3, pages: 3, from: 17, to: 19, items: [16, 17, 18] });
  assert.equal(pageOf(items, 99).page, 3);
  assert.deepEqual(pageOf([], 2), { page: 1, pages: 1, from: 0, to: 0, items: [] });
  assert.deepEqual(pageButtons(1, 34), [1, 2, 3, 4, '…', 34]);
  assert.deepEqual(pageButtons(17, 34), [1, '…', 16, 17, 18, '…', 34]);
  assert.deepEqual(pageButtons(34, 34), [1, '…', 31, 32, 33, 34]);
  assert.deepEqual(pageButtons(2, 3), [1, 2, 3]);
});

test('top creators sum only volume with a dollar price and say when a total is partial', () => {
  const tokens = [
    t('a', { creator: '0xAAAA000000000000000000000000000000000001', volume24h: 1 }),
    t('b', { creator: '0xaaaa000000000000000000000000000000000001', volume24h: 0.5 }),
    t('c', { creator: '0xaaaa000000000000000000000000000000000001', pair: 'token', usdReference: null, volume24h: 10 }),
    t('d', { creator: '0xbbbb000000000000000000000000000000000002', pair: 'token', usdReference: null, volume24h: 10 }),
    t('e', { creator: '0xcccc000000000000000000000000000000000003', volume24h: 0 }),
  ];
  const rows = topCreators(tokens, 10, now);
  assert.equal(rows.length, 1, 'creators with no priced volume are hidden');
  assert.equal(rows[0].volumeUsd, 3000);
  assert.equal(rows[0].tokens, 3);
  assert.equal(rows[0].partial, true);
});

test('the live feed shows buys of listed tokens only', () => {
  const tokens = [t('0xAbC0000000000000000000000000000000000001')];
  const trades = [
    { network: 'base-sepolia', address: '0xabc0000000000000000000000000000000000001', side: 'buy', timestamp: now - 5 },
    { network: 'base-sepolia', address: '0xabc0000000000000000000000000000000000001', side: 'sell', timestamp: now - 4 },
    { network: 'base-sepolia', address: '0xdead000000000000000000000000000000000000', side: 'buy', timestamp: now - 3 },
    { network: 'bnb-testnet', address: '0xabc0000000000000000000000000000000000001', side: 'buy', timestamp: now - 2 },
  ];
  const rows = feedRows(trades, tokens);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trade.timestamp, now - 5);
  assert.equal(rows[0].token, tokens[0]);
});

test('Explore view state round-trips through the URL and ignores unknown values', () => {
  const state = { tab: 'koth', pair: 'usdc', chain: 'solana-devnet', query: 'hope coin', page: 2 };
  const hash = exploreHash(state);
  assert.equal(hash, '#/?tab=koth&pair=usdc&chain=solana-devnet&q=hope+coin&page=2');
  assert.deepEqual(exploreStateFromHash(hash), state);
  assert.equal(exploreStateFromHash('#/?tab=graduating').tab, 'koth', 'links to the old Graduating tab open King of the Hill');
  assert.equal(exploreHash({}), '#/');
  assert.deepEqual(exploreStateFromHash('#/?tab=nope&pair=gold&page=-3'), { tab: 'trending', pair: 'all', chain: 'all', query: '', page: 1 });
});

test('a live wallet read laid over the index keeps 24h activity, the price change and the image (refresh regression)', () => {
  const now = 1_800_000_000;
  const indexed = { network: 'solana-devnet', address: 'MASHmint', symbol: 'MASHLE', volume24h: 2.81, trades24h: 6, lastTradeAt: now - 60, priceChange24h: { percent: 12 },
    marketCap: '2.7', metadata: { name: 'Mash Burnedead', image: '/api/content/abc', description: 'd' } };
  // The chain read through a connected wallet: fresher reserves, but no activity and an empty or partial metadata.
  const live = { network: 'solana-devnet', address: 'MASHmint', symbol: 'MASHLE', marketCap: '2.9', reserve: '1.2', volume24h: undefined, metadata: {} };
  const merged = overlayToken(indexed, live);
  assert.equal(merged.marketCap, '2.9', 'live values win where the read has them');
  assert.equal(merged.reserve, '1.2');
  assert.equal(merged.volume24h, 2.81, 'activity comes from the index');
  assert.deepEqual(merged.priceChange24h, { percent: 12 });
  assert.equal(merged.metadata.image, '/api/content/abc', 'an empty metadata object does not erase the image');
  assert.equal(overlayToken(indexed, { ...live, metadata: { name: 'Mash', image: '' } }).metadata.image, '/api/content/abc', 'nor does a blank field');
  assert.equal(overlayToken(indexed, { ...live, metadata: { image: '/api/wallet-logo/x' } }).metadata.image, '/api/wallet-logo/x', 'a real new image replaces it');
  // The Trending strip sees the token after the overlay, as it did before the refresh.
  assert.deepEqual(trendingTokens([merged, { ...indexed, address: 'other', volume24h: 0 }], 10, now).map(t => t.symbol), ['MASHLE']);
  assert.equal(overlayToken(undefined, live), live); assert.equal(overlayToken(indexed, null), indexed);
  assert.equal(tokenKey('ethereum-sepolia', '0xABC'), tokenKey('ethereum-sepolia', '0xabc'), 'one key whatever the address casing');
});

test('King of the Hill: 80%+ of the curve sold and not graduated; the king is the closest curve still trading', () => {
  assert.equal(KOTH_PROGRESS, 0.8);
  const tokens = [
    t('low', { sold: 6.39e8 }),                          // 79.9%
    t('edge', { sold: 6.4e8 }),                          // exactly 80%
    t('high', { sold: 7.6e8, spotPrice: 0.000001 }),     // 95%
    t('tie', { sold: 7.6e8, spotPrice: 0.000002 }),      // 95%, bigger market cap
    t('done', { sold: 8e8, complete: true }),            // waiting to migrate: on the hill, never the king
    t('grad', { sold: 8e8, complete: true, graduated: true }),
  ];
  const by = id => tokens.find(x => x.address === id);
  assert.equal(isKothContender(by('low')), false);
  assert.equal(isKothContender(by('edge')), true);
  assert.equal(isKothContender(by('done')), true);
  assert.equal(isKothContender(by('grad')), false, 'graduated tokens leave the hill');
  assert.equal(curveProgress(by('done')), 1);
  assert.equal(kingOfTheHill(tokens, now).address, 'tie', 'equal progress: the higher market cap wins');
  assert.equal(kingOfTheHill(tokens.filter(x => x.address !== 'tie' && x.address !== 'high'), now).address, 'edge');
  assert.equal(kingOfTheHill([by('low'), by('done'), by('grad')], now), null, 'no curve still trading above 80%: no king');
  const model = exploreModel(tokens, { tab: 'koth' }, now);
  assert.deepEqual(new Set(model.items.map(x => x.address)), new Set(['edge', 'high', 'tie', 'done']));
  assert.equal(model.items.at(-1).address, 'done', 'waiting migrations come last');
  assert.equal(model.items.at(-2).address, 'edge');
});
