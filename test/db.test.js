'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { audit, recentAudit } = require('../server/audit');

test('migrations apply once and are idempotent', () => {
  const db = openDb(':memory:');
  const n1 = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get().n;
  assert.equal(n1, require('node:fs').readdirSync(require('node:path').join(__dirname, '..', 'server', 'migrations')).filter((f) => /^\d+_.*\.sql$/.test(f)).length);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['users', 'identities', 'claims', 'notifications', 'audit', 'chain_events', 'limits_usage', 'batches', 'autopay', 'x_mentions', 'x_outbox', 'x_dms', 'withdrawals']) assert.ok(tables.includes(t), t);
});

test('one identity can only belong to one user', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (cdp_sub, created_at) VALUES ('a', 1), ('b', 1)").run();
  db.prepare("INSERT INTO identities (user_id, kind, provider_id, verified_at) VALUES (1, 'x', '123', 1)").run();
  assert.throws(() => db.prepare("INSERT INTO identities (user_id, kind, provider_id, verified_at) VALUES (2, 'x', '123', 1)").run(), /UNIQUE/);
});

test('claim status is constrained and the idempotency key is unique per sender', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (cdp_sub, created_at) VALUES ('a', 1)").run();
  const ins = (id, st, key) => db.prepare("INSERT INTO claims (id, sender_user_id, sender_address, recipient_kind, recipient_hash, recipient_provider_id, recipient_label, amount_micro, fee_micro, status, expiry, idempotency_key, created_at, updated_at) VALUES (?, 1, '0xabc', 'x', '0xh', '1', '@a', '1000000', '100000', ?, 9, ?, 1, 1)").run(id, st, key);
  ins('0x01', 'draft', 'k1');
  assert.throws(() => ins('0x02', 'weird', 'k2'), /CHECK/);
  assert.throws(() => ins('0x03', 'draft', 'k1'), /UNIQUE/);
});

test('audit rows keep bigint data as strings and read back newest first', () => {
  const db = openDb(':memory:');
  audit(db, { actor: 'u:1', action: 'claim.create', subject: '0x01', data: { amount: 5000000n } });
  audit(db, { actor: 'admin', action: 'pause' });
  const rows = recentAudit(db, 5);
  assert.equal(rows[0].action, 'pause');
  assert.equal(JSON.parse(rows[1].data).amount, '5000000');
});
