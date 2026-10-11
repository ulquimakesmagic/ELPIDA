// Testnet registry for the browser-wallet flow. Values come from each network's official docs
// (see docs/CHAIN_MATRIX.md). The app re-verifies the quote token's code and decimals on-chain
// before deploying, so a wrong address fails safely instead of launching against a fake asset.
//
// quote.address: the Circle-issued test USDC, or null when Circle does not issue USDC on that
// testnet. In that case the app deploys a clearly labelled Elpida Test USDC (tUSDC) with a
// public faucet, which has no value and is not USDC.
//
// shared: fill in after one team deployment so every tester uses the same launchpad instead of a
// per-browser factory. Leave null to let each browser deploy its own.
export const testnets = [
  {
    key: 'base-sepolia', name: 'Base Sepolia', short: 'BASE SEPOLIA', kind: 'evm', enabled: true,
    chainId: 84532, rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    quote: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', label: 'Circle test USDC', faucet: 'https://faucet.circle.com' },
    gasFaucet: 'https://docs.base.org/get-started/get-funds',
    shared: null,
  },
  {
    key: 'ethereum-sepolia', name: 'Ethereum Sepolia', short: 'ETH SEPOLIA', kind: 'evm', enabled: true,
    chainId: 11155111, rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    quote: { address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', label: 'Circle test USDC', faucet: 'https://faucet.circle.com' },
    gasFaucet: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia',
    shared: null,
  },
  {
    key: 'bnb-testnet', name: 'BNB Chain Testnet', short: 'BNB TESTNET', kind: 'evm', enabled: true,
    chainId: 97, rpcUrl: 'https://bsc-testnet-dataseed.bnbchain.org', explorer: 'https://testnet.bscscan.com',
    nativeCurrency: { name: 'Test BNB', symbol: 'tBNB', decimals: 18 },
    // Circle does not issue USDC on BNB Chain; mainnet USDC there is a bridged 18-decimal token.
    quote: { address: null, label: 'Elpida Test USDC', faucet: null },
    gasFaucet: 'https://www.bnbchain.org/en/testnet-faucet',
    shared: null,
  },
  {
    key: 'robinhood-testnet', name: 'Robinhood Chain Testnet', short: 'ROBINHOOD TESTNET', kind: 'evm', enabled: true,
    chainId: 46630, rpcUrl: 'https://rpc.testnet.chain.robinhood.com', explorer: 'https://explorer.testnet.chain.robinhood.com',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    // No Circle test USDC is published for this testnet, so Elpida deploys its own test quote token.
    quote: { address: null, label: 'Elpida Test USDC', faucet: null },
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
  quote: { address: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', label: 'Circle test USDC', faucet: 'https://faucet.circle.com' },
  gasFaucet: 'https://faucet.solana.com',
  shared: null, // e.g. { programId: '…' }
};
// Developer-only: a local solana-test-validator (start the server with ELPIDA_SOLANA_CLUSTER=localnet).
export const solanaLocalnet = {
  ...solanaDevnet, key: 'solana-localnet', name: 'Solana Localnet', short: 'SOLANA LOCAL', cluster: 'localnet',
  rpcUrl: 'http://127.0.0.1:8899', wsUrl: 'ws://127.0.0.1:8900', explorer: 'https://explorer.solana.com',
  quote: { address: null, label: 'Local test USDC', faucet: null }, gasFaucet: null, shared: null,
};
testnets.push(solanaDevnet);

export const evmTestnets = testnets.filter(net => net.kind === 'evm' && net.enabled);
export const LAUNCH_FEE_WHOLE = 10n;
export const VIRTUAL_QUOTE_WHOLE = 30_000n;
