'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeFunctionData } = require('viem');
const { makeCtx, user, ADDR } = require('./helpers');
const tokens = require('../server/tokens');
const abi4 = require('../server/abi/DoviClaimV4.json');
const VIBES = '0x2222222222222222222222222222222222222222';

function world() {
  const ctx = makeCtx();
  ctx.cfg.tokens = [{ symbol: 'VIBES', name: 'Vibes', address: VIBES, decimals: 18, minUnits: 10n ** 18n, perClaimUnits: 1000n * 10n ** 18n, test: true }];
  const alice = user(ctx, 'email:alice@mail.com', [['email', 'alice@mail.com', 'alice@mail.com']]);
  const bob = user(ctx, 'x:555', [['x', '555', '@bob']]);
  return { ctx, alice, bob };
}
const draft = (w, over = {}) => tokens.createDraft(w.ctx, { userId: w.alice.id, senderAddress: ADDR.alice, symbol: 'VIBES', amount: '5', kind: 'x', providerId: '555', label: '@bob', ...over });
function fund(w, d) {
  const row = w.ctx.db.prepare('SELECT * FROM token_claims WHERE id = ?').get(d.claimId);
  w.ctx.chain.onchainTokenCreate(d.claimId, { sender: ADDR.alice, token: VIBES, amount: row.amount_units, expiry: row.expiry, recipientHash: row.recipient_hash });
}

test('options list only configured tokens and stay off without any', () => {
  const w = world();
  const o = tokens.options(w.ctx);
  assert.equal(o.enabled, true); assert.equal(o.tokens[0].symbol, 'VIBES'); assert.equal(o.tokens[0].decimals, 18);
  w.ctx.cfg.tokens = [];
  assert.equal(tokens.options(w.ctx).enabled, false);
  assert.throws(() => draft(w), (e) => e.code === 'token_off');
});

test('a draft carries the token amount in its own units, no fee, and approve plus create transactions', () => {
  const w = world();
  const d = draft(w, { amount: '5.5' });
  assert.equal(d.amountUnits, '5500000000000000000'); assert.equal(d.amountText, '5.5 VIBES'); assert.equal(d.status, 'draft');
  assert.equal(d.txs.length, 2); assert.equal(d.txs[0].to, VIBES);
  const call = decodeFunctionData({ abi: abi4, data: d.txs[1].data });
  assert.equal(call.functionName, 'createTokenClaim');
  assert.equal(call.args[0].toLowerCase(), VIBES); assert.equal(call.args[3], 5500000000000000000n);
});

test('amount limits, self sends and bad input are refused', () => {
  const w = world();
  assert.equal(assertCode(() => draft(w, { amount: '0.5' })), 'below_minimum');
  assert.equal(assertCode(() => draft(w, { amount: '1001' })), 'above_cap');
  assert.equal(assertCode(() => draft(w, { amount: 'abc' })), 'bad_amount');
  assert.equal(assertCode(() => draft(w, { amount: '-3' })), 'bad_amount');
  assert.equal(assertCode(() => draft(w, { kind: 'email', providerId: 'alice@mail.com', label: 'me' })), 'self_send');
});
function assertCode(fn) { try { fn(); } catch (e) { return e.code; } return null; }

test('draft is idempotent and capped at five open drafts', () => {
  const w = world();
  const a = draft(w, { idempotencyKey: 'k1' }); const b = draft(w, { idempotencyKey: 'k1' });
  assert.equal(a.claimId, b.claimId);
  for (let i = 0; i < 4; i++) draft(w);
  assert.equal(assertCode(() => draft(w)), 'too_many_drafts');
});

test('funding is checked against the chain: wrong amount is a mismatch, correct one funds, and USDC tables are untouched', async () => {
  const w = world();
  const d = draft(w);
  await assert.rejects(() => tokens.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0xaa' }), (e) => e.code === 'not_funded_yet');
  w.ctx.chain.onchainTokenCreate(d.claimId, { sender: ADDR.alice, token: VIBES, amount: 1n, expiry: 1, recipientHash: '0x' + '11'.repeat(32) });
  await assert.rejects(() => tokens.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0xaa' }), (e) => e.code === 'mismatch');
  fund(w, d);
  await assert.rejects(() => tokens.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.bob.id, txHash: '0xaa' }), (e) => e.code === 'not_yours');
  const v = await tokens.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0xaa' });
  assert.equal(v.status, 'funded');
  assert.equal(w.ctx.db.prepare('SELECT COUNT(*) n FROM claims').get().n, 0);
  assert.equal(w.ctx.db.prepare("SELECT COUNT(*) n FROM activity WHERE kind NOT LIKE 'token_%'").get().n, 0);
  assert.equal(w.ctx.db.prepare('SELECT COUNT(*) n FROM limits_usage').get().n, 0);
});

