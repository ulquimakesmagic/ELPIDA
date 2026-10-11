export function launchProfile(chain) {
  const solana=chain.startsWith('solana-');
  return {solana,pairs:solana?['usdc']:['native','usdc'],decimals:solana?6:18,maxNameBytes:solana?32:40};
}
// Shared publishing is optional for test launches; configured upload failures still stop the launch.
export function publishForLaunch({chain,publicEnabled,metadataSupported}) {
  return chain==='base-sepolia' && publicEnabled===true && metadataSupported===true;
}
