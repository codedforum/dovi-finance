CREATE TABLE x_dms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_x_id TEXT NOT NULL,
  claim_id TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE UNIQUE INDEX x_dms_claim ON x_dms(claim_id) WHERE claim_id IS NOT NULL;
