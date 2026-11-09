'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverTypedDataAddress } = require('viem');
const { makeCtx, user, ADDR } = require('./helpers');
const claims = require('../server/claims');
const { TYPES, domainFor } = require('../server/attester');
const { recipientHash } = require('../server/ids');

function world() {
  const ctx = makeCtx();
  const alice = user(ctx, 'email:alice@mail.com', [['email', 'alice@mail.com', 'alice@mail.com']]);
  const bob = user(ctx, 'x:555', [['x', '555', '@bob']]);
  return { ctx, alice, bob };
}
const draft = (w, over = {}) => claims.createDraft(w.ctx, { userId: w.alice.id, senderAddress: ADDR.alice, kind: 'x', providerId: '555', label: '@bob', amountMicro: 5000000n, ...over });

function fund(w, d) {
  const row = w.ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(d.claimId);
  w.ctx.chain.onchainCreate(d.claimId, { sender: ADDR.alice, amount: row.amount_micro, fee: row.fee_micro, expiry: row.expiry, recipientHash: row.recipient_hash });
}

test('draft math: fee is the 0.10 minimum at 1 and 5 USDC and 1 percent at 50 USDC, never above 1.5 percent', () => {
  const w = world();
  w.ctx.cfg.claim.perClaimCapMicro = 100000000n;
  w.ctx.cfg.claim.perUserDayCapMicro = 1000000000n;
  const d1 = draft(w, { amountMicro: 1000000n, idempotencyKey: 'a' });
  assert.equal(d1.feeMicro, '100000'); assert.equal(d1.totalMicro, '1100000');
  assert.equal(draft(w, { amountMicro: 5000000n, idempotencyKey: 'b' }).feeMicro, '100000');
  const d50 = draft(w, { amountMicro: 50000000n, idempotencyKey: 'c' });
  assert.equal(d50.feeMicro, '500000');
  assert.ok(BigInt(d50.feeMicro) * 10000n <= BigInt(d50.amountMicro) * 150n);
});

test('draft returns the two transactions, a preview with the visible fee line, and a link', () => {
  const w = world();
  const d = draft(w);
  assert.equal(d.status, 'draft');
  assert.equal(d.txs.length, 2);
  assert.equal(d.txs[0].to, w.ctx.cfg.base.usdc);
  assert.equal(d.txs[1].to, w.ctx.cfg.claim.contract);
  assert.deepEqual(d.preview.lines.map((l) => l.label), ['They receive', 'DOVI fee', 'You pay']);
  assert.equal(d.preview.lines[2].value, '$5.10');
  assert.match(d.link, /^https:\/\/dovi\.test\/c\/[2-9a-hj-km-np-zA-HJ-NP-Z]{8}$/);
  assert.ok(d.link.length < 40);
  const code = d.link.split('/c/')[1];
  assert.equal(claims.publicView(w.ctx, code).claimId, d.claimId);
  assert.equal(claims.publicView(w.ctx, d.claimId).claimId, d.claimId);
});

test('drafting twice with the same idempotency key returns the same claim', () => {
  const w = world();
  const a = draft(w, { idempotencyKey: 'k1' });
  const b = draft(w, { idempotencyKey: 'k1' });
  assert.equal(a.claimId, b.claimId);
  assert.equal(w.ctx.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 1);
});

test('refuses non-live chain, self send, bad amounts and over-cap with specific codes', () => {
  const w = world();
  w.ctx.registry.setStatus('base', 'off', 't');
  assert.throws(() => draft(w), (e) => e.code === 'chain_not_live');
  w.ctx.registry.setStatus('base', 'live', 't');
  assert.throws(() => draft(w, { kind: 'email', providerId: 'ALICE@mail.com' }), (e) => e.code === 'self_send');
  assert.throws(() => draft(w, { amountMicro: 0n }), (e) => e.code === 'bad_amount');
  assert.throws(() => draft(w, { amountMicro: 500000n }), (e) => e.code === 'below_minimum');
  assert.throws(() => draft(w, { amountMicro: 10000001n }), (e) => e.code === 'above_cap');
  assert.throws(() => draft(w, { amountMicro: 'abc' }), (e) => e.code === 'bad_amount');
});

