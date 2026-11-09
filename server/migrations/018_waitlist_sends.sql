CREATE TABLE IF NOT EXISTS waitlist_sends (
  campaign TEXT NOT NULL,
  waitlist_id INTEGER NOT NULL REFERENCES waitlist(id),
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (campaign, waitlist_id)
);
