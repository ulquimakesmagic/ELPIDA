# ELPIDA V2.0 — Phase 0 repository audit

8 November 2026. Audited `main` at `d81ff67` (PR #187, Model 11 stock pairs on testnets) against the
ELPIDA V2.0 master specification. Branch: `v2.0` (local; not yet pushed). Nothing was deployed, and no
contract, key or live setting was changed.

**Bottom line.** Most of V2.0 already exists in some form: a curve with locked liquidity on every chain, a
creator reward engine, holder epochs, a flywheel keeper, an Ondo registry with issuer gates, analytics and
keepers. What V2.0 changes is the *economics* (start/graduation, fee range, the five-way split, the first-buy
cap) and three things that must move **on chain**: per-token fees, the five-way split, and real burns. Because
every deployed contract is immutable, V2.0 is a **new launchpad version** for new launches. Tokens already
launched under Model 10 and Model 11 keep their current rules and must be labelled that way.

Nine of the spec's rules contradict decisions recorded since October. The spec says it overrides earlier
rules, so they are listed in §11 with a recommendation each. Four of them need Malik's answer before
contract work starts.

---

## 1. Architecture summary

| Layer | What exists | Where |
|---|---|---|
| EVM curve + graduation (**Model 10**) | Virtual-reserve curve, atomic graduation to a Uniswap v3 / PancakeSwap v3 1% pool, LP locked in `ElpidaV3FeeLocker`, partner buyback, anti-snipe | `contracts/evm/src/ElpidaDexFactory.sol`, `ElpidaDexCurve.sol`, `ElpidaV3MigrationAdapter.sol`, `ElpidaV3FeeLocker.sol` |
| EVM locked-from-launch (**Model 11**) | One Uniswap v4 hook owns every pool's liquidity forever; curve and post-milestone pool are the same pool; custom fee accounting in the quote | `contracts/evm/v4/ElpidaV4Hook.sol`, `ElpidaV4Factory.sol`, `ElpidaV4Router.sol` |
| Solana | One Anchor program: launch + optional first buy, curve, anti-snipe, partner tiers, graduation to Raydium CPMM (SOL pairs) or PumpSwap (other pairs), LP held forever by a PDA, Raydium buyback | `contracts/solana/programs/elpida_launchpad/src/lib.rs` (2,405 lines) |
| Older / parallel EVM paths | Model 9 curve, tax tokens (V2 tax router), locked pool prototype, beta curve | `ElpidaTax*`, `ElpidaLocked*`, `ElpidaBeta*`, `ElpidaCurve.sol` |
| Creator rewards | Reward vault: wallets, verified X / domain identity buckets, holder distribution, reward-token purchase, buyback with vesting, 64-recipient batches | `ElpidaRewardVault.sol`, `ElpidaCreatorAllocation.sol`, `apps/api/reward-engine.mjs` |
| Holder epochs | Manifest-committed epochs funded from the vault, two-provider archive snapshots | `ElpidaHolderEpochs.sol`, `apps/api/holder-snapshot.mjs`, `holder-epoch-keeper.mjs` |
| Flywheel | Keeper spends a hand-topped-up wallet; top 10 by market cap; native pairs only; dead-address transfer | `apps/api/flywheel-keeper.mjs`, `packages/core/revenue-flywheel.mjs` |
| Ondo / stocks | Registry, issuer-control drift checks, restriction rehearsal, feed review, TSLAon/SPYon targets, stock picker | `packages/core/ondo-*.mjs`, `config/tokenized-equity-registry.json`, `docs/ONDO_*.md` |
| Backend | Single Node server with keepers (graduation, price, buyback, flywheel, holder epochs), public indexer, analytics, admin panel, backups | `apps/api/*` |
| Indexers | EVM, v4, Solana, native-router attribution | `packages/indexer/*` |
| Frontend | Vanilla ES modules, CSP-strict, launch flow, token page, explore, portfolio, rewards, analytics, admin | `apps/web/*` |
| Data | Draft PostgreSQL schema, but the running server stores on a Railway volume | `db/schema.sql`, `apps/api/storage-*` |

## 2. Live deployments (all test networks)

| Chain | Model 10 | Model 11 | Notes |
|---|---|---|---|
| Base Sepolia | Pinned factory, block 53536219 | Pinned, Uniswap's own PoolManager | No canonical Ondo stocks on Base |
| Ethereum Sepolia | Pinned, block 12048655 | Pinned | First Ondo chain (TSLAon, SPYon) |
| BNB testnet | Pinned, PancakeSwap v3 | Pinned on a **test** PoolManager (no v4 on BNB testnet) | Test stock pairs on Model 11 |
| Robinhood testnet | Pinned, test Uniswap v3 | — | No public Elpida DEX integration |
| Solana devnet | Program upgraded 5 Nov (stock pairs) | n/a | Raydium for SOL pairs |

Nothing is on mainnet. Each network keeps several legacy factories indexed.

## 3. Working features

- Atomic launch with optional first buy, $10 fee (oracle-priced native or 10 USDC), metadata pinned at launch.
- Curves with anti-snipe (90% falling over 60 s), 1.25% fee, exact-integer accounting, slippage limits.
- Model 10 atomic graduation with LP locked; Model 11 liquidity locked from the first trade.
- Partner tiers on EVM and Solana (10% / 20% of the fee to buyback-and-burn, from Elpida's half).
- Creator reward vault, verified identities, holder distributions with a USD minimum.
- Flywheel keeper on testnets, with TWAP guard and public record.
- Ondo restriction states and drift monitoring (testnet and fork evidence only).
- Admin panel, analytics, backups with a second-provider mirror, production guard.

## 4. Incomplete features

- Independent audit, multisig/Squads for mainnet, timed restore drill (C3, C5 in the mainnet checklist).
- USDC-paired public lifecycle on Base Sepolia (A4); Robinhood has no public DEX path.
- Flywheel covers native pairs only, no Solana, and top-ups are not reconciled against fees received.
- Ondo stock pairs: the feed variant and corporate-action source are still open questions with Ondo.
- Solana stock pairs need Token-2022 support and a venue that accepts issuer extensions.
- No trader airdrop, no protocol-funded holder rewards, no concentration / connected-wallet analytics beyond the
  existing dev-transparency and holder views.

## 5. Tests

Baseline on `main` at `d81ff67`, `npm test`, 8 November 2026: **790 tests, 755 pass, 0 fail, 35 skipped**
(11 min 12 s). The 35 skips are the Solana validator suite: this environment has no Solana CLI, so those tests
were **not run** here. No broken tests were found.

The `v2.0` branch adds `tests/v2-economics.test.mjs` (9 tests, all pass): the spec's acceptance checks for the
start and graduation values, fee range, the five-way split and its rounding, the 3% cap, and the ticker rule.

## 6. Reusable as is

- The Model 11 hook design: it is the only design here that can charge **any** fee and split it **five ways on
  every trade, before and after graduation**, because the hook owns the pool. A v3 pool cannot: v3 offers fixed
  fee tiers, paid to the LP in the input token.
- The factory's CREATE2 quote ordering, USD-priced launch fee, metadata rules, partner-window code.
- Reward vault, identity verification, holder snapshot keeper, holder epochs, batching and replay markers.
- Flywheel planner and keeper (needs a new ranking and a new funding source, see §7).
- Ondo registry, restriction state machine, drift checks, stock picker.
- Indexers, analytics, admin panel, backups, production guard.

## 7. Required new components

| Component | Why |
|---|---|
| **V2 token** with `burn()` (ERC-20 supply reduction) | Spec §14.5: a dead-address transfer may not be reported as a burn. No Elpida token has `burn()` today, so under the spec **no existing token is flywheel-eligible**. |
| **V2 hook / factory** (Model 11 successor) | Per-token fee 1.25%–4% stored at launch and immutable; $20k start, $100k milestone (price ×5); 3% first-buy cap; five-way split |
| **FeeRouter + five vault ledgers** | On-chain 30/30/10/10/20 split with events; today the split is 50/50 in the hook and the flywheel is off-chain |
| **TraderAirdropVault** + volume indexer + monthly Merkle/batch payouts | New |
| **HolderRewardVault** (protocol-funded, separate from the creator vault) | New; converts to the native asset or the paired Ondo asset |
| **FlywheelVault** funded on chain | Replaces the hand-topped-up keeper wallet |
| Solana equivalents | Per-token fee field, five-way split, SPL `burn`, first-buy cap |
| Concentration and connected-wallet analytics | New |

## 8. Breaking contract changes

All are new deployments; nothing deployed can be changed.

- New token ABI (`burn`), new hook constants (`VIRTUAL_TOKEN = 1.25 × supply`, milestone ×5), per-pool fee
  storage, new events for five ledgers. Indexers and the UI must read both old and V2 layouts.
- Solana: a program upgrade with new account fields. Existing pool accounts keep the old layout, so the
  program must read both, or V2 pools use a new account type.

## 9. Data migrations

- Index records gain `launchpadVersion: 'v2'`, `feeBps`, and the five ledger totals. Old tokens keep
  `fee: 125, split: 50/50` so analytics never mixes them.
- Analytics totals must be per version until reconciled; the spec's protocol dashboard (§21.6) shows V2 only or
  labels both.
- The flywheel's public record keeps its old "sent to dead address" label; V2 entries show supply burned.

## 10. Economics check (spec §8.3)

Same curve family as today. Price continuity at graduation needs virtual token `vT = r·S/(r−1)`, where r is
the price multiple (scratch simulation, exact formulas, fees 1.25%):

| | Today: $5k → $50k (×10) | V2: $20k → $100k (×5) |
|---|---|---|
| Virtual token | 1.1111 B | 1.2500 B |
| Sold on the curve | 75.97% | 69.10% |
| Raised before fees | $12,013 | **$30,902** |
| Locked pool at graduation | 24.03% + $12,013 (TVL $24k) | 30.90% + $30,902 (TVL **$61.8k**) |
| Cost of the first 3% | $156 | **$623** (the V2 first-buy cap) |
| Cost of the first 20% (10 wallets × 2%) | $1,235 | $4,822 |
| Price impact of a $1,000 buy after graduation | 9.3% | 4.2% |
| Price impact of a $5,000 buy after graduation | 42.6% | 17.2% |

So V2 roughly **quadruples the cost of bundling the early supply** and gives a pool **2.6× deeper** at graduation.
It does not stop bundling: 20% of supply still costs under $5,000.

The fee example in spec §11.2 checks out: $1,250 of fees → $375 / $375 / $125 / $125 / $250. At 4%, $100k of
volume gives $1,200 / $1,200 / $400 / $400 / $800. Integer rounding: compute four shares by floor and give the
remainder to the treasury, so the five always sum exactly.

## 11. Conflicts with recorded decisions

The spec says it overrides earlier rules. These are the places where it does, with a recommendation each.

| # | Recorded decision | V2.0 spec | Recommendation |
|---|---|---|---|
| C1 | Start $5k FDV, migrate at $50k | $20k start, $100k graduation | Adopt for V2 launches; old tokens unchanged |
| C2 | No cap on the creator's first buy (Oct) | Optional, capped at 3% of supply | Adopt |
| C3 | Fee 1.25% fixed, split 50% creator / 50% Elpida | 1.25% default, up to 4%, split 30/30/10/10/20 | Adopt |
| C4 | **Partner tiers**: creator always keeps 50%; Partner 50/10/40, Elite 50/20/30 | Not mentioned; creator gets 30% | **Needs Malik.** Recommend: keep tiers, but take their extra buyback from the 20% treasury share (Partner 10 points, Elite 15), and leave the creator at 30% |
| C5 | **After the milestone, Model 11 charges 1%** (2 Nov) | The creator's fee continues after graduation | **Needs Malik.** Recommend: keep the creator's chosen fee after the milestone, as the spec says; the hook can do it |
| C6 | Flywheel: off-chain wallet topped up with 10% of *protocol* fees (≈5% of all fees), ranked by market cap, dead-address transfer | 10% of *all* fees on chain, ranked by verified 7-day volume, true burns | Adopt the on-chain vault and real burns. **Needs Malik on the ranking**, see C9 |
| C7 | Fee payable in the native coin at an oracle price, or 10 USDC | "$10 USDC" | **Needs Malik.** Recommend: keep both. Requiring USDC forces every creator to hold USDC on the launch chain, which on Solana and BNB costs an extra swap. The protocol still receives $10 |
| C8 | EVM: Model 10 (v3 graduation) and Model 11 (v4, locked from launch) both live | "Graduation", "migration" and "permanently lock post-graduation liquidity" | Build V2 on **Model 11**: liquidity is locked from launch, so there is no migration step to fail, and the milestone at $100k is the graduation. Model 10 cannot enforce a 1.25–4% fee or the split after graduation |
| C9 | — | Flywheel top 10 by **volume**; trader airdrop pays top **volume** wallets | See the risk below |

**Volume can be bought.** With the V2 split, a creator who wash-trades their own token pays the fee but gets
back 30% as creator and up to 30% as trader airdrop (if their wallets win the ranking). Net cost: about 40% of
the fee, so **0.5% of volume at the default fee**. $1M of fake volume costs about $5,000 and buys a top-10
flywheel slot and a large airdrop share. The spec asks for anti-wash filters; they will catch the obvious cases
(self-trades, circular trades, one funding source) but not well-funded independent wallets. Recommendations:

1. Rank the flywheel by **net buy volume from wallets not linked to the creator**, with a minimum number of
   independent traders, rather than gross volume.
2. Cap each wallet's airdrop share (spec §13.4.7), and exclude wallets that traded only the token they created.
3. Pay airdrops in proportion to **fees paid**, capped, rather than ranked top-N, so buying rank has no cliff.

## 12. Security considerations

- The hook is the highest-risk code (custom accounting). V2 adds per-pool fee storage and five ledgers to it.
  It needs the independent audit before any mainnet use, and fuzz tests on the split's conservation.
- Five vaults multiply the solvency invariants. One test must assert, after every trade, that the hook's
  balance in each quote equals the sum of the five ledgers plus pool principal.
- The trader airdrop and holder rewards add keeper keys that move funds. Keep them per chain, capped per
  cycle, and with the Merkle root published before payouts.
- Ondo pause bypass: our curve must refuse trades in the paired asset when the issuer pauses; third-party
  pools cannot be stopped, and the UI must say so.
- Upgrade authority: EVM contracts are immutable; the Solana program is upgradeable, so its authority must move
  to Squads before mainnet (checklist C3).

## 13. Roadmap (dependency order)

1. **Decisions C4, C5, C7, C9** (this document).
2. ~~Reference economics in `packages/core`~~ **Done on `v2.0`:** `packages/core/v2-economics.mjs` and its tests.
   The minimum fee is a required caller parameter until it is approved. For a ×5 multiple the hook's sale range is
   16,100 ticks (×5.002), against 23,030 for ×10 today.
3. V2 token with `burn()`, V2 hook and factory on a local chain: start, milestone, fee range, cap, split.
4. Fee ledgers and the three new vaults (flywheel, trader airdrop, holder rewards) on a local chain.
5. Indexer and UI support for both versions; launch form fee selector and split preview.
6. Solana program changes.
7. Testnet deployments from the operator panel (Malik), then the keepers.
8. Analytics, concentration, then the audit package.

## 14. Spec parameters still open (§25)

Not decided by the spec and not by this audit: minimum fee (recommend **1.00%**, so the five shares stay
meaningful), trader reward formula and caps, holder snapshot frequency (recommend weekly per chain), minimum
payout, flywheel cadence (today daily), airdrop currency (recommend the chain's native coin, like holder rewards),
recovery timeout after an issuer pause.
