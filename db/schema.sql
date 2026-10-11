-- Elpida V1 draft PostgreSQL schema. Ledger is illustrative, not a production accounting system.
CREATE TABLE chains (
  chain_key TEXT PRIMARY KEY,
  chain_kind TEXT NOT NULL CHECK (chain_kind IN ('solana', 'evm')),
  chain_id TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE users (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE wallets (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  chain_key TEXT NOT NULL REFERENCES chains(chain_key),
  address TEXT NOT NULL,
  UNIQUE(chain_key, address)
);
CREATE TABLE cash_ledger (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  chain_key TEXT NOT NULL REFERENCES chains(chain_key),
  asset_address TEXT NOT NULL,
  amount_atomic NUMERIC(78,0) NOT NULL,
  entry_type TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  operation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cash_ledger_user_idx ON cash_ledger(user_id, created_at);
CREATE TABLE tokens (
  id UUID PRIMARY KEY,
  chain_key TEXT NOT NULL REFERENCES chains(chain_key),
  token_address TEXT NOT NULL,
  curve_address TEXT,
  creator_wallet_id UUID REFERENCES wallets(id),
  launch_tx TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chain_key, token_address)
);
CREATE TABLE reward_allocations (
  id UUID PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES tokens(id),
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('wallet','identity','holder_pool')),
  recipient_ref TEXT NOT NULL,
  share_bps INTEGER NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  version INTEGER NOT NULL,
  finalized BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE holder_epochs (
  id UUID PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES tokens(id),
  min_holding_atomic NUMERIC(78,0) NOT NULL,
  reward_asset TEXT NOT NULL,
  threshold_atomic NUMERIC(78,0) NOT NULL,
  snapshot_root TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE distribution_batches (
  id UUID PRIMARY KEY,
  epoch_id UUID NOT NULL REFERENCES holder_epochs(id),
  batch_index INTEGER NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL,
  UNIQUE(epoch_id,batch_index)
);