test('confirmFunded accepts the matching on-chain claim and rejects a different amount', async () => {
  const w = world();
  const d = draft(w);
  await assert.rejects(claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0xabc' }), (e) => e.code === 'not_funded_yet');
  const row = w.ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(d.claimId);
  w.ctx.chain.onchainCreate(d.claimId, { sender: ADDR.alice, amount: 4000000n, fee: row.fee_micro, expiry: row.expiry, recipientHash: row.recipient_hash });
  await assert.rejects(claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0xabc' }), (e) => e.code === 'mismatch');
  fund(w, d);
  const ok = await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0xabc' });
  assert.equal(ok.status, 'funded');
  const again = await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0xabc' });
  assert.equal(again.status, 'funded');
  await assert.rejects(claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.bob.id, txHash: '0x' }), (e) => e.code === 'not_yours');
});

test('only the matching identity can get an attestation, and the attestation recovers to the attester', async () => {
  const w = world();
  const d = draft(w);
  fund(w, d);
  await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0x1' });
  const carol = user(w.ctx, 'x:777', [['x', '777', '@carol']]);
  await assert.rejects(claims.prepareClaim(w.ctx, { claimId: d.claimId, userId: carol.id, recipientAddress: ADDR.carol }), (e) => e.code === 'not_recipient');
  const out = await claims.prepareClaim(w.ctx, { claimId: d.claimId, userId: w.bob.id, recipientAddress: ADDR.bob });
  const signer = await recoverTypedDataAddress({ domain: domainFor(w.ctx.cfg), types: TYPES, primaryType: 'Attest', message: { id: d.claimId, recipient: out.recipient, deadline: BigInt(out.deadline) }, signature: out.attestation });
  assert.equal(signer, w.ctx.attester.address);
  assert.equal(out.deadline, Math.floor(w.ctx.now() / 1000) + 600);
  assert.equal(out.tx.to, w.ctx.cfg.claim.contract);
});

test('an X claim follows the immutable id: a new person holding the old handle cannot claim', async () => {
  const w = world();
  const d = draft(w, { kind: 'x', providerId: '555', label: '@oldname' });
  fund(w, d);
  await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0x1' });
  const squatter = user(w.ctx, 'x:999', [['x', '999', '@oldname']]);
  await assert.rejects(claims.prepareClaim(w.ctx, { claimId: d.claimId, userId: squatter.id, recipientAddress: ADDR.carol }), (e) => e.code === 'not_recipient');
  w.ctx.db.prepare("UPDATE identities SET label = '@newname' WHERE provider_id = '555'").run();
  const ok = await claims.prepareClaim(w.ctx, { claimId: d.claimId, userId: w.bob.id, recipientAddress: ADDR.bob });
  assert.ok(ok.attestation);
});

test('email claims are case and whitespace insensitive but a plus alias is a different mailbox', async () => {
  const w = world();
  assert.equal(recipientHash('email', ' Amara@Mail.com '), recipientHash('email', 'amara@mail.com'));
  assert.notEqual(recipientHash('email', 'amara+x@mail.com'), recipientHash('email', 'amara@mail.com'));
  const d = draft(w, { kind: 'email', providerId: 'Amara@Mail.com', label: 'amara@mail.com' });
  fund(w, d);
  await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0x1' });
  const lower = user(w.ctx, 'email:amara@mail.com', [['email', 'amara@mail.com', 'amara@mail.com']]);
  const plus = user(w.ctx, 'email:amara+x@mail.com', [['email', 'amara+x@mail.com', 'amara+x@mail.com']]);
  await assert.rejects(claims.prepareClaim(w.ctx, { claimId: d.claimId, userId: plus.id, recipientAddress: ADDR.carol }), (e) => e.code === 'not_recipient');
  assert.ok((await claims.prepareClaim(w.ctx, { claimId: d.claimId, userId: lower.id, recipientAddress: ADDR.carol })).attestation);
});

