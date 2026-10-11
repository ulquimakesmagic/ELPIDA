// Testnet registry for the browser-wallet flow. Values come from each network's official docs
// (see docs/CHAIN_MATRIX.md). Pricing is native: every launch pays its creation fee in the network's
// own coin, at the values in config/native-pricing.json; there are no dollar (USDC) pairs or fees.
//
// shared: fill in after one team deployment so every tester uses the same launchpad instead of a
// per-browser factory. Leave null to let each browser deploy its own.
export const testnets = [
  {
    key: 'base-sepolia', name: 'Base Sepolia', short: 'BASE SEPOLIA', kind: 'evm', enabled: true,
    chainId: 84532, rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    gasFaucet: 'https://docs.base.org/get-started/get-funds',
    shared: { factory: '0xe605787F7260F5Dae2768d2F9E93E7F18EE14f91', block: 47994800, model: 'curve-dex-v9', metadataVersion: 1 },
  },
  {
    key: 'ethereum-sepolia', name: 'Ethereum Sepolia', short: 'ETH SEPOLIA', kind: 'evm', enabled: true,
    chainId: 11155111, rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    gasFaucet: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia',
    shared: null,
  },
  {
    key: 'bnb-testnet', name: 'BNB Chain Testnet', short: 'BNB TESTNET', kind: 'evm', enabled: true,
    chainId: 97, rpcUrl: 'https://bsc-testnet-dataseed.bnbchain.org', explorer: 'https://testnet.bscscan.com',
    nativeCurrency: { name: 'Test BNB', symbol: 'tBNB', decimals: 18 },
    gasFaucet: 'https://www.bnbchain.org/en/testnet-faucet',
    shared: null,
  },
  {
    key: 'robinhood-testnet', name: 'Robinhood Chain Testnet', short: 'ROBINHOOD TESTNET', kind: 'evm', enabled: true,
    chainId: 46630, rpcUrl: 'https://rpc.testnet.chain.robinhood.com', explorer: 'https://explorer.testnet.chain.robinhood.com',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    gasFaucet: 'https://faucet.testnet.chain.robinhood.com',
    shared: null,
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
