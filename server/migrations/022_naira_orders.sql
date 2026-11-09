CREATE TABLE IF NOT EXISTS naira_orders (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  rail TEXT NOT NULL,
  status TEXT NOT NULL,
  ngn_kobo TEXT NOT NULL,
  usdc_micro TEXT NOT NULL,
  rate_milli TEXT NOT NULL,
  fee_bps INTEGER NOT NULL,
  pay_json TEXT,
  bank_json TEXT,
  deposit_address TEXT,
  tx_hash TEXT UNIQUE,
  provider_ref TEXT,
  detail TEXT,
  payout_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_naira_orders_user ON naira_orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_naira_orders_open ON naira_orders(status, updated_at);
