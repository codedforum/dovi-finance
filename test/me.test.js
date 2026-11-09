'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, user } = require('./helpers');
const { summary } = require('../server/me');

test('the account summary adds up sends, claims, take backs, fees, received and today\'s limit', () => {
  const ctx = makeCtx();
  const a = user(ctx, 'email:a@x.co', []);
  const row = (id, status, amt, fee) => ctx.db.prepare('INSERT INTO claims (id, sender_user_id, sender_address, recipient_kind, recipient_hash, recipient_provider_id, recipient_label, amount_micro, fee_micro, chain, status, expiry, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, a.id, '0xabc', 'email', 'h' + id, 'p', 'p@x.co', String(amt), String(fee), 'base', status, 9999999999, 1, 1);
  row('c1', 'claimed', 5000000, 100000);
  row('c2', 'funded', 2000000, 100000);
  row('c3', 'returned', 3000000, 100000);
  row('c4', 'draft', 9000000, 100000);
  ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(a.id, 'receive', 'r', null, '4000000', 'done', 5);
  const s = summary(ctx, a);
  assert.deepEqual(s.stats.sent, { n: 3, micro: '10000000' });
  assert.deepEqual(s.stats.claimed, { n: 1, micro: '5000000' });
  assert.deepEqual(s.stats.waiting, { n: 1, micro: '2000000' });
  assert.deepEqual(s.stats.returned, { n: 1, micro: '3000000' });
  assert.deepEqual(s.stats.feesPaid, { n: 1, micro: '100000' });
  assert.deepEqual(s.stats.received, { n: 1, micro: '4000000' });
  assert.equal(s.limits.spentTodayMicro, '0');
  assert.equal(s.limits.perClaimMicro, ctx.cfg.claim.perClaimCapMicro.toString());
});
