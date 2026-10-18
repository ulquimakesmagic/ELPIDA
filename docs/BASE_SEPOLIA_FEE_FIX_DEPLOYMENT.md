# Corrected Base Sepolia factory

Model 10 pricing is unchanged. New ElpidaDexFactory deployments expose
FEE_ACCOUNTING_VERSION = 1 to identify inclusion of the shared-recipient curve
fee fix independently of MODEL_VERSION = 10 and METADATA_VERSION = 1.

The network dialog checks the connected Base Sepolia factory's revision. A
confirmed missing getter identifies the earlier deployment; an RPC failure does
not enable the replacement control. Only Base Sepolia offers this corrective
deployment path. No mainnet deployment is part of this workflow.

1. Refresh the website, connect the test wallet on Base Sepolia, and open Network
   and test funds. Under Launchpad on this network, select Deploy corrected Base
   Sepolia launchpad.
2. Review the wallet's network and gas estimate before confirming. The workflow
   may deploy a migration adapter if none is saved, deploy the factory, activate
   its configured oracle, and configure the approved USDC pair. These are separate
   transactions using test ETH; there is no need to add simulated-stock pairs.
3. Retain the factory deployment receipt, address and block number. The browser
   archives its previous deployment and selects the corrected factory on reload.
   This temporary browser selection does not publish the new factory globally.
4. Verify the factory's model, accounting revision, oracle, terms and adapter
   on chain before registering it as the new shared Base Sepolia factory. Add the
   previous shared factory to legacy deployments so existing tokens remain indexed.
   Set feeAccountingVersion: 1 on the new shared record.
5. After the registry/indexer update, create a fresh token and verify shared and
   distinct recipient claims, trading, graduation and post-graduation collection.

Existing tokens and their immutable contracts are unchanged. The original
VASTOLORDE curve still has the old fee-accounting defect; the new factory cannot
repair its ledger. Account balances and receipts must be checked on the public
testnet; local tests and website publication do not constitute that verification.
