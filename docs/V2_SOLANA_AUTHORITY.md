# Solana authority: current state, the migration, and the payout-key decision

Audit findings SOL-UPG (upgrade authority is one keypair) and SOL-OPR (one operator key decides every payout).

## 1. Current state, measured

`node scripts/solana-authority-check.mjs` (read-only, devnet), run 11 November 2026:

```
program            ANkA5pytoVkiKQbjzd5NdPWKgmwfsihNJvSfg3vtKLNz
loader             BPFLoaderUpgradeab1e11111111111111111111111
program data       EoihUfFKgSq2ThoK5QRDab18fQk8AGUyw2WfW5ZbPpcV
upgrade authority  FeUWFps7CYtrXNXosirwJCfFQM5Na6PamEV6hpFcKaH8
authority owner    11111111111111111111111111111111  (the system program)
multisig           false
```

A system-owned account with 32 bytes of data is a plain keypair. That key can upgrade the program, and an upgrade can
move every curve reserve, LP position and distributor vault. `docs/AUDIT_SCOPE_V2.md` describes a Squads multisig as
the intended mainnet holder; it is **not** the current holder.

Guard: `node scripts/solana-authority-check.mjs --require-multisig` exits 1 with
`UPGRADE_AUTHORITY_NOT_MULTISIG` while this is true. Any mainnet release checklist should run it and refuse on that
exit code.

## 2. Migration to a Squads vault (SOL-UPG)

This is an operator procedure, deliberately not automated here: it moves control of the program, and it must be done
with the keys in front of a human.

1. Create a Squads multisig (v4) with the intended members and threshold (≥ 3 of 5 is the usual minimum for a program
   that can drain vaults). Record the vault PDA and the members in `docs/HUMAN_ACTIONS.md`.
2. Set the program's upgrade authority to the Squads **vault PDA** using the loader's `SetAuthority`
   (`bpf_loader_upgradeable::set_authority`), signed by the current authority `FeUWF…`.
3. Re-run `node scripts/solana-authority-check.mjs --require-multisig`. It must exit 0 and report `multisig: true`
   with `authorityOwner` equal to the Squads program id.
4. Rehearse one upgrade through Squads on devnet (propose → approve → execute) and record the transaction in
   `docs/HUMAN_ACTIONS.md`. The earlier rehearsal was on a throwaway program and does not carry over.
5. Add a timelock (Squads "time lock" setting) so an upgrade cannot be executed in the same block it is proposed.

Until step 3 passes, the answer to "can we launch on mainnet" is no, regardless of anything else.

## 3. Payout key (SOL-OPR) — a decision is needed

`post_v2_root` requires `distributor.operator == operator.key()` on a **Signer**
(`contracts/solana/programs/elpida_launchpad/src/lib.rs:2519-2523`). Funds sit in a vault PDA — custody is not the
operator's — but **allocation is**: a compromised or misused keeper key can post a root that pays itself the entire
reserved balance, and nothing on chain would flag it. The devnet operator is `3CcwEu3nSM9Y7UQCgqggiqZrUb361JNRZi9oA7KNQxZW`,
the server's hot key.

Three options, with what each costs:

| Option | Mechanism | Cost |
|---|---|---|
| **A. Dispute window** (recommended) | A posted root becomes claimable only after N hours; anyone can freeze a root during the window; the operator cannot remove a freeze | One program change, a small keeper change to wait before pushing, and a UI state for "pending" |
| B. Root through a multisig | `operator` is a Squads vault; every round needs a proposal and approvals | Safest, but a daily round needs human approval every day |
| C. Per-root cap | A round may reserve at most X% of the vault; the rest needs a second root | Simple program change, but a compromised key drains slowly instead of at once |

**Recommendation: A**, with B for unusually large rounds. A keeps the daily payout automatic while making a stolen key
unable to pay itself silently.

Whichever is chosen, the program change cannot be verified in this environment: `cargo` and the Solana CLI are absent,
so nothing here is built or tested. Any implementation must be compiled and run against the host tests
(`cargo test --release --manifest-path contracts/solana/host-tests/Cargo.toml`) before it is proposed for review.

## 4. What this document does not claim

- No program change is included. The Rust source is untouched.
- The authority has **not** been moved; step 2 is an operator action.
- No mainnet cluster is enabled, so none of this affects a live mainnet program yet.
