// Trading pairs, the same four kinds on every chain:
//   native  the chain's own coin (ETH, BNB, SOL…), the default
//   usdc    verified USDC, with a deployed migration configuration
//   xstock  a tokenized stock (xStocks); on test networks a clearly labelled simulated stock
//   token   another approved token, for example a graduated Elpida token
// Creation fees support oracle-priced native currency or verified USDC. Network gas remains native.
// A network offers a kind when its launchpad has at least one approved asset of that kind. The web app
// shows all four everywhere and explains why a kind is unavailable on a given network.

export const PAIR_KINDS = ['native', 'usdc', 'xstock', 'token'];

/**
 * USD reference for a token's quote asset, used to show prices, liquidity and market caps in dollars.
 * Native pairs use the chain's oracle price (`nativeReference`). USDC pairs are valued at $1 per USDC:
 * an explicit parity assumption, labelled as such, not an oracle reading. Other kinds keep whatever
 * reference they already carry (usually none, so values stay in the pair asset).
 */
export const USDC_PARITY_SOURCE = 'USDC valued at $1 (assumed parity)';
export function usdReferenceFor(token, nativeReference, now = Math.floor(Date.now() / 1000)) {
  if (token?.pair === 'native') return nativeReference ?? null;
  if (token?.pair === 'usdc') return { status: 'fresh', usd: 1, updatedAt: now, maxAge: Number.MAX_SAFE_INTEGER, source: USDC_PARITY_SOURCE };
  return token?.usdReference ?? null;
}

export const PAIR_INFO = {
  native: { title: 'Native coin', glyph: 'coins', note: symbol => `Buyers pay in ${symbol}, the network’s own coin.` },
  usdc: { title: 'USDC', glyph: 'coins', note: () => 'Buyers pay in USDC. The curve and graduated pool stay paired with USDC; network gas is separate.' },
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
 * Solana pair templates for a cluster. `native` is that cluster's entry in config/native-pricing.json
 * (launchFee in SOL, startFdv / endFdv in SOL). Test networks add a labelled test paired token, minted
 * only by the program's faucet PDA; its curve is sized in that token, its creation fee is still SOL.
 */
export function solanaPairTemplates(native, { test = false, usdcMint = null, usdcStartFdv = '5000' } = {}) {
  const sol = { kind: 'native', key: 'sol', symbol: 'SOL', name: 'SOL (wrapped automatically)', decimals: 9, wsol: true, startFdv: native.startFdv, endFdv: native.endFdv, launchFee: native.launchFee, testSized: !!native.testSized };
  const pairs = [sol];
  if (usdcMint) pairs.push({ kind: 'usdc', key: 'usdc', symbol: 'USDC', name: test ? 'Circle test USDC (no value)' : 'USDC', mint: usdcMint, decimals: 6, startFdv: usdcStartFdv, endFdv: String(Number(usdcStartFdv)*10), launchFee: native.launchFee, testSized: !!test });
  if (test) pairs.push({ kind: 'token', key: 'test-meme', symbol: 'TEST-MEME', name: 'Elpida test paired token (no value)', decimals: 6, startFdv: '500000', endFdv: '5000000', launchFee: native.launchFee, faucet: '6000000' });
  return pairs;
}

/** EVM test-network paired assets the treasury can deploy and approve from the browser (DEX launchpads). */
export const EVM_TEST_PAIRS = [
  { kind: 'xstock', key: 'test-stock', symbol: 'TEST-STOCK', name: 'Elpida test stock (simulated xStock, no value)', decimals: 18, startFdv: '20', faucet: '250' },
  { kind: 'token', key: 'test-meme', symbol: 'TEST-MEME', name: 'Elpida test paired token (no value)', decimals: 18, startFdv: '500000', faucet: '6000000' },
];
