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
    // Deployed by Malik from the operator panel, 6 Nov 2026 (factory created in block 55188766; treasury 0xf5B0…639D).
    v4: { poolManager: '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408', shared: { factory: '0x70e5E07a4EBBCcE5144DEd022a1ADE2019538Da3', hook: '0x8D4342B2fB2E52822CD6c4ceECb4628b1B90e8cC', router: '0x1136B6D2410b1B32Ec6039aD92a0B110A934aCE9', block: 55188766 } },
    // ELPIDA V2 test launchpad, deployed by Malik from the operator panel, 9 Nov 2026 (factory from block 56522761;
    // treasury 0xf5B0…639D; reward contracts run by the server keeper 0x95d3…5124). The public index checks the wiring.
    v2: { shared: { factory: '0xb70Db4E38C5668713967187dDe88a187c6afA3Bc', hook: '0xC8C7Af0D152F548a26D90EAa2181229dA12D68cc', router: '0x5221007e755fA8231cAb135500C6B715ec7c0916', airdrop: '0xFcE86b3A8F1245a2B8343b50B10ad23360C97A8B', holder: '0x72dB6F7985c815941fACA4D0dE9377e2BC792327', usdcAirdrop: '0xC745acDA2AA19C57563289244FD51c801F4eD31f', usdcHolder: '0xa054523063B8D729AaaFb533cdD54Eb9aA693781', flywheel: '0xf3FAb645403542A933949eAD9C053247913C694f', keeper: '0x95d3fAea73006C4557b02aC81593d8312ff25124', block: 56522761, minFeeBps: 100 } },
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
    // Deployed by Malik from the operator panel, 6 Nov 2026 (factory created in block 12075675, hook in 12075678, the
    // rest after a resumed run; treasury 0xf5B0…639D).
    v4: { poolManager: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543', shared: { factory: '0x1136B6D2410b1B32Ec6039aD92a0B110A934aCE9', hook: '0xbe3C898140D32DFcAa1DeE5B1BaDE36BCe4B68cC', router: '0xC5FA99cFd6c752199BCb37f9dEF3fb94279b7B3c', block: 12075675 } },
    // ELPIDA V2 test launchpad (contracts/evm/v2), deployed by Malik from the operator panel, 9 Nov 2026 (factory from
    // block 12096986; treasury 0xf5B0…639D). The distributors and the flywheel vault are run by the server keeper
    // 0x95d3…5124 (ELPIDA_V2_KEEPER_KEY); the public index checks the wiring on chain before listing anything.
    v2: { shared: { factory: '0xb70Db4E38C5668713967187dDe88a187c6afA3Bc', hook: '0x137FfB83950Ea837BcE397909e03Fa600f9428Cc', router: '0x0D749010DCee1A70F61D458d0E92Fa5e1269Ea0B', airdrop: '0xf3FAb645403542A933949eAD9C053247913C694f', holder: '0x155a8B63e43a0a64D32bEd959375d00643918885', usdcAirdrop: '0x86E79d3ff55b3bC8eA44887814a7580A6fd58D3b', usdcHolder: '0x572D40446a6f78cD4a40D0974A68484926C21e75', flywheel: '0x651FD708EFa8D5EF46115bb3CeDF7664fF1511F5', keeper: '0x95d3fAea73006C4557b02aC81593d8312ff25124', block: 12096986, minFeeBps: 100 } },
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
    // Model 11 test launchpad (6 Nov 2026). BNB Chain testnet has no Uniswap v4 (it is only on BNB mainnet), so the
    // operator deploys a labelled test copy of Uniswap's own PoolManager from the operator panel first. Pin its address
    // in `poolManager` and the launchpad in `shared` once deployed (docs/HUMAN_ACTIONS.md).
    // Deployed by Malik from the operator panel, 6 Nov 2026: the test PoolManager (Uniswap v4-core 1.0.2, unchanged; block
    // 141138906), then the Model 11 launchpad on it (factory created in block 141139092; treasury 0xf5B0…639D).
    v4: { poolManager: '0x251E30304241c21d76219e56f3611d8b53F03a13', testPoolManager: true, shared: { factory: '0xA05eEe6f4443707EF6a88D4aE478c297342C0fd2', hook: '0x11C491F546491259f6B017E95fd918bBA7dC28CC', router: '0xA2DC3f5Ae12811404a4667C147c60D46748865fB', block: 141139092 } },
    // ELPIDA V2 test launchpad on the labelled test PoolManager, deployed by Malik from the operator panel, 9 Nov 2026
    // (factory from block 141724857; treasury 0xf5B0…639D; reward contracts run by the server keeper 0x95d3…5124).
    // PancakeSwap's router is not SwapRouter02, so holder rewards of USDC pairs are paid in USDC here.
    v2: { shared: { factory: '0x1798C56A217A37f13D4a36001608Ae9773E9f37A', hook: '0x88D6b95377cAF59A641241e7c305AC3ad06728cC', router: '0xE8280f27F785c13cC18268a8823DBD7C69F95659', airdrop: '0xD4342b5C791621453ed83938E4a4f2908372B85f', holder: '0xc46031762364E5dC2b1Cdd36dB6AD2aeb5793F24', flywheel: '0x888eD56692e9B8Acded9Cf8F84B60019fd667E0D', keeper: '0x95d3fAea73006C4557b02aC81593d8312ff25124', block: 141724857, minFeeBps: 100 } },
    shared: { factory: '0x4CabA05067171DbA4B840aDae1e652B8279dE499', block: 140398704, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1, partnerTiersVersion: 1, reviewFixesVersion: 1 },
    legacy: [{ factory: '0x5795b25C7fA37638eEacd29848522f8Cd48a1156', block: 139102664, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1, partnerTiersVersion: 1 }, { factory: '0x8c48b67E3D541955ec5DCf99629c4270aC6CfBbE', block: 138485798, model: 'curve-dex-v10', metadataVersion: 1, feeAccountingVersion: 1, launchFeaturesVersion: 1 }],
  },
  {
    key: 'robinhood-testnet', name: 'Robinhood Chain Testnet', short: 'ROBINHOOD TESTNET', kind: 'evm', enabled: true,
    chainId: 46630, rpcUrl: 'https://rpc.testnet.chain.robinhood.com', explorer: 'https://explorer.testnet.chain.robinhood.com',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    gasFaucet: 'https://faucet.testnet.chain.robinhood.com',
    // No Uniswap v4 on this testnet either: as on BNB testnet, a labelled test copy of Uniswap's own PoolManager (v4-core
    // 1.0.2, unchanged), deployed by Malik from the operator panel, 9 Nov 2026 (block 150924125, tx 0x7eac8d8b…5d8f).
    v4: { poolManager: '0xa9E3183680eDef78b14f6d2e60d6AF65c4d47D4C', testPoolManager: true, shared: null },
    // ELPIDA V2 test launchpad on that PoolManager, deployed by Malik from the operator panel, 9 Nov 2026 (factory from
    // block 150924467; treasury 0xf5B0…639D; reward contracts run by the server keeper 0x95d3…5124). USD pricing from the
    // relay feed below.
    v2: { shared: { factory: '0xDDCc87C34eD8D8bEB6D5fAFc6C14e7cE8578fd41', hook: '0x74f2f46A45fCAc130252552880402b57aF3328Cc', router: '0xD8D64a0835BAF274077Ce92dc25F7a09984fEb59', airdrop: '0x3a4B7128b400CF2502E77341AE444B08F926a57d', holder: '0x3ED5280488e335f3eF70f7F78F4Fb78Cc0910CE9', flywheel: '0x1798C56A217A37f13D4a36001608Ae9773E9f37A', keeper: '0x95d3fAea73006C4557b02aC81593d8312ff25124', block: 150924467, minFeeBps: 100,
      // tUSDG payout distributors, deployed by Malik from the operator panel, 11 Nov 2026.
      usdcAirdrop: '0xAD5eb8Ac5e603D7dc7d8aE9B5a854b2559316955', usdcHolder: '0xd54bcE6b4Ea06d8bAfB9cfDe9C179bB98aD1775D' } },
    // Robinhood Chain pays in USDG; Circle's USDG has no code on this testnet, so a labelled Elpida test dollar (no value),
    // deployed by Malik from the operator panel, 11 Nov 2026, with a 1% ETH/tUSDG pool for the keeper's conversions.
    payoutStable: { address: '0xa7697599Dee1fD8903Ee72472eB319272cAEEe6a', symbol: 'tUSDG', decimals: 6, test: true },
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
