ALTER TABLE users ADD COLUMN admin_frozen_at INTEGER;
ALTER TABLE users ADD COLUMN admin_frozen_reason TEXT;
CREATE TABLE IF NOT EXISTS user_limits (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  per_claim_micro TEXT,
  per_day_micro TEXT,
  updated_at INTEGER NOT NULL
);
