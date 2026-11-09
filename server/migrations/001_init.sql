CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cdp_sub TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('email','google','x','telegram')),
  provider_id TEXT NOT NULL,
  label TEXT,
  verified_at INTEGER NOT NULL,
  UNIQUE (kind, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);
CREATE TABLE IF NOT EXISTS addresses (
  user_id INTEGER NOT NULL REFERENCES users(id),
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, chain)
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  sender_user_id INTEGER NOT NULL REFERENCES users(id),
  sender_address TEXT NOT NULL,
  recipient_kind TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  recipient_provider_id TEXT NOT NULL,
  recipient_label TEXT NOT NULL,
  amount_micro TEXT NOT NULL,
  fee_micro TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'base',
  status TEXT NOT NULL CHECK (status IN ('draft','funded','claimed','returned','expired')),
  expiry INTEGER NOT NULL,
  idempotency_key TEXT,
  fund_tx TEXT,
  claim_tx TEXT,
  reclaim_tx TEXT,
  claimed_by_user_id INTEGER REFERENCES users(id),
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_idem ON claims(sender_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_recipient ON claims(recipient_hash, status);
CREATE INDEX IF NOT EXISTS idx_claims_sender ON claims(sender_user_id, status);
CREATE TABLE IF NOT EXISTS chain_events (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  amount_micro TEXT,
  fee_micro TEXT,
  block_time INTEGER,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  source TEXT NOT NULL,
  raw TEXT NOT NULL,
  typed TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('previewed','approved','rejected','done')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  private_title TEXT NOT NULL,
  amount_micro TEXT,
  action_label TEXT,
  action_href TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  ref TEXT,
  counterparty TEXT,
  amount_micro TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id, id);
CREATE TABLE IF NOT EXISTS limits_usage (
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  spent_micro TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  to_kind TEXT NOT NULL,
  to_provider_id TEXT NOT NULL,
  to_label TEXT NOT NULL,
  amount_micro TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  subject TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chain_status (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT,
  data TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
