//! D7 escape hatch on the compiled program (build/elpida_launchpad.so) with LiteSVM, which can move
//! the clock: a completed curve that has not migrated reopens only after exactly 24 hours.
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData};
use elpida_launchpad::{CurvePool, GRADUATION_GRACE_SECS, STATUS_GRADUATED, STATUS_MIGRATED, STATUS_TRADING};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use anchor_lang::prelude::{AccountMeta, Pubkey};
use anchor_lang::solana_program::instruction::Instruction;

const PROGRAM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../build/elpida_launchpad.so");
const GRADUATED_AT: i64 = 1_800_000_000;

struct Env { svm: LiteSVM, payer: Keypair, pool: Pubkey }

fn pool_state(mint: Pubkey, bump: u8, status: u8) -> CurvePool {
    CurvePool {
        config: Pubkey::new_unique(), mint, creator: Pubkey::new_unique(), reward: Pubkey::new_unique(),
        name: [0; 32], symbol: [0; 10], virtual_quote: 5_555_555_556, virtual_token: 1_111_111_111_111_111,
        curve_supply: 759_746_926_647_958, real_quote: 12_008_000_000, sold: 759_746_926_647_958, liquidity_bonus: 77,
        protocol_fees: 5, creator_fees: 5, created_at: GRADUATED_AT - 3_600, graduated_at: GRADUATED_AT, status, bump,
    }
}

fn setup(status: u8) -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(elpida_launchpad::ID, PROGRAM).expect("build/elpida_launchpad.so");
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let mint = Pubkey::new_unique();
    let (pool, bump) = Pubkey::find_program_address(&[b"curve", mint.as_ref()], &elpida_launchpad::ID);
    let mut data = Vec::new();
    pool_state(mint, bump, status).try_serialize(&mut data).unwrap();
    data.resize(8 + <CurvePool as anchor_lang::Space>::INIT_SPACE, 0);
    svm.set_account(pool, Account { lamports: 10_000_000, data, owner: elpida_launchpad::ID, executable: false, rent_epoch: 0 }).unwrap();
    Env { svm, payer, pool }
}

fn at(env: &mut Env, unix: i64) {
    let mut clock: Clock = env.svm.get_sysvar();
    clock.unix_timestamp = unix;
    env.svm.set_sysvar(&clock);
    env.svm.expire_blockhash();
}

fn reopen(env: &mut Env, pool: Pubkey) -> Result<Vec<String>, (u32, Vec<String>)> {
    let ix = Instruction { program_id: elpida_launchpad::ID, accounts: vec![AccountMeta::new(pool, false)], data: elpida_launchpad::instruction::ReopenCurve {}.data() };
    let tx = Transaction::new(&[&env.payer], Message::new(&[ix], Some(&env.payer.pubkey())), env.svm.latest_blockhash());
    match env.svm.send_transaction(tx) {
        Ok(meta) => Ok(meta.logs),
        Err(failed) => {
            // e.g. InstructionError(0, Custom(6031)); anything else (owner or seed checks) maps to u32::MAX.
            let text = format!("{:?}", failed.err);
            let code = text.split("Custom(").nth(1).and_then(|r| r.split(')').next()).and_then(|n| n.parse().ok()).unwrap_or(u32::MAX);
            Err((code, failed.meta.logs))
        }
    }
}

fn status(env: &Env) -> CurvePool {
    let account = env.svm.get_account(&env.pool).unwrap();
    CurvePool::try_deserialize(&mut &account.data[..]).unwrap()
}

const NOT_COMPLETE: u32 = 6016;
const GRACE_NOT_OVER: u32 = 6031;

#[test]
fn reopens_exactly_24_hours_after_completion_and_keeps_reserves() {
    assert_eq!(GRADUATION_GRACE_SECS, 86_400);
    let mut env = setup(STATUS_GRADUATED);
    let pool = env.pool;
    for early in [GRADUATED_AT, GRADUATED_AT + 3_600, GRADUATED_AT + GRADUATION_GRACE_SECS - 1] {
        at(&mut env, early);
        assert_eq!(reopen(&mut env, pool).unwrap_err().0, GRACE_NOT_OVER, "too early at +{}", early - GRADUATED_AT);
        assert_eq!(status(&env).status, STATUS_GRADUATED);
    }
    at(&mut env, GRADUATED_AT + GRADUATION_GRACE_SECS);
    let logs = reopen(&mut env, pool).expect("reopen after 24 h");
    assert!(logs.iter().any(|l| l.starts_with("Program data: ")), "CurveReopened event emitted");
    let after = status(&env);
    let before = pool_state(after.mint, after.bump, STATUS_GRADUATED);
    assert_eq!(after.status, STATUS_TRADING);
    // Nothing but the status changes: reserves, the locked bonus, owed fees and timestamps stay.
    assert_eq!((after.real_quote, after.sold, after.liquidity_bonus, after.protocol_fees, after.creator_fees, after.graduated_at, after.created_at),
               (before.real_quote, before.sold, before.liquidity_bonus, before.protocol_fees, before.creator_fees, before.graduated_at, before.created_at));
    // A second reopen is refused: the curve is trading again.
    at(&mut env, GRADUATED_AT + GRADUATION_GRACE_SECS + 10);
    assert_eq!(reopen(&mut env, pool).unwrap_err().0, NOT_COMPLETE);
}

#[test]
fn trading_and_migrated_curves_cannot_be_reopened() {
    for state in [STATUS_TRADING, STATUS_MIGRATED] {
        let mut env = setup(state);
        let pool = env.pool;
        at(&mut env, GRADUATED_AT + 10 * GRADUATION_GRACE_SECS);
        assert_eq!(reopen(&mut env, pool).unwrap_err().0, NOT_COMPLETE, "status {state}");
        assert_eq!(status(&env).status, state);
    }
}

#[test]
fn reopen_rejects_accounts_that_are_not_an_elpida_curve() {
    let mut env = setup(STATUS_GRADUATED);
    at(&mut env, GRADUATED_AT + GRADUATION_GRACE_SECS);
    // Same bytes under a foreign owner, and a valid pool copied to an address that is not its PDA.
    let real = env.svm.get_account(&env.pool).unwrap();
    let foreign = Pubkey::new_unique();
    env.svm.set_account(foreign, Account { owner: Pubkey::new_unique(), ..real.clone() }).unwrap();
    assert!(reopen(&mut env, foreign).is_err());
    let misplaced = Pubkey::new_unique();
    env.svm.set_account(misplaced, real).unwrap();
    assert!(reopen(&mut env, misplaced).is_err(), "seeds must match the pool's mint");
    assert_eq!(status(&env).status, STATUS_GRADUATED);
}
