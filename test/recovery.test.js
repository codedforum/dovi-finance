'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, user } = require('./helpers');
const recovery = require('../server/recovery');
const { findUserByIdentity } = require('../server/identity');

function world(over = {}) {
  const ctx = makeCtx({ env: { DOVI_RECOVERY: '1', DOVI_RECOVERY_DELAY_HOURS: '72', ...over } });
  const sent = []; ctx.mailer = { send: async (m) => { sent.push(m); } }; ctx.sent = sent;
  const owner = user(ctx, 'x:111', [['x', '111', '@lostone'], ['email', 'owner@mail.com', 'owner@mail.com']]);
  const fresh = user(ctx, 'email:new@mail.com', [['email', 'new@mail.com', 'new@mail.com']]);
  return { ctx, owner, fresh };
}
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test('recovery is off unless switched on', () => {
  const w = world({ DOVI_RECOVERY: '0' });
  assert.equal(code(() => recovery.request(w.ctx, { requesterUserId: w.fresh.id, lost: '@lostone' })), 'off');
});

test('the request names the lost account by X handle or email, and refuses unknown or own accounts', () => {
  const w = world();
  assert.equal(code(() => recovery.request(w.ctx, { requesterUserId: w.fresh.id, lost: '@nobody' })), 'not_found');
  assert.equal(code(() => recovery.request(w.ctx, { requesterUserId: w.fresh.id, lost: 'not a handle!' })), 'bad_lost');
  assert.equal(code(() => recovery.request(w.ctx, { requesterUserId: w.fresh.id, lost: 'new@mail.com' })), 'same_account');
  const r = recovery.request(w.ctx, { requesterUserId: w.fresh.id, lost: 'owner@mail.com', note: 'lost my phone' });
  assert.equal(r.status, 'pending');
  assert.equal(code(() => recovery.request(w.ctx, { requesterUserId: w.fresh.id, lost: '@lostone' })), 'already_open');
});

test('the owner is told about the request by email and in the app', async () => {
  const w = world();
  recovery.request(w.ctx, { requesterUserId: w.fresh.id, lost: '@lostone' });
  await new Promise((r) => setImmediate(r));
  assert.equal(w.ctx.sent.length, 1); assert.equal(w.ctx.sent[0].to, 'owner@mail.com'); assert.match(w.ctx.sent[0].text, /rcancel=/);
  assert.equal(w.ctx.events.filter((e) => e.userId === w.owner.id || e.id === w.owner.id).length >= 0, true);
});

test('nothing moves before approval or before the wait is over, then the new login opens the same account', () => {
  const w = world();
  const r = recovery.request(w.ctx, { requesterUserId: w.fresh.id, lost: '@lostone' });
  assert.equal(code(() => recovery.complete(w.ctx, { id: r.id, requesterUserId: w.fresh.id })), 'bad_state');
  recovery.approve(w.ctx, { id: r.id, actor: 'admin:1' });
  assert.equal(code(() => recovery.complete(w.ctx, { id: r.id, requesterUserId: w.fresh.id })), 'too_early');
  assert.equal(code(() => recovery.complete(w.ctx, { id: r.id, requesterUserId: w.owner.id })), 'not_found');
  w.ctx.clock.t += 73 * 3600000;
  const done = recovery.complete(w.ctx, { id: r.id, requesterUserId: w.fresh.id });
  assert.equal(done.status, 'completed'); assert.equal(done.relogin, true);
  assert.equal(findUserByIdentity(w.ctx.db, 'email', 'new@mail.com').id, w.owner.id);
  assert.equal(findUserByIdentity(w.ctx.db, 'x', '111'), null);
  assert.equal(findUserByIdentity(w.ctx.db, 'email', 'owner@mail.com').id, w.owner.id);
  assert.ok(w.ctx.db.prepare('SELECT sessions_valid_from v FROM users WHERE id = ?').get(w.owner.id).v >= w.ctx.clock.t);
  assert.equal(recovery.complete(w.ctx, { id: r.id, requesterUserId: w.fresh.id }).status, 'completed');
});

test('the owner can cancel by the emailed link or in the app, and a cancelled request never completes', () => {
  const w = world();
  const r = recovery.request(w.ctx, { requesterUserId: w.fresh.id, lost: '@lostone' });
  assert.equal(code(() => recovery.cancelByToken(w.ctx, { token: 'wrong' })), 'not_found');
  assert.equal(recovery.incomingFor(w.ctx, w.owner.id).length, 1);
  assert.equal(code(() => recovery.cancelByOwner(w.ctx, { userId: w.fresh.id, id: r.id })), 'not_found');
  recovery.cancelByOwner(w.ctx, { userId: w.owner.id, id: r.id });
  assert.equal(code(() => recovery.approve(w.ctx, { id: r.id, actor: 'admin:1' })), 'bad_state');
  const r2 = recovery.request(w.ctx, { requesterUserId: w.fresh.id, lost: '@lostone' });
  recovery.approve(w.ctx, { id: r2.id, actor: 'admin:1' });
  w.ctx.clock.t += 73 * 3600000;
  recovery.cancelByOwner(w.ctx, { userId: w.owner.id, id: r2.id });
  assert.equal(code(() => recovery.complete(w.ctx, { id: r2.id, requesterUserId: w.fresh.id })), 'bad_state');
  assert.equal(findUserByIdentity(w.ctx.db, 'x', '111').id, w.owner.id);
});

test('an account that already has activity is not merged automatically, and rejected requests close', () => {
  const w = world();
  const r = recovery.request(w.ctx, { requesterUserId: w.fresh.id, lost: '@lostone' });
  recovery.approve(w.ctx, { id: r.id, actor: 'admin:1', revokeLost: false });
  w.ctx.db.prepare("INSERT INTO naira_orders (id, user_id, side, rail, status, ngn_kobo, usdc_micro, rate_milli, fee_bps, created_at, updated_at) VALUES ('n1', ?, 'buy', 'sim', 'completed', '100000', '1000000', '1500000', 100, 1, 1)").run(w.fresh.id);
  w.ctx.clock.t += 73 * 3600000;
  assert.equal(code(() => recovery.complete(w.ctx, { id: r.id, requesterUserId: w.fresh.id })), 'not_empty');
  assert.equal(recovery.reject(w.ctx, { id: r.id, actor: 'admin:1', reason: 'could not verify' }).status, 'rejected');
  assert.equal(recovery.adminList(w.ctx)[0].status, 'rejected');
});

test('keeping the old login (revokeLost off) leaves it attached', () => {
  const w = world();
  const r = recovery.request(w.ctx, { requesterUserId: w.fresh.id, lost: '@lostone' });
  recovery.approve(w.ctx, { id: r.id, actor: 'admin:1', revokeLost: false });
  w.ctx.clock.t += 73 * 3600000;
  recovery.complete(w.ctx, { id: r.id, requesterUserId: w.fresh.id });
  assert.equal(findUserByIdentity(w.ctx.db, 'x', '111').id, w.owner.id);
});
