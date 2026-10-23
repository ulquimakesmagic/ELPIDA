# Multisig treasury (mainnet checklist C3, 23 October 2026)

A launchpad's treasury is fixed forever at deployment. It receives every launch fee and the protocol's share of fees,
and only it can finish the setup: activate USD pricing (once) and approve quote assets such as USDC. A single wallet
as treasury is a single point of failure: one lost or leaked key is a lost treasury. On mainnet the site therefore
**requires a Safe that needs at least two signatures**. On testnet it is optional.

## One-time: create the Safe (free apart from gas)

1. Open app.safe.global and connect the wallet you will sign with. Choose the network (for a trial: Base Sepolia
   or Ethereum Sepolia, which cost only test gas).
2. Owners: at least two keys you control separately. For example, your main wallet plus a second wallet on another
   device. A hardware wallet is best for mainnet. Threshold: 2.
3. Create it, and note the Safe address. It can receive ETH, which the launchpad needs for launch fees.

## Deploy a launchpad with the Safe as treasury

1. Elpida → Network and funds → the network → **Treasury**: paste the Safe address → **Set up launchpad**.
   The connected wallet deploys the graduation adapter, the launchpad and the USDC adapter, paying gas only. It
   gets no powers.
2. The site downloads `elpida-treasury-setup-<chainId>.json`. In Safe{Wallet}: Apps → Transaction Builder → drag in
   the file → check that it shows two calls to the launchpad (`configureUsdPricing`, `approveQuote`) → Create batch →
   the owners sign → Execute.
3. Launches open as soon as the batch executes. If the file is lost, Network and funds shows
   **Download the Safe setup file** until the setup is done.
4. Send the launchpad address and block to be pinned as the network's shared launchpad (as with Sepolia).

## What this does not cover

- **Solana:** the program's upgrade authority moves to a multisig with the deploy script
  (`solana.test.mjs`: "the upgrade authority can move to a multisig"). The Squads setup is a separate step.
- **Existing testnet launchpads** keep the wallet treasury they were deployed with.

Evidence: `tests/multisig-treasury.test.mjs` runs the real `deploy()` against a local chain with a stand-in Safe
(2 of 2):
- the Safe is the treasury, and the deployer cannot configure anything;
- the batch holds exactly the two treasury-only calls;
- after the Safe executes them, a launch's fee arrives at the Safe;
- mainnet refuses the connected wallet or a one-signer Safe.
