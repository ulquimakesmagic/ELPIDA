// Exact reference for the Model 11 prototype tests: Model 10's virtual constant-product curve, in exact rational
// arithmetic, with the virtual reserves implied by a Uniswap position (liquidity L at sqrt price sqrtU):
// vQ0 = L·Q96/sqrtU (ETH) and vT0 = L·sqrtU/Q96 (tokens), so vQ·vT = L². Also a BigInt port of Uniswap's TickMath.
export const Q96 = 1n << 96n;

/** Uniswap v4 TickMath.getSqrtPriceAtTick, ported bit for bit. */
export function sqrtPriceAtTick(tick) {
  const t = BigInt(tick), abs = t < 0n ? -t : t;
  let price = (abs & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  const factors = [0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
    0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n,
    0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
    0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n, 0xd097f3bdfd2022b8845ad8f792aa5825n,
    0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
    0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n, 0x48a170391f7dc42444e8fa2n];
  for (let i = 0; i < factors.length; i++) if ((abs & (1n << BigInt(i + 1))) !== 0n) price = (price * factors[i]) >> 128n;
  if (t > 0n) price = ((1n << 256n) - 1n) / price;
  return (price >> 32n) + ((price & ((1n << 32n) - 1n)) === 0n ? 0n : 1n);
}

/**
 * Model 10 with the pool's implied virtual reserves. State is R, the net ETH in the curve, exactly as Model 10's
 * realReserve; every output is the exact rational value, floored once.
 */
export class Model10 {
  constructor(L, sqrtU) { this.L = L; this.sqrtU = sqrtU; this.R = 0n; }
  /** Denominator D(R) = L·Q96 + R·sqrtU, so vQ = D/sqrtU and vT = L²·sqrtU/D. */
  D(R = this.R) { return this.L * Q96 + R * this.sqrtU; }
  /** Tokens out for `net` ETH into the curve: vT(R) - vT(R + net). */
  buyOut(net) {
    const a = this.D(), b = this.D(this.R + net);
    return (this.L * this.L * this.sqrtU * this.sqrtU * net) / (a * b);
  }
  /** Gross ETH out for `tokens` sold back: vQ(R) - L²/(vT(R) + tokens). */
  sellGross(tokens) {
    const d = this.D();
    return (tokens * d * d) / (this.sqrtU * (this.L * this.L * this.sqrtU + tokens * d));
  }
  /** Net ETH a buy must pay into the curve to receive `tokens`: inverse of buyOut, rounded up. */
  buyNetFor(tokens) {
    const d = this.D(), num = tokens * d * d, den = this.sqrtU * (this.L * this.L * this.sqrtU - tokens * d);
    return (num + den - 1n) / den;
  }
  /** Tokens a sell must put in to take `gross` ETH out of the curve: inverse of sellGross, rounded up. */
  sellTokensFor(gross) {
    const d = this.D(), num = gross * this.sqrtU * this.sqrtU * this.L * this.L, den = d * d - gross * this.sqrtU * d;
    return (num + den - 1n) / den;
  }
  /** Sets R from the pool's price: the real ETH the curve holds is vQ(price) - vQ0 = L·Q96/sqrtP - L·Q96/sqrtU. */
  sync(sqrtP) { this.R = this.L * Q96 / sqrtP - this.L * Q96 / this.sqrtU; return this; }
  /** Tokens worth `wei` of ETH at the current price: the tolerance for Uniswap's per-step rounding. */
  tokensFor(wei) { return this.buyOut(wei) + 2n; }
  buy(net) { const out = this.buyOut(net); this.R += net; return out; }
  sell(tokens) { const gross = this.sellGross(tokens); this.R -= gross; return gross; }
}

/** Model 10's fee schedule (ElpidaDexCurve.currentFeeBps and _fees). */
export function feeBps(elapsed) {
  if (elapsed >= 60) return 125n;
  return 125n + (9000n - 125n) * BigInt(60 - elapsed) / 60n;
}
export function fees(gross, bps) {
  const fee = gross * bps / 10000n; let base = gross * 125n / 10000n; if (base > fee) base = fee;
  return { fee, base };
}
/** Model 10's split of the base fee: creator half (odd wei), burn share from the protocol half, protocol the rest. */
export function split(base, buybackBps = 0n) {
  const creator = base - base / 2n, burn = base * buybackBps / 10000n;
  return { creator, burn, protocol: base - creator - burn };
}
