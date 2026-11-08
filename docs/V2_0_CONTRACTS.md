# ELPIDA V2.0 — contracts on a local chain (roadmap step 3)

8 November 2026, branch `v2.0`. **Prototype, not audited, local chain only.** Nothing is deployed; no testnet or
mainnet was touched. Built on Model 11 (Uniswap v4 hook, liquidity locked from launch), per audit decision C8.

Two sessions built this step in parallel on 8 November. Malik chose this version (the one first pushed as
`v2.0-session-b`); it replaces the other's contracts and tests on `v2.0`. The audit, the reference economics and the
trader-airdrop simulation (`V2_0_AUDIT.md` §14a) are kept as they were.

## Files

| File | What |
|---|---|
| `contracts/evm/v2/ElpidaV2Token.sol` | Fixed 1B supply minted once to the hook; `burn()` and `burnFrom()` reduce `totalSupply`; no owner, mint, pause or tax |
| `contracts/evm/v2/ElpidaV2Hook.sol` | Model 11's hook with V2 economics and five fee ledgers per token |
| `contracts/evm/v2/ElpidaV2Factory.sol` | One-transaction launch: $10 fee (native at the oracle price, or 10 USDC), ticker rule, token, pool, optional first buy |
| `scripts/compile-v4.mjs` | Also builds `contracts/evm/v2` (Solidity 0.8.26, cancun, via IR); the issuer-stock mock joins the test build |
| `tests/helpers/v2-fixture.mjs`, `tests/v2-hook.test.mjs` | 9 tests against Uniswap's own PoolManager |
| `package.json` | `npm run test:v2` (reference economics and contracts) |

The existing `ElpidaV4Router` trades V2 tokens unchanged (it needs only `poolKey` and `currentFeeBps`). Sizes: hook
17,971 bytes, factory 10,960, token 1,794 (limit 24,576). Model 11's bytecode is unchanged by the shared build.

## What changed from Model 11

| | Model 11 | V2 |
|---|---|---|
| Start / milestone | $5k / ×10 (23,030 ticks) | **$20k / ×5 (16,100 ticks = ×5.002)**; virtual token 1.25B, virtual quote = start × 5/4 |
| Fee | 1.25% fixed, 1% after the milestone | **Creator picks `minFeeBps`–4% at launch; fixed for life; same fee after the milestone** (C5) |
| Anti-snipe | 90% → 1.25% over 60 s | 90% → the token's own fee over 60 s; the surplus still joins the locked liquidity, never paid out |
| Split | creator 50% / Elpida 50%, partner burn from Elpida's half | **creator 30 / trader airdrop 30 / flywheel 10 / holder rewards 10 / treasury 20** of the running total, each rounded down; the milestone's dust to the treasury; the split's remainder (0–4 base units per token, ever) stays in the hook |
| Ledgers | creator and protocol balances, updated per trade | **one running fee total per token**; each recipient is owed its share of it, rounded down, less what it was paid (`ledgers(token)`). One storage write per trade instead of five |
| Recipients | creator vault, treasury | creator vault per token; trader-airdrop vault, flywheel vault, holder-reward vault and treasury fixed per hook |
| First buy | uncapped, base fee | **at most 3% of supply** on the tokens received, at the token's own fee; above it the whole launch reverts (`FirstBuyAboveCap`) |
| Partner tiers | yes | **none** (C4) |
| Burns | transfer to `0xdead` | **`burn()`**: launch dust and tokens donated to the pool reduce `totalSupply` |
| Third-party liquidity | the treasury could open a graduated pool | **never**: every pool holds only the hook's positions, so the fee and split cannot be bypassed in the same pool |
| Tickers | any | `^[A-Za-z0-9]{1,10}$` on chain in the factory; duplicates allowed, no registry, no surcharge |
| Start market cap | any value from 1 to 1,000,000 | **20,000, or 50 on a test-sized test network** (the factory accepts nothing else) |

`minFeeBps` is a constructor value of each hook (1–125) because the spec leaves the minimum open (§25.1). Tests use
100 (1.00%), the audit's recommendation.

## Gas

