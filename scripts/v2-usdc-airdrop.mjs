#!/usr/bin/env node
// The USDC trader-airdrop distributor on a mainnet (contracts/evm/v2/ElpidaV2UsdcDistributor.sol). Malik, 22 November
// 2026: the monthly trader airdrop pays in USDC, scored by EWPR (packages/core/ewpr.mjs), on Base and BNB Chain now.
// One contract per chain, beside the launchpad's airdrop distributor, whose monthly schedule it copies. The keeper (its
// operator) moves each finished month's airdrop share into it, converts it to USDC on the chain's v3 DEX (at least 97%
// of a fresh quote) and pushes the USDC to every qualifying wallet. The keeper cannot send the funds anywhere else.
//
//   node scripts/v2-usdc-airdrop.mjs check    --plan deployments/plans/base-mainnet.json
//   node scripts/v2-usdc-airdrop.mjs rehearse --plan deployments/plans/base-mainnet.json --node http://127.0.0.1:8545
//   node scripts/v2-usdc-airdrop.mjs deploy   --plan deployments/plans/base-mainnet.json
//
// `check` and `deploy` need ELPIDA_MAINNET_RPC_URL. `rehearse` runs everything on a dev node forking the chain (anvil):
// deploys, funds the launchpad's airdrop distributor with native coin, moves to the month's end, and pays one wallet in
// USDC exactly as the keeper will. `deploy` needs the approval file deployments/approvals/<key>-usdc-airdrop.json, asks
// for the deployer key with a hidden prompt (or ELPIDA_MAINNET_DEPLOYER_KEY; never printed) and adds `usdcAirdrop` to
// deployments/<key>.json. Nothing else in the launchpad changes; no Safe transaction is needed.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, ZeroAddress, formatEther, formatUnits, parseEther, solidityPacked } from 'ethers';
import { compileV4 } from './compile-v4.mjs';
import { EVM_MAINNETS } from '../packages/core/mainnets.mjs';
import { buildRound } from '../packages/core/v2-rounds.mjs';
import { readPlan, askHidden, askTyped, deployerKey, devRpc } from './v2-mainnet-deploy.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEE_TIERS = [100, 500, 2500, 3000, 10000];
const SOURCE = ['function operator() view returns(address)', 'function period() view returns(uint256)', 'function genesis() view returns(uint256)', 'function purpose() view returns(string)',
  'function currentRound() view returns(uint256)', 'function roundEnd(uint256) view returns(uint256)', 'function available(address) view returns(uint256)',
  'function postRoot(uint256,address,bytes32,uint256,uint32,string)', 'function claim(uint256,address,address,uint256,bytes32[]) returns(bool)'];
const QUOTER = ['function quoteExactInput(bytes,uint256) returns(uint256,uint160[],uint32[],uint256)', 'function factory() view returns(address)', 'function WETH9() view returns(address)'];
const ERC20 = ['function decimals() view returns(uint8)', 'function symbol() view returns(string)', 'function balanceOf(address) view returns(uint256)'];

