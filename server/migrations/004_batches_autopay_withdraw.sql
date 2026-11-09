CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft','funded')),
  item_count INTEGER NOT NULL,
  amount_micro TEXT NOT NULL,
  fee_micro TEXT NOT NULL,
  expiry INTEGER NOT NULL,
  fund_tx TEXT,
  created_at INTEGER NOT NULL,
  funded_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_batches_user ON batches(user_id, created_at);
ALTER TABLE claims ADD COLUMN batch_id TEXT;
ALTER TABLE claims ADD COLUMN source TEXT NOT NULL DEFAULT 'app';
ALTER TABLE claims ADD COLUMN x_tweet_id TEXT;
CREATE INDEX IF NOT EXISTS idx_claims_batch ON claims(batch_id);
CREATE TABLE IF NOT EXISTS autopay (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  per_payment_micro TEXT NOT NULL,
  per_day_micro TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS x_mentions (
  tweet_id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  author_handle TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  claim_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS x_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reply_to TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  route TEXT NOT NULL CHECK (route IN ('public','private')),
  to_address TEXT NOT NULL,
  amount_micro TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  deposit_address TEXT,
  quote_json TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, created_at);
