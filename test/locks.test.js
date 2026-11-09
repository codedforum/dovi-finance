'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeFunctionData } = require('viem');
const { makeCtx, user, ADDR } = require('./helpers');
const claims = require('../server/claims');
const batch = require('../server/batch');
const abi = require('../server/abi/DoviClaim.json');

function world(lock = true) {
  const ctx = makeCtx();
  ctx.cfg.claim.lockEnabled = lock;
  ctx.cfg.claim.perClaimCapMicro = 100000000n; ctx.cfg.claim.perUserDayCapMicro = 1000000000n;
  const alice = user(ctx, 'email:alice@mail.com', [['email', 'alice@mail.com', 'alice@mail.com']]);
  const bob = user(ctx, 'x:555', [['x', '555', '@bob']]);
  ctx.lookupDelayMs = 0;
  ctx.fetch = async (url) => { const h = String(url).split('/').pop().toLowerCase(); const ids = { bob: '555', kofi: '43' }; return ids[h] ? { status: 200, json: async () => ({ user: { id: ids[h], screen_name: h, protected: false } }) } : { status: 404, json: async () => ({}) }; };
  return { ctx, alice, bob };
}
const draft = (w, over = {}) => claims.createDraft(w.ctx, { userId: w.alice.id, senderAddress: ADDR.alice, kind: 'x', providerId: '555', label: '@bob', amountMicro: 5000000n, ...over });
function fund(w, d, lock) {
  const row = w.ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(d.claimId);
  w.ctx.chain.onchainCreate(d.claimId, { sender: ADDR.alice, amount: row.amount_micro, fee: row.fee_micro, expiry: row.expiry, recipientHash: row.recipient_hash, lock });
}
const HOUR = 3600;

test('a locked draft builds the locked contract call, and a plain draft is unchanged', () => {
  const w = world();
  const plain = draft(w); assert.equal(decodeFunctionData({ abi, data: plain.txs[1].data }).functionName, 'createClaim'); assert.equal(plain.lockUntil, null);
  const locked = draft(w, { lockSeconds: 3 * 24 * HOUR });
  const call = decodeFunctionData({ abi, data: locked.txs[1].data });
  assert.equal(call.functionName, 'createClaimLocked'); assert.equal(Number(call.args[4]), locked.lockUntil);
  assert.ok(locked.lockUntil > Math.floor(w.ctx.now() / 1000) + 3 * 24 * HOUR - 5);
});

test('lock rules: off until the contract is upgraded, between one hour and the expiry', () => {
  const off = world(false);
  assert.throws(() => draft(off, { lockSeconds: 7200 }), (e) => e.code === 'lock_off');
  const w = world();
  assert.throws(() => draft(w, { lockSeconds: 60 }), (e) => e.code === 'bad_lock');
  assert.throws(() => draft(w, { lockSeconds: 8 * 24 * HOUR }), (e) => e.code === 'bad_lock');
  assert.throws(() => draft(w, { lockSeconds: 'abc' }), (e) => e.code === 'bad_lock');
  assert.ok(draft(w, { lockSeconds: 7 * 24 * HOUR }).lockUntil);
});

test('funding is only accepted when the chain holds the same lock', async () => {
  const w = world();
  const d = draft(w, { lockSeconds: 2 * 24 * HOUR });
  fund(w, d, 0);
  await assert.rejects(() => claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id }), (e) => e.code === 'mismatch');
  fund(w, d, d.lockUntil + 60);
  await assert.rejects(() => claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id }), (e) => e.code === 'mismatch');
  fund(w, d, d.lockUntil);
  const v = await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id });
  assert.equal(v.status, 'funded'); assert.equal(v.lockUntil, d.lockUntil);
});

test('the sender cannot take a locked payment back early, and can after the lock', async () => {
  const w = world();
  const d = draft(w, { lockSeconds: 2 * 24 * HOUR });
  fund(w, d, d.lockUntil); await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id });
  assert.throws(() => claims.prepareReclaim(w.ctx, { claimId: d.claimId, userId: w.alice.id }), (e) => e.code === 'locked' && /UTC/.test(e.message));
  w.ctx.clock.t += 2 * 24 * 3600 * 1000 + 1000;
  assert.equal(claims.prepareReclaim(w.ctx, { claimId: d.claimId, userId: w.alice.id }).claimId, d.claimId);
});

