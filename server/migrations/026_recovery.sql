CREATE TABLE IF NOT EXISTS recovery_requests (
  id TEXT PRIMARY KEY,
  target_user_id INTEGER NOT NULL REFERENCES users(id),
  requester_user_id INTEGER NOT NULL REFERENCES users(id),
  lost_kind TEXT NOT NULL,
  lost_provider_id TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','waiting','completed','cancelled','rejected')),
  revoke_lost INTEGER NOT NULL DEFAULT 1,
  cancel_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  ready_at INTEGER,
  closed_at INTEGER,
  closed_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_recovery_target ON recovery_requests(target_user_id, status);
CREATE INDEX IF NOT EXISTS idx_recovery_requester ON recovery_requests(requester_user_id, status);
