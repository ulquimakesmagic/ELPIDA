#!/usr/bin/env node
// Checks a V2 deployment plan before anyone touches a chain.
//
//   node scripts/deploy-v2.mjs --chain 8453 --name Base --mainnet \
//     --treasury 0x… --recipient 0x… --recipient 0x… --recipient 0x… \
//     --min-fee-bps 100 --approval approval.json --rpc https://…
//
// It prints the plan and its hash, then refuses unless the approval signs that exact hash, the treasury is a contract,
// and the start cap is the mainnet one. It does not send a transaction: deploying is a separate, explicitly authorised
// step, and this repository has no mainnet deployer yet (docs/V2_0_CONTRACTS.md).
//
// Exit codes: 0 plan is deployable, 1 the gate refused, 2 bad usage.
import { readFileSync } from 'node:fs';
import { JsonRpcProvider } from 'ethers';
import { buildPlan, assertReady, MAINNET_START_MCAP_USD } from '../packages/core/v2-deploy-gate.mjs';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const value = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const many = name => argv.reduce((out, arg, i) => (arg === `--${name}` ? [...out, argv[i + 1]] : out), []);

const usage = () => {
  console.error('usage: node scripts/deploy-v2.mjs --chain <id> [--name <name>] [--testnet] --treasury <address> --recipient <address> (x3) --min-fee-bps <n> --approval <file> --rpc <url>');
  process.exit(2);
};

try {
  if (!value('chain') || !value('treasury') || !value('approval')) usage();

  const mainnet = !flag('testnet');
  const plan = buildPlan({
    chainId: Number(value('chain')),
    chainName: value('name'),
    mainnet,
    treasury: value('treasury'),
    recipients: many('recipient'),
    minFeeBps: Number(value('min-fee-bps') ?? 100),
  });

  console.log(JSON.stringify(plan, null, 2));

  // The treasury check needs a node; a mainnet plan without one cannot pass.
  const rpc = value('rpc');
  let treasuryIsContract = false;
  if (rpc) {
    const code = await new JsonRpcProvider(rpc).getCode(plan.treasury);
    treasuryIsContract = code !== '0x';
  } else if (mainnet) {
    console.error(JSON.stringify({ refused: 'RPC_REQUIRED', detail: 'A mainnet plan needs --rpc so the treasury can be checked for contract code.' }));
    process.exit(1);
  }

  const approval = JSON.parse(readFileSync(value('approval'), 'utf8'));
  assertReady(plan, approval, { treasuryIsContract });

  console.log(JSON.stringify({
    deployable: true,
    planHash: plan.planHash,
    startMcapUsd: plan.startMcapUsd,
    note: mainnet
      ? `Approved and sane. This script does not deploy; a mainnet deployer is a separate authorised step. The plan starts at $${MAINNET_START_MCAP_USD}.`
      : 'Approved and sane for a test network (test-sized start cap).',
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ refused: error.code ?? 'ERROR', detail: error.message }));
  process.exit(1);
}
