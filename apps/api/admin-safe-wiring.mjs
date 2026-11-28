import { readFileSync } from 'node:fs';
import { Contract, FetchRequest, Interface, JsonRpcProvider, Signature, TypedDataEncoder, ZeroAddress, concat, dataLength, keccak256, recoverAddress, solidityPacked } from 'ethers';

const batch = JSON.parse(readFileSync(new URL('../../deployments/elysium-mainnet-v23-safe-batch.json', import.meta.url), 'utf8'));
const chainId = 99901;
const safeAddress = '0x99654F654450F0e070Bf62ee2566005b69d54428';
const factoryAddress = '0xB549943443f12006D83E6c2a0B3eD0bd7a3DE5e8';
const multiSendAddress = '0xA83c336B20401Af773B6219BA5027174338D1836';
const multiSendCodeHash = '0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663';
export const wiringHash = '0xf8d6ee14ce6c4d28d11f81c07bda008e86837edcb61fbe95925af8a4e9823954';
const signers = ['0x1e994ec9ae8fa989598fff02a601845118b016c5', '0x97f1b036d26dddfd60906bf54e70e39f6be6c16b'];
const safeAbi = [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)',
  'function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)',
];
const factoryAbi = [
  'function treasury() view returns (address)', 'function hook() view returns (address)',
  'function usdFeed() view returns (address)', 'function feeUsdc() view returns (address)',
  'function maxPriceAge() view returns (uint256)', 'function approvedQuotes(address) view returns (uint256)',
  'function guardian() view returns (address)', 'function dailyLaunchCap() view returns (uint256)',
];
const writes = new Interface([
  'function setHook(address)', 'function configureUsdPricing(address,uint256,address)',
  'function approveQuote(address,uint256)', 'function setGuardian(address)', 'function setDailyLaunchCap(uint256)',
]);
const multiSend = new Interface(['function multiSend(bytes)']);

function wiringBatch() {
  if (Number(batch.chainId) !== chainId || batch.meta.createdFromSafeAddress !== safeAddress || batch.transactions.length !== 5 ||
    batch.transactions.some(tx => tx.to !== factoryAddress || tx.value !== '0')) throw new Error('Unexpected Elysium wiring batch.');
  const packed = batch.transactions.map(({ to, data }) => solidityPacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, to, 0, dataLength(data), data]));
  const data = multiSend.encodeFunctionData('multiSend', [concat(packed)]);
  const domain = { chainId, verifyingContract: safeAddress };
  const message = { to: multiSendAddress, value: '0', data, operation: '1', safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZeroAddress, refundReceiver: ZeroAddress, nonce: '0' };
  const types = { SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ] };
  if (TypedDataEncoder.hash(domain, types, message) !== wiringHash) throw new Error('Elysium wiring hash changed.');
  const args = types.SafeTx.slice(0, -1).map(({ name }) => message[name]);
  const calls = batch.transactions.map(({ data: input }) => writes.parseTransaction({ data: input }));
  return { args, calls, typedData: TypedDataEncoder.getPayload(domain, types, message) };
}

const { args, calls, typedData } = wiringBatch();
const [hook] = calls[0].args, [feed, maxAge, usdc] = calls[1].args, [, virtualQuote] = calls[2].args;
const [guardian] = calls[3].args, [cap] = calls[4].args;
const callDescriptions = [
  `Connect V2.3 hook ${hook}`,
  `Configure HYPE/USD feed ${feed} with a 24-hour maximum price age`,
  `Enable USDC ${usdc} with a $25,000 virtual quote and set it as the fee token`,
  `Set guardian ${guardian}`,
  `Set the daily launch cap to ${cap}`,
];

function failure(status, message) { return Object.assign(new Error(message), { status }); }

export function elysiumWiringProvider(rpcUrls) {
  const url = (rpcUrls ?? '').split(',').map(value => value.trim()).find(value => value.startsWith('https://')) ?? 'https://elysium-rpc.publicnode.com';
  const request = new FetchRequest(url);
  request.timeout = 10_000;
  return new JsonRpcProvider(request, chainId);
}

