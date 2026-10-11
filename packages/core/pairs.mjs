// Trading pairs, the same three kinds on every chain:
//   native  the chain's own coin (ETH, BNB, SOL…), the default
//   xstock  a tokenized stock (xStocks); on test networks a clearly labelled simulated stock
//   token   another approved token, for example a graduated Elpida token
// Creation fees are always paid in the chain's native coin, at the price the team sets in
// config/native-pricing.json. There are no dollar (USDC) pairs or fees.
// A network offers a kind when its launchpad has at least one approved asset of that kind. The web app
// shows all three everywhere and explains why a kind is unavailable on a given network.

export const PAIR_KINDS = ['native', 'xstock', 'token'];

export const PAIR_INFO = {
  native: { title: 'Native coin', glyph: 'coins', note: symbol => `Buyers pay in ${symbol}, the network’s own coin.` },
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
export function solanaPairTemplates(native, { test = false } = {}) {
  const sol = { kind: 'native', key: 'sol', symbol: 'SOL', name: 'SOL (wrapped automatically)', decimals: 9, wsol: true, startFdv: native.startFdv, endFdv: native.endFdv, launchFee: native.launchFee, testSized: !!native.testSized };
  if (!test) return [sol];
  return [sol, { kind: 'token', key: 'test-meme', symbol: 'TEST-MEME', name: 'Elpida test paired token (no value)', decimals: 6, startFdv: '500000', endFdv: '5000000', launchFee: native.launchFee, faucet: '6000000' }];
}

/** EVM test-network paired assets the treasury can deploy and approve from the browser (DEX launchpads). */
export const EVM_TEST_PAIRS = [
  { kind: 'xstock', key: 'test-stock', symbol: 'TEST-STOCK', name: 'Elpida test stock (simulated xStock, no value)', decimals: 18, startFdv: '20', faucet: '250' },
  { kind: 'token', key: 'test-meme', symbol: 'TEST-MEME', name: 'Elpida test paired token (no value)', decimals: 18, startFdv: '500000', faucet: '6000000' },
];
