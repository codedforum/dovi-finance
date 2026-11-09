'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx } = require('./helpers');
const { syncEvents } = require('../server/indexer');

test('the indexer shrinks its window to the RPC log range limit and still reaches the head', async () => {
  const ctx = makeCtx();
  const spans = [];
  ctx.chain = {
    blockNumber: async () => 1000n,
    getEvents: async (from, to) => {
      spans.push(Number(to - from) + 1);
      if (to - from + 1n > 200n) throw new Error('eth_getLogs is limited to a 200 range');
      return [];
    },
  };
  const r = await syncEvents(ctx, { startBlock: 0 });
  assert.equal(r.head, 995);
  assert.equal(ctx.db.prepare("SELECT v FROM kv WHERE k = 'idx:block'").get().v, '995');
  assert.equal(ctx.db.prepare("SELECT v FROM kv WHERE k = 'idx:step'").get().v, '200');
  assert.ok(spans[0] > 200 && spans.slice(1).every((x) => x <= 200));
});

test('an unrelated RPC error still surfaces', async () => {
  const ctx = makeCtx();
  ctx.chain = { blockNumber: async () => 10n, getEvents: async () => { throw new Error('boom'); } };
  await assert.rejects(syncEvents(ctx, { startBlock: 0 }), /boom/);
});

test('a claim paid on chain before the browser reports it is completed by the indexer, and a draft that is on chain is funded', async () => {
  const claims = require('../server/claims');
  const { ADDR, user } = require('./helpers');
  const ctx = makeCtx();
  const alice = user(ctx, 'email:alice@mail.com', [['email', 'alice@mail.com', 'alice@mail.com']]);
  const bob = user(ctx, 'x:555', [['x', '555', '@bob']]);
  let n = 100; ctx.chain.blockNumber = async () => (n += 20);
  const d = claims.createDraft(ctx, { userId: alice.id, senderAddress: ADDR.alice, kind: 'x', providerId: '555', label: '@bob', amountMicro: 5000000n });
  const row = ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(d.claimId);
  ctx.chain.onchainCreate(d.claimId, { sender: ADDR.alice, amount: row.amount_micro, fee: row.fee_micro, expiry: row.expiry, recipientHash: row.recipient_hash });
  ctx.chain.events = [{ name: 'ClaimCreated', args: { id: d.claimId, amount: BigInt(row.amount_micro), fee: BigInt(row.fee_micro) }, txHash: '0xa1', logIndex: 0 }];
  await syncEvents(ctx, { startBlock: 0 });
  assert.equal(ctx.db.prepare('SELECT status FROM claims WHERE id = ?').get(d.claimId).status, 'funded');
  ctx.chain.onchainClaim(d.claimId);
  ctx.chain.events = [{ name: 'ClaimClaimed', args: { id: d.claimId, amount: BigInt(row.amount_micro), fee: BigInt(row.fee_micro) }, txHash: '0xa2', logIndex: 0 }];
  await syncEvents(ctx, { startBlock: 0 });
  const done = ctx.db.prepare('SELECT status, claimed_by_user_id FROM claims WHERE id = ?').get(d.claimId);
  assert.equal(done.status, 'claimed');
  assert.equal(done.claimed_by_user_id, bob.id);
});