test('claim after expiry is refused at the expiry boundary and the sender can still reclaim', async () => {
  const w = world();
  const d = draft(w);
  fund(w, d);
  await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0x1' });
  const row = w.ctx.db.prepare('SELECT expiry FROM claims WHERE id = ?').get(d.claimId);
  w.ctx.clock.t = row.expiry * 1000;
  assert.ok(await claims.prepareClaim(w.ctx, { claimId: d.claimId, userId: w.bob.id, recipientAddress: ADDR.bob }));
  w.ctx.clock.t = row.expiry * 1000 + 1000;
  await assert.rejects(claims.prepareClaim(w.ctx, { claimId: d.claimId, userId: w.bob.id, recipientAddress: ADDR.bob }), (e) => e.code === 'expired');
  assert.equal(claims.publicView(w.ctx, d.claimId).status, 'expired');
  assert.ok(claims.prepareReclaim(w.ctx, { claimId: d.claimId, userId: w.alice.id }).tx);
  assert.throws(() => claims.prepareReclaim(w.ctx, { claimId: d.claimId, userId: w.bob.id }), (e) => e.code === 'not_yours');
});

test('completed claim records activity and notifies both sides, and cannot be claimed twice', async () => {
  const w = world();
  const d = draft(w);
  fund(w, d);
  await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0x1' });
  w.ctx.chain.onchainClaim(d.claimId);
  await assert.rejects(claims.confirmClaimed(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0xbad' }), (e) => e.code === 'not_recipient');
  assert.equal(w.ctx.db.prepare('SELECT status FROM claims WHERE id = ?').get(d.claimId).status, 'funded');
  const done = await claims.confirmClaimed(w.ctx, { claimId: d.claimId, userId: w.bob.id, txHash: '0x2' });
  assert.equal(done.status, 'claimed');
  const again = await claims.confirmClaimed(w.ctx, { claimId: d.claimId, userId: w.bob.id, txHash: '0x2' });
  assert.equal(again.status, 'claimed');
  assert.equal(w.ctx.db.prepare('SELECT COUNT(*) AS n FROM activity').get().n, 3);
  const types = w.ctx.events.map((e) => e.type);
  assert.ok(types.includes('claim_completed') && types.includes('payment_received'));
  await assert.rejects(claims.prepareClaim(w.ctx, { claimId: d.claimId, userId: w.bob.id, recipientAddress: ADDR.bob }), (e) => e.code === 'not_claimable');
});

test('reclaim returns the payment and the notification says no fee was charged', async () => {
  const w = world();
  const d = draft(w);
  fund(w, d);
  await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0x1' });
  await assert.rejects(claims.confirmReclaimed(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0x3' }), (e) => e.code === 'not_returned_yet');
  w.ctx.chain.onchainReclaim(d.claimId);
  const r = await claims.confirmReclaimed(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0x3' });
  assert.equal(r.status, 'returned');
  assert.match(w.ctx.events.at(-1).body, /No fee was charged/);
});

test('public view hides the sender address and the recipient hash', async () => {
  const w = world();
  const d = draft(w);
  const v = claims.publicView(w.ctx, d.claimId);
  assert.deepEqual(Object.keys(v).sort(), ['amountMicro', 'autoReleaseAt', 'autoReleaseRule', 'awaitingRelease', 'claimId', 'claimedAt', 'expiry', 'from', 'kind', 'lockUntil', 'note', 'returnedAt', 'sentAt', 'status', 'to']);
  assert.throws(() => claims.publicView(w.ctx, '0x' + '12'.repeat(32)), (e) => e.code === 'claim_not_found');
  assert.throws(() => claims.publicView(w.ctx, 'nonsense'), (e) => e.code === 'claim_not_found');
});

test('sweep warns once before expiry and marks old claims expired', async () => {
  const w = world();
  const d = draft(w);
  fund(w, d);
  await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0x1' });
  const row = w.ctx.db.prepare('SELECT expiry FROM claims WHERE id = ?').get(d.claimId);
  w.ctx.clock.t = (row.expiry - 3600) * 1000;
  assert.equal(claims.sweep(w.ctx).expiring, 1);
  assert.equal(claims.sweep(w.ctx).expiring, 0);
  w.ctx.clock.t = (row.expiry + 10) * 1000;
  assert.equal(claims.sweep(w.ctx).expired, 1);
});

test('send then take back is fully recorded with times, and only the parties can read the detail', async () => {
  const w = world();
  const d = draft(w);
  fund(w, d);
  await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0xaa' });
  const kinds = () => w.ctx.db.prepare('SELECT kind FROM activity WHERE user_id = ? ORDER BY id').all(w.alice.id).map((r) => r.kind);
  assert.deepEqual(kinds(), ['claim_funded']);
  w.ctx.chain.onchainReclaim(d.claimId);
  await claims.confirmReclaimed(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0xbb' });
  assert.deepEqual(kinds(), ['claim_funded', 'claim_returned']);
  const det = claims.detailFor(w.ctx, d.claimId, w.alice.id);
  assert.equal(det.status, 'returned');
  assert.equal(det.role, 'sender');
  assert.ok(det.fundedAt > 0 && det.returnedAt >= det.fundedAt);
  assert.equal(det.chargedFeeMicro, '0');
  assert.deepEqual(det.txs, { send: '0xaa', claim: null, reclaim: '0xbb' });
  assert.equal(det.link, null);
  assert.throws(() => claims.detailFor(w.ctx, d.claimId, w.bob.id), (e) => e.code === 'claim_not_found');
  const pub = claims.publicView(w.ctx, d.claimId);
  assert.equal(pub.status, 'returned'); assert.equal(pub.returnedAt, det.returnedAt);
});

test('unfunded drafts count against the day cap so many drafts cannot be funded past it', () => {
  const w = world();
  w.ctx.cfg.claim.perUserDayCapMicro = 12000000n;
  draft(w, { amountMicro: 5000000n, idempotencyKey: 'a' });
  draft(w, { amountMicro: 5000000n, idempotencyKey: 'b' });
  assert.throws(() => draft(w, { amountMicro: 5000000n, idempotencyKey: 'c' }), (e) => e.code === 'day_cap');
});

test('a fee setting that differs from the contract stops new drafts until it matches', async () => {
  const drift = require('../server/drift');
  const w = world();
  const k = w.ctx.cfg.claim;
  w.ctx.chain.readConfig = async () => ({ feeBps: BigInt(k.feeBps) + 1n, minFee: BigInt(k.feeMinMicro), minAmount: BigInt(k.minAmountMicro), perClaimCap: BigInt(k.perClaimCapMicro) });
  assert.equal((await drift.check(w.ctx)).length, 1);
  assert.throws(() => draft(w), (e) => e.code === 'config_drift');
  w.ctx.chain.readConfig = async () => ({ feeBps: BigInt(k.feeBps), minFee: BigInt(k.feeMinMicro), minAmount: BigInt(k.minAmountMicro), perClaimCap: BigInt(k.perClaimCapMicro) });
  assert.equal((await drift.check(w.ctx)).length, 0);
  assert.ok(draft(w).claimId);
});

test('taking back a payment that does not exist on the current contract gives a clear message instead of a failed transaction', async () => {
  const w = world();
  const d = draft(w);
  await assert.rejects(claims.prepareReclaimChecked(w.ctx, { claimId: d.claimId, userId: w.alice.id }), (e) => e.code === 'legacy_claim' || e.code === 'not_open' || e.code === 'bad_state');
  fund(w, d);
  await claims.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0x1' });
  assert.ok((await claims.prepareReclaimChecked(w.ctx, { claimId: d.claimId, userId: w.alice.id })).tx);
});
