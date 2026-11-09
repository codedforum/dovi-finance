'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { loadConfig } = require('../server/config');
const { checkLimits, recordSpend } = require('../server/limits');

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (cdp_sub, created_at) VALUES ('a', 1), ('b', 1)").run();
  return { db, cfg: loadConfig({}) };
}
const day1 = Date.UTC(2026, 9, 18, 12);
const day2 = Date.UTC(2026, 9, 19, 12);

test('rejects zero, bad, below minimum and above the per claim cap with specific reasons', () => {
  const { db, cfg } = setup();
  const r = (a) => checkLimits(db, cfg, { userId: 1, amountMicro: a, now: day1 });
  assert.equal(r(0n).reason, 'bad_amount');
  assert.equal(r('abc').reason, 'bad_amount');
  assert.equal(r(-5n).reason, 'bad_amount');
  assert.equal(r(999999n).reason, 'below_minimum');
  assert.equal(r(10000001n).reason, 'above_cap');
  assert.equal(r(10000000n).ok, true);
  assert.equal(r(1000000n).ok, true);
});

test('per user day cap counts earlier spend the same UTC day and resets the next day', () => {
  const { db, cfg } = setup();
  for (let i = 0; i < 4; i++) recordSpend(db, 1, 10000000n, day1);
  const same = checkLimits(db, cfg, { userId: 1, amountMicro: 10000000n, now: day1 });
  assert.equal(same.ok, true);
  recordSpend(db, 1, 10000000n, day1);
  const over = checkLimits(db, cfg, { userId: 1, amountMicro: 1000000n, now: day1 });
  assert.equal(over.reason, 'day_cap');
  assert.equal(checkLimits(db, cfg, { userId: 1, amountMicro: 10000000n, now: day2 }).ok, true);
  assert.equal(checkLimits(db, cfg, { userId: 2, amountMicro: 10000000n, now: day1 }).ok, true);
});

test('global cap counts funded claims including their fee', () => {
  const { db, cfg } = setup();
  const c = { ...cfg, claim: { ...cfg.claim, globalCapMicro: 25000000n } };
  const ins = (id, st) => db.prepare("INSERT INTO claims (id, sender_user_id, sender_address, recipient_kind, recipient_hash, recipient_provider_id, recipient_label, amount_micro, fee_micro, status, expiry, created_at, updated_at) VALUES (?, 1, '0x', 'x', '0xh', '1', '@a', '10000000', '100000', ?, 9, 1, 1)").run(id, st);
  ins('0x01', 'funded'); ins('0x02', 'funded'); ins('0x03', 'claimed');
  assert.equal(checkLimits(db, c, { userId: 2, amountMicro: 4000000n, now: day1 }).ok, true);
  assert.equal(checkLimits(db, c, { userId: 2, amountMicro: 5000000n, now: day1 }).reason, 'global_cap');
});
