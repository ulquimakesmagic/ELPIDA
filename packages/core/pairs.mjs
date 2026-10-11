// Trading pairs, the same four kinds on every chain:
//   native  the chain's own coin (ETH, BNB, SOL…)
//   usdc    USDC (Circle test USDC or Elpida tUSDC on test networks)
//   xstock  a tokenized stock (xStocks); on test networks a clearly labelled simulated stock
//   token   another approved token, for example a graduated Elpida token
// A network offers a kind when its launchpad has at least one approved asset of that kind. The web app
// shows all four everywhere and explains why a kind is unavailable on a given network.

export const PAIR_KINDS = ['native', 'usdc', 'xstock', 'token'];

export const PAIR_INFO = {
  native: { title: 'Native coin', glyph: 'coins', note: symbol => `Buyers pay in ${symbol}, the network’s own coin.` },
  usdc: { title: 'USDC', glyph: 'circle-dollar-sign', note: () => 'Buyers pay in USDC, a dollar stablecoin. Prices read directly in dollars.' },
  xstock: { title: 'xStock', glyph: 'chart-candlestick', note: () => 'Buyers pay in a tokenized stock. On test networks this is a simulated stock with no value.' },
  token: { title: 'Paired token', glyph: 'layers', note: () => 'Buyers pay in another approved token, such as a graduated Elpida token.' },
};

/**
 * Why a kind is unavailable on a chain even though it is part of the structure. xStocks on Solana are
 * Token-2022 mints with an issuer permanent delegate; PumpSwap refuses such quote mints, so an
 * xStock-paired curve could never graduate. Meteora DAMM v2 accepts them (xStocks are badged there),
 * so a DAMM v2 graduation path is the way to add them.
 */
export const PAIR_LIMITS = {
  solana: { xstock: 'Not on Solana yet: xStocks carry an issuer permanent delegate, which PumpSwap does not accept, so the curve could never graduate. It needs a Meteora graduation path.' },
};

/**
 * Solana test-network pair templates. Amounts are whole units of the pair asset. Curves are test sized
 * so a tester can complete one with faucet funds; on mainnet they would be priced at $5k → $50k FDV.
 * Test assets are minted only by the program's faucet PDA and are labelled as having no value.
 */
export const SOLANA_TEST_PAIRS = [
  { kind: 'native', key: 'sol', symbol: 'SOL', name: 'SOL (wrapped automatically)', decimals: 9, wsol: true, startFdv: '0.5', endFdv: '5', launchFee: '0.01', testSized: true },
  { kind: 'token', key: 'test-meme', symbol: 'TEST-MEME', name: 'Elpida test paired token (no value)', decimals: 6, startFdv: '500000', endFdv: '5000000', launchFee: '1000', faucet: '6000000' },
];

/** EVM test-network paired assets the treasury can deploy and approve from the browser (DEX launchpads). */
export const EVM_TEST_PAIRS = [
  { kind: 'xstock', key: 'test-stock', symbol: 'TEST-STOCK', name: 'Elpida test stock (simulated xStock, no value)', decimals: 18, startFdv: '20', faucet: '250' },
  { kind: 'token', key: 'test-meme', symbol: 'TEST-MEME', name: 'Elpida test paired token (no value)', decimals: 18, startFdv: '500000', faucet: '6000000' },
];

/** Circle USDC on Solana mainnet. */
export const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Solana mainnet pair templates. USDC is the program's default config ($5k → $50k FDV, 10 USDC fee);
 * the SOL pair is priced the same in dollars at `solUsd` when it is created. Its parameters are fixed
 * once created, so a later SOL price change moves its dollar FDV range.
 */
export function solanaMainnetPairs(solUsd) {
  const price = Number(solUsd);
  if (!(price > 0)) throw new Error('A positive SOL price is required.');
  const sol = usd => (usd / price).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  return [{ kind: 'native', key: 'sol', symbol: 'SOL', name: 'SOL (wrapped automatically)', decimals: 9, wsol: true, startFdv: sol(5_000), endFdv: sol(50_000), launchFee: sol(10) }];
}
