CREATE TABLE IF NOT EXISTS token_claims (
  id TEXT PRIMARY KEY,
  sender_user_id INTEGER NOT NULL REFERENCES users(id),
  sender_address TEXT NOT NULL,
  recipient_kind TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  recipient_provider_id TEXT NOT NULL,
  recipient_label TEXT NOT NULL,
  symbol TEXT NOT NULL,
  token TEXT NOT NULL,
  amount_units TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','funded','claimed','returned')),
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_token_claims_idem ON token_claims(sender_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_token_claims_recipient ON token_claims(recipient_hash, status);
CREATE INDEX IF NOT EXISTS idx_token_claims_sender ON token_claims(sender_user_id, status);
