ALTER TABLE users ADD COLUMN sessions_valid_from INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN invited_by INTEGER;
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS user_sessions_user ON user_sessions(user_id);
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id INTEGER PRIMARY KEY,
  money INTEGER NOT NULL DEFAULT 1,
  claims INTEGER NOT NULL DEFAULT 1,
  quiet_on INTEGER NOT NULL DEFAULT 0,
  quiet_start INTEGER NOT NULL DEFAULT 1320,
  quiet_end INTEGER NOT NULL DEFAULT 420,
  tz_offset INTEGER NOT NULL DEFAULT 0
);