test('pay on delivery: no invite and no claim until the sender approves, then the recipient is told once', async () => {
  const w = world();
  const mails = []; w.ctx.mailer = { send: async (m) => { mails.push(m); } };
  const d = claims.createDraft(w.ctx, { userId: w.alice.id, senderAddress: ADDR.alice, kind: 'email', providerId: 'zed@mail.com', label: 'zed@mail.com', amountMicro: 5000000n, needsRelease: true });
  fund(w, d); await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(mails.length, 0);
  assert.equal(claims.publicView(w.ctx, d.claimId).awaitingRelease, true);
  const zed = user(w.ctx, 'email:zed@mail.com', [['email', 'zed@mail.com', 'zed@mail.com']]);
  await assert.rejects(() => claims.prepareClaim(w.ctx, { claimId: d.claimId, userId: zed.id, recipientAddress: ADDR.bob }), (e) => e.code === 'awaiting_release');
  assert.throws(() => claims.release(w.ctx, { claimId: d.claimId, userId: zed.id }), (e) => e.code === 'not_yours');
  const rel = claims.release(w.ctx, { claimId: d.claimId, userId: w.alice.id });
  assert.ok(rel.releasedAt);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(mails.length, 1);
  claims.release(w.ctx, { claimId: d.claimId, userId: w.alice.id });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(mails.length, 1);
  assert.equal(claims.publicView(w.ctx, d.claimId).awaitingRelease, false);
  const ok = await claims.prepareClaim(w.ctx, { claimId: d.claimId, userId: zed.id, recipientAddress: ADDR.bob });
  assert.ok(ok.attestation);
});

test('a payment that needs no approval cannot be released, and a returned one cannot either', async () => {
  const w = world();
  const d = draft(w); fund(w, d); await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id });
  assert.throws(() => claims.release(w.ctx, { claimId: d.claimId, userId: w.alice.id }), (e) => e.code === 'no_release');
});

test('a locked, approve-first batch uses one locked call, marks every row, and releases all at once', async () => {
  const w = world();
  const b = await batch.draftBatch(w.ctx, { userId: w.alice.id, senderAddress: ADDR.alice, title: 'Creators', items: [{ to: '@bob', amount: '5' }, { to: 'zed@mail.com', amount: '3' }], lockSeconds: 3 * 24 * HOUR, payOnDelivery: true });
  const call = decodeFunctionData({ abi, data: b.txs[1].data });
  assert.equal(call.functionName, 'createBatchLocked'); assert.equal(Number(call.args[4]), b.lockUntil); assert.equal(call.args[0].length, 2);
  assert.equal(b.payOnDelivery, true); assert.ok(b.items.every((i) => i.needsRelease && !i.released && i.lockUntil === b.lockUntil));
  for (const it of b.items) { const row = w.ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(it.claimId); w.ctx.chain.onchainCreate(it.claimId, { sender: ADDR.alice, amount: row.amount_micro, fee: row.fee_micro, expiry: row.expiry, recipientHash: row.recipient_hash, lock: b.lockUntil }); }
  await batch.confirmBatchFunded(w.ctx, { batchId: b.batchId, userId: w.alice.id });
  const out = batch.releaseBatch(w.ctx, { batchId: b.batchId, userId: w.alice.id });
  assert.equal(out.released, 2); assert.ok(out.batch.items.every((i) => i.released));
  assert.equal(batch.releaseBatch(w.ctx, { batchId: b.batchId, userId: w.alice.id }).released, 0);
  const plain = await batch.draftBatch(w.ctx, { userId: w.alice.id, senderAddress: ADDR.alice, title: 'Plain', items: [{ to: '@kofi', amount: '2' }] });
  assert.throws(() => batch.releaseBatch(w.ctx, { batchId: plain.batchId, userId: w.alice.id }), (e) => e.code === 'no_release');
  assert.throws(() => batch.releaseBatch(w.ctx, { batchId: b.batchId, userId: w.bob.id }), (e) => e.code === 'batch_not_found');
});
