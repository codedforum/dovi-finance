CREATE TABLE IF NOT EXISTS email_optouts (
  email TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  source TEXT
);
CREATE TABLE IF NOT EXISTS data_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  detail TEXT,
  admin_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS data_requests_user ON data_requests(user_id);
CREATE INDEX IF NOT EXISTS data_requests_status ON data_requests(status);
