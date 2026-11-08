# ELPIDA V2.0 — Phase 1–3 contracts (local chain)

8 November 2026, branch `v2.0`. **Prototype, not audited, local chain only.** Nothing is deployed; no testnet or
mainnet was touched. Built on Model 11 (Uniswap v4 hook, liquidity locked from launch), per audit decision C8.

## Files

| File | What |
|---|---|
| `contracts/evm/v2/ElpidaV2Token.sol` | Fixed-supply ERC-20 with `burn()` that reduces `totalSupply`; ticker rule `^[A-Za-z0-9]{1,10}$` enforced on chain; no owner, mint, pause or tax |
| `contracts/evm/v2/ElpidaV2Hook.sol` | Model 11's hook with V2 economics and five fee ledgers |
| `contracts/evm/v2/ElpidaV2Factory.sol` | One-transaction launch: $10 fee (native at oracle price, or 10 USDC), token, pool, optional first buy |
| `scripts/compile-v4.mjs` | Now also builds `contracts/evm/v2` (Solidity 0.8.26, cancun, via IR) |
| `tests/helpers/v2-fixture.mjs`, `tests/v2-launchpad.test.mjs` | 9 tests against Uniswap's own PoolManager |
| `package.json` | `npm run test:v2` |

The existing `ElpidaV4Router` works unchanged with the V2 hook (it only needs `poolKey` and `currentFeeBps`).
Sizes: hook 19,419 bytes, factory 11,096, token 1,721 (limit 24,576).

## What changed from Model 11

| | Model 11 | V2 |
|---|---|---|
| Start / milestone | $5k / ×10 (23,030 ticks) | **$20k / ×5 (16,100 ticks = ×5.002)**; virtual token 1.25B |
| Fee | 1.25% fixed, 1% after milestone | **Creator picks `minFeeBps`–4% at launch; fixed for life; same fee after the milestone** |
| Anti-snipe | 90% → 1.25% over 60 s | 90% → the chosen fee over 60 s; surplus still joins the locked liquidity |
| Split | creator 50% / Elpida 50%, partner burn from Elpida's half | **creator 30 / trader airdrop 30 / flywheel 10 / holder rewards 10 / treasury 20** (treasury takes rounding remainder) |
| Recipients | creator vault, treasury | creator vault, treasury, and three immutable hook addresses: trader-airdrop vault, flywheel vault, holder-reward vault |
| First buy | uncapped | **≤ 3% of supply** (reverts above; the whole launch rolls back, fee included) |
| Partner tiers | yes | **none** (decision C4) |
| Burns | transfer to `0xdead` | **`burn()`**: launch dust and donated tokens reduce `totalSupply`; `Burned` event carries the new supply |

`minFeeBps` is a constructor value of each hook deployment (1–125), because the V2 minimum is not approved yet
(spec §25.1). Tests use 100 (1.00%), the audit's recommendation.

## Tests

`npm run test:v2`: **18 pass**. Full `npm test` on `v2.0`: 808 tests, 773 pass, 0 fail, 35 skipped (Solana validator, no CLI here) (9 reference-economics, 9 on-chain). On chain they check:

- launch at $20k, never cheaper (within 0.1% from tick rounding); the sale range is ×5.002; the whole supply sits in the
  pool; dust is really burned; the only state-changing functions are launch, fee payout, the treasury's
  liquidity switch and Uniswap callbacks — no fee setter, no principal removal; third-party liquidity refused;
- fee range: min and exactly 4% launch, 0, min−1, 401 and 1000 bps revert; anti-snipe then the chosen fee;
- tickers: invalid ones revert on chain; a duplicate ticker launches and pays the same $10;
- five-way split equals `splitFee()` on every trade (buys, a sell, a dust buy); ledgers equal the hook's claims;
  `withdrawFees` pays all five recipients their exact ledgers; nobody else can claim;
- first buy: zero valid; the reference maximum launches at 99.8–100% of the cap for 1%, 1.25% and 4%; 1% more reverts
  with the launch fee untouched; double reverts with `first buy cap`;
- milestone: raise ≈ 12.36 ETH ($30.9k) at $2,500/ETH; reached inside the crossing buy; afterwards the fee is still
  the chosen 3% and still splits five ways; ledgers stay solvent;
- a donation before the milestone cannot block it; donated tokens are burned and `totalSupply` falls by that amount;
- USDC pair with the fee paid in USDC;
- holders can burn their own tokens; the token has no other privileged function.

Model 11's own suite (`npm run test:v4`, 34 tests) and the contract-size test still pass with V2 in the same build.

## Security notes

- Highest-risk code, as for Model 11: hook custom accounting. V2 removes the in-swap partner buyback, which removes a
  swap inside a swap; it adds four ledgers and three recipient addresses.
- The three new recipient addresses are immutable per hook. They must be the real vault contracts (or multisigs)
  before any public deployment; on a test deployment they can be the treasury, and `withdrawFees` handles one address
  holding several roles.
- A recipient that cannot receive keeps its balance and never blocks the others (unchanged from Model 11).
- Solvency invariant: `totalOwed(quote)` equals the sum of all ledgers plus anti-snipe bonuses; checked after trades,
  through the milestone and after payouts.

## Not done yet (next phases)

- The three vault contracts themselves (trader airdrop, flywheel, holder rewards). Today the hook pays them in the
  quote; their distribution logic is the next phase.
- Indexer, UI (fee selector, split preview), operator-panel deployment.
- Solana program changes.
- Fuzz/invariant runs over long random sequences (Model 11 has one; port it).

## Economic consistency

Matches the V2.0 values: $10 fee, $20k start, $100k graduation (×5), default 1.25%, max 4%, 30/30/10/10/20, 3% cap,
duplicate tickers without surcharge. Minimum fee not set by the spec (recommended 1.00%).

## Compatibility by chain

EVM only, local chain. Base Sepolia and Ethereum Sepolia have Uniswap v4; BNB testnet would need the labelled test
PoolManager, as Model 11 does; Robinhood testnet has no v4 path. Solana not started.

## Deployment status

Local implementation and automated tests only. No testnet verification, no security review, no production deployment.
