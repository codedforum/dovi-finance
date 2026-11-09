ALTER TABLE claims ADD COLUMN short TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS claims_short_uq ON claims(short);
