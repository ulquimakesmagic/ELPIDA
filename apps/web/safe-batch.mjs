// Multisig treasury (mainnet checklist C3). A factory's treasury is immutable: it receives launch fees and the
// protocol share, and it alone can configure USD pricing (once) and approve quote assets. So the mainnet treasury must
// be a multisig (Safe) from the start. The connected wallet deploys and pays gas but gets no powers; the
// treasury-only steps are handed to the Safe's signers as a Transaction Builder batch (Safe{Wallet} → Apps →
// Transaction Builder → drag in the file → review → create → collect signatures → execute).
export const SAFE_ABI = ['function getOwners() view returns(address[])', 'function getThreshold() view returns(uint256)'];

/** What lives at `address`: { contract, safe, owners, threshold }. Reads only. */
export async function readSafe(Contract, provider, address) {
  if ((await provider.getCode(address)) === '0x') return { contract: false, safe: false };
  try {
    const safe = new Contract(address, SAFE_ABI, provider);
    const [owners, threshold] = await Promise.all([safe.getOwners(), safe.getThreshold()]);
    return { contract: true, safe: true, owners: [...owners], threshold: Number(threshold) };
  } catch { return { contract: true, safe: false }; }
}

/**
 * Why this treasury must not be used, or null. Any treasury other than the connected wallet must be a Safe (its
 * signers execute the setup batch). On mainnet the treasury must be a Safe that needs at least two signatures.
 */
export function treasuryError({ mainnet = false, treasury, connected, safe }) {
  const external = treasury.toLowerCase() !== connected.toLowerCase();
  if (mainnet && !external) return 'On mainnet the launchpad treasury must be a multisig (a Safe), not the connected wallet. Create a Safe at app.safe.global and enter its address. Nothing was deployed.';
  if (!external) return null;
  if (!safe?.contract) return 'The treasury address is not a contract. Enter a Safe address, or leave it empty to use this wallet on testnet. Nothing was deployed.';
  if (!safe.safe) return 'The treasury contract is not a Safe (it has no owners and threshold). Nothing was deployed.';
  if (mainnet && safe.threshold < 2) return `This Safe needs only ${safe.threshold} signature. A mainnet treasury needs at least 2. Nothing was deployed.`;
  return null;
}

/** A Safe Transaction Builder batch file (JSON) for the treasury-only setup steps. */
export function safeBatch({ chainId, safe, name, description, transactions, now = Date.now() }) {
  if (!transactions.length) throw new Error('Nothing for the treasury to sign.');
  return {
    version: '1.0', chainId: String(chainId), createdAt: now,
    meta: { name, description, txBuilderVersion: '1.16.5', createdFromSafeAddress: safe, createdFromOwnerAddress: '' },
    transactions: transactions.map(t => ({ to: t.to, value: String(t.value ?? 0n), data: t.data, contractMethod: null, contractInputsValues: null })),
  };
}
