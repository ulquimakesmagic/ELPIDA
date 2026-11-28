import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Contract, Wallet, formatEther, keccak256, parseEther, zeroPadValue, toBeHex } from 'ethers';
import { RotatingRpcProvider } from './rotating-provider.mjs';

export const ELYSIUM_ORACLE = Object.freeze({
  source: '0x2b25BC41D55de29F3A2e163F8Eebf63966B25b57',
  publisher: '0x84B5af2d2fa874833838Ad0BF7bAEaDA075A129A',
  inbox: '0xce59f8B65ad41C9DAE4c07A0571a39824bD92cff',
  receiver: '0x29f0D2A8F2DD5B2dF872222f10bE35D6B27aFD71',
  alias: '0x95C6aF2D2FA874833838Ad0Bf7bAEADa075a23aB',
  deployedAt: 52425703,
  maxAge: 86400,
});
const day = ELYSIUM_ORACLE.maxAge * 1000;
const pollInterval = 5 * 60_000;
const deliveryGrace = 15 * 60_000;
const parentPublicRpc = 'https://hyperliquid-rpc.publicnode.com';
const feedAbi = ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)', 'function decimals() view returns (uint8)'];
const gasPad = gas => (gas * 125n + 99n) / 100n;
const larger = (a, b) => a > b ? a : b;
const smaller = (a, b) => a < b ? a : b;
const fault = code => Object.assign(new Error(code), { relayCode: code });

class RelayRpcProvider extends RotatingRpcProvider {
  _getConnection() {
    const request = super._getConnection();
    request.timeout = 12_000;
    request.setThrottleParams({ maxAttempts: 1 });
    return request;
  }
}

function boundedProvider(env, rpcUrl, chainId, key) {
  const name = `ELPIDA_RPC_${chainId}`;
  const urls = (env[name] ?? '').split(',').map(value => value.trim()).filter(value => value.startsWith('https://'));
  const rpcEnv = { [name]: [...new Set([...urls, rpcUrl])].join(','), ALCHEMY_API_KEYS: env.ALCHEMY_API_KEYS };
  return new RelayRpcProvider({ chainId, key, rpcUrl }, rpcEnv, chainId, { batchMaxCount: 1 });
}

export async function relayHistoryLogs(parent, history, filter) {
  try { return await parent.getLogs(filter); }
  catch (error) {
    const rpc = error.info?.error ?? error.error;
    if (!/block[\s-]+range/i.test(rpc?.message ?? error.shortMessage ?? '')) throw error;
    return history.getLogs(filter);
  }
}

