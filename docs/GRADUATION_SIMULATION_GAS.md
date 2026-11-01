# Sepolia completing-buy simulation recovery — 1 November 2026

## Observed failure

STKTEST (`0xc717BBd54d052FF45AFC73578b8e340D99541c11`), curve `0x6244e307A17dd98831B6524e18Aedd9B62c39bC1`, still has no graduated pool. The test wallet holds 48.403769994929974261 tNVDAon, with an existing 48-token curve allowance. The fresh gross completion quote is 47.690649927832016425; neither another faucet request nor another approval is required at that observed state.

Four earlier completing buys were mined with status 0 and gas limits of only **900000**:

- `0x408b9eb478fdefd79afda23b59254f5a9d31f0afced66588fd534b08a63436bd`
- `0x83f10e71082d804732934f61c8b8d112092f440c585d08590bae3f8c60448ddd`
- `0x6ad982ba2e546bb3ecd1596024918d4003ce93110db688b89a5fe9cc3ce8794d`
- `0x8728bedd1e6123004a20b53e699c90201afab171d83f1807f00fd82cadfe0a58`

Their gas used was approximately 402900; purchase state rolled back. Test gas was charged. The user's latest reported no-popup attempt is distinct from those earlier mined failures.

The primary public RPC returns an empty `execution reverted` for this completing buy even with a larger requested simulation ceiling. A fresh same-chain Tenderly public RPC successfully simulates the identical call and estimates **54372186 gas**. The repaired browser provider plus actual signer preflight returns **65246623 gas** (20% headroom), without invoking any wallet submission.

A read-only-upstream local fork of block 12042495 also executes the purchase successfully. Its Cancun simulation reports 7694284 gas, which is **not** used as a live Sepolia estimate: fork gas accounting differs from the current public chain. No local impersonation or fork transaction is a public testnet receipt.

## Fix

- Prefer the already configured working Sepolia simulation endpoint first. Other configured endpoints currently require paid access for at least some methods.
- Allow up to 15 seconds for read-only fallback calls/estimates, while chain/head verification retains its 5-second timeout. Chain ID, fresh head, simulation ceiling and real revert-data checks remain enforced.
- An unresolved `CALL_EXCEPTION`, including missing/empty revert bytes, stops before wallet submission. A transport failure without a verified estimate also stops. It must not fall through to wallet default gas. No hardcoded graduation gas limit is introduced; successful network estimation supplies the limit.
- Existing explicit gas limits retain their existing behavior. Wallet signatures and broadcasts remain in the wallet. No contract, Model 10 curve, fee allocation, recipient or chain-wallet changes.

The public RPC cap explanation is consistent with Geth's configurable `rpc.gascap` behavior ([official options](https://geth.ethereum.org/docs/fundamentals/command-line-options)); the exact primary-node operator setting is not exposed, so it is not claimed as measured.

## Retry after merge and redeployment

Refresh Elpida so the new browser module and endpoint order load. On Ethereum Sepolia choose STKTEST → Buy → tNVDAon → Complete curve. Review the newly fetched quote and let the app obtain verified gas. The previously observed estimate with headroom was about 65.25 million, not 900000; do not manually reuse the earlier small limit. If estimation cannot be verified, the app reports an error and sends no wallet request. Do not repeatedly click Buy.

After a successful receipt, verify atomic graduation, genuine V3 pool and permanent LP lock, then repeat a small native buy/sell through the registered router. Graduation is not yet publicly confirmed by this fix.