const saveJson = (path, value) => { writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n'); renameSync(path + '.tmp', path); };

export function usdcArtifact() {
  const out = compileV4(), a = Object.values(out).find(e => e.ElpidaV2UsdcDistributor?.evm?.bytecode?.object)?.ElpidaV2UsdcDistributor;
  return { abi: a.abi, bytecode: '0x' + a.evm.bytecode.object.replace(/^0x/, '') };
}

/** The chain's payout DEX (packages/core/mainnets.mjs) for this plan. */
export function payoutDexFor(plan) {
  const dex = EVM_MAINNETS.find(n => n.chainId === Number(plan.chainId))?.payoutDex;
  if (!dex) throw new Error(`${plan.name} has no payout DEX configured in packages/core/mainnets.mjs. Nothing was deployed.`);
  return dex;
}

/** The best quote for `amount` of the wrapped native coin into USDC, over each fee tier: { path, out } or null. */
export async function bestNativeRoute(provider, dex, usdc, amount) {
  const quoter = new Contract(dex.quoter, QUOTER, provider);
  let best = null;
  for (const f of FEE_TIERS) {
    const path = solidityPacked(['address', 'uint24', 'address'], [dex.weth, f, usdc]);
    try { const [out] = await quoter.quoteExactInput.staticCall(path, amount); if (out > 0n && (!best || out > best.out)) best = { path, out, fee: f }; } catch { /* no pool on this tier */ }
  }
  return best;
}

/** Every check before deploying: the launchpad's airdrop distributor, USDC, the DEX, and a live native → USDC quote. */
export async function checks({ provider, plan, record }) {
  const out = [], ok = (check, pass, detail = '') => out.push({ check, ok: !!pass, detail });
  const dex = payoutDexFor(plan), code = async a => (await provider.getCode(a)) !== '0x';
  ok('chain id matches the plan', Number((await provider.getNetwork()).chainId) === Number(plan.chainId));
  const airdrop = record?.contracts?.airdrop;
  ok('the launchpad has an airdrop distributor', airdrop && await code(airdrop), airdrop ?? 'missing');
  if (airdrop && await code(airdrop)) {
    const s = new Contract(airdrop, SOURCE, provider);
    ok('its operator is the plan keeper', (await s.operator()).toLowerCase() === plan.keeper.toLowerCase());
    ok('it runs calendar months', (await s.period()) === 0n);
    ok('its purpose is trader-airdrop', (await s.purpose()) === 'trader-airdrop');
  }
  const usdc = new Contract(plan.usdc, ERC20, provider);
  ok('USDC is a contract', await code(plan.usdc), plan.usdc);
  ok('USDC decimals match the plan', Number(await usdc.decimals()) === Number(plan.usdcDecimals ?? 6), String(await usdc.decimals()));
  ok(`${dex.name} router is a contract`, await code(dex.router), dex.router);
  ok(`${dex.name} quoter is a contract`, await code(dex.quoter), dex.quoter);
  ok('the quoter uses the same wrapped native coin', (await new Contract(dex.quoter, QUOTER, provider).WETH9()).toLowerCase() === dex.weth.toLowerCase(), dex.weth);
  const route = await bestNativeRoute(provider, dex, plan.usdc, parseEther('0.1'));
  ok('0.1 native coin quotes into USDC', route, route ? `${formatUnits(route.out, Number(plan.usdcDecimals ?? 6))} USDC on the ${route.fee / 10000}% pool` : 'no pool');
  ok('no USDC airdrop distributor recorded yet', !record?.contracts?.usdcAirdrop, record?.contracts?.usdcAirdrop ?? '');
  return out;
}

/** Deploys and reads every constructor argument back. Returns { address, hash, block, readBack }. */
export async function deployUsdcAirdrop({ signer, plan, record, art = usdcArtifact(), confirmations = plan.confirmations ?? 2 }) {
  const dex = payoutDexFor(plan), provider = signer.provider, source = new Contract(record.contracts.airdrop, SOURCE, provider);
  const args = [plan.keeper, await source.period(), await source.genesis(), 'trader-airdrop', plan.usdc, dex.router, dex.weth, record.contracts.airdrop, dex.routerVersion === 1];
  const c = await new ContractFactory(art.abi, art.bytecode, signer).deploy(...args), tx = c.deploymentTransaction(), receipt = await tx.wait(confirmations);
  const d = new Contract(await c.getAddress(), art.abi, provider);
  const readBack = [
    ['operator', (await d.operator()).toLowerCase() === plan.keeper.toLowerCase()],
    ['period', (await d.period()) === args[1]], ['genesis', (await d.genesis()) === args[2]],
    ['purpose', (await d.purpose()) === 'trader-airdrop'], ['usdc', (await d.usdc()).toLowerCase() === plan.usdc.toLowerCase()],
    ['swapRouter', (await d.swapRouter()).toLowerCase() === dex.router.toLowerCase()], ['wrappedNative', (await d.wrappedNative()).toLowerCase() === dex.weth.toLowerCase()],
    ['source', (await d.source()).toLowerCase() === record.contracts.airdrop.toLowerCase()], ['routerDeadline', (await d.routerDeadline()) === (dex.routerVersion === 1)],
  ].map(([check, pass]) => ({ check: `read back: ${check}`, ok: pass }));
  return { address: await c.getAddress(), hash: tx.hash, block: receipt.blockNumber, readBack };
}

/**
 * On a dev node forking the chain: deploy, then run one month exactly as the keeper will (native coin in the
 * launchpad's airdrop distributor → moved into the USDC distributor → converted → paid to one wallet in USDC).
 */
export async function rehearseUsdcAirdrop({ node, plan, record, log = () => {} }) {
  const provider = new JsonRpcProvider(node, undefined, { staticNetwork: true, cacheTimeout: -1 });
  const [first] = await provider.send('eth_accounts', []);
  const deployer = await provider.getSigner(first);
  const pre = await checks({ provider, plan, record: { ...record, contracts: { ...record.contracts, usdcAirdrop: undefined } } });
  const art = usdcArtifact(), dep = await deployUsdcAirdrop({ signer: deployer, plan, record, art, confirmations: 1 });
  log(`deployed on the fork at ${dep.address}`);
  // Act as the keeper (impersonated on the fork) for one finished month.
  await devRpc(provider, 'impersonateAccount', [plan.keeper]);
  await devRpc(provider, 'setBalance', [plan.keeper, '0x' + parseEther('1').toString(16)]);
  const keeper = await provider.getSigner(plan.keeper), source = new Contract(record.contracts.airdrop, SOURCE, keeper), target = new Contract(dep.address, art.abi, keeper);
  const sourceBalance = await provider.getBalance(record.contracts.airdrop), fund = parseEther('0.05');
  await devRpc(provider, 'setBalance', [record.contracts.airdrop, '0x' + (sourceBalance + fund).toString(16)]);
  const round = Number(await source.currentRound()), end = Number(await source.roundEnd(round));
  await provider.send('evm_setNextBlockTimestamp', ['0x' + (end + 60).toString(16)]); await provider.send('evm_mine', []);
  const chainId = Number(plan.chainId), avail = await source.available(ZeroAddress);
  const move = buildRound({ chainId, distributor: record.contracts.airdrop, round, asset: ZeroAddress }, new Map([[dep.address.toLowerCase(), avail]]));
  await (await source.postRoot(round, ZeroAddress, move.root, move.total, move.recipients, 'rehearsal')).wait();
  const e = move.entries[0]; await (await source.claim(round, ZeroAddress, e.account, e.amount, e.proof)).wait();
  const dex = payoutDexFor(plan), route = await bestNativeRoute(provider, dex, plan.usdc, avail);
  if (!route) throw new Error('No native → USDC quote on the fork.');
  await (await target.convert(ZeroAddress, avail, route.out * 97n / 100n, route.path)).wait();
  const usdc = new Contract(plan.usdc, ERC20, provider), got = await target.available(plan.usdc);
  const winner = Wallet.createRandom().address.toLowerCase();
  const pay = buildRound({ chainId, distributor: dep.address, round, asset: plan.usdc }, new Map([[winner, got]]));
  await (await target.postRoot(round, plan.usdc, pay.root, pay.total, pay.recipients, 'rehearsal')).wait();
  const p = pay.entries[0]; await (await target.claim(round, plan.usdc, p.account, p.amount, p.proof)).wait();
  const paid = await usdc.balanceOf(winner), places = Number(plan.usdcDecimals ?? 6);
  const flow = [
    { check: `moved ${formatEther(avail)} native coin into the USDC distributor`, ok: (await provider.getBalance(dep.address)) === 0n },
    { check: `converted to ${formatUnits(got, places)} USDC (quote ${formatUnits(route.out, places)})`, ok: got >= route.out * 97n / 100n },
    { check: `a wallet was paid ${formatUnits(paid, places)} USDC`, ok: paid === got && paid > 0n },
    { check: 'nothing left reserved', ok: (await target.reserved(plan.usdc)) === 0n },
  ];
  return { checks: pre, readBack: dep.readBack, flow, address: dep.address };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2), arg = n => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : null; };
  const planPath = arg('plan');
  if (!['check', 'rehearse', 'deploy'].includes(cmd) || !planPath) { console.log('usage: node scripts/v2-usdc-airdrop.mjs check|rehearse|deploy --plan deployments/plans/<key>.json [--node <anvil url>]'); process.exit(2); }
  const { plan } = readPlan(planPath), recordPath = join(root, 'deployments', `${plan.key}.json`);
  if (!existsSync(recordPath)) throw new Error(`No ${plan.name} launchpad record (deployments/${plan.key}.json). Nothing was deployed.`);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const print = list => { for (const c of list) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.check}${c.detail ? `: ${c.detail}` : ''}`); };
  console.log(`${plan.name}: USDC trader-airdrop distributor`);
  if (cmd === 'rehearse') {
    if (!arg('node')) throw new Error('rehearse needs --node <anvil forking the chain>.');
    const r = await rehearseUsdcAirdrop({ node: arg('node'), plan, record, log: m => console.log(m) });
    print(r.checks); print(r.readBack); print(r.flow);
    const ok = [...r.checks.filter(c => !/no USDC airdrop distributor/.test(c.check)), ...r.readBack, ...r.flow].every(c => c.ok);
    saveJson(join(root, 'deployments', `${plan.key}-usdc-airdrop-rehearsal.json`), { network: plan.key, at: new Date().toISOString(), scope: 'LOCAL FORK ONLY: nothing was sent to the public chain', ok, checks: r.checks, readBack: r.readBack, flow: r.flow });
    console.log(ok ? `Rehearsal passed. Evidence: deployments/${plan.key}-usdc-airdrop-rehearsal.json` : 'Rehearsal FAILED: do not deploy.');
    process.exit(ok ? 0 : 1);
  }
  const rpc = process.env.ELPIDA_MAINNET_RPC_URL; if (!rpc) throw new Error('Set ELPIDA_MAINNET_RPC_URL.');
  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  const c = await checks({ provider, plan, record }); print(c);
  if (cmd === 'check') process.exit(c.every(x => x.ok) ? 0 : 1);
  const approvalPath = join(root, 'deployments', 'approvals', `${plan.key}-usdc-airdrop.json`);
  if (!existsSync(approvalPath)) throw new Error(`No approval file deployments/approvals/${plan.key}-usdc-airdrop.json. Nothing was deployed.`);
  if (c.some(x => !x.ok)) throw new Error('A check failed. Nothing was deployed.');
  if (!existsSync(join(root, 'deployments', `${plan.key}-usdc-airdrop-rehearsal.json`)) || !JSON.parse(readFileSync(join(root, 'deployments', `${plan.key}-usdc-airdrop-rehearsal.json`), 'utf8')).ok)
    throw new Error(`Run the fork rehearsal first (rehearse --node …); it must pass. Nothing was deployed.`);
  const key = deployerKey(process.env.ELPIDA_MAINNET_DEPLOYER_KEY ?? await askHidden('Deployer private key (hidden, then Enter): '));
  const signer = new Wallet(key, provider);
  console.log(`deployer ${signer.address}, balance ${formatEther(await provider.getBalance(signer.address))}`);
  if ((await askTyped('Type DEPLOY to deploy on mainnet: ')).trim() !== 'DEPLOY') throw new Error('Cancelled. Nothing was deployed.');
  const dep = await deployUsdcAirdrop({ signer, plan, record });
  print(dep.readBack);
  const fresh = JSON.parse(readFileSync(recordPath, 'utf8'));
  fresh.contracts.usdcAirdrop = dep.address; fresh.txs.usdcAirdrop = { hash: dep.hash, block: dep.block };
  fresh.usdcAirdrop = { deployedAt: new Date().toISOString(), deployer: signer.address, readBack: dep.readBack.every(x => x.ok) ? 'ok' : 'FAILED' };
  saveJson(recordPath, fresh);
  if (dep.readBack.some(x => !x.ok)) throw new Error('Deployed, but a read-back check failed. Do not merge the record; tell Claude.');
  console.log(`Deployed at ${dep.address}. Recorded in deployments/${plan.key}.json: commit it on a branch and open a PR.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e.message); process.exit(1); });
