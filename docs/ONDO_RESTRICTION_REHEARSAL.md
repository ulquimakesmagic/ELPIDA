# Ondo issuer restriction rehearsal, 29 October 2026

This is local-fork evidence, not an issuer permission, audit approval or public deployment. Model 10, production contracts and separate chain wallets are unchanged. All tokenized-equity capabilities remain disabled.

## Confirmed dependency path

The NVDAon token delegates compliance to OndoComplianceGMView, which forwards the shared GM identifier to OndoCompliance. That core checks a blocklist and a sanctions list. GMToken separately checks TokenPauseManager. The source records for the token implementation, compliance view, compliance core, pause manager and blocklist were retrieved from Sourcify v2. Their recorded runtime hashes match the fork's deployed code before any local issuer operation is allowed.

| Contract | Ethereum address | Relevant authority |
|---|---|---|
| GMToken implementation | `0xebbcb2cee51c2fee4062c9c1270dcb98b0b22250` | CONFIGURER_ROLE can replace managers; default admin administers roles; beacon can replace implementation |
| Compliance view | `0x54a8757c2fef8649830b158a8c19d3a670e80318` | Ownable2Step owner can replace compliance core and GM identifier |
| Compliance core | `0x156f73fc73197555e950743cb2b23f411c751002` | Master or asset-specific configuration roles can replace lists; role manager administers asset roles |
| Pause manager | `0xfd48112e448417ca79305a518c4186df4b0a200a` | Separate pause/unpause roles; default admin can change membership; individual and global pause |
| Blocklist | `0xd8c8174691d936e2c80114ec449037b13421b0a8` | Ownable2Step owner can add/remove blocked accounts |

The view, core, pause manager and blocklist sources are direct contract implementations without a proxy upgrade function. Their owners/roles and replaceable dependency pointers still matter. This does not establish who legally controls any authority account, validate its signer threshold, or audit the token beacon or sanctions provider.

Source records use `https://sourcify.dev/server/v2/contract/1/<address>?fields=all`. They report runtime matches; metadata transformations are not an independently reproduced exact compilation. The rehearsal refuses changed bytecode rather than guessing compatible methods.

## What is tested

[ondo-ethereum-nvda-restrictions-2026-10-29.json](evidence/ondo-ethereum-nvda-restrictions-2026-10-29.json) records the pinned block, hashes, existing issuer authority accounts, source records and completed checks. The test impersonates existing pause/unpause role members and the existing blocklist owner only inside Hardhat. It neither grants roles nor patches storage. The archive gateway refuses public transaction methods.

Eight operations are exercised under both token pause and a targeted block: curve buy, curve sell, curve fee claim, final buy with atomic graduation, pool buy, pool sell, and each fixed recipient's quote-side pool-fee claim. Targets include the curve, trader, treasury, migration adapter, pool and recipients. Reverting operations preserve recorded token balances, reserve/fee ledgers and applicable pool position/claim state. Curve fee claims instead emit FeePayoutFailed and preserve the owed ledger, as designed; a failed recipient must not strand another recipient's payout. After each restriction is removed locally, the normal lifecycle verifies successful recovery, exact claims and permanently locked LP principal.

The canonical run uses Ethereum NVDAon at block 26294021, with locally deployed ELPIDA and Uniswap v3 contracts, test-sized virtual stock reserves and a mock native USD feed. The fork chain is 31337, and Hardhat metadata must identify Ethereum as its upstream before impersonation. Asset identity and dependency runtime pins are mandatory.

```powershell
$env:ELPIDA_EQUITY_RESTRICTIONS = '1'
$env:ELPIDA_EQUITY_HOLDER = '0x3cd7caa5109d1634b5EA7DC9D469314439981a69'
node --env-file=.env.ondo.local scripts/equity-cached-fork.mjs ethereum NVDAon ondo
Remove-Item Env:ELPIDA_EQUITY_RESTRICTIONS
```

Use the existing reviewed pin, or explicitly select the evidence block. A fresh pin is a new observation and may require source/policy review. Restriction reports use a separate filename; partial results and timeout failures remain incomplete. The fixture is intentionally restricted to the reviewed Ethereum NVDAon path.

## Limits and remaining gates

Validation: the real pinned NVDAon rehearsal passed 31 checks (15 lifecycle checks and 16 restriction checks). The strict focused regression gate passed 40 tests across nine files, with zero failures and no skips, including local 6/18-decimal lifecycle fixtures, the local-only impersonation guards, cache, registry, valuation, controls and documentation/evidence checks. Broader CI is a separate gate; the previous full-suite result predates this change.

This phase does not exercise global pauses, forced burns, sanctions-list updates, issuer upgrades, changes during a transaction, every possible spender/recipient combination, partner buybacks, or BNB/Solana venues. It does not test fee collection while paused, although pool-fee claims and LP principal are checked. A pause can halt redemption/trading indefinitely; recovery here assumes the issuer removes it. Exact rollback does not eliminate issuer custody risk.

Production total-return price/status sources, independent executable liquidity, fresh monitoring of the complete dependency path, end-user/contract eligibility, and a full privilege review remain open. No live flag is enabled by this report.
