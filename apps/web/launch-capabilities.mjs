export function launchProfile(chain) {
  const solana=chain.startsWith('solana-');
  // Every chain uses the same four pair kinds; live assets come from each wallet's pairOptions().
  return {solana,pairs:['native','usdc','xstock','token'],decimals:solana?6:18,maxNameBytes:solana?32:40};
}
// Metadata is staged before launching and its content identifier is signed in the launch transaction.
// Solana always does: the launch instruction writes the URI into immutable Metaplex metadata (D11).
export function publishForLaunch({chain,publicEnabled,metadataSupported}) {
  return (chain==='base-sepolia' && metadataSupported===true) || chain.startsWith('solana-');
}
