'use strict';
const { normalizeProviderId, IdError } = require('./ids');

class IdentityTaken extends Error {
  constructor() { super('identity_taken'); this.name = 'IdentityTaken'; this.code = 'identity_taken'; }
}

function upsertUser(db, { cdpSub, displayName = null, now = Date.now() }) {
  const found = db.prepare('SELECT * FROM users WHERE cdp_sub = ?').get(cdpSub);
  if (found) return found;
  const r = db.prepare('INSERT INTO users (cdp_sub, display_name, created_at) VALUES (?, ?, ?)').run(cdpSub, displayName, now);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
}

function linkIdentity(db, { userId, kind, providerId, label = null, now = Date.now() }) {
  const pid = normalizeProviderId(kind, providerId);
  const existing = db.prepare('SELECT * FROM identities WHERE kind = ? AND provider_id = ?').get(kind, pid);
  if (existing) {
    if (existing.user_id !== userId) throw new IdentityTaken();
    if (label && label !== existing.label) db.prepare('UPDATE identities SET label = ? WHERE id = ?').run(label, existing.id);
    return db.prepare('SELECT * FROM identities WHERE id = ?').get(existing.id);
  }
  const r = db.prepare('INSERT INTO identities (user_id, kind, provider_id, label, verified_at) VALUES (?, ?, ?, ?, ?)').run(userId, kind, pid, label, now);
  return db.prepare('SELECT * FROM identities WHERE id = ?').get(Number(r.lastInsertRowid));
}

function findUserByIdentity(db, kind, providerId) {
  const pid = normalizeProviderId(kind, providerId);
  return db.prepare('SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id WHERE i.kind = ? AND i.provider_id = ?').get(kind, pid) || null;
}

function userIdentities(db, userId) {
  return db.prepare('SELECT kind, provider_id, label, verified_at FROM identities WHERE user_id = ? ORDER BY id').all(userId);
}

function userHasIdentity(db, userId, kind, providerId) {
  const pid = normalizeProviderId(kind, providerId);
  return !!db.prepare('SELECT 1 FROM identities WHERE user_id = ? AND kind = ? AND provider_id = ?').get(userId, kind, pid);
}

function userFromSessionIdentity(db, sessionIdentity, { label = null, now = Date.now() } = {}) {
  const s = String(sessionIdentity || '');
  const i = s.indexOf(':');
  if (i < 1) throw new IdError('bad_session_identity');
  const kind = s.slice(0, i);
  const rest = s.slice(i + 1);
  const user = upsertUser(db, { cdpSub: s, now });
  if (['email', 'google', 'x', 'telegram'].includes(kind)) linkIdentity(db, { userId: user.id, kind, providerId: rest, label, now });
  return user;
}

class AddressTaken extends Error {
  constructor() { super('That wallet address already belongs to another account.'); this.name = 'AddressTaken'; this.code = 'address_taken'; this.status = 409; }
}

function setAddress(db, userId, chain, address, now = Date.now()) {
  const other = db.prepare('SELECT user_id FROM addresses WHERE chain = ? AND lower(address) = lower(?) AND user_id <> ?').get(chain, address, userId);
  if (other) throw new AddressTaken();
  db.prepare('INSERT INTO addresses (user_id, chain, address, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, chain) DO UPDATE SET address = excluded.address, updated_at = excluded.updated_at').run(userId, chain, address, now);
}

function getAddress(db, userId, chain) {
  const r = db.prepare('SELECT address FROM addresses WHERE user_id = ? AND chain = ?').get(userId, chain);
  return r ? r.address : null;
}

module.exports = { AddressTaken, IdentityTaken, upsertUser, linkIdentity, findUserByIdentity, userIdentities, userHasIdentity, userFromSessionIdentity, setAddress, getAddress };