Five ledgers written on every trade cost about 17,000 gas more per trade than one running total (51,000 more on a
token's first trade, when the slots are new). Measured on a local chain through the Elpida router, at 1.25%:

| | First buy | Next buy | Sell |
|---|---|---|---|
| Five ledgers per trade | 289,831 | 154,512 | 158,446 |
| **One running total (current)** | **238,291** | **137,172** | **141,106** |

## Issuer pause (spec §17)

Nothing in the hook swaps one asset for another. When the quote is an Ondo stock and the issuer pauses transfers,
every trade in its pools fails at the transfer, and every payout fails inside its own step: the amount stays owed
(`FeePayoutFailed`) and is paid in full once transfers resume. The test runs this with the issuer-stock mock.

## Tests

`npm run test:v2`: 26 pass (12 reference economics, 5 airdrop, 9 on chain). On chain:

- **Start and graduation:** $20,000 at launch, never cheaper (tick rounding at most +0.1%); 16,100-tick sale range;
  sale position within 0.01% of 69.1% of supply; a buy crossing the milestone moves about $30.9k (12.36 ETH at $2,500)
  into the locked range; graduation at ×5.002.
- **First buy:** zero, small, and the reference maximum (99.8–100% of the cap) at 1%, 1.25% and 4%, native and
  USDC; 0.5–1% more reverts with `FirstBuyAboveCap`; the full 3% costs about $623.
- **Fee:** 0, 99, 401 and 9,000 bps revert; 100/125/250/400 launch and are reported; anti-snipe, then the
  token's own fee; a 4% token still charges 4% after graduating; no setter exists on the hook or the factory.
- **Split:** after every trade (anti-snipe window, dust-sized trades, sells, the milestone, a recipient paid mid-way)
  the running total equals the sum of the `Fee` events at the token's rate, each recipient's share equals
  `splitAccrued()`, and the hook's claims equal what is owed plus the bonus plus a remainder of at most 4;
  `withdrawFees` (anyone may call) pays all five exactly what they are owed.
- **§17:** a paused stock quote stops trading and holds all five payouts owed; after unpausing they pay in full and
  trading resumes.
- **Locked:** adding liquidity, creating a pool on the hook, and calling `launch` directly all revert.
- **Tickers and launch fee:** duplicates launch as separate tokens; invalid tickers and empty names revert;
  $10 in ETH (0.004 at $2,500) or exactly 10 USDC reaches the treasury.
- **Burns:** launch dust is burned (nothing at `0xdead`); holders burn and `burnFrom` respects allowances; 1,000
  donated tokens come out at the milestone and are burned.
- **Router:** the quote equals the trade, with the token's own fee.

## Security notes

- Highest-risk code, as for Model 11: the hook's custom accounting. V2 removes the in-swap partner buyback (no swap
  inside a swap) and adds four ledgers and three recipient addresses.
- The three new recipient addresses are immutable per hook. They must be the real vault contracts (or multisigs)
  before any public deployment.
- A recipient that cannot receive keeps its balance and never blocks the others.
- Ledgers are `uint128`, which is more than enough for any real asset; a cast that overflowed would revert the trade
  rather than wrap.

## Not done yet (next phases)

- The three vault contracts (trader airdrop, flywheel, holder rewards) and their keepers.
- Indexer and UI (fee selector, split preview), and deployment from the operator panel.
- Solana program changes.
- A long random-sequence invariant run (Model 11 has one; port it).

## Economic consistency

Matches the V2.0 values: $10 fee, $20k start, $100k graduation (×5), default 1.25%, max 4%, 30/30/10/10/20, 3% cap,
duplicate tickers without a surcharge. The anti-snipe surplus (first 60 seconds only) is locked as liquidity rather
than split, as in Models 10 and 11 (confirmed by Malik, 8 November). The minimum fee is still open.

## Compatibility by chain

EVM only, local chain. Base Sepolia and Ethereum Sepolia have Uniswap v4. BNB testnet would need the labelled test
PoolManager, as Model 11 does. Robinhood testnet has no v4 path. Solana is not started.

## Deployment status

Local implementation and automated tests only. No testnet deployment, no security review, no production deployment.
