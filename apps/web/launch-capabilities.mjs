export function launchProfile(chain) {
  const solana=chain.startsWith('solana-');
  // Every chain uses the same four pair kinds; live assets come from each wallet's pairOptions().
  return {solana,pairs:['native','usdc','xstock','token'],decimals:solana?6:18,maxNameBytes:solana?32:40};
}
// Metadata is staged before launching and its content identifier is signed in the launch transaction.
// Solana always does: the launch instruction writes the URI into immutable Metaplex metadata (D11).
// Other EVM chains stage details only on the team launchpad that Elpida indexes: staged details are kept once the
// public indexer sees the launch, and would expire on a private per-browser launchpad.
/**
 * Token details are published only inside the launch transaction, never afterwards. Returns why a launch must not be
 * sent on this launchpad, or null when its details will be included.
 */
export function launchDetailsError({chain,networkName,metadataSupported,publiclyIndexed=false}) {
  if(publishForLaunch({chain,metadataSupported,publiclyIndexed}))return null;
  if(metadataSupported!==true)return 'This launchpad predates token details at launch. Its operator needs to set up the current launchpad. Nothing was submitted.';
  return `Launches on ${networkName} open once Elpida's shared launchpad is set up there, so token details are always published in the launch transaction. Nothing was submitted.`;
}
export function publishForLaunch({chain,publicEnabled,metadataSupported,publiclyIndexed=false}) {
  return ((chain==='base-sepolia' || publiclyIndexed===true) && metadataSupported===true) || chain.startsWith('solana-');
}
