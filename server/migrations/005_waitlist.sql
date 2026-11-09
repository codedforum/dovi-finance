CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  x_id TEXT NOT NULL UNIQUE,
  x_handle TEXT,
  name TEXT,
  avatar_url TEXT,
  email TEXT,
  email_added_at INTEGER,
  ref_code TEXT NOT NULL UNIQUE,
  referred_by INTEGER REFERENCES waitlist(id),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS waitlist_referred_by ON waitlist(referred_by);
