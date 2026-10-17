# Local holder reward rehearsal

From `elpida-v1`, run:

```
npm run rehearse:holders
```

Open the `http://127.0.0.1:<port>` URL printed in the terminal. No extension wallet
is needed. The standalone server binds only to 127.0.0.1; the production app has
no rehearsal route or mutation endpoint. No public RPC URL, keys, addresses or
arbitrary calldata are accepted. Each server process owns a fresh, non-forked
Hardhat `localTest` chain with chain ID 31337.

Follow the numbered buttons:

1. Create the actual ElpidaToken, Model 10 curve, RewardVault and HolderEpochs
   contracts, plus a separate allocation vault. The migration adapter is a local
   code-bearing stub because this scenario does not graduate a pool. Deployment,
   launch fees and graduation are outside this rehearsal.
2. Make three fixed simulated buys of 10, 20 and 30 test USDC after anti-snipe decay.
   The unchanged 1.25% fee splits equally: 0.375 creator and 0.375 protocol USDC.
3. Collect and sync creator fees. Reserve 0.1 USDC in a vested grant in the same
   strategy vault, leaving 0.275 for the holder epoch. A separate allocation vault
   holds 100 simulated USDC in direct claims.
4. Verify a historical snapshot. Holdings change after the cutoff; both local
   readers query historical balances and reconcile discovered holders with supply.
   These are two adapters to one private chain, not independent production RPCs.
5. Fund and publish atomically with a 60-second delay. The receipt is deliberately
   lost, then recovered from matching on-chain epoch fields. An early payout is
   checked and rejected. The manifest and snapshot sidecar are journaled under a
   new OS temp `elpida-rehearsal-*` directory and contain no private keys.
6. Advance only the simulated chain clock through the publication delay.
7. Run payouts. The first click pays two holders and injects an RPC failure before
   the second batch. Click again to create a fresh keeper run and pay only the
   remaining holder, using on-chain paid state rather than an in-memory cursor.
8. Verify publication/payout retries, exact final holder balances, zero distributor
   reservation, and zero spendable strategy balance. The vested 0.1 USDC remains
   accounted and held in the same vault; all 100 USDC of direct claims are protected.

The page shows balances, historical/current holdings, entitlements, paid state,
manifest root, snapshot hash and the event log. Download the manifest for inspection.
Restart the command for a fresh session. Do not reuse the simulated accounts on a
public chain. There is no automatic deployment, real fund movement or timer here.

The HTTP server checks exact Host and Origin plus an unpredictable mutation token,
serializes actions and limits request size. Cross-origin requests are rejected.
It is designed for a single local operator and is not a hosted administration tool.

Automated test: `node --test tests/holder-rehearsal.test.mjs`. This exercises the
same HTTP actions and actual contracts used by the page, including the injected
failures. Browser visual verification remains pending; prior browser access was
declined and was not bypassed.

Validation on 2026-10-17: the complete HTTP action sequence passed, including
vesting protection, lost publication receipt, interrupted keeper, repeat publication,
repeat payout, and cross-origin rejection. Final holder payout: 0.275 simulated USDC;
remaining same-vault vested grant: 0.1; protected direct claims: 100. No real funds.
