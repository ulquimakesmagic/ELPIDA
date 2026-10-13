export function launchProfile(chain) {
  const solana=chain.startsWith('solana-');
  // Every chain uses the same four pair kinds; live assets come from each wallet's pairOptions().
  return {solana,pairs:['native','usdc','xstock','token'],decimals:solana?6:18,maxNameBytes:solana?32:40};
}
// Shared publishing is optional for test launches; configured upload failures still stop the launch.
export function publishForLaunch({chain,publicEnabled,metadataSupported}) {
  return chain==='base-sepolia' && publicEnabled===true && metadataSupported===true;
}
