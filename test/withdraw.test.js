'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeFunctionData, parseAbi } = require('viem');
const { makeCtx, user, ADDR } = require('./helpers');
const withdraw = require('../server/withdraw');
const { setAddress } = require('../server/identity');

const EXT = '0x4444444444444444444444444444444444444444';
function world(over = {}) {
  const ctx = makeCtx(over);
  const alice = user(ctx, 'email:alice@mail.com', [['email', 'alice@mail.com', 'alice@mail.com']]);
  setAddress(ctx.db, alice.id, 'base', ADDR.alice, ctx.now());
  return { ctx, alice };
}
const transferAbi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const txHash = '0x' + 'ab'.repeat(32);

test('options: public always, private only with a key on mainnet, fiat is coming soon', () => {
  const w = world();
  assert.equal(withdraw.options(w.ctx).public.available, true);
  assert.equal(withdraw.options(w.ctx).private.available, false);
  assert.equal(withdraw.options(w.ctx).fiat.available, false);
  w.ctx.near = {};
  assert.equal(withdraw.options(w.ctx).private.available, true);
  w.ctx.cfg.base.testnet = true;
  assert.equal(withdraw.options(w.ctx).private.available, false);
  assert.match(withdraw.options(w.ctx).private.reason, /mainnet/);
});

test('public prepare returns one USDC transfer to the wallet with a clear preview and no fee', async () => {
  const w = world();
  const p = await withdraw.prepare(w.ctx, { userId: w.alice.id, to: EXT, amountMicro: 3500000n });
  assert.equal(p.route, 'public');
  assert.equal(p.tx.to, w.ctx.cfg.base.usdc);
  const d = decodeFunctionData({ abi: transferAbi, data: p.tx.data });
  assert.equal(d.args[0].toLowerCase(), EXT);
  assert.equal(d.args[1], 3500000n);
  assert.deepEqual(p.preview.lines.map((l) => l.label), ['To', 'Route', 'You send', 'Network fee', 'They receive']);
  assert.equal(p.preview.lines[4].value, '$3.50');
});

test('prepare refuses bad addresses, the contract, the usdc token, the own account, tiny amounts and too much', async () => {
  const w = world();
  const go = (to, amountMicro = 2000000n) => withdraw.prepare(w.ctx, { userId: w.alice.id, to, amountMicro });
  await assert.rejects(go('not an address'), { code: 'bad_address' });
  await assert.rejects(go('0x123'), { code: 'bad_address' });
  await assert.rejects(go('0x0000000000000000000000000000000000000000'), { code: 'bad_destination' });
  await assert.rejects(go(w.ctx.cfg.claim.contract), { code: 'bad_destination' });
  await assert.rejects(go(w.ctx.cfg.base.usdc), { code: 'bad_destination' });
  await assert.rejects(go(ADDR.alice), { code: 'own_account' });
  await assert.rejects(go(EXT, 100000n), { code: 'below_minimum' });
  await assert.rejects(go(EXT, 9000000n), { code: 'insufficient' });
});

test('confirm needs the exact transfer from the user to the wallet, then records activity once', async () => {
  const w = world();
  const p = await withdraw.prepare(w.ctx, { userId: w.alice.id, to: EXT, amountMicro: 3000000n });
  await assert.rejects(withdraw.confirm(w.ctx, { userId: w.alice.id, id: p.withdrawalId, txHash }), { code: 'not_confirmed' });
  w.ctx.chain.transfers.set(txHash, { status: 'success', transfers: [{ token: w.ctx.cfg.base.usdc, from: ADDR.alice, to: '0x2222222222222222222222222222222222222222', value: '3000000' }] });
  await assert.rejects(withdraw.confirm(w.ctx, { userId: w.alice.id, id: p.withdrawalId, txHash }), { code: 'mismatch' });
  w.ctx.chain.transfers.set(txHash, { status: 'success', transfers: [{ token: w.ctx.cfg.base.usdc, from: ADDR.alice, to: EXT, value: '3000000' }] });
  const v = await withdraw.confirm(w.ctx, { userId: w.alice.id, id: p.withdrawalId, txHash });
  assert.equal(v.status, 'done');
  await withdraw.confirm(w.ctx, { userId: w.alice.id, id: p.withdrawalId, txHash });
  assert.equal(w.ctx.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'withdraw'").get().n, 1);
  assert.equal(withdraw.list(w.ctx, w.alice.id).length, 1);
});

test('another user cannot confirm or read someone elses withdrawal', async () => {
  const w = world();
  const eve = user(w.ctx, 'email:eve@mail.com', [['email', 'eve@mail.com', 'eve@mail.com']]);
  const p = await withdraw.prepare(w.ctx, { userId: w.alice.id, to: EXT, amountMicro: 3000000n });
  await assert.rejects(withdraw.confirm(w.ctx, { userId: eve.id, id: p.withdrawalId, txHash }), { code: 'not_found' });
  await assert.rejects(withdraw.get(w.ctx, { userId: eve.id, id: p.withdrawalId }), { code: 'not_found' });
});

test('private route: quote deposit address becomes the transfer target, status polling finishes it', async () => {
  const w = world();
  const DEP = '0x3333333333333333333333333333333333333333';
  const calls = [];
  w.ctx.near = {
    quote: async (b) => { calls.push(b); return { quote: { depositAddress: DEP, amountIn: '4000000', amountOut: '3998000', timeEstimate: 37 } }; },
    submitDeposit: async () => ({}),
    status: async () => ({ status: 'SUCCESS' }),
  };
  const p = await withdraw.prepare(w.ctx, { userId: w.alice.id, route: 'private', to: EXT, amountMicro: 4000000n });
  assert.equal(calls[0].confidentiality, 'basic');
  assert.equal(calls[0].recipient.toLowerCase(), EXT);
  assert.equal(calls[0].refundTo, ADDR.alice);
  assert.equal(decodeFunctionData({ abi: transferAbi, data: p.tx.data }).args[0].toLowerCase(), DEP);
  assert.equal(p.preview.lines[4].value, '$3.998');
  assert.match(p.preview.note, /not linked/);
  w.ctx.chain.transfers.set(txHash, { status: 'success', transfers: [{ token: w.ctx.cfg.base.usdc, from: ADDR.alice, to: DEP, value: '4000000' }] });
  const c = await withdraw.confirm(w.ctx, { userId: w.alice.id, id: p.withdrawalId, txHash });
  assert.equal(c.status, 'submitted');
  const done = await withdraw.get(w.ctx, { userId: w.alice.id, id: p.withdrawalId });
  assert.equal(done.status, 'done');
  assert.equal(w.ctx.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'withdraw'").get().n, 1);
});

test('private route refuses when it is not switched on', async () => {
  const w = world();
  await assert.rejects(withdraw.prepare(w.ctx, { userId: w.alice.id, route: 'private', to: EXT, amountMicro: 3000000n }), { code: 'private_unavailable' });
});

test('confirm without a transaction id finds the transfer on chain by sender, target and amount', async () => {
  const w = world();
  const p = await withdraw.prepare(w.ctx, { userId: w.alice.id, to: EXT, amountMicro: 2500000n });
  await assert.rejects(withdraw.confirm(w.ctx, { userId: w.alice.id, id: p.withdrawalId }), { code: 'not_confirmed' });
  w.ctx.chain.found = { txHash };
  const v = await withdraw.confirm(w.ctx, { userId: w.alice.id, id: p.withdrawalId });
  assert.equal(v.status, 'done'); assert.equal(v.txHash, txHash);
});
