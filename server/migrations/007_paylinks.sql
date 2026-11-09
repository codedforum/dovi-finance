CREATE TABLE IF NOT EXISTS paylinks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  amount_micro TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS paylinks_user ON paylinks(user_id);
CREATE TABLE IF NOT EXISTS paylink_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paylink_id INTEGER NOT NULL REFERENCES paylinks(id),
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  amount_micro TEXT NOT NULL,
  payer_user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, ref)
);
CREATE INDEX IF NOT EXISTS paylink_payments_link ON paylink_payments(paylink_id);
