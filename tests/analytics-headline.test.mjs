// Analytics headline (Malik, 10 November): paid to holders, earned by creators, flywheel buybacks and the airdrop vault
// from the V2 rewards summary; V2 fees, coins launched, graduated and stock pairs from the protocol analytics. Tiles
// whose source is missing are left out, never shown as zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import { headlineFigures } from '../apps/web/analytics-headline.mjs';

const E = n => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString(), U = n => String(Math.round(n * 1e6));
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e', ETH = '0x0000000000000000000000000000000000000000', SOL = 'So11111111111111111111111111111111111111112';
const base = { key: 'base-sepolia', name: 'Base Sepolia', assets: { [ETH]: { symbol: 'ETH', decimals: 18, usd: 2500 }, [USDC]: { symbol: 'USDC', decimals: 6, usd: 1 } },
  fees: [{ asset: ETH, total: E(1), creator: E(0.3) }, { asset: USDC, total: U(1000), creator: U(300) }],
  holder: { assets: [{ asset: USDC, size: U(40) }], rounds: [{ asset: USDC, claimed: U(60) }] },
  airdrop: { assets: [{ asset: USDC, size: U(250) }], rounds: [] },
  flywheel: { spentByAsset: [{ asset: ETH, amount: E(0.02) }], burnedByToken: [{ token: '0x1', amount: '5' }, { token: '0x2', amount: '0' }] } };
const solana = { key: 'solana-devnet', name: 'Solana devnet', assets: { [SOL]: { symbol: 'SOL', decimals: 9, usd: null } },
  fees: [{ asset: SOL, total: '2000000000', creator: '600000000' }], holder: { assets: [], rounds: [] }, airdrop: { assets: [], rounds: [] },
  flywheel: { spentByAsset: [{ asset: SOL, amount: '0' }], burnedByToken: [{ token: 'Mint', amount: '7' }] } };
const analytics = { totals: { tokens: 5492, graduated: 59 }, assets: [{ key: 'base-sepolia:0xaaa', pair: 'xstock' }, { key: 'ethereum-sepolia:0xbbb', pair: 'xstock' }, { key: 'base-sepolia:native', pair: 'native' }] };

test('the headline adds every chain together, in dollars where priced', () => {
  const f = headlineFigures({ deployed: true, chains: [base, solana] }, analytics), by = k => [...f.large, ...f.small].find(x => x.key === k);
  assert.deepEqual(f.large.map(x => x.key), ['holders', 'creators', 'flywheel', 'airdrop']);
  assert.equal(by('holders').value, '$60'); assert.match(by('holders').note, /^\$40 more waiting/);
  assert.equal(by('creators').value, '$1.05K', '0.3 ETH at $2,500 + 300 USDC');
  assert.match(by('creators').detail, /0\.6 SOL/, 'unpriced SOL is listed in SOL, not converted');
  assert.equal(by('flywheel').value, '$50'); assert.match(by('flywheel').note, /^2 coins bought and burned/);
  assert.equal(by('airdrop').value, '$250'); assert.equal(by('airdrop').note, 'USDC for qualifying traders');
  assert.equal(by('fees').value, '$3.5K');
  assert.deepEqual(f.small.slice(1).map(x => [x.key, x.value]), [['launched', '5,492'], ['graduated', '59'], ['stocks', '2']]);
});

test('without V2 the large tiles are left out; without analytics the counts are', () => {
  const none = headlineFigures({ deployed: false, chains: [] }, analytics);
  assert.deepEqual(none.large, []); assert.deepEqual(none.small.map(x => x.key), ['launched', 'graduated', 'stocks']);
  assert.deepEqual(headlineFigures(null, null), { large: [], small: [] });
  assert.deepEqual(headlineFigures({ deployed: true, chains: [base] }, null).small.map(x => x.key), ['fees']);
});
