// Compare decimal amounts without rounding away the last token/native-asset unit.
export function exceedsRemaining(amount, remaining) {
  const decimal = value => {
    const match = String(value).match(/^(\d+)(?:\.(\d*))?$/);
    return match && {whole:match[1],fraction:match[2] ?? ''};
  };
  const a = decimal(amount), b = decimal(remaining);
  if (!a || !b) return false;
  const places = Math.max(a.fraction.length,b.fraction.length);
  const units = value => BigInt(value.whole + value.fraction.padEnd(places,'0'));
  return units(a) > units(b);
}