export function createElysiumOracleReader(env = process.env) {
  const cfg = ELYSIUM_ORACLE;
  const parent = boundedProvider(env, parentPublicRpc, 999, 'hyperevm-mainnet');
  const history = boundedProvider({}, parentPublicRpc, 999, 'hyperevm-mainnet');
  const child = boundedProvider(env, 'https://elysium-rpc.publicnode.com', 99901, 'elysium-mainnet');
  const source = new Contract(cfg.source, feedAbi, parent);
  const publisher = new Contract(cfg.publisher, [
    'function source() view returns (address)', 'function inbox() view returns (address)', 'function receiver() view returns (address)',
    'function relay(uint256,uint256,uint256) payable returns (uint256)',
    'event RoundQueued(uint80 indexed roundId, uint256 indexed ticketId, uint256 updatedAt)',
  ], parent);
  const receiver = new Contract(cfg.receiver, [...feedAbi, 'error InvalidRound()',
    'function parentPublisher() view returns (address)', 'function aliasedPublisher() view returns (address)',
    'function receiveRound((uint80,int256,uint256,uint256,uint80))',
  ], child);
  const inbox = new Contract(cfg.inbox, ['function paused() view returns (bool)',
    'function calculateRetryableSubmissionFee(uint256,uint256) view returns (uint256)'], parent);
  const node = new Contract('0x00000000000000000000000000000000000000C8', [
    'function estimateRetryableTicket(address,uint256,address,uint256,address,address,bytes)',
  ], child);

  async function read() {
    const [head, childHead, parentNet, childNet] = await Promise.all([
      parent.getBlock('latest'), child.getBlock('latest'), parent.getNetwork(), child.getNetwork(),
    ]);
    if (!head || !childHead || parentNet.chainId !== 999n || childNet.chainId !== 99901n) throw fault('wrong_chain');
    const [round, delivered, liveSource, liveInbox, liveReceiver, livePublisher, liveAlias, sourceDecimals, childDecimals] = await Promise.all([
      source.latestRoundData({ blockTag: head.number }),
      receiver.latestRoundData({ blockTag: childHead.number }).catch(error => {
        if (error.revert?.name === 'InvalidRound') return null;
        throw error;
      }),
      publisher.source(), publisher.inbox(), publisher.receiver(), receiver.parentPublisher(), receiver.aliasedPublisher(),
      source.decimals(), receiver.decimals(),
    ]);
    if (liveSource !== cfg.source || liveInbox !== cfg.inbox || liveReceiver !== cfg.receiver || livePublisher !== cfg.publisher ||
        liveAlias !== cfg.alias || sourceDecimals !== 18n || childDecimals !== 18n) throw fault('oracle_configuration');
    return { head, childHead, round, delivered };
  }

  // A queue for the same round cannot predate the oracle's own observation time.
  async function queued({ head, round }) {
    const filter = { address: cfg.publisher, topics: [publisher.interface.getEvent('RoundQueued').topicHash, zeroPadValue(toBeHex(round[0]), 32)] };
    for (let end = head.number; end >= cfg.deployedAt;) {
      const fromBlock = Math.max(cfg.deployedAt, end - 4999);
      const logs = await relayHistoryLogs(parent, history, { ...filter, fromBlock, toBlock: end });
      if (logs.length) return publisher.interface.parseLog(logs.at(-1)).args.ticketId.toString();
      const first = await parent.getBlock(fromBlock);
      if (!first) throw fault('queue_history_unavailable');
      if (BigInt(first.timestamp) < round[3]) break;
      end = fromBlock - 1;
    }
    return null;
  }

  async function quote({ head, childHead, round }, address) {
    if (head.baseFeePerGas === null || childHead.baseFeePerGas === null || await inbox.paused()) throw fault('bridge_unavailable');
    const calldata = receiver.interface.encodeFunctionData('receiveRound', [Array.from(round)]);
    const [ticketGas, directGas, submission, childFee, parentFee, balance, nonce, pendingNonce] = await Promise.all([
      node.estimateRetryableTicket.estimateGas(cfg.publisher, parseEther('1'), cfg.receiver, 0n, address, address, calldata),
      child.estimateGas({ from: cfg.alias, to: cfg.receiver, data: calldata }),
      inbox.calculateRetryableSubmissionFee((calldata.length - 2) / 2, head.baseFeePerGas),
      child.getFeeData(), parent.getFeeData(), parent.getBalance(address),
      parent.getTransactionCount(address, 'latest'), parent.getTransactionCount(address, 'pending'),
    ]);
    if (nonce !== pendingNonce) throw fault('wallet_transaction_pending');
    if (childFee.gasPrice === null || parentFee.maxFeePerGas === null || parentFee.maxPriorityFeePerGas === null) throw fault('fee_quote_unavailable');
    const childGas = gasPad(larger(ticketGas, directGas));
    const childMaxFee = 2n * larger(childFee.gasPrice, childHead.baseFeePerGas);
    const maxSubmission = submission * 2n;
    const value = maxSubmission + childGas * childMaxFee;
    if (balance < value) throw fault('gas_balance_low');
    const args = [maxSubmission, childGas, childMaxFee];
    const call = [...args, { from: address, value }];
    const [estimatedGas] = await Promise.all([publisher.relay.estimateGas(...call), publisher.relay.staticCall(...call)]);
    const transaction = { type: 2, chainId: 999, to: cfg.publisher, data: publisher.interface.encodeFunctionData('relay', args),
      nonce, value, gasLimit: gasPad(estimatedGas), maxFeePerGas: parentFee.maxFeePerGas, maxPriorityFeePerGas: parentFee.maxPriorityFeePerGas };
    return { transaction, balance, baseFee: head.baseFeePerGas };
  }

  return { read, queued, quote, broadcast: raw => parent.broadcastTransaction(raw),
    receipt: hash => parent.getTransactionReceipt(hash), close() { parent.destroy(); child.destroy(); history.destroy(); } };
}

