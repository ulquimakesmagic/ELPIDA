# Pre-mainnet plan: audit, keys and legal (checklist C1, C3, D5; 24 October 2026)

What has to happen, and roughly what it costs, before any mainnet launch on Base, BNB Chain, Robinhood Chain,
Ethereum or Solana. Prices are market references, not quotes. Nothing here has been booked or sent.

## 1. Audit (C1)

**What we ask auditors to review** is fixed in `docs/AUDIT_SCOPE.md`: 9 EVM files, 768 source lines (one codebase
for all four EVM chains; 631 before the partner buyback was added on 26 October), plus the Solana program (2,287
lines, Anchor, 23 instructions, including the Raydium graduation and buyback) as a separate engagement. The brief already
lists our own findings (F-1 to F-7), the invariants we test, the Slither triage and the fork-check results on all
four mainnets.

**What that size usually costs (2026 market references):**

| Option | Typical price | Notes |
|---|---|---|
| Solo independent auditor, small scope | about $1k–8k | One experienced reviewer; often the best value for a small codebase. Check past reports first |
| Boutique firm | about $10k–40k | A team, a formal report and a recognisable name |
| Top-tier firm | $50k+ | Large scope and long queues; not needed at this size |
| Competitive audit (contest) | depends on the prize pool | Many researchers at once; about 500 lines fits a roughly 3-day contest window |
| Re-check after fixes | about $5k–20k per pass at firms; often included by solo auditors | Ask up front |

- Solana (Rust/Anchor) reviews typically cost 25–40% more than the same size in Solidity.
- Rushed timelines typically add 20–40%.
- The money-moving code is what gets priced, not the repository size, so the small EVM scope keeps the EVM quote low.

**Suggested order for a tight budget:**
1. One solo auditor with public past reports on Uniswap-v3-style integrations reviews the EVM scope (about a week).
2. Fix, then ask for the re-check.
3. Solana separately, from someone with public Anchor reports, before Solana mainnet.
4. After launch, a public bug bounty sized to what the contracts hold.

**Quote request (draft; Malik sends it, nothing is sent automatically):**

> Subject: Audit quote: Elpida launchpad, 9 Solidity files / 768 SLOC
>
> Hi, I'm Malik, building Elpida (elpida.fun), a memecoin launchpad. I'm looking for a security review of our EVM
> contracts before mainnet on Base, BNB Chain, Ethereum and Robinhood Chain.
>
> - Scope: 9 Solidity 0.8.24 files, 631 source lines. A bonding curve that graduates into a Uniswap v3 / PancakeSwap v3
>   pool inside the completing buy, a full-range position locked forever, a Chainlink-priced $10 launch fee, a
>   50/50 fee splitter, and an opt-in partner buyback-and-burn capped at 1% of pool depth per call. No owner, pause,
>   upgrade or rescue functions.
> - The brief is attached: scope, roles, invariants, our own findings and the Slither triage. Fork checks of the full
>   lifecycle passed on all four mainnets.
> - Repository and the commit to review are available on request.
>
> Could you share your availability, a fixed price and whether a re-check of fixes is included? I'm a small team
> on a tight budget, so a focused review of the money-moving paths suits us best.
>
> Thanks, Malik

### Shortlist and how to reach them (checked 30 October 2026)

Contact routes are taken from each firm's own site. No firm has been contacted, and no price has been quoted.

| Scope | Who | Why | How to request |
|---|---|---|---|
| EVM | Pashov Audit Group | Boutique; lists both Solidity and Solana (Rust/Anchor); says a focused single-contract review takes 3–5 days and can start within 24 h | Form at pashov.com/request-audit, or Telegram @pashovkrum |
| EVM | Cantina | Private audit by a matched researcher team, or a competition | support@cantina.xyz, or "Request an Audit" on cantina.xyz |
| EVM | Sherlock | Contest or collaborative audit | sherlock.xyz/contact |
| Solana | Accretion | Anchor-specific reviews by two researchers, fix verification included; public reports (MetaDAO, Marginfi) at github.com/accretion-xyz/audit-reports | accretion.xyz/inquiry, contact@accretion.xyz |

A 2026 market guide puts boutique and independent reviews at about $5k–60k over 1–6 weeks, and Rust programs at a
20–60% premium over Solidity. Ask each firm for:
- a fixed price;
- the start date;
- the number of reviewers;
- whether a re-check of fixes is included.

**Attach the brief as a PDF** rendered from `AUDIT_SCOPE.md` at the commit you send. Keep the repository private;
grant read access to the chosen auditor only, at the recorded commit.

