// Wallet signs, public RPC reads. A wallet whose testnet RPC stalls (Zerion on Ethereum Sepolia) used to leave the
// launchpad setup silent: ethers asked the wallet's RPC for a gas estimate before the wallet window could open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './helpers/browser-modules.mjs';
import { startServer } from '../apps/api/server.mjs';
const { PublicRpcSigner } = await import('../apps/web/public-rpc-signer.mjs');

const ME = '0x00000000000000000000000000000000000000aa';
function setup({ estimate = async () => 100000n, seenAfter = 2, walletKnows = false } = {}) {
  const log = { sent: [], slow: [], lookups: 0 };
  const provider = { estimateGas: async tx => { log.estimated = tx; return estimate(tx); }, getTransaction: async hash => (++log.lookups >= seenAfter ? { hash, from: 'public' } : null) };
  const walletSigner = {
    getAddress: async () => ME,
    sendUncheckedTransaction: async tx => { log.sent.push(tx); return '0xhash'; },
    signMessage: async m => 'sig:' + m,
    provider: { getTransaction: async hash => (walletKnows ? { hash, from: 'wallet' } : null) },
  };
  const signer = new PublicRpcSigner(walletSigner, provider, { onSlow: m => log.slow.push(m), slowMs: 30, findMs: 50, pollMs: 1, sleep: () => new Promise(r => setTimeout(r, 5)) });
  return { signer, log, walletSigner };
}

test('gas is estimated on the public RPC (+20%) before the wallet is asked, and the receipt is found there too', async () => {
  const { signer, log } = setup();
  const tx = await signer.sendTransaction({ data: '0x6000', value: 0n });
  assert.equal(log.estimated.from, ME, 'estimated as the connected account');
  assert.equal(log.sent.length, 1); assert.equal(log.sent[0].gasLimit, 120000n);
  assert.deepEqual(tx, { hash: '0xhash', from: 'public' });
  assert.equal(typeof signer.provider.getTransaction, 'function', 'contracts and waits read through the public provider');
});

test('an explicit gas limit is kept; failed gas verification and reverts stop before the wallet', async () => {
  let s = setup(); await s.signer.sendTransaction({ to: '0x1', gasLimit: 5n }); assert.equal(s.log.sent[0].gasLimit, 5n); assert.equal(s.log.estimated, undefined);
  s = setup({ estimate: async () => { throw Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' }); } });
  await assert.rejects(s.signer.sendTransaction({ to: '0x1' }),e=>e.code==='GAS_ESTIMATE_UNAVAILABLE'); assert.equal(s.log.sent.length,0,'unverified gas never falls back to a wallet default');
  s = setup({ estimate: async () => { throw Object.assign(new Error('execution reverted: "Ownable"'), { code: 'CALL_EXCEPTION', data: '0x08c379a0' }); } });
  await assert.rejects(s.signer.sendTransaction({ to: '0x1' }), /Ownable/); assert.equal(s.log.sent.length, 0, 'the wallet never opens for a doomed transaction');
});

test('a slow wallet gets a visible hint; a transaction the public RPC never shows falls back to the wallet, then reports the hash', async () => {
  const { signer, log, walletSigner } = setup();
  walletSigner.sendUncheckedTransaction = tx => new Promise(r => setTimeout(() => { log.sent.push(tx); r('0xhash'); }, 80));
  await signer.sendTransaction({ to: '0x1' });
  assert.equal(log.slow.length, 1); assert.match(log.slow[0], /open the wallet extension/);
  assert.deepEqual(await setup({ seenAfter: Infinity, walletKnows: true }).signer.sendTransaction({ to: '0x1' }), { hash: '0xhash', from: 'wallet' });
  await assert.rejects(setup({ seenAfter: Infinity }).signer.sendTransaction({ to: '0x1' }), e => e.hash === '0xhash' && /explorer/.test(e.message));
  assert.equal(await setup().signer.signMessage('hi'), 'sig:hi');
});

test('every module the page imports is served (a missing entry would break the whole site)', async t => {
  const app = await startServer({ port: 0, seed: false });
  t.after(() => app.close());
  const base = app.url, seen = new Set(), queue = ["/app.mjs"];
  while (queue.length) {
    const path = queue.shift(); if (seen.has(path)) continue; seen.add(path);
    const res = await fetch(base + path); assert.equal(res.status, 200, `${path} is not served`);
    if (path === '/vendor/ethers.js' || !/javascript/.test(res.headers.get('content-type') ?? '')) continue;
    const text = await res.text();
    for (const [, spec] of text.matchAll(/(?:^|[;\n}])\s*import\s*(?:[\w*{}\s,$]+from\s*)?['"]([^'"]+)['"]/g)) queue.push(new URL(spec, base + path).pathname);
    for (const [, spec] of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) queue.push(new URL(spec, base + path).pathname);
  }
  assert.ok(seen.has('/public-rpc-signer.mjs') && seen.has('/wallet.mjs') && seen.size > 20, `crawled ${seen.size} modules`);
});

test('on a real chain: deploy, wait for deployment, call, wait for the receipt, and a revert stops before the wallet', async t => {
  const { network } = await import('hardhat');
  const { BrowserProvider, ContractFactory } = await import('ethers');
  const { compiled } = await import('./helpers/dex-fixture.mjs');
  const connection = await network.create('localTest');
  const wallet = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }), pub = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  wallet.pollingInterval = pub.pollingInterval = 10;
  t.after(async () => { wallet.destroy(); pub.destroy(); await connection.close(); });
  const sent = [], walletSigner = await wallet.getSigner(0), unchecked = walletSigner.sendUncheckedTransaction.bind(walletSigner);
  walletSigner.sendUncheckedTransaction = tx => { sent.push(tx); return unchecked(tx); };
  const signer = new PublicRpcSigner(walletSigner, pub, { pollMs: 5 });
  const a = compiled['contracts/evm/testnet/ElpidaTestAsset.sol'].ElpidaTestAsset;
  const asset = await new ContractFactory(a.abi, a.evm.bytecode.object, signer).deploy('Test Stock', 'TEST-STOCK', 'xstock', 18, 250);
  await asset.waitForDeployment();
  assert.ok(sent[0].gasLimit > 0n, 'the deployment carried a public-RPC gas limit');
  const receipt = await (await asset.faucet(10n ** 18n)).wait();
  assert.equal(receipt.status, 1); assert.ok(sent[1].gasLimit > 0n);
  assert.equal(await asset.balanceOf(await signer.getAddress()), 10n ** 18n);
  await assert.rejects(asset.faucet(10n ** 30n), /faucet limit/); assert.equal(sent.length, 2, 'the wallet was never asked for the doomed call');
});