export function createAdminSafeWiring({ provider, adminAddresses }) {
  const safe = new Contract(safeAddress, safeAbi, provider);
  const factory = new Contract(factoryAddress, factoryAbi, provider);
  const signatures = new Map();
  const allows = address => signers.includes(address) && adminAddresses.includes(address);

  async function readState() {
    try {
      const [network, owners, threshold, nonce, treasury, actualHook, multiSendCode] = await Promise.all([
        provider.getNetwork(), safe.getOwners(), safe.getThreshold(), safe.nonce(), factory.treasury(), factory.hook(), provider.getCode(multiSendAddress),
      ]);
      if (network.chainId !== BigInt(chainId) || owners.length !== 3 || threshold !== 2n ||
          !signers.every(address => allows(address) && owners.some(owner => owner.toLowerCase() === address)) ||
          treasury !== safeAddress || keccak256(multiSendCode) !== multiSendCodeHash) {
        throw failure(409, 'The Elysium Safe or signer configuration changed.');
      }
      if (nonce === 0n && actualHook === ZeroAddress && await safe.getTransactionHash(...args, 0) === wiringHash) return 'pending';
      if (nonce > 0n && actualHook === hook) {
        const [actualFeed, feeToken, age, quote, actualGuardian, actualCap] = await Promise.all([
          factory.usdFeed(), factory.feeUsdc(), factory.maxPriceAge(), factory.approvedQuotes(usdc), factory.guardian(), factory.dailyLaunchCap(),
        ]);
        if (actualFeed === feed && feeToken === usdc && age === maxAge && quote === virtualQuote && actualGuardian === guardian && actualCap === cap) {
          signatures.clear();
          return 'executed';
        }
      }
      throw failure(409, 'The Safe nonce or factory wiring changed. Ask an operator to verify it on Elysium.');
    } catch (error) {
      if (error.status === 409) throw error;
      throw failure(503, 'Elysium verification is temporarily unavailable. Refresh to try again.');
    }
  }

  function requireSigner(address) {
    if (!allows(address)) throw failure(403, 'This wallet cannot access Elysium Safe wiring.');
  }

  async function requirePending(address) {
    requireSigner(address);
    if (await readState() !== 'pending') throw failure(409, 'The Elysium Safe batch is already executed. Refresh to see its status.');
  }

  return {
    allows,
    async status(address) {
      requireSigner(address);
      const state = await readState();
      return { state, safe: safeAddress, factory: factoryAddress, hash: wiringHash, calls: callDescriptions,
        threshold: 2, owners: signers.map(owner => ({ address: owner, signed: signatures.has(owner) })),
        typedData: state === 'pending' && !signatures.has(address) ? typedData : undefined };
    },
    async sign(address, submitted) {
      requireSigner(address);
      let signature;
      try {
        if (typeof submitted !== 'string' || !/^0x[a-fA-F0-9]{130}$/.test(submitted)) throw new Error();
        signature = Signature.from(submitted).serialized;
        if (recoverAddress(wiringHash, signature).toLowerCase() !== address) throw new Error();
      } catch {
        throw failure(400, 'The signature must match this owner and the exact Elysium Safe batch.');
      }
      await requirePending(address);
      signatures.set(address, signature);
      return { signed: true };
    },
    async prepare(address) {
      await requirePending(address);
      if (!signers.every(owner => signatures.has(owner))) throw failure(409, 'Both selected Safe owners must sign first.');
      // Safe expects signatures in ascending owner-address order.
      const call = [...args, concat(signers.slice().sort().map(owner => signatures.get(owner)))];
      try {
        if (!await safe.execTransaction.staticCall(...call, { from: address })) throw new Error();
      } catch {
        throw failure(409, 'The batch could not run on Elysium. Check the HYPE/USD feed is current and refresh the Safe status before retrying.');
      }
      return { from: address, to: safeAddress, value: '0x0', data: safe.interface.encodeFunctionData('execTransaction', call) };
    },
  };
}