**Solana quote request (draft):**

> Subject: Anchor audit quote: Elpida launchpad program, ~2,200 lines
>
> Hi, I'm Malik, building Elpida (elpida.fun), a memecoin launchpad live on Solana devnet. Before Solana mainnet
> I'm looking for a review of our Anchor program.
>
> - Scope: one Anchor program (`lib.rs`, about 2,200 lines, 23 instructions): a bonding curve, a $10 launch fee priced
>   by Pyth, graduation into Raydium CPMM (1% tier) through raw CPIs with permanently locked LP, LP-fee harvesting
>   and a partner buyback-and-burn capped at 1% of pool depth. Other pairs graduate into PumpSwap.
> - Test-only instructions refuse to run off test clusters. Upgrade authority moves to a Squads multisig before
>   mainnet.
> - The brief is attached. The Raydium graduation, harvest and buyback have been verified on devnet.
>
> Could you share availability, a fixed price and whether a re-check of fixes is included?
>
> Thanks, Malik

Sources: [Pashov Audit Group](https://www.pashov.com/),
[Cantina: how audits work](https://docs.cantina.xyz/for-organizations/security-solutions/how-audits-work),
[Sherlock audit contests](https://sherlock.xyz/solutions/audit-contests),
[Accretion Anchor audits](https://accretion.xyz/services/anchor-audits),
[Smart contract audit pricing 2026](https://www.smartcontractaudit.com/guides/smart-contract-audit-pricing-2026).

## 2. Keys (C3)

**EVM treasury:** each chain's launchpad treasury is fixed forever at deployment, so it must be a Safe with at least
two signers from the start. The site enforces this on mainnet. Steps: `docs/MULTISIG_TREASURY.md`. Cost: only the
gas to create the Safe on each chain (cents on Base and Robinhood Chain, more on Ethereum).
- Two separate signing keys, ideally one on a hardware wallet. Never two keys on the same device.
- Before Robinhood Chain: confirm Safe{Wallet} offers Robinhood Chain in its network selector. Safe's networks page
  shows a "Robinhood" entry. If it is missing at deployment time, wait rather than use a single wallet.

**Solana upgrade authority:** today it is the single deployer `FeUWF…KaH8`. Before Solana mainnet, move it to a Squads
multisig (2 of 2 or 2 of 3) with `npm run solana:deploy -- --cluster mainnet … --transfer-authority <Squads vault>`.
Upgrades then go through Squads (`scripts/solana-beta.mjs` prepares the buffers).

## 3. Legal and terms (D5)

**Get a lawyer's view before mainnet.** Claude is not a lawyer, and this is not legal advice. What a lawyer should
look at first:

- **Nigeria:** the Investments and Securities Act 2025 (Act No. 2 of 2025, in force from 25 March 2025) brings
  virtual and digital assets into the definition of securities. It lets the SEC register and regulate exchanges,
  virtual asset service providers and digital asset operators.
  - The SEC's rules also cover Digital Asset Offering Platforms.
  - A revised minimum-capital circular sets capital floors for such platforms, with compliance due by 30 June 2027.
  - The SEC's ARIP pathway fast-tracks digital-asset providers.
  - Question for the lawyer: does Elpida count as an offering platform or another regulated operator? If so, is ARIP
    the right route?
- **Where users are:** which countries to block or restrict, for example under US and UK rules.
- **The site's terms and risk disclosures:** a starting draft is in `docs/TERMS_AND_RISK_DRAFT.md` for the lawyer to
  edit.

## 4. Order

1. Get two or three audit quotes. Start with solo auditors.
2. A lawyer's initial view (Nigeria first), because it may change what launches and where.
3. The audit and its fixes.
4. Safes per chain, then a Squads multisig for Solana.
5. A mainnet deployment per chain, with suggested `maxAge` values from `MULTICHAIN_TESTNETS.md`.
6. A bug bounty.

Sources (read 23–24 Oct 2026):
- [Sherlock, Smart contract audit pricing 2026](https://www.sherlock.xyz/post/smart-contract-audit-pricing-a-market-reference-for-2026)
- [What does a smart contract audit actually cost (DEV)](https://dev.to/juan23z/what-does-a-smart-contract-audit-actually-cost-an-honest-breakdown-for-small-protocols-5gfm)
- [Safe networks](https://safe.global/networks)
- [Nigeria ISA 2025 and digital assets (CryptoSlate)](https://cryptoslate.com/crypto-laws/nigeria-investments-securities-act-2025-virtual-digital-assets/)
