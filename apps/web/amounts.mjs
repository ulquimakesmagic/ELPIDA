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

// Display only: transaction amounts and minimums keep their original integer/decimal units.
export function compactTradeAmount(value){
 const n=Number(value);if(!Number.isFinite(n))return '—';if(n===0)return '0';
 if(Math.abs(n)<0.000001)return n.toExponential(3).replace(/\.?0+e/,'e');
 return n.toLocaleString('en-US',Math.abs(n)>=1000?{notation:'compact',maximumFractionDigits:2}:{maximumSignificantDigits:6});
}
