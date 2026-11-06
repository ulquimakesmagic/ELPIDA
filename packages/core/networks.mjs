// Testnet registry for the browser-wallet flow. Values come from each network's official docs
// (see docs/CHAIN_MATRIX.md). Pricing is native: every launch pays its creation fee in the network's
// own coin, at the values in config/native-pricing.json; there are no dollar (USDC) pairs or fees.
//
// shared: fill in after one team deployment so every tester uses the same launchpad instead of a
// per-browser factory. Leave null to let each browser deploy its own.
// rpcFallbacks: extra public RPCs the server's indexer moves to when the main one keeps failing (server only;
// browsers use rpcUrl, which the CSP allows).
// legacy: earlier team factories on the same network. They stay indexed (listings, trading, fees)
// but take no new launches.
export const testnets = [
  {
    key: 'base-sepolia', name: 'Base Sepolia', short: 'BASE SEPOLIA', kind: 'evm', enabled: true,
    chainId: 84532, rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org',
    rpcFallbacks: ['https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.drpc.org'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    gasFaucet: 'https://docs.base.org/get-started/get-funds',
    // Partner-tier atomic Model 10 factory, deployed by Malik 26 Oct 2026 (block 50624512); graduation adapter
    // 0xe828…5659 reports PARTNER_TIERS_VERSION 1. Treasury 0xf5B0…639D.
    // Reviewed launchpad (security review fixes E-1 to E-3), deployed by Malik 2 Nov 2026; pricing turned on in tx
    // 0x1e42d8f5…a827b (block 53536219; no launch can precede it). Factory and adapter 0x12b4…0713 both report
    // REVIEW_FIXES_VERSION 1. The 50624512 factory moves to legacy and stays indexed. No new launches go there.
    shared: { factory: '0x381c26893322cbadFbf83D0f2de69f52aA9Ab94c', block: 53536219, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1, partnerTiersVersion: 1, reviewFixesVersion: 1 },
    // Earlier team launchpads stay indexed so their tokens remain listed and tradable. No new launches go here.
    // Model 11 test launchpad (Uniswap v4 hook, liquidity locked from launch; NOT AUDITED, test networks only).
    // poolManager is Uniswap's own v4 PoolManager here (developers.uniswap.org, v4 deployments, 6 Nov 2026). Pin the
    // launchpad in `shared` once Malik deploys it from the site (docs/HUMAN_ACTIONS.md, Model 11); until then it is off.
    v4: { poolManager: '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408', shared: null },
    legacy: [{ factory: '0xb5dAE15BCCe080a49e8b776E59B3d982269aC74C', block: 50624512, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1, partnerTiersVersion: 1 }, { factory: '0x98a0E75dbBe9EdA5D228319C72D496b814bA7145', block: 48289973, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1 }, { factory: '0x8194285faC2aFa04867a1C421EFee9f28ab0290f', block: 48272244, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1 }, { factory: '0xD64119914DDA7b206d01Fb2B334A630Ca94fD6d2', block: 48209837, model: 'curve-dex-v10', metadataVersion: 1 }, { factory: '0xe605787F7260F5Dae2768d2F9E93E7F18EE14f91', block: 47994800, model: 'curve-dex-v9', metadataVersion: 1 }],
  },
  {
    key: 'ethereum-sepolia', name: 'Ethereum Sepolia', short: 'ETH SEPOLIA', kind: 'evm', enabled: true,
    chainId: 11155111, rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io',
    rpcFallbacks: ['https://sepolia.gateway.tenderly.co', 'https://1rpc.io/sepolia', 'https://sepolia.drpc.org'],
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    gasFaucet: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia',
    // Partner-tier atomic Model 10 factory (Uniswap v3), deployed by Malik 26 Oct 2026 (block 12000324); adapter 0x2a0f…b79a.
    // Reviewed launchpad (security review fixes E-1 to E-3), deployed by Malik 2 Nov 2026; pricing turned on in tx
    // 0x517086cb…2928c (block 12048655; no launch can precede it). Factory and adapter 0xdd6e…6262 both report
    // REVIEW_FIXES_VERSION 1. The 12000324 factory moves to legacy and stays indexed. No new launches go there.
    shared: { factory: '0x37Ca07Eb2A14E30051DbF78e4adCc7fBc1430477', block: 12048655, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1, partnerTiersVersion: 1, reviewFixesVersion: 1 },
    // Ordinary-wallet native/pair router: each one is bound to one factory. The 1 Nov 2026 router (0xDDCc…fd41, tx
    // 0x2843b435…5eb61, verified with a public buy and sell) serves the now-legacy 0x5aA2…07f6 factory only, so it is
    // no longer pinned. Pin the reviewed factory's router here once Malik deploys it (HUMAN_ACTIONS).
    // The 22 Oct factory (tx 0xdad271f4…82be9; first launch VEGETA) stays indexed. No new launches go here.
    // Model 11 test launchpad (Uniswap v4 hook, liquidity locked from launch; NOT AUDITED, test networks only).
    // poolManager is Uniswap's own v4 PoolManager here (developers.uniswap.org, v4 deployments, 6 Nov 2026). Pin the
    // launchpad in `shared` once Malik deploys it from the site (docs/HUMAN_ACTIONS.md, Model 11); until then it is off.
    v4: { poolManager: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543', shared: null },
    legacy: [{ factory: '0x5aA283B8B12786314e76ac4E977B1E9275b407f6', block: 12000324, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1, partnerTiersVersion: 1 }, { factory: '0xD64119914DDA7b206d01Fb2B334A630Ca94fD6d2', block: 11972040, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1 }],
  },
  {
    key: 'bnb-testnet', name: 'BNB Chain Testnet', short: 'BNB TESTNET', kind: 'evm', enabled: true,
    chainId: 97, rpcUrl: 'https://bsc-testnet-rpc.publicnode.com', explorer: 'https://testnet.bscscan.com',
    rpcFallbacks: ['https://bnb-testnet.api.onfinality.io/public', 'https://bsc-testnet.drpc.org'],
    nativeCurrency: { name: 'Test BNB', symbol: 'tBNB', decimals: 18 },
    gasFaucet: 'https://www.bnbchain.org/en/testnet-faucet',
    // Atomic Model 10 factory (PancakeSwap v3), deployed 23 Oct 2026 in tx 0x7b0cefee…7247f; requires token details
    // on-chain at launch. Its graduation adapter is 0xD641…6d2 (same address as other chains' contracts: nonce match).
    // Partner-tier factory, deployed by Malik 26 Oct 2026 (block 139102664); adapter 0x33ce…b9a6. The 23 Oct factory
    // stays indexed (first launch MIDORIYA). No new launches go there.
    // Reviewed launchpad (security review fixes E-1 to E-3), deployed by Malik 2 Nov 2026; pricing turned on in tx
    // 0x17e922cb…c5e6 (block 140398704; no launch can precede it). Factory and adapter 0x5343…ed9a both report
    // REVIEW_FIXES_VERSION 1. The 139102664 factory moves to legacy and stays indexed. No new launches go there.
    shared: { factory: '0x4CabA05067171DbA4B840aDae1e652B8279dE499', block: 140398704, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1, partnerTiersVersion: 1, reviewFixesVersion: 1 },
    legacy: [{ factory: '0x5795b25C7fA37638eEacd29848522f8Cd48a1156', block: 139102664, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1, partnerTiersVersion: 1 }, { factory: '0x8c48b67E3D541955ec5DCf99629c4270aC6CfBbE', block: 138485798, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1 }],
  },
  {
    key: 'robinhood-testnet', name: 'Robinhood Chain Testnet', short: 'ROBINHOOD TESTNET', kind: 'evm', enabled: true,
    chainId: 46630, rpcUrl: 'https://rpc.testnet.chain.robinhood.com', explorer: 'https://explorer.testnet.chain.robinhood.com',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    gasFaucet: 'https://faucet.testnet.chain.robinhood.com',
    // This testnet has neither Uniswap v3 nor a Chainlink feed (24 Oct 2026). The launchpad owner deploys a labelled
    // Elpida test deployment of Uniswap v3 and an ElpidaRelayFeed from the site; the server relay (apps/api/feed-relay.mjs)
    // copies Chainlink ETH / USD from Base Sepolia into it, keeping Chainlink's timestamps. Mainnet uses the real ones.
    testDex: true,
    // ElpidaRelayFeed deployed 24 Oct 2026 (block 141826583); updater: the server relay 0x3d06…94FC.
    relay: { source: { network: 'base-sepolia', feed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1' }, feed: '0xdB7f43FFFdA626c1cc26206981C05507C75E983F', maxAge: 3600 },
    // Atomic Model 10 factory (the test Uniswap v3 above), deployed by Malik 24 Oct 2026 in tx 0x5933c8f8…c2e6; graduation
    // adapter 0xa37F…106A (WETH, 1%). Priced by the relay feed. Requires token details on-chain at launch.
    // Partner-tier factory, deployed by Malik 26 Oct 2026 (block 143196574) on the same test DEX and relay feed; adapter
    // 0x8a9f…c031. The 24 Oct factory above stays indexed. No new launches go there.
    // Reviewed launchpad (security review fixes E-1 to E-3), deployed by Malik 2 Nov 2026; pricing turned on in tx
    // 0x16fab606…1667f (block 147096680; no launch can precede it). Factory and adapter 0x905d…cacd both report
    // REVIEW_FIXES_VERSION 1. The 143196574 factory moves to legacy and stays indexed. No new launches go there.
    shared: { factory: '0xEC353bfBCb22424aF0fA5E93dFA1728bfE702Ea8', block: 147096680, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1, partnerTiersVersion: 1, reviewFixesVersion: 1 },
    legacy: [{ factory: '0x4CabA05067171DbA4B840aDae1e652B8279dE499', block: 143196574, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1, partnerTiersVersion: 1 }, { factory: '0x64d93212adc10d28E867Db44EBC1480AFaeaAD97', block: 141864043, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1 }],
  },
];

// Solana uses the Anchor program in contracts/solana instead of a browser-deployed factory.
// Deploy it once with `npm run solana:deploy`; that writes local-data/solana-devnet.json, which the
// server reads. To share a deployment with testers, paste its programId into `shared`.
export const solanaDevnet = {
  key: 'solana-devnet', name: 'Solana Devnet', short: 'SOLANA DEVNET', kind: 'solana', enabled: true, cluster: 'devnet',
  rpcUrl: 'https://api.devnet.solana.com', wsUrl: 'wss://api.devnet.solana.com', explorer: 'https://explorer.solana.com',
  nativeCurrency: { name: 'Devnet SOL', symbol: 'SOL', decimals: 9 },
  gasFaucet: 'https://faucet.solana.com',
  shared: null, // e.g. { programId: '…' }
};
// Developer-only: a local solana-test-validator (start the server with ELPIDA_SOLANA_CLUSTER=localnet).
export const solanaLocalnet = {
  ...solanaDevnet, key: 'solana-localnet', name: 'Solana Localnet', short: 'SOLANA LOCAL', cluster: 'localnet',
  rpcUrl: 'http://127.0.0.1:8899', wsUrl: 'ws://127.0.0.1:8900', explorer: 'https://explorer.solana.com', gasFaucet: null, shared: null,
};
// Mainnet beta (start the server with ELPIDA_SOLANA_CLUSTER=mainnet and SOLANA_RPC_URL set). The browser
// talks to Solana through the server's /api/solana-rpc proxy, so the RPC key never reaches the page.
export const solanaMainnet = {
  key: 'solana-mainnet', name: 'Solana', short: 'SOLANA', kind: 'solana', enabled: true, cluster: 'mainnet', mainnet: true,
  rpcUrl: '/api/solana-rpc', wsUrl: null, explorer: 'https://explorer.solana.com',
  nativeCurrency: { name: 'SOL', symbol: 'SOL', decimals: 9 },
  gasFaucet: null,
  shared: null,
};
testnets.push(solanaDevnet);

export const evmTestnets = testnets.filter(net => net.kind === 'evm' && net.enabled);
