// Comparing observations never verifies issuer controls or authorizes pairing.
const hash = value => /^0x[0-9a-f]{64}$/i.test(value ?? '');
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const normalized = value => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? value.toLowerCase()
  : Array.isArray(value) ? value.map(normalized) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalized(v)])) : value;

function validate(report) {
  if (report?.kind !== 'ondo-readonly-control-observations' || !['ethereum', 'bnb'].includes(report.network)
    || !/^0x[0-9a-f]{40}$/i.test(report.token ?? '') || !Number.isSafeInteger(report.number) || report.number < 0
    || report.chainId !== ({ ethereum: 1, bnb: 56 })[report.network] || !hash(report.hash)
    || typeof report.identityMatches !== 'boolean' || typeof report.codePresent !== 'boolean'
    || (report.codePresent && !hash(report.codeHash)) || !report.observations || !report.proxySlots || !report.roles) {
    throw new Error('A complete canonical EVM Ondo observation report is required.');
  }
}

function fields(report) {
  const result = { codePresent: report.codePresent, codeHash: report.codeHash, identityMatches: report.identityMatches };
  const add = (key, probe) => { result[key] = probe?.status === 'observed' ? normalized(probe.value) : { unverified: true }; };
  for (const key of ['symbol', 'decimals', 'owner', 'paused', 'blocklist', 'sanctionsList', 'sharesMultiplier']) add(`token.${key}`, report.observations[key]);
  for (const key of ['implementation', 'admin', 'beacon']) add(`proxy.${key}`, report.proxySlots[key]);
  result['beacon.address'] = report.beacon?.address?.toLowerCase() ?? null;
  for (const key of ['owner', 'implementation', 'implementationCode']) add(`beacon.${key}`, report.beacon?.[key]);
  for (const key of ['DEFAULT_ADMIN_ROLE', 'PAUSER_ROLE', 'UPGRADER_ROLE', 'BURNER_ROLE', 'BLOCKLIST_ROLE']) {
    const role = report.roles[key];
    add(`role.${key}.id`, role?.role); add(`role.${key}.count`, role?.memberCount);
    // Enumerable sets may change order without changing membership.
    result[`role.${key}.members`] = role?.members?.every(x => x.status === 'observed') && role.truncated === false
      ? role.members.map(x => normalized(x.value)).sort() : { unverified: true };
  }
  return result;
}

export function compareOndoControls(baseline, current) {
  validate(baseline); validate(current);
  if (baseline.network !== current.network || baseline.token.toLowerCase() !== current.token.toLowerCase()
    || baseline.symbol !== current.symbol || current.number < baseline.number
    || (baseline.number === current.number && baseline.hash.toLowerCase() !== current.hash.toLowerCase())) {
    throw new Error('Reports must describe the same asset and an ordered, consistent block history.');
  }
  const before = fields(baseline), after = fields(current), changes = [], unverified = [];
  for (const [field, value] of Object.entries(after)) {
    if (value?.unverified || before[field]?.unverified) unverified.push(field);
    if (stable(before[field]) !== stable(value)) changes.push({ field, before: before[field], after: value });
  }
  return { kind: 'ondo-control-drift', network: current.network, token: current.token,
    baseline: { number: baseline.number, hash: baseline.hash }, current: { number: current.number, hash: current.hash },
    status: changes.length ? 'CHANGED' : 'NO_OBSERVED_CHANGE', changes, unverified,
    issuerControlsVerified: false, liveCapabilitiesApproved: false,
    note: 'No observed change is not verification. Review changed, unavailable and truncated controls against verified source; never auto-accept a new baseline.' };
}
