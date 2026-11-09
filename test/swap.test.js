'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeFunctionData } = require('viem');
const { makeCtx, ADDR } = require('./helpers');
const swap = require('../server/swap');
const { POOL_ABI, ERC20_ABI } = require('../server/chain-client');
const VIBES = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333';

function world() {
  const ctx = makeCtx();
  ctx.cfg.tokens = [{ symbol: 'VIBES', name: 'Vibes', address: VIBES, decimals: 18, minUnits: 10n ** 18n, perClaimUnits: 1000n * 10n ** 18n }];
  ctx.cfg.pool = { address: POOL }; ctx.chain.usdcAddr = ctx.cfg.base.usdc;
  return ctx;
}
const code = async (fn) => { try { await fn(); } catch (e) { return e.code; } return null; };

test('options show reserves and the price, and stay off without a pool or tokens', async () => {
  const ctx = world();
  const o = await swap.options(ctx);
  assert.equal(o.enabled, true); assert.equal(o.priceText, '1 VIBES = $0.1000'); assert.deepEqual(o.symbols, ['USDC', 'VIBES']);
  ctx.cfg.pool = null;
  assert.equal((await swap.options(ctx)).enabled, false);
});

test('a quote follows the pool formula in both directions with a minimum output and the price impact', async () => {
  const ctx = world();
  const q = await swap.quote(ctx, { from: 'USDC', to: 'VIBES', amount: '10' });
  const expected = (10000000n * 9970n * 50000n * 10n ** 18n) / (5000000000n * 10000n + 10000000n * 9970n);
  assert.equal(q.out, expected); assert.equal(q.minOut, expected * 9900n / 10000n);
  assert.equal(q.view.out.endsWith(' VIBES'), true); assert.equal(q.view.feeBps, 30);
  const back = await swap.quote(ctx, { from: 'VIBES', to: 'USDC', amount: '100' });
  assert.ok(back.out > 0n && back.out < 10000000n);
});

test('bad input is refused: same token, unknown token, zero, too small, too large for the pool', async () => {
  const ctx = world();
  assert.equal(await code(() => swap.quote(ctx, { from: 'USDC', to: 'USDC', amount: '5' })), 'same_token');
  assert.equal(await code(() => swap.quote(ctx, { from: 'USDC', to: 'ETH', amount: '5' })), 'bad_token');
  assert.equal(await code(() => swap.quote(ctx, { from: 'USDC', to: 'VIBES', amount: '0' })), 'bad_amount');
  assert.equal(await code(() => swap.quote(ctx, { from: 'USDC', to: 'VIBES', amount: '-1' })), 'bad_amount');
  assert.equal(await code(() => swap.quote(ctx, { from: 'USDC', to: 'VIBES', amount: '600' })), 'too_big');
  assert.equal(await code(() => swap.quote(ctx, { from: 'VIBES', to: 'USDC', amount: '0.000001' })), 'too_small');
});

test('prepare builds an approve and a swap that pays the person, and refuses more than they hold', async () => {
  const ctx = world();
  const p = await swap.prepare(ctx, { userId: 1, from: 'USDC', to: 'VIBES', amount: '10', address: ADDR.alice });
  assert.equal(p.txs.length, 2);
  const ap = decodeFunctionData({ abi: ERC20_ABI, data: p.txs[0].data });
  assert.equal(ap.functionName, 'approve'); assert.equal(ap.args[0].toLowerCase(), POOL); assert.equal(ap.args[1], 10000000n);
  const sw = decodeFunctionData({ abi: POOL_ABI, data: p.txs[1].data });
  assert.equal(sw.functionName, 'swap'); assert.equal(sw.args[3].toLowerCase(), ADDR.alice); assert.equal(sw.args[2].toString(), p.minOutUnits);
  ctx.chain.tokenBalance = async () => 1000000n;
  assert.equal(await code(() => swap.prepare(ctx, { userId: 1, from: 'USDC', to: 'VIBES', amount: '10', address: ADDR.alice })), 'insufficient');
});

test('a confirmed swap is recorded once in Activity with a notification, and an unseen swap is not recorded', async () => {
  const ctx = world();
  const { user } = require('./helpers');
  const u = user(ctx, 'email:swapper@mail.com', [['email', 'swapper@mail.com', 'swapper@mail.com']]);
  ctx.notified = []; ctx.notify = (id, evt) => ctx.notified.push([id, evt]);
  const args = { userId: u.id, from: 'USDC', to: 'VIBES', amount: '10', address: ADDR.alice };
  assert.equal(await code(() => swap.confirm(ctx, args)), 'not_found_yet');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM activity WHERE kind = 'swap'").get().n, 0);
  ctx.chain.swaps.push({ trader: ADDR.alice, tokenIn: ctx.cfg.base.usdc, amountIn: 10000000n, amountOut: 99501593821919093327n, txHash: '0x' + 'ab'.repeat(32) });
  const r = await swap.confirm(ctx, args);
  assert.equal(r.text, '10 USDC for 99.5015 VIBES');
  await swap.confirm(ctx, args);
  const rows = ctx.db.prepare("SELECT * FROM activity WHERE kind = 'swap'").all();
  assert.equal(rows.length, 1); assert.equal(rows[0].amount_text, '10 USDC for 99.5015 VIBES'); assert.equal(rows[0].amount_micro, null);
  assert.equal(ctx.notified.length, 1); assert.equal(ctx.notified[0][1].type, 'swap_completed');
  const list = require('../server/activity').listActivity(ctx.db, u.id, { group: 'swaps' });
  assert.equal(list.length, 1); assert.equal(list[0].amountText, '10 USDC for 99.5015 VIBES');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM limits_usage").get().n, 0);
});
