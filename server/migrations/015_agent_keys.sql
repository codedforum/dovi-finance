CREATE TABLE IF NOT EXISTS agent_keys (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  per_payment_micro TEXT NOT NULL,
  per_day_micro TEXT NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_keys_user ON agent_keys(user_id);
ALTER TABLE claims ADD COLUMN agent_key_id TEXT;
CREATE INDEX IF NOT EXISTS claims_agent_key ON claims(agent_key_id);
