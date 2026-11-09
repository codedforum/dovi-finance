ALTER TABLE claims ADD COLUMN funded_at INTEGER;
ALTER TABLE claims ADD COLUMN claimed_at INTEGER;
ALTER TABLE claims ADD COLUMN returned_at INTEGER;
ALTER TABLE claims ADD COLUMN expired_at INTEGER;
UPDATE claims SET funded_at = created_at WHERE status IN ('funded','claimed','returned','expired');
UPDATE claims SET claimed_at = updated_at WHERE status = 'claimed';
UPDATE claims SET returned_at = updated_at WHERE status = 'returned';
UPDATE claims SET expired_at = updated_at WHERE status = 'expired';