test('setup resumes a confirmed deployment without resending and preserves pending or failed records', async () => {
  const { resumeSetupDeployment } = await import('../apps/web/public-rpc-signer.mjs');
  const hash = '0x' + '12'.repeat(32), address = '0x' + '34'.repeat(20);
  const records = new Map(), storage = { getItem: k => records.get(k), setItem: (k, v) => records.set(k, v) };
  let sent = 0, receipt = null;
  const args = { storage, key: 'chain:factory:wallet:asset', timeoutMs: 0,
    provider: { getTransactionReceipt: async () => receipt, getCode: async () => '0x6000' },
    deploy: async () => { sent++; return { target: address, deploymentTransaction: () => ({ hash }) }; } };
  await assert.rejects(resumeSetupDeployment(args), /Reopen setup to resume/);
  assert.equal(sent, 1); assert.ok(records.has(args.key));
  receipt = { status: 1, contractAddress: address };
  assert.equal(await resumeSetupDeployment(args), address); assert.equal(sent, 1);
  receipt = { status: 0, contractAddress: address };
  await assert.rejects(resumeSetupDeployment(args), /failed/); assert.equal(sent, 1);
  receipt = { status: 1, contractAddress: ME };
  await assert.rejects(resumeSetupDeployment(args), /different contract/);
  receipt = { status: 1, contractAddress: address }; args.provider.getCode = async () => '0x';
  await assert.rejects(resumeSetupDeployment(args), /no code/);
});

test('a slow gas preflight is labelled before requesting the wallet',async()=>{
 const {signer,log}=setup({estimate:async()=>{await new Promise(r=>setTimeout(r,70));return 100000n;}});
 await signer.sendTransaction({to:ME});assert.equal(log.sent.length,1);assert.ok(log.slow.some(m=>/No wallet request has been sent/.test(m)));
});

test('an unresolved empty simulation revert never submits a wallet default-gas transaction',async()=>{
 for(const data of [null,undefined,'0x']){
  const s=setup({estimate:async()=>{throw Object.assign(Error('missing revert data'),{code:'CALL_EXCEPTION',data});}});
  await assert.rejects(s.signer.sendTransaction({to:ME}),/missing revert data/);assert.equal(s.log.sent.length,0);
 }
});

test('a capped primary simulation recovers a large graduation estimate and sends that bounded gas to the wallet',async()=>{
 const {FetchRequest}=await import('ethers'),{PacedJsonRpcProvider}=await import('../apps/web/paced-rpc.mjs');
 const request=new FetchRequest('https://primary.test');request.getUrlFunc=async req=>{const payload=JSON.parse(new TextDecoder().decode(req.body));return{statusCode:200,statusMessage:'OK',headers:{'content-type':'application/json'},body:new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',id:payload.id,error:{code:3,message:'execution reverted'}}))};};
 const original=globalThis.fetch,seen=[];globalThis.fetch=async(url,opts)=>{const body=JSON.parse(opts.body);seen.push(body);return{ok:true,json:async()=>({jsonrpc:'2.0',id:body.id,result:body.method==='eth_chainId'?'0xaa36a7':body.method==='eth_getBlockByNumber'?{timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),gasLimit:'0xbebc200'}:'0x33da75a'})};};
 const provider=new PacedJsonRpcProvider(request,11155111,{staticNetwork:true,batchMaxCount:1,cacheTimeout:-1},{fallbacks:['https://simulation.test']});
 try{
  const sent=[];provider.getTransaction=async hash=>({hash});
  const wallet={getAddress:async()=>ME,sendUncheckedTransaction:async tx=>{sent.push(tx);return'0xhash';}};
  const signer=new PublicRpcSigner(wallet,provider);await signer.sendTransaction({to:ME,data:'0x1234'});
  assert.equal(sent.length,1);assert.equal(sent[0].gasLimit,54372186n*120n/100n);assert.ok(sent[0].gasLimit>900000n);
  const estimate=seen.find(p=>p.method==='eth_estimateGas');assert.equal(estimate.params[0].gas,'0xbebc200');assert.equal(estimate.params[0].from,ME);
 }finally{provider.destroy();globalThis.fetch=original;}
});
