'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { loadConfig } = require('../server/config');
const controls = require('../server/controls');
const { checkLimits } = require('../server/limits');

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (cdp_sub, created_at, display_name) VALUES ('a', 1, 'ada'), ('b', 1, 'bo')").run();
  let t = 1000;
  return { db, cfg: loadConfig({}), ctx: { db, now: () => t, tick: (n) => { t += n; } } };
}

test('hold and release set the flag, keep a reason and are audited', () => {
  const { db, ctx } = setup();
  controls.setHold(ctx, { userId: 1, on: true, reason: 'chargeback review', actor: 'admin:9' });
  const u = db.prepare('SELECT admin_frozen_at, admin_frozen_reason, frozen_at FROM users WHERE id = 1').get();
  assert.ok(u.admin_frozen_at); assert.equal(u.admin_frozen_reason, 'chargeback review'); assert.equal(u.frozen_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE action = 'admin.hold'").get().n, 1);
  controls.setHold(ctx, { userId: 1, on: false, actor: 'admin:9' });
  assert.equal(db.prepare('SELECT admin_frozen_at FROM users WHERE id = 1').get().admin_frozen_at, null);
  assert.throws(() => controls.setHold(ctx, { userId: 99, on: true, actor: 'a' }), (e) => e.code === 'no_user');
});

test('per-account limits override the global caps for that account only, and clear back', () => {
  const { db, cfg, ctx } = setup();
  const chk = (id, a) => checkLimits(db, cfg, { userId: id, amountMicro: a, now: 5000 });
  assert.equal(chk(1, 10000000n).ok, true);
  controls.setLimits(ctx, { userId: 1, perClaimMicro: '2000000', perDayMicro: '3000000', actor: 'admin:9' });
  assert.equal(chk(1, 2000001n).reason, 'above_cap');
  assert.equal(chk(1, 2000000n).ok, true);
  assert.equal(chk(2, 10000000n).ok, true);
  controls.setLimits(ctx, { userId: 1, perClaimMicro: '9000000', perDayMicro: '1500000', actor: 'admin:9' });
  assert.equal(chk(1, 2000000n).reason, 'day_cap');
  controls.setLimits(ctx, { userId: 1, perClaimMicro: null, perDayMicro: null, actor: 'admin:9' });
  assert.equal(chk(1, 10000000n).ok, true);
  assert.throws(() => controls.setLimits(ctx, { userId: 1, perClaimMicro: 'abc', actor: 'a' }), (e) => e.code === 'bad_limit');
});

test('the notice cleans its text, expires and clears', () => {
  const { ctx } = setup();
  assert.equal(controls.getBanner(ctx), null);
  const r = controls.setBanner(ctx, { text: 'Back soon — <b>maintenance</b>', tone: 'warn', hours: 1, actor: 'admin:9' });
  assert.equal(r.banner.text.includes('<'), false); assert.equal(r.banner.text.includes('—'), false);
  assert.deepEqual(controls.getBanner(ctx), { text: r.banner.text, tone: 'warn' });
  ctx.tick(2 * 3600000);
  assert.equal(controls.getBanner(ctx), null);
  controls.setBanner(ctx, { text: 'Hello', actor: 'a' });
  assert.equal(controls.getBanner(ctx).tone, 'info');
  controls.setBanner(ctx, { text: '  ', actor: 'a' });
  assert.equal(controls.getBanner(ctx), null);
});

test('the user list shows holds and limits and can be searched', () => {
  const { ctx } = setup();
  controls.setHold(ctx, { userId: 2, on: true, actor: 'a' });
  controls.setLimits(ctx, { userId: 2, perClaimMicro: '1000000', actor: 'a' });
  const all = controls.listUsers(ctx);
  assert.equal(all.length, 2);
  const bo = controls.listUsers(ctx, { q: 'bo' });
  assert.equal(bo.length, 1); assert.equal(bo[0].held, true); assert.equal(bo[0].perClaimMicro, '1000000');
});
