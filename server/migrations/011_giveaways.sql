CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  tweet_id TEXT NOT NULL,
  command_tweet_id TEXT,
  winners INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  reqs TEXT NOT NULL,
  prize_micro TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  created_at INTEGER NOT NULL,
  drawn_at INTEGER
);
CREATE INDEX IF NOT EXISTS giveaways_user ON giveaways(user_id);
CREATE INDEX IF NOT EXISTS giveaways_due ON giveaways(status, ends_at);
CREATE TABLE IF NOT EXISTS giveaway_pool (
  giveaway_id INTEGER NOT NULL,
  x_id TEXT NOT NULL,
  handle TEXT,
  PRIMARY KEY (giveaway_id, x_id)
);
