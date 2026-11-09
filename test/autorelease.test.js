'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, user, ADDR } = require('./helpers');
const claims = require('../server/claims');
const batch = require('../server/batch');
const auto = require('../server/autorelease');

function world() {
  const ctx = makeCtx();
  ctx.cfg.claim.lockEnabled = true; ctx.cfg.claim.perClaimCapMicro = 100000000n; ctx.cfg.claim.perUserDayCapMicro = 1000000000n;
  const alice = user(ctx, 'email:alice@mail.com', [['email', 'alice@mail.com', 'alice@mail.com']]);
  const bob = user(ctx, 'x:555', [['x', '555', '@bob']]);
  ctx.lookupDelayMs = 0;
  ctx.fetch = async (url) => { const h = String(url).split('/').pop().toLowerCase(); const ids = { bob: '555', kofi: '43' }; return ids[h] ? { status: 200, json: async () => ({ user: { id: ids[h], screen_name: h, protected: false } }) } : { status: 404, json: async () => ({}) }; };
  return { ctx, alice, bob };
}
const NOW = (w) => Math.floor(w.ctx.now() / 1000);
async function fundedClaim(w, extra) {
  const d = claims.createDraft(w.ctx, { userId: w.alice.id, senderAddress: ADDR.alice, kind: 'x', providerId: '555', label: '@bob', amountMicro: 5000000n, ...extra });
  const row = w.ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(d.claimId);
  w.ctx.chain.onchainCreate(d.claimId, { sender: ADDR.alice, amount: row.amount_micro, fee: row.fee_micro, expiry: row.expiry, recipientHash: row.recipient_hash, lock: d.lockUntil || 0 });
  await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id });
  return d.claimId;
}

test('a time rule needs a sensible moment, turns on approve-first, and is shown on the claim page', async () => {
  const w = world();
  const bad = (at) => assert.throws(() => claims.createDraft(w.ctx, { userId: w.alice.id, senderAddress: ADDR.alice, kind: 'x', providerId: '555', label: '@bob', amountMicro: 5000000n, autoRelease: { mode: 'time', at } }), (e) => e.code === 'bad_release_time');
  bad(NOW(w)); bad(NOW(w) + 60); bad(NOW(w) + 9 * 86400); bad('abc');
  const at = NOW(w) + 3600;
  const id = await fundedClaim(w, { autoRelease: { mode: 'time', at } });
  const row = w.ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
  assert.equal(row.needs_release, 1); assert.equal(row.release_rule, 'time'); assert.equal(row.release_at, at);
  const pv = claims.publicView(w.ctx, id); assert.equal(pv.awaitingRelease, true); assert.equal(pv.autoReleaseAt, at);
});

test('releaseDue approves a timed payout when its time comes, once, and tells the sender', async () => {
  const w = world();
  const id = await fundedClaim(w, { autoRelease: { mode: 'time', at: NOW(w) + 3600 } });
  assert.deepEqual((await auto.releaseDue(w.ctx)).processed, []);
  w.ctx.clock.t += 3601 * 1000;
  const r = await auto.releaseDue(w.ctx); assert.deepEqual(r.processed.map((x) => x.status), ['released']);
  assert.ok(w.ctx.db.prepare('SELECT released_at FROM claims WHERE id = ?').get(id).released_at);
  assert.equal(claims.publicView(w.ctx, id).awaitingRelease, false);
  assert.ok(w.ctx.events.some((e) => e.userId === w.alice.id && /Released to @bob/.test(e.title)));
  assert.deepEqual((await auto.releaseDue(w.ctx)).processed, []);
});

test('a frozen sender holds the release, and cancelling returns the payment to manual approval', async () => {
  const w = world();
  const id = await fundedClaim(w, { autoRelease: { mode: 'time', at: NOW(w) + 3600 } });
  w.ctx.clock.t += 3601 * 1000;
  w.ctx.db.prepare('UPDATE users SET frozen_at = ? WHERE id = ?').run(1, w.alice.id);
  assert.equal((await auto.releaseDue(w.ctx)).processed[0].status, 'held_frozen');
  w.ctx.db.prepare('UPDATE users SET frozen_at = NULL WHERE id = ?').run(w.alice.id);
  assert.throws(() => auto.cancelAuto(w.ctx, { claimId: id, userId: w.bob.id }), (e) => e.code === 'claim_not_found');
  const v = auto.cancelAuto(w.ctx, { claimId: id, userId: w.alice.id });
  assert.equal(v.releaseRule, null); assert.equal(v.needsRelease, true);
  assert.deepEqual((await auto.releaseDue(w.ctx)).processed, []);
  assert.equal(w.ctx.db.prepare('SELECT released_at FROM claims WHERE id = ?').get(id).released_at, null);
});

