// BigInt-only reference math; USDC units are integer micro-USDC.
export const FEE_BPS = 125n;
export const BPS = 10000n;
export const LAUNCH_FEE_USDC = 10_000_000n;
export function feeSplit(gross) {
  if (gross <= 0n) throw new Error('positive amount required');
  const fee = gross * FEE_BPS / BPS;
  const protocol = fee / 2n;
  return { fee, protocol, creator: fee - protocol, net: gross - fee };
}
export function buyQuote({ gross, virtualQuote, virtualToken, reserve, sold }) {
  const { net, fee } = feeSplit(gross);
  const available = virtualToken - sold;
  if (available <= 0n) throw new Error('invalid virtual token reserve');
  const out = available * net / (virtualQuote + reserve + net);
  if (out <= 0n) throw new Error('dust buy');
  return { out, fee, net };
}
export function sellQuote({ tokenIn, virtualQuote, virtualToken, reserve, sold }) {
  if (tokenIn <= 0n || tokenIn > sold) throw new Error('invalid token input');
  const gross = (virtualQuote + reserve) * tokenIn / (virtualToken - sold + tokenIn);
  if (gross > reserve) throw new Error('insufficient real reserve');
  const { fee, protocol, creator, net } = feeSplit(gross);
  return { gross, fee, protocol, creator, net };
}
