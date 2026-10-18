# Shared Base Sepolia factory — accounting revision 1

The corrected factory is `0x8194285faC2aFa04867a1C421EFee9f28ab0290f`, deployed
at block 48272244 in transaction
`0x7aff4473403a071b94255dda787e263677c7b71afd79bcdd146b3d7b2fa41074`.
Pricing was configured successfully by its treasury in transaction
`0x6a767c00051c227e7411ed180d3c06fbf0682833e4ff71a595891016e3132eae`.

Read-only verification confirmed Model 10, FEE_ACCOUNTING_VERSION 1, metadata
version 1, $50 starting FDV, 86400-second graduation grace, treasury
`0xf5B0cE04241f9518dfA3CBfbaafC7E40638E639D`, and the configured Base Sepolia
USD feed, 1500-second maximum age, and test USDC address. The native migration
adapter matches the configured Uniswap v3 manager/factory, WETH and 1% pool fee.

Factory creation input, including constructor arguments and embedded curve
deployment bytecode, exactly matched a local rebuild with solc 0.8.24 and the API's
includeMocks=true settings after normalizing source line endings to LF, matching
the Linux production build. Raw Windows CRLF source hashes produce different
Solidity metadata and are unsuitable for that exact comparison.

The registry makes this factory shared and preserves the former Model 10 factory
`0xD64119914DDA7b206d01Fb2B334A630Ca94fD6d2` under legacy, alongside Model 9.
Existing tokens stay indexed and trade through their own original factory.
The old shared-recipient ledger defect in existing curves is not repaired.

USDC quote registration was still zero/unconfigured at the last check. Native
launches are configured; the treasury wallet must finish Enable USDC trading pair
before USDC-paired launches are tested. Do not describe USDC setup or a fresh-token
public claim rehearsal as complete. This registry change submits no transactions.