test('a post rule releases only when the recipient wrote the post and it is old enough, and holds with a note otherwise', async () => {
  const w = world();
  const id = await fundedClaim(w, { autoRelease: { mode: 'post', hours: 24 }, postId: '9001' });
  const nowS = () => NOW(w);
  let answer = { status: 'ok', authorId: '555', createdSec: nowS() - 3600 };
  w.ctx.postChecker = { calls: 0, async check() { this.calls++; if (answer === 'boom') throw new Error('x'); return answer; } };
  assert.deepEqual((await auto.releaseDue(w.ctx)).processed, []);
  assert.equal(w.ctx.postChecker.calls, 1);
  w.ctx.clock.t += 60000; assert.deepEqual((await auto.releaseDue(w.ctx)).processed, []);
  assert.equal(w.ctx.postChecker.calls, 1);
  w.ctx.clock.t += 56 * 60000; answer = { status: 'ok', authorId: '777', createdSec: nowS() - 99999 };
  assert.equal((await auto.releaseDue(w.ctx)).processed[0].status, 'wrong_author');
  w.ctx.clock.t += 56 * 60000; answer = { status: 'missing' };
  assert.equal((await auto.releaseDue(w.ctx)).processed[0].status, 'post_missing');
  const before = w.ctx.events.length; w.ctx.clock.t += 56 * 60000;
  await auto.releaseDue(w.ctx); assert.equal(w.ctx.events.length, before);
  w.ctx.clock.t += 56 * 60000; answer = 'boom'; assert.equal((await auto.releaseDue(w.ctx)).processed[0].status, 'check_failed');
  w.ctx.clock.t += 56 * 60000; answer = { status: 'ok', authorId: '555', createdSec: nowS() - 24 * 3600 + 5 };
  assert.deepEqual((await auto.releaseDue(w.ctx)).processed, []);
  w.ctx.clock.t += 56 * 60000;
  assert.equal((await auto.releaseDue(w.ctx)).processed[0].status, 'released');
  assert.ok(w.ctx.db.prepare('SELECT released_at FROM claims WHERE id = ?').get(id).released_at);
});

test('a post rule needs the post link on every batch line, and a batch can release on a time', async () => {
  const w = world();
  await assert.rejects(() => batch.draftBatch(w.ctx, { userId: w.alice.id, senderAddress: ADDR.alice, items: [{ to: '@bob', amount: '5' }], autoRelease: { mode: 'post', hours: 24 } }), (e) => e.code === 'invalid_lines' && /post/.test(e.details[0].message));
  const b = await batch.draftBatch(w.ctx, { userId: w.alice.id, senderAddress: ADDR.alice, items: [{ to: '@bob', amount: '5', post: 'https://x.com/bob/status/123456789' }, { to: '@kofi', amount: '3', post: '987654321' }], autoRelease: { mode: 'post', hours: 12 } });
  assert.equal(b.payOnDelivery, true); assert.equal(b.releaseMode, 'post'); assert.deepEqual(b.items.map((i) => i.postId), ['123456789', '987654321']); assert.ok(b.items.every((i) => i.postHours === 12 && i.needsRelease));
  const t = await batch.draftBatch(w.ctx, { userId: w.alice.id, senderAddress: ADDR.alice, items: [{ to: '@bob', amount: '5' }], autoRelease: { mode: 'time', at: NOW(w) + 7200 } });
  assert.equal(t.releaseMode, 'time'); assert.ok(t.items[0].releaseAt);
  await assert.rejects(() => batch.draftBatch(w.ctx, { userId: w.alice.id, senderAddress: ADDR.alice, items: [{ to: '@bob', amount: '5' }], autoRelease: { mode: 'time', at: 5 } }), (e) => e.code === 'bad_release_time');
});

test('the post checker reads a post and tells a missing one apart', async () => {
  const f = async (url) => (String(url).endsWith('/404') ? { status: 404 } : String(url).endsWith('/500') ? { status: 500 } : { status: 200, json: async () => ({ tweet: { id: '1', author: { id: '555' }, created_timestamp: 1790000000 } }) });
  const c = auto.makePostChecker({}, f);
  assert.deepEqual(await c.check('100'), { status: 'ok', authorId: '555', createdSec: 1790000000 });
  assert.deepEqual(await c.check('404'), { status: 'missing' });
  await assert.rejects(() => c.check('500'));
});
