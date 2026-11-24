// The page wording that says which networks Elpida runs on (17 November 2026). index.html is written for the testnet
// site; the mainnet site (ELPIDA_MODE=mainnet) serves the same file with these sentences replaced before any script
// runs, so search engines, link previews and visitors without JavaScript never read "testnet" on the mainnet site.
// app.mjs sets the same notes again once the page loads.
import { SPLIT } from '../../packages/core/seo.mjs';

/** V2.3, the only launchpad on every mainnet (23 November 2026): 50% traders / 30% creator / 20% Elpida. */
export const MAINNET_SPLIT = '50% to a monthly USDC airdrop for traders, 30% to the creator and 20% to the Elpida treasury';

/** index.html with the network wording for `mode`. `names`: the mainnet chain names, for example ['Base']. */
export function siteHtml(html, { mode, names = [] } = {}) {
  if (mode !== 'mainnet') return html;
  const where = names.length ? names.join(', ') : 'mainnet';
  const swaps = [
    ['Elpida runs on a local simulation and public testnets.', `Elpida is live on ${where} mainnet.`],
    ['Live on public testnets.', `Live on ${where} mainnet.`],
    ['Currently running on public testnets.', `Live on ${where} mainnet with real funds; the contracts are not independently audited.`],
    ['Elpida currently runs on a local simulation and public testnets only. No mainnet launch is available.', `Elpida runs on ${where} mainnet with real funds. The contracts have not been independently audited.`],
    // The mainnet footer carries no notice (Malik, 20 Nov): it is on How it works (#how-network-note).
    ['<span id="footer-note">Prototype on test networks. Test tokens have no monetary value.</span>', '<span id="footer-note" hidden></span>'],
    // Mainnet launches are V2 only: liquidity sits in a Uniswap v4 pool from launch and graduates in that same pool.
    ['When the curve sells out, its trading reserve and the remaining tokens open a DEX pool at the final curve price: Uniswap v3 on Base Sepolia and the local DEX simulation. Other EVM testnets use a locked test pool. Existing Solana tokens use PumpSwap. That liquidity is locked permanently.',
      'Every token trades in its own Uniswap v4 pool from the first block. At five times its starting market cap it graduates in that same pool: what the sale raised becomes permanent liquidity that nobody can withdraw.'],
  ];
  return swaps.reduce((page, [from, to]) => page.split(from).join(to), html);
}

/**
 * The /learn guides, the FAQ (page and JSON-LD) and llms.txt with the network wording for `mode`. Exact sentence swaps,
 * kept free of quotes and apostrophes so the HTML-escaped and JSON copies match alike.
 */
export function seoText(text, { mode, names = [] } = {}) {
  if (mode !== 'mainnet') return text;
  const where = names.length ? names.join(', ') : 'mainnet';
  const swaps = [
    ['Elpida currently runs on public testnets: Base Sepolia, Ethereum Sepolia, BNB Chain Testnet, Robinhood Chain Testnet and Solana Devnet. Mainnet is not open to the public.', `Elpida runs on ${where} mainnet. More chains follow as each gets its own deployment and checks.`],
    ['No. Elpida is in testnet. Its contracts have not had an independent audit. Do not treat any testnet token as having value, and do not send funds you cannot afford to lose to any contract that has not been audited.', `Yes, on ${where} mainnet. Its contracts have not had an independent audit, so do not send funds you cannot afford to lose. New launches have a daily cap and a launch stop.`],
    [' On testnets the amounts use test funds.', ''],
    [' On testnets the sizes are scaled down with the same shape.', ''],
    ['Only as test assets on testnets.', 'Yes. Approved tokenized stocks can be a trading pair: stocks issued by Coinbase on Base, Ondo Global Markets stocks on BNB Chain and Ethereum, and Robinhood stock tokens on Robinhood Chain. Each is priced by a Chainlink feed. Stock pairs are not available to US persons.'],
    // 24 November 2026: the V2.3 split, no Solana on the mainnet site, stocks live.
    [SPLIT, MAINNET_SPLIT],
    ['every trading fee is shared between the creator, traders, holders, a buy-and-burn flywheel and the protocol', 'every trading fee is shared between traders, the creator and the protocol'],
    ['every fee shared with creators, traders and holders', 'every fee shared with traders and creators'],
    ['how every fee is shared five ways', 'how every fee is shared three ways'],
    ['Tokenized stocks are test assets only. Their issuers', 'Tokenized stocks are issued by third parties. Their issuers'],
    [' On Solana, SOL pairs move to a Raydium CPMM pool and other pairs to PumpSwap, with the liquidity locked in a program-controlled account.', ''],
    [' On Solana the graduated position is locked in a program account.', ''],
    ['On EVM networks the pool', 'The pool'],
    [', and on Solana graduated tokens move to Raydium or PumpSwap', ''],
    ['<tr><th scope="row">Solana after graduation</th><td>SOL pairs trade in a Raydium CPMM pool (its own 1% fee tier); other pairs in PumpSwap. Fees earned by the locked position are harvested and shared the same way.</td></tr>', ''],
    ['What about test tokens launched before V2?', 'Do fees continue after graduation?'],
    ['They keep the rules they launched with: an earlier curve that graduates into a locked pool and a fee split between the protocol and the creator. Each token page says which model the token uses.',
      'Yes. Graduation happens inside the same Uniswap v4 pool, so every trade keeps paying the fee the creator chose, shared the same way, for good. There is no migration to another pool.'],
    ['Elpida currently runs on public testnets.', `Elpida runs on ${where} mainnet.`],
    ['Elpida currently runs on testnets.', `Elpida runs on ${where} mainnet.`],
    ['Launch a token on testnet', 'Launch a token'],
    ['Elpida runs on a local simulation and public testnets, its contracts are not audited, and nothing here is financial advice.', `Elpida runs on ${where} mainnet with real funds, its contracts are not independently audited, and nothing here is financial advice.`],
    ['Choose where the token lives (Base Sepolia, Ethereum Sepolia, BNB Chain Testnet, Robinhood Chain Testnet and Solana Devnet)', `Choose where the token lives (${where})`],
    ['Elpida runs on Base Sepolia, Ethereum Sepolia, BNB Chain Testnet, Robinhood Chain Testnet and Solana Devnet.', `Elpida runs on ${where} mainnet.`],
    ['Elpida is in testnet and its contracts have not had an independent audit.', 'Elpida runs with real funds and its contracts have not had an independent audit.'],
    ['Currently running on public testnets.', `Live on ${where} mainnet.`],
    ['It is in testnet; its contracts are not audited', 'It runs with real funds; its contracts are not independently audited'],
  ];
  return swaps.reduce((out, [from, to]) => out.split(from).join(to), text);
}