function validRound(round, timestamp) {
  return round && round[0] > 0n && round[1] > 0n && round[2] > 0n && round[2] <= round[3] && round[4] >= round[0] &&
    round[3] <= BigInt(timestamp) && BigInt(timestamp) - round[3] <= BigInt(ELYSIUM_ORACLE.maxAge);
}

function openLedger(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS attempts (round TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, maximum TEXT NOT NULL,
      submitted INTEGER NOT NULL, status TEXT NOT NULL);`);
  return db;
}

function remainingBudget(db, daily, now) {
  const spent = db.prepare('SELECT maximum FROM attempts WHERE submitted > ? OR status = ?').all(now - day, 'pending');
  return daily - spent.reduce((sum, row) => sum + BigInt(row.maximum), 0n);
}

function reserve(db, round, hash, maximum, daily, now) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM attempts WHERE round = ? OR status = ? LIMIT 1').get(round, 'pending')) throw fault('submission_in_progress');
    if (maximum > remainingBudget(db, daily, now)) throw fault('daily_limit_reached');
    db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?)').run(round, hash, String(maximum), now, 'pending');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function readLimits(env) {
  try {
    const perTx = parseEther(env.ELPIDA_ELYSIUM_RELAY_TX_CAP_HYPE ?? '0');
    const daily = parseEther(env.ELPIDA_ELYSIUM_RELAY_24H_CAP_HYPE ?? '0');
    if (perTx > 0n && daily >= perTx) return { perTx, daily };
  } catch { /* Invalid limits keep publishing off. */ }
  return null;
}

export function createElysiumRelay({ env = {}, enabled = false, durable = false, ledgerPath, reader, now = Date.now, log = console.log } = {}) {
  if (!enabled) return { status: () => ({ mode: 'off' }), start() {}, async close() {} };
  const mode = env.ELPIDA_ELYSIUM_RELAY_MODE ?? 'monitor';
  const chain = reader ?? createElysiumOracleReader(env);
  const limits = readLimits(env);
  let wallet, db, configurationIssue;
  if (mode === 'publish') {
    if (!limits || !durable || !ledgerPath) configurationIssue = 'publishing_limits_or_storage_missing';
    else {
      try { wallet = new Wallet(env.ELPIDA_ELYSIUM_RELAY_KEY ?? ''); }
      catch { configurationIssue = 'relay_wallet_missing'; }
      if (wallet) {
        try { db = openLedger(ledgerPath); }
        catch { configurationIssue = 'relay_ledger_unavailable'; }
      }
    }
  } else if (mode !== 'monitor') configurationIssue = 'relay_mode_invalid';

  let status = { mode, state: 'checking', configurationIssue, wallet: wallet?.address };
  let timer, active;
  const logEvent = (event, fields) => log(JSON.stringify({ event, network: 'elysium-mainnet', ...fields }));

  async function reconcile() {
    if (!db) return null;
    const pending = db.prepare('SELECT round, hash, submitted FROM attempts WHERE status = ?').get('pending');
    if (!pending) return null;
    const receipt = await chain.receipt(pending.hash);
    if (!receipt || await receipt.confirmations() < 2) return pending;
    const result = receipt.status === 1 ? 'confirmed' : 'reverted';
    db.prepare('UPDATE attempts SET status = ? WHERE hash = ?').run(result, pending.hash);
    logEvent('elysium_relay_receipt', { ...pending, result });
    return null;
  }

  async function run() {
    const snapshot = await chain.read();
    const { head, childHead, round, delivered } = snapshot;
    const time = now();
    if ([head, childHead].some(block => Math.abs(time - block.timestamp * 1000) > pollInterval)) throw fault('chain_head_stale');
    const pending = await reconcile();
    const deliveredFresh = validRound(delivered, childHead.timestamp);
    const sourceValid = validRound(round, head.timestamp) && validRound(round, childHead.timestamp);
    const roundId = String(round[0]), deliveredRound = delivered ? String(delivered[0]) : null;
    const expiresAt = deliveredFresh ? Number(delivered[3]) + ELYSIUM_ORACLE.maxAge : null;
    const secondsLeft = expiresAt === null ? 0 : expiresAt - childHead.timestamp;
    const sameRound = deliveredFresh && delivered[0] === round[0];
    const observationsChanged = status.sourceRound !== roundId || status.deliveredRound !== deliveredRound;
    status = { mode, configurationIssue, checkedAt: time, wallet: wallet?.address, sourceRound: roundId, deliveredRound, expiresAt, secondsLeft,
      state: deliveredFresh ? (sameRound ? 'current' : 'awaiting_delivery') : 'stale_or_missing',
      pendingHash: pending?.hash, pendingSince: pending?.submitted,
      delaySeconds: Math.max(0, childHead.timestamp - Number(round[3])) };
    if (sameRound && !Array.from(round).every((value, i) => value === delivered[i])) throw fault('round_mismatch');
    if (deliveredFresh && delivered[0] > round[0]) throw fault('source_behind_receiver');
    if (!sourceValid) throw fault('source_round_invalid');
    if (observationsChanged) logEvent('elysium_relay_checked', { mode, sourceRound: roundId, deliveredRound, expiresAt });
    if (pending || sameRound || !db) return;

    const attempted = db.prepare('SELECT status FROM attempts WHERE round = ?').get(roundId);
    if (attempted?.status === 'reverted') throw fault('parent_transaction_reverted');
    if (attempted) return;
    const ticket = await chain.queued(snapshot);
    if (ticket) { status.ticket = ticket; return; }
    const { transaction, balance, baseFee } = await chain.quote(snapshot, wallet.address);
    const journalLimit = remainingBudget(db, limits.daily, now());
    const limit = smaller(limits.perTx, journalLimit);
    const available = smaller(limit, balance);
    if (transaction.value + transaction.gasLimit * baseFee > available) {
      if (balance < transaction.value + transaction.gasLimit * baseFee) throw fault('gas_balance_low');
      throw fault(journalLimit < limits.perTx ? 'daily_limit_reached' : 'transaction_limit_exceeded');
    }
    transaction.maxFeePerGas = smaller(transaction.maxFeePerGas, (available - transaction.value) / transaction.gasLimit);
    if (transaction.maxFeePerGas < baseFee) throw fault('fee_quote_unavailable');
    transaction.maxPriorityFeePerGas = smaller(transaction.maxPriorityFeePerGas, transaction.maxFeePerGas - baseFee);
    const maximum = transaction.value + transaction.gasLimit * transaction.maxFeePerGas;
    const signed = await wallet.signTransaction(transaction);
    const hash = keccak256(signed);
    reserve(db, roundId, hash, maximum, limits.daily, now());
    Object.assign(status, { pendingHash: hash, pendingSince: now() });
    try { await chain.broadcast(signed); }
    catch { throw fault('broadcast_unconfirmed'); }
    logEvent('elysium_relay_submitted', { round: roundId, hash, maximumHype: formatEther(maximum) });
  }

  function tick() {
    if (active) return active;
    active = run().catch(error => {
      status = { ...status, error: error.relayCode ?? 'rpc_or_ledger_unavailable' };
    }).finally(() => { active = null; });
    return active;
  }

  return { tick, status: () => ({ ...status }), start() {
    void tick();
    timer = setInterval(tick, pollInterval);
    timer.unref?.();
  }, async close() { clearInterval(timer); await active; db?.close(); chain.close?.(); } };
}

export function elysiumRelayIncident(relay, now) {
  if (!relay || relay.mode === 'off') return null;
  if (relay.configurationIssue) return 'Elysium price relay publishing has a configuration issue.';
  if (relay.pendingSince != null && now - relay.pendingSince > deliveryGrace) return 'An Elysium price relay submission is unresolved. Check its transaction before retrying.';
  if (relay.error || !relay.checkedAt || now - relay.checkedAt > 2 * pollInterval) return 'Elysium price relay reports an error or has missed its latest checks.';
  if (relay.state === 'stale_or_missing') return 'The Elysium HYPE/USD price has expired or is missing.';
  if (relay.secondsLeft <= 7200) return 'The Elysium HYPE/USD price expires within two hours.';
  if (relay.state === 'awaiting_delivery' && relay.delaySeconds > deliveryGrace / 1000) return 'The latest HyperEVM HYPE/USD round has not reached Elysium.';
  return null;
}
