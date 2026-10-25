# Solana `withdraw_fees`: what the isolation finding actually covers

**Status:** investigation record. The program is unchanged. The audit finding C7 said `withdraw_fees` is not
failure-isolated; that is still true of the code, but the exposure is **much narrower** than the EVM analogue suggested,
and this note corrects it.

## What the code does

`withdraw_fees` reads both ledgers, clears both, then pays each side with `?`:

```rust
pool.protocol_fees = 0;
pool.creator_fees = 0;
quote_transfer(... treasury ...)?;
quote_transfer(... reward ...)?;
```

One failing transfer reverts the whole instruction. That much is real, and it is the same shape the EVM curve had before
`claimFees`/`FeePayoutFailed`.

## What can actually fail, checked against the accounts struct

| Case | Reachable? | Why |
|---|---|---|
| The creator's reward token account was **closed** | **No** | `reward_quote` is `#[account(init_if_needed, payer = payer, associated_token…)]`: the program recreates it and pays. CI proved this — a test that closed the account still saw `creatorFees` drop to zero. |
| The treasury's token account was **closed** | **No**, and isolation would not help | `treasury_quote` is a plain `associated_token` account with no `init_if_needed`, so Anchor rejects the instruction during account validation, before the body runs. |
| A destination is **frozen** | **Yes** | A Token/Token-2022 transfer to a frozen account fails inside the CPI, which is the only failure that reaches the body. |

So the recommendation "pay each side independently" only changes behaviour for a frozen destination, and **no fixture
mint in this repository has a freeze authority** (`create_test_usdc` and the deploy script never set one), which is why
the suite cannot produce the case.

## What was tried, and why it is not merged

A patch was written (each side attempted, only a settled ledger cleared, `FeePayoutFailed` emitted) and pushed as PR #92
for CI to compile. Three runs:

1. the program **built** and 29 tests passed, but the new test's `CloseAccount` was refused — the account still held
   fees;
2. after draining it, the withdrawal still paid the creator: the test had closed the **legacy** token-program ATA while
   the program pays into the quote program's one (`quoteAta` vs `ata`);
3. with the right account closed, the payout still succeeded — because of `init_if_needed`.

The PR was closed rather than merged: the change compiles, but nothing demonstrates the behaviour it claims to fix, and
an untested program change is what this work was meant to prevent.

## What a real test needs

One of:

- **a mint with a freeze authority** in the fixture (create it in the deploy script, freeze the reward account in the
  test, then withdraw), or
- **a mock quote token program** that rejects a transfer to one specific account, which is cleaner and does not depend on
  mint configuration, or
- a **host test** on a pure helper, if the payment loop is factored into a function that takes the two transfer results
  and returns the two ledger values. That would test the decision logic without a validator, but not the CPI.

Until one of those exists, the honest description of C7 is: *the sweep is not failure-isolated, but the only reachable
failure is a frozen destination, which this deployment cannot currently produce.*
