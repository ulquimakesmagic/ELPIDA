import { network } from 'hardhat';
import { BrowserProvider, Contract, ContractFactory, formatUnits, parseUnits, isAddress, ZeroAddress } from 'ethers';
import { compileContracts } from '../../scripts/compile.mjs';
import { testnets, evmTestnets } from '../../packages/core/networks.mjs';

const USDC = 1_000_000n;

export function amount(value, decimals = 6) {
  if (typeof value !== 'string' || !/^\d{1,18}(\.\d+)?$/.test(value)) throw new Error('Enter a valid positive amount.');
  let result;
  try { result = parseUnits(value, decimals); } catch { throw new Error(`Use at most ${decimals} decimal places.`); }
  if (result <= 0n) throw new Error('Amount must be greater than zero.');
  return result;
}

export async function createRuntime({ seed = true } = {}) {
  const compiled = compileContracts({ includeMocks: true });
  const artifact = name => compiled[`contracts/evm/src/${name}.sol`][name];
  const connection = await network.create('localTest');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const signers = await Promise.all([0, 1, 2, 3].map(i => provider.getSigner(i)));
  const addresses = await Promise.all(signers.map(s => s.getAddress()));
  const mock = compiled['tests/fixtures/MockUSDC.sol'].MockUSDC;
  const testUsdc = compiled['contracts/evm/testnet/ElpidaTestUSDC.sol'].ElpidaTestUSDC;
  const quote = await new ContractFactory(mock.abi, mock.evm.bytecode.object, signers[0]).deploy();
  await quote.waitForDeployment();
  const factory = await new ContractFactory(artifact('ElpidaLockedFactory').abi, artifact('ElpidaLockedFactory').evm.bytecode.object, signers[0]).deploy(await quote.getAddress(), addresses[2]);
  await factory.waitForDeployment();
  for (const address of addresses.slice(0, 2)) await (await quote.mint(address, 10_000n * USDC)).wait();
  const tokens = [];
  const activity = [];
  let queue = Promise.resolve();
  const signerFor = account => {
    if (account !== '0' && account !== '1') throw new Error('Choose a local demo account.');
    return signers[Number(account)];
  };
  const tokenFor = address => {
    const record = tokens.find(item => item.address.toLowerCase() === String(address).toLowerCase());
    if (!record) throw new Error('Token not found on this local session.');
    return record;
  };
  const config = {
    local: { chainId: 31337, name: 'Local devnet', factory: await factory.getAddress(), usdc: await quote.getAddress(), treasury: addresses[2], reward: addresses[3] },
    accounts: addresses.slice(0, 2).map((address, index) => ({ id: String(index), address, name: index ? 'Trader' : 'Creator' })),
    testnets: evmTestnets,
    plannedTestnets: testnets.filter(net => !net.enabled).map(({ key, name, note }) => ({ key, name, note })),
    model: 'locked-pool-v2',
    contracts: { factory: { abi: artifact('ElpidaLockedFactory').abi, bytecode: `0x${artifact('ElpidaLockedFactory').evm.bytecode.object}` }, token: { abi: artifact('ElpidaToken').abi }, curve: { abi: artifact('ElpidaLockedPool').abi }, quote: { abi: [...mock.abi] }, testUsdc: { abi: testUsdc.abi, bytecode: `0x${testUsdc.evm.bytecode.object}` } },
  };

  async function execute(action, body) {
    const signer = signerFor(body.account ?? '0');
    const owner = await signer.getAddress();
    const wait = async pending => { const tx = await pending; const receipt = await tx.wait(); return { tx, receipt }; };
    if (action === 'faucet') {
      const { tx } = await wait(quote.mint(owner, 1_000n * USDC));
      return { hash: tx.hash, message: 'Added 1,000 local test USDC.' };
    }
    if (action === 'launch') {
      const name = String(body.name ?? '').trim();
      const symbol = String(body.symbol ?? '').trim().toUpperCase();
      if (!name || name.length > 40 || !/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('Use a name up to 40 characters and a symbol of 1–10 letters or numbers.');
      const buy = amount(body.firstBuy);
      const seedQuote = amount(body.liquidity);
      const reward = body.reward || owner;
      if (!isAddress(reward) || reward === ZeroAddress) throw new Error('Enter a valid reward wallet.');
      const supply = await factory.TOKEN_SUPPLY();
      const net = buy - buy * 125n / 10000n;
      const out = supply * net / (seedQuote + net);
      await wait(quote.connect(signer).approve(await factory.getAddress(), await factory.LAUNCH_FEE() + seedQuote + buy));
      const { tx, receipt } = await wait(factory.connect(signer).launch(name, symbol, seedQuote, buy, out * 9950n / 10000n, reward));
      const event = receipt.logs.map(log => { try { return factory.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === 'Launched');
      const record = { address: event.args.token, curve: event.args.pool, pool: event.args.pool, liquidityLocked: true, initialLiquidity: formatUnits(seedQuote, 6), creator: owner, reward, name, symbol, created: Date.now(), hash: tx.hash };
      tokens.unshift(record);
      activity.unshift({ type: 'Launch', symbol, amount: formatUnits(buy, 6), account: owner, hash: tx.hash, time: Date.now() });
      return { hash: tx.hash, token: record.address, message: `${symbol} launched with permanently locked liquidity.` };
    }
    const record = tokenFor(body.token);
    const curve = new Contract(record.curve, artifact('ElpidaLockedPool').abi, signer);
    let result, display;
    if (action === 'withdraw') {
      result = await wait(curve.withdrawFees());
      display = 'Accrued fees sent to the protocol and creator wallets.';
    } else if (action === 'buy') {
      const gross = amount(body.amount);
      const [out] = await curve.quoteBuy(gross);
      const bps = slippage(body.slippage);
      await wait(quote.connect(signer).approve(record.curve, gross));
      result = await wait(curve.buy(gross, out * (10000n - bps) / 10000n));
      display = `Bought ${record.symbol}.`;
    } else if (action === 'sell') {
      const input = amount(body.amount, 18);
      const [out] = await curve.quoteSell(input);
      const bps = slippage(body.slippage);
      const token = new Contract(record.address, artifact('ElpidaToken').abi, signer);
      await wait(token.approve(record.curve, input));
      result = await wait(curve.sell(input, out * (10000n - bps) / 10000n));
      display = `Sold ${record.symbol}.`;
    } else throw new Error('Unknown action.');
    activity.unshift({ type: action === 'withdraw' ? 'Fees paid' : action === 'buy' ? 'Buy' : 'Sell', symbol: record.symbol, amount: body.amount ?? '', account: owner, hash: result.tx.hash, time: Date.now() });
    activity.splice(100);
    return { hash: result.tx.hash, message: display };
  }

  function slippage(value = '0.5') {
    const percent = Number(value);
    if (!Number.isFinite(percent) || percent < 0.1 || percent > 5) throw new Error('Slippage must be between 0.1% and 5%.');
    return BigInt(Math.round(percent * 100));
  }

  async function state(account = '0') {
    const owner = await signerFor(account).getAddress();
    const listings = await Promise.all(tokens.map(async record => {
      const curve = new Contract(record.curve, artifact('ElpidaLockedPool').abi, provider);
      const token = new Contract(record.address, artifact('ElpidaToken').abi, provider);
      const [reserve, sold, supply, balance, protocolFees, creatorFees, rewardBalance] = await Promise.all([curve.realReserve(), curve.sold(), token.totalSupply(), token.balanceOf(owner), curve.protocolFees(), curve.creatorFees(), quote.balanceOf(record.reward)]);
      return { ...record, reserve: formatUnits(reserve, 6), sold: formatUnits(sold, 18), supply: formatUnits(supply, 18), balance: formatUnits(balance, 18), protocolFees: formatUnits(protocolFees, 6), creatorFees: formatUnits(creatorFees, 6), rewardBalance: formatUnits(rewardBalance, 6) };
    }));
    return { wallet: owner, balance: formatUnits(await quote.balanceOf(owner), 6), tokens: listings, activity, treasuryBalance: formatUnits(await quote.balanceOf(addresses[2]), 6) };
  }

  async function getQuote(body) {
    const record = tokenFor(body.token);
    const curve = new Contract(record.curve, artifact('ElpidaLockedPool').abi, provider);
    if (body.side !== 'buy' && body.side !== 'sell') throw new Error('Choose buy or sell.');
    const input = amount(body.amount, body.side === 'buy' ? 6 : 18);
    const [out, fee] = body.side === 'buy' ? await curve.quoteBuy(input) : await curve.quoteSell(input);
    return { out: formatUnits(out, body.side === 'buy' ? 18 : 6), fee: formatUnits(fee, 6) };
  }

  if (seed) {
    for (const [name, symbol, firstBuy, account] of [['Orbit Club', 'ORBIT', '250', '0'], ['Pixel Party', 'PIXEL', '120', '1'], ['Lucky Sprout', 'LUCK', '75', '0']]) await execute('launch', { name, symbol, firstBuy, liquidity: '1000', account });
  }
  return {
    config, state, getQuote,
    transact(action, body) {
      const result = queue.then(() => execute(action, body));
      queue = result.catch(() => {});
      return result;
    },
    async close() { await queue; provider.destroy(); await connection.close(); },
  };
}