test('only the named recipient gets an attestation, and claim then confirms', async () => {
  const w = world();
  const d = draft(w); fund(w, d);
  await tokens.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id });
  const carol = user(w.ctx, 'x:777', [['x', '777', '@carol']]);
  await assert.rejects(() => tokens.prepareClaim(w.ctx, { claimId: d.claimId, userId: carol.id, recipientAddress: ADDR.carol }), (e) => e.code === 'not_recipient');
  const p = await tokens.prepareClaim(w.ctx, { claimId: d.claimId, userId: w.bob.id, recipientAddress: ADDR.bob });
  const call = decodeFunctionData({ abi: abi4, data: p.tx.data });
  assert.equal(call.functionName, 'claimToken'); assert.equal(call.args[1].toLowerCase(), ADDR.bob);
  await assert.rejects(() => tokens.confirmClaimed(w.ctx, { claimId: d.claimId, userId: w.bob.id }), (e) => e.code === 'not_claimed_yet');
  w.ctx.chain.onchainTokenClaim(d.claimId);
  const v = await tokens.confirmClaimed(w.ctx, { claimId: d.claimId, userId: w.bob.id, txHash: '0xbb' });
  assert.equal(v.status, 'claimed');
  await assert.rejects(() => tokens.prepareClaim(w.ctx, { claimId: d.claimId, userId: w.bob.id, recipientAddress: ADDR.bob }), (e) => e.code === 'not_claimable');
});

test('the sender can take back an unclaimed payment, a stranger cannot, and expiry blocks the claim', async () => {
  const w = world();
  const d = draft(w); fund(w, d);
  await tokens.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id });
  await assert.rejects(() => tokens.prepareReclaim(w.ctx, { claimId: d.claimId, userId: w.bob.id }), (e) => e.code === 'not_yours');
  const r = await tokens.prepareReclaim(w.ctx, { claimId: d.claimId, userId: w.alice.id });
  assert.equal(decodeFunctionData({ abi: abi4, data: r.tx.data }).functionName, 'reclaimToken');
  await assert.rejects(() => tokens.confirmReclaimed(w.ctx, { claimId: d.claimId, userId: w.alice.id }), (e) => e.code === 'not_returned_yet');
  w.ctx.chain.onchainTokenReclaim(d.claimId);
  assert.equal((await tokens.confirmReclaimed(w.ctx, { claimId: d.claimId, userId: w.alice.id, txHash: '0xcc' })).status, 'returned');
  const d2 = draft(w); fund(w, d2);
  await tokens.confirmFunded(w.ctx, { claimId: d2.claimId, userId: w.alice.id });
  w.ctx.clock.t += 8 * 86400000;
  await assert.rejects(() => tokens.prepareClaim(w.ctx, { claimId: d2.claimId, userId: w.bob.id, recipientAddress: ADDR.bob }), (e) => e.code === 'expired');
});

test('lists show sent and incoming payments with readable amounts', async () => {
  const w = world();
  const d = draft(w, { amount: '12' }); fund(w, d);
  await tokens.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id });
  assert.equal(tokens.listFor(w.ctx, w.alice.id).sent[0].amountText, '12 VIBES');
  assert.equal(tokens.listFor(w.ctx, w.bob.id).incoming[0].amountText, '12 VIBES');
  assert.equal(tokens.show(1234500000000000000000n, 18), '1,234.5');
  assert.equal((await tokens.balances(w.ctx, ADDR.alice)).VIBES.text, '12.5');
});

test('a send above the wallet balance is refused up front with the balance in the message', async () => {
  const w = world();
  await tokens.checkBalance(w.ctx, { symbol: 'VIBES', amount: '12', address: ADDR.alice });
  await assert.rejects(() => tokens.checkBalance(w.ctx, { symbol: 'VIBES', amount: '13', address: ADDR.alice }), (e) => e.code === 'insufficient' && /12\.5 VIBES/.test(e.message));
});

test('token payments appear in Activity as sent, received and returned without touching USDC numbers', async () => {
  const w = world();
  const act = require('../server/activity');
  const d = draft(w, { amount: '12' }); fund(w, d);
  await tokens.confirmFunded(w.ctx, { claimId: d.claimId, userId: w.alice.id });
  w.ctx.chain.onchainTokenClaim(d.claimId);
  await tokens.confirmClaimed(w.ctx, { claimId: d.claimId, userId: w.bob.id });
  const a = act.listActivity(w.ctx.db, w.alice.id); const b = act.listActivity(w.ctx.db, w.bob.id);
  assert.equal(a[0].kind, 'token_sent'); assert.equal(a[0].amountText, '12 VIBES'); assert.equal(a[0].amountMicro, null);
  assert.equal(b[0].kind, 'token_received'); assert.equal(act.listActivity(w.ctx.db, w.bob.id, { group: 'received' }).length, 1);
  const d2 = draft(w); fund(w, d2);
  await tokens.confirmFunded(w.ctx, { claimId: d2.claimId, userId: w.alice.id });
  w.ctx.chain.onchainTokenReclaim(d2.claimId);
  await tokens.confirmReclaimed(w.ctx, { claimId: d2.claimId, userId: w.alice.id });
  assert.equal(act.listActivity(w.ctx.db, w.alice.id, { group: 'returned' })[0].kind, 'token_returned');
  assert.match(act.exportCsv(w.ctx.db, w.alice.id), /12 VIBES/);
  assert.equal(require('../server/me').summary(w.ctx, w.ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(w.alice.id)).stats.sent.n, 0);
});
