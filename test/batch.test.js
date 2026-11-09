'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeFunctionData } = require('viem');
const { makeCtx, user, ADDR } = require('./helpers');
const batch = require('../server/batch');
const abi = require('../server/abi/DoviClaim.json');

function world() {
  const ctx = makeCtx();
  ctx.cfg.claim.perClaimCapMicro = 20000000n;
  ctx.cfg.claim.perUserDayCapMicro = 100000000n;
  ctx.cfg.claim.globalCapMicro = 1000000000n;
  const alice = user(ctx, 'email:alice@mail.com', [['email', 'alice@mail.com', 'alice@mail.com']]);
  const other = user(ctx, 'email:eve@mail.com', [['email', 'eve@mail.com', 'eve@mail.com']]);
  return { ctx, alice, other };
}
const items = (...pairs) => pairs.map(([to, amount]) => ({ to, amount }));
const draft = (w, its, extra = {}) => batch.draftBatch(w.ctx, { userId: w.alice.id, senderAddress: ADDR.alice, title: 'Giveaway', items: its, ...extra });
function fundAll(w, d) {
  for (const it of d.items) {
    const row = w.ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(it.claimId);
    w.ctx.chain.onchainCreate(it.claimId, { sender: ADDR.alice, amount: row.amount_micro, fee: row.fee_micro, expiry: row.expiry, recipientHash: row.recipient_hash });
  }
}

test('draft builds one approve for the total and one createBatch call carrying every payment', async () => {
  const w = world();
  const d = await draft(w, items(['a@mail.com', '3'], ['b@mail.com', '5.50'], ['c@mail.com', '10']));
  assert.equal(d.count, 3);
  assert.equal(d.amountMicro, '18500000');
  assert.equal(d.feeMicro, String(100000 * 3));
  assert.equal(d.totalMicro, '18800000');
  assert.equal(d.txs.length, 2);
  assert.equal(d.txs[0].to, w.ctx.cfg.base.usdc);
  assert.equal(d.txs[1].to, w.ctx.cfg.claim.contract);
  const call = decodeFunctionData({ abi, data: d.txs[1].data });
  assert.equal(call.functionName, 'createBatch');
  assert.deepEqual(call.args[0], d.items.map((i) => i.claimId));
  assert.deepEqual(call.args[2], [3000000n, 5500000n, 10000000n]);
  assert.deepEqual(d.preview.lines.map((l) => l.label), ['Payments', 'They receive', 'DOVI fee', 'You pay']);
  assert.equal(d.preview.lines[3].value, '$18.80');
  for (const it of d.items) assert.match(it.link, /^https:\/\/dovi\.test\/c\/[2-9a-hj-km-np-zA-HJ-NP-Z]{8}$/);
  assert.equal(w.ctx.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE batch_id = ? AND status = 'draft' AND source = 'batch'").get(d.batchId).n, 3);
});

test('invalid lines are all reported together and nothing is saved', async () => {
  const w = world();
  await assert.rejects(draft(w, items(['a@mail.com', '3'], ['not a handle !!', '5'], ['b@mail.com', 'abc'], ['c@mail.com', '0.5'], ['a@mail.com', '4'], ['alice@mail.com', '2'])), (e) => {
    assert.equal(e.code, 'invalid_lines');
    assert.deepEqual(e.details.map((x) => x.line), [2, 3, 4, 5, 6]);
    assert.match(e.details.find((x) => x.line === 5).message, /Listed twice/);
    assert.match(e.details.find((x) => x.line === 6).message, /yourself/);
    return true;
  });
  assert.equal(w.ctx.db.prepare('SELECT COUNT(*) AS n FROM batches').get().n, 0);
  assert.equal(w.ctx.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 0);
});

test('size and cap rules: empty, too many, per payment cap, and the daily total', async () => {
  const w = world();
  await assert.rejects(draft(w, []), { code: 'empty' });
  await assert.rejects(draft(w, Array.from({ length: batch.MAX_ITEMS + 1 }, (_, i) => ({ to: 'u' + i + '@mail.com', amount: '1' }))), { code: 'too_many' });
  await assert.rejects(draft(w, items(['a@mail.com', '25'])), (e) => e.code === 'invalid_lines' && /limit per payment/.test(e.details[0].message));
  await assert.rejects(draft(w, Array.from({ length: 11 }, (_, i) => ({ to: 'u' + i + '@mail.com', amount: '10' }))), { code: 'day_cap' });
});

test('confirming funded marks every payment and the batch, records spend once per payment, and is repeatable', async () => {
  const w = world();
  const d = await draft(w, items(['a@mail.com', '3'], ['b@mail.com', '4']));
  await assert.rejects(batch.confirmBatchFunded(w.ctx, { batchId: d.batchId, userId: w.alice.id, txHash: '0x' + '11'.repeat(32) }), { code: 'not_funded_yet' });
  fundAll(w, d);
  const done = await batch.confirmBatchFunded(w.ctx, { batchId: d.batchId, userId: w.alice.id, txHash: '0x' + '22'.repeat(32) });
  assert.equal(done.status, 'funded');
  assert.deepEqual(done.counts, { funded: 2 });
  assert.equal(w.ctx.db.prepare("SELECT spent_micro FROM limits_usage WHERE user_id = ?").get(w.alice.id).spent_micro, '7000000');
  const again = await batch.confirmBatchFunded(w.ctx, { batchId: d.batchId, userId: w.alice.id });
  assert.equal(again.status, 'funded');
  assert.equal(batch.list(w.ctx, w.alice.id).length, 1);
});

test('half funded stays a draft batch and reports not funded yet', async () => {
  const w = world();
  const d = await draft(w, items(['a@mail.com', '3'], ['b@mail.com', '4']));
  const first = w.ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(d.items[0].claimId);
  w.ctx.chain.onchainCreate(first.id, { sender: ADDR.alice, amount: first.amount_micro, fee: first.fee_micro, expiry: first.expiry, recipientHash: first.recipient_hash });
  await assert.rejects(batch.confirmBatchFunded(w.ctx, { batchId: d.batchId, userId: w.alice.id }), { code: 'not_funded_yet' });
  assert.equal(w.ctx.db.prepare('SELECT status FROM batches WHERE id = ?').get(d.batchId).status, 'draft');
});

test('another user cannot read or confirm someone else batch', async () => {
  const w = world();
  const d = await draft(w, items(['a@mail.com', '3']));
  assert.throws(() => batch.detail(w.ctx, { batchId: d.batchId, userId: w.other.id }), { code: 'batch_not_found' });
  await assert.rejects(batch.confirmBatchFunded(w.ctx, { batchId: d.batchId, userId: w.other.id }), { code: 'batch_not_found' });
  assert.equal(batch.detail(w.ctx, { batchId: d.batchId, userId: w.alice.id }).items.length, 1);
});
