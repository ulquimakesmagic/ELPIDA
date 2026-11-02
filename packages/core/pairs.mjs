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
  // Only the explicitly simulated issuer on public test networks supplies this reference.
  // Never promote test issuer data into a live stock valuation.
  const stock=token?.stock;
  if(token?.pair==='xstock'&&['ethereum-sepolia','base-sepolia','bnb-testnet','robinhood-testnet'].includes(token.network)&&stock?.provider==='ondo-test'){
    const usd=Number(stock.price),updatedAt=Number(stock.updatedAt),age=now-updatedAt;
    if(!stock.paused&&['open','closed'].includes(stock.marketStatus)&&Number.isFinite(usd)&&usd>0&&Number.isFinite(updatedAt)&&age>=-300&&age<=172800)
      return {status:'fresh',usd,updatedAt:Math.min(now,updatedAt),maxAge:172800,source:'Simulated test-stock USD feed (no monetary value)',feed:stock.feed};
    return null;
  }
  return token?.usdReference ?? null;
}

export const PAIR_INFO = {
  native: { title: 'Native coin', glyph: 'coins', note: symbol => `Buyers pay in ${symbol}, the network’s own coin.` },
  usdc: { title: 'USDC', glyph: 'coins', note: () => 'Buyers pay in USDC. The curve and graduated pool stay paired with USDC; network gas is separate.' },
  xstock: { title: 'Tokenized stock', glyph: 'chart-candlestick', note: () => 'Buyers pay in a tokenized stock from the network’s designated provider. On test networks this is a simulated stock with no value; live provider assets stay off until verified.' },
  token: { title: 'Paired token', glyph: 'layers', note: () => 'Buyers pay in another approved token, such as a graduated Elpida token.' },
};

/**
 * Why a kind is unavailable on a chain even though it is part of the structure. xStocks on Solana are
 * Token-2022 mints with an issuer permanent delegate; PumpSwap refuses such quote mints, so an
 * xStock-paired curve could never graduate. Meteora DAMM v2 accepts them (xStocks are badged there),
 * so a DAMM v2 graduation path is the way to add them.
 */
// New Solana launches pair with SOL only, so every curve graduates to Raydium (decided 1 November 2026). Tokens
// already launched on USDC or token pairs keep trading on their PumpSwap pools, and stay indexed and claimable.
const SOL_ONLY = 'New Solana launches pair with SOL and graduate to Raydium. Tokens already launched on other pairs keep trading on PumpSwap.';
export const SOLANA_LAUNCH_KINDS = Object.freeze(['native']);
export const PAIR_LIMITS = {
  solana: { usdc: SOL_ONLY, token: SOL_ONLY, xstock: 'Not on Solana: new Solana launches pair with SOL only, and xStocks carry an issuer permanent delegate that blocks graduation (see docs/TOKENIZED_EQUITY.md).' },
};

/**
 * Designated tokenized-stock provider per network (mainnet and test keys). One provider each; there is no
 * fallback to another. Live capabilities are tracked in config/tokenized-equity-registry.json and are off
 * until verified. Display names only; nothing here implies a partnership.
 */
export const EQUITY_PROVIDERS = {
  ethereum: 'xStocks', 'ethereum-sepolia': 'xStocks', 'solana-mainnet': 'xStocks', 'solana-devnet': 'xStocks', 'solana-localnet': 'xStocks',
  'robinhood-testnet': 'Robinhood Stock Tokens', 'bnb-testnet': 'Binance bStocks', 'base-sepolia': 'Coinbase Tokenized Stocks',
};

/**
 * Issuer-risk text shown before a live (non-test) tokenized stock is used as a trading pair. Every sentence is
 * backed by the provider's own documentation or by the local fork checks recorded in docs/TOKENIZED_EQUITY.md.
 * Providers we have not verified get the generic text only; nothing is invented for them.
 */
const GENERIC_ISSUER_NOTICE = 'This is a tokenized stock issued and controlled by its provider, not by Elpida. The provider can restrict, pause or change it, and eligibility rules apply, including exclusions for US persons. Elpida cannot reverse an issuer action.';
export const ISSUER_NOTICES = {
  'Robinhood Stock Tokens': 'Robinhood can block any account, pause a token, burn tokens from any account and upgrade every token at once. In our fork tests a block on a curve or pool stopped all buys and sells until the issuer unblocked it, and a burn from a curve would leave it short of funds.',
  'Coinbase Tokenized Stocks': 'Coinbase sets transfer policies and can pause these tokens; a transfer to a blocked address fails. A policy change could stop a curve or pool from trading until it is reversed.',
  xStocks: 'xStocks are issued by Backed Finance and can be paused around corporate actions such as dividends and splits. On Solana the mint carries an issuer permanent delegate, which some pools refuse.',
};
export function issuerNotice(provider) {
  const specific = ISSUER_NOTICES[provider];
  return specific ? `${specific} ${GENERIC_ISSUER_NOTICE}` : GENERIC_ISSUER_NOTICE;
}

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
  // An Ondo-style test stock (contracts/evm/testnet/ElpidaTestOndoStock.sol): issuer pause, blocklist and a test
  // total-return price feed, so the stock gate can be rehearsed end to end. Not an Ondo token; no value.
  { kind: 'xstock', key: 'test-ondo-nvda', symbol: 'tNVDAon', name: 'Elpida test Ondo-style NVDA stock (no value)', decimals: 18, startFdv: '20', faucet: '25',
    ondo: { feed: 'tNVDAon / USD (test total-return)', price: '180' } },
  // More Ondo-style stand-ins (2 November 2026), so the stock dropdown can be tried with several stocks. Same contracts
  // and controls as tNVDAon; prices are round test values near the real stocks', posted by the treasury afterwards.
  { kind: 'xstock', key: 'test-ondo-tsla', symbol: 'tTSLAon', name: 'Elpida test Ondo-style TSLA stock (no value)', decimals: 18, startFdv: '20', faucet: '25',
    ondo: { feed: 'tTSLAon / USD (test total-return)', price: '410' } },
  { kind: 'xstock', key: 'test-ondo-spy', symbol: 'tSPYon', name: 'Elpida test Ondo-style SPY ETF (no value)', decimals: 18, startFdv: '20', faucet: '25',
    ondo: { feed: 'tSPYon / USD (test total-return)', price: '765' } },
  { kind: 'xstock', key: 'test-ondo-qqq', symbol: 'tQQQon', name: 'Elpida test Ondo-style QQQ ETF (no value)', decimals: 18, startFdv: '20', faucet: '25',
    ondo: { feed: 'tQQQon / USD (test total-return)', price: '695' } },
  { kind: 'xstock', key: 'test-ondo-aapl', symbol: 'tAAPLon', name: 'Elpida test Ondo-style AAPL stock (no value)', decimals: 18, startFdv: '20', faucet: '25',
    ondo: { feed: 'tAAPLon / USD (test total-return)', price: '340' } },
];
