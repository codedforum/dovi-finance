'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeFunctionData } = require('viem');
const { makeCtx, user, ADDR } = require('./helpers');
const naira = require('../server/naira');
const { setAddress } = require('../server/identity');
const { makeKora, KoraError } = require('../lib/kora');

const EXEC = '0x00000000000000000000000000000000000e0ec1';
const BANK = { bankCode: '058', accountNumber: '0123456789', accountName: 'Ada Obi' };
const TX = '0x' + 'ab'.repeat(32);

function world({ kora = null, env = {} } = {}) {
  const ctx = makeCtx({ env: { DOVI_NETWORK: 'sepolia' } });
  ctx.env = { DOVI_NAIRA: '1', ...env };
  ctx.fetch = async () => ({ ok: true, json: async () => ({ rates: { NGN: 1500 }, time_last_update_unix: 1 }) });
  ctx.sent = [];
  ctx.sendFail = null;
  ctx.executor = { async address() { return EXEC; }, async sendUsdc(a) { if (ctx.sendFail) throw ctx.sendFail; ctx.sent.push(a); return { txHash: '0x' + String(ctx.sent.length).padStart(64, '0') }; } };
  if (kora) ctx.kora = kora;
  const u = user(ctx, 'x:900', [['x', '900', '@ada']]);
  setAddress(ctx.db, u.id, 'base', ADDR.alice, ctx.now());
  return { ctx, u };
}
const row = (ctx, id) => ctx.db.prepare('SELECT * FROM naira_orders WHERE id = ?').get(id);

test('the quote maths: a naira amount buys USDC and a USDC amount sells for naira, both after a 1 percent fee', async () => {
  const { ctx } = world();
  const b = await naira.quoteFor(ctx, 'buy', 15000000n);
  assert.equal(b.usdcMicro, 99000000n);
  const s = await naira.quoteFor(ctx, 'sell', 100000000n);
  assert.equal(s.ngnKobo, 14850000n);
  assert.equal(naira.ngnText(14850000n), '₦148,500.00');
  const odd = await naira.quoteFor(ctx, 'buy', 5000000n);
  assert.equal(odd.usdcMicro, 32990000n, 'USDC credited is rounded down to whole cents, never six odd decimals');
  assert.equal(odd.usdcMicro % 10000n, 0n);
  assert.equal(naira.parseNgn('1,500.5'), 150050n);
  for (const bad of ['', 'abc', '-5', '1.234', '10000000000']) assert.throws(() => naira.parseNgn(bad), /amount in naira/);
});

test('the rail stays off unless switched on, needs the executor, and never runs a live key without the live flag', async () => {
  const off = world({ env: { DOVI_NAIRA: '0' } });
  assert.equal((await naira.options(off.ctx)).available, false);
  await assert.rejects(naira.buyStart(off.ctx, { userId: off.u.id, amountNgn: '5000' }), { code: 'unavailable' });
  const noExec = world(); noExec.ctx.executor = null;
  assert.equal(naira.rail(noExec.ctx), null);
  const live = world({ kora: { test: false } });
  assert.equal(naira.rail(live.ctx), null, 'a live key is ignored without DOVI_NAIRA_LIVE');
  live.ctx.env.DOVI_NAIRA_LIVE = '1';
  assert.equal(naira.rail(live.ctx).id, 'kora'); assert.equal(naira.rail(live.ctx).simulated, false);
  assert.equal(naira.rail(world().ctx).id, 'sim');
  const main = world(); main.ctx.cfg.base.testnet = false;
  assert.equal(naira.rail(main.ctx), null, 'the simulator never runs on mainnet');
  const o = await naira.options(world().ctx);
  assert.equal(o.available, true); assert.equal(o.simulated, true); assert.equal(o.rate, 1500); assert.ok(o.banks.length > 10);
});

test('buy with the simulator: a test payment credits the exact USDC once and records activity', async () => {
  const { ctx, u } = world();
  const o = await naira.buyStart(ctx, { userId: u.id, amountNgn: '150000' });
  assert.equal(o.status, 'awaiting_payment'); assert.equal(o.simulated, true);
  assert.match(o.pay.accountNumber, /^\d{10}$/); assert.equal(o.pay.amountExpectedKobo, '15000000'); assert.equal(o.usdcMicro, '99000000');
  const done = await naira.buyTestPaid(ctx, { userId: u.id, id: o.id });
  assert.equal(done.status, 'completed');
  assert.deepEqual(ctx.sent, [{ to: ADDR.alice, amountMicro: '99000000' }]);
  const again = await naira.buyTestPaid(ctx, { userId: u.id, id: o.id });
  assert.equal(again.status, 'completed'); assert.equal(ctx.sent.length, 1, 'a second press never pays twice');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM activity WHERE kind = 'topup'").get().n, 1);
  assert.ok(ctx.events.some((e) => e.type === 'send_confirmed' && /Added \$99\.00/.test(e.title)));
});

test('two test payments pressed at once credit only once', async () => {
  const { ctx, u } = world();
  const o = await naira.buyStart(ctx, { userId: u.id, amountNgn: '5000' });
  await Promise.all([naira.buyTestPaid(ctx, { userId: u.id, id: o.id }), naira.buyTestPaid(ctx, { userId: u.id, id: o.id })]);
  assert.equal(ctx.sent.length, 1);
});

test('buy limits: amount range, open orders, daily orders, per order USDC and the shared daily capacity', async () => {
  const { ctx, u } = world();
  await assert.rejects(naira.buyStart(ctx, { userId: u.id, amountNgn: '500' }), { code: 'amount_range' });
  await assert.rejects(naira.buyStart(ctx, { userId: u.id, amountNgn: '2000001' }), { code: 'amount_range' });
  await assert.rejects(naira.buyStart(ctx, { userId: u.id, amountNgn: '1000000' }), { code: 'amount_range' }, 'about 660 USDC is over the per order cap');
  for (let i = 0; i < 3; i++) await naira.buyStart(ctx, { userId: u.id, amountNgn: '2000' });
  await assert.rejects(naira.buyStart(ctx, { userId: u.id, amountNgn: '2000' }), { code: 'too_many_open' });
  const w2 = world({ env: { DOVI_NAIRA_DAY_MICRO: '1000000' } });
  await assert.rejects(naira.buyStart(w2.ctx, { userId: w2.u.id, amountNgn: '5000' }), { code: 'capacity' });
});

test('an order nobody pays expires, and an expired order cannot be paid', async () => {
  const { ctx, u } = world();
  const o = await naira.buyStart(ctx, { userId: u.id, amountNgn: '5000' });
  ctx.clock.t += 31 * 60 * 1000;
  assert.equal((await naira.get(ctx, { userId: u.id, id: o.id })).status, 'expired');
  const late = await naira.buyTestPaid(ctx, { userId: u.id, id: o.id });
  assert.equal(late.status, 'expired'); assert.equal(ctx.sent.length, 0);
});

test('a failed credit never reports success: it is flagged for a person, with the reason', async () => {
  const { ctx, u } = world();
  const a = await naira.buyStart(ctx, { userId: u.id, amountNgn: '5000' });
  ctx.sendFail = new Error('boom');
  assert.equal((await naira.buyTestPaid(ctx, { userId: u.id, id: a.id })).status, 'needs_attention');
  assert.equal(row(ctx, a.id).detail, 'credit_failed');
  const b = await naira.buyStart(ctx, { userId: u.id, amountNgn: '5000' });
  ctx.sendFail = Object.assign(new Error('late'), { broadcast: true });
  await naira.buyTestPaid(ctx, { userId: u.id, id: b.id });
  assert.equal(row(ctx, b.id).detail, 'credit_unconfirmed');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM activity WHERE kind = 'topup'").get().n, 0);
});

test('orders belong to their owner', async () => {
  const { ctx, u } = world();
  const o = await naira.buyStart(ctx, { userId: u.id, amountNgn: '5000' });
  const other = user(ctx, 'x:901', [['x', '901', '@bo']]);
  await assert.rejects(naira.get(ctx, { userId: other.id, id: o.id }), { code: 'not_found' });
  await assert.rejects(naira.buyTestPaid(ctx, { userId: other.id, id: o.id }), { code: 'not_found' });
  assert.equal(naira.list(ctx, other.id).length, 0); assert.equal(naira.list(ctx, u.id).length, 1);
});

test('sell: the bank details are validated, the quote is shown and the transfer goes to the treasury', async () => {
  const { ctx, u } = world();
  const p = (over = {}) => naira.sellPrepare(ctx, { userId: u.id, amountMicro: '5000000', bank: { ...BANK, ...over } });
  await assert.rejects(p({ bankCode: '999' }), { code: 'bad_bank' });
  await assert.rejects(p({ accountNumber: '12345' }), { code: 'bad_account' });
  await assert.rejects(p({ accountName: '1' }), { code: 'bad_name' });
  await assert.rejects(naira.sellPrepare(ctx, { userId: u.id, amountMicro: '100', bank: BANK }), { code: 'below_minimum' });
  await assert.rejects(naira.sellPrepare(ctx, { userId: u.id, amountMicro: '9000000', bank: BANK }), { code: 'insufficient' });
  await assert.rejects(naira.sellPrepare(ctx, { userId: u.id, amountMicro: '2000000000', bank: BANK }), { code: 'amount_range' }, 'about 2.9 million naira is over the order cap');
  const r = await p();
  assert.equal(r.ngnKobo, '742500'); assert.equal(r.simulated, true);
  const d = decodeFunctionData({ abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }], data: r.tx.data });
  assert.equal(d.args[0].toLowerCase(), EXEC.toLowerCase()); assert.equal(d.args[1], 5000000n);
  assert.ok(r.preview.lines.some((l) => l.label === 'You receive' && l.value === '₦7,425.00'));
  assert.ok(r.preview.lines.some((l) => l.label === 'Bank' && /GTBank ending 6789/.test(l.value)));
});

test('sell: a matching transfer starts the payout, a wrong one is refused, and a transaction settles one order only', async () => {
  const { ctx, u } = world();
  const r = await naira.sellPrepare(ctx, { userId: u.id, amountMicro: '5000000', bank: BANK });
  const transfer = (over) => ({ status: 'success', transfers: [{ token: ctx.cfg.base.usdc, to: EXEC, from: ADDR.alice, value: '5000000', ...over }] });
  ctx.chain.transfers.set(TX, transfer({ to: ADDR.bob }));
  await assert.rejects(naira.sellConfirm(ctx, { userId: u.id, id: r.orderId, txHash: TX }), { code: 'mismatch' });
  ctx.chain.transfers.set(TX, transfer({ value: '4000000' }));
  await assert.rejects(naira.sellConfirm(ctx, { userId: u.id, id: r.orderId, txHash: TX }), { code: 'mismatch' });
  await assert.rejects(naira.sellConfirm(ctx, { userId: u.id, id: r.orderId, txHash: 'nope' }), { code: 'bad_tx' });
  await assert.rejects(naira.sellConfirm(ctx, { userId: u.id, id: r.orderId }), { code: 'not_confirmed' });
  ctx.chain.transfers.set(TX, transfer());
  const c = await naira.sellConfirm(ctx, { userId: u.id, id: r.orderId, txHash: TX });
  assert.equal(c.status, 'processing'); assert.equal(c.txHash, TX); assert.equal(c.bank.last4, '6789');
  assert.equal((await naira.sellConfirm(ctx, { userId: u.id, id: r.orderId, txHash: TX })).status, 'processing', 'confirming twice is harmless');
  const r2 = await naira.sellPrepare(ctx, { userId: u.id, amountMicro: '5000000', bank: BANK });
  await assert.rejects(naira.sellConfirm(ctx, { userId: u.id, id: r2.orderId, txHash: TX }), { code: 'mismatch' });
  assert.equal((await naira.get(ctx, { userId: u.id, id: r.orderId })).status, 'processing');
  ctx.clock.t += 16 * 1000;
  const done = await naira.get(ctx, { userId: u.id, id: r.orderId });
  assert.equal(done.status, 'completed');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM activity WHERE kind = 'withdraw'").get().n, 1);
  const other = user(ctx, 'x:902', [['x', '902', '@cy']]);
  await assert.rejects(naira.sellConfirm(ctx, { userId: other.id, id: r2.orderId, txHash: TX }), { code: 'not_found' });
});

function fakeKora(over = {}) {
  const calls = [];
  const k = { test: true, calls, charge: { status: 'pending', amountPaidKobo: '0' }, payout: { status: 'pending' }, failDisburse: null,
    async initCharge(a) { calls.push(['init', a]); return { amountExpectedKobo: String(BigInt(a.amountKobo) + 5000n), account: { bankName: 'Wema Bank', accountNumber: '8012345678', accountName: 'DOVI/KORA', expiresAt: Date.UTC(2026, 9, 20, 12, 30) } }; },
    async getCharge(ref) { calls.push(['charge', ref]); return k.charge; },
    async resolve() { return { accountName: 'ADA OBI' }; },
    async disburse(a) { calls.push(['disburse', a]); if (k.failDisburse) throw k.failDisburse; return { status: 'pending' }; },
    async getPayout(ref) { calls.push(['payout', ref]); return k.payout; }, ...over };
  return k;
}

test('buy through Kora: pending stays pending, an underpayment is flagged, a full payment credits once', async () => {
  const kora = fakeKora();
  const { ctx, u } = world({ kora });
  const o = await naira.buyStart(ctx, { userId: u.id, amountNgn: '5000' });
  assert.equal(o.pay.bankName, 'Wema Bank'); assert.equal(o.pay.amountExpectedKobo, '505000'); assert.equal(o.simulated, true);
  assert.equal(kora.calls[0][1].reference, o.id); assert.equal(kora.calls[0][1].amountKobo, 500000n);
  assert.equal((await naira.get(ctx, { userId: u.id, id: o.id })).status, 'awaiting_payment');
  kora.charge = { status: 'success', amountPaidKobo: '100000' };
  assert.equal((await naira.get(ctx, { userId: u.id, id: o.id })).status, 'needs_attention');
  assert.equal(ctx.sent.length, 0);
  const o2 = await naira.buyStart(ctx, { userId: u.id, amountNgn: '5000' });
  kora.charge = { status: 'success', amountPaidKobo: '505000' };
  await Promise.all([naira.get(ctx, { userId: u.id, id: o2.id }), naira.get(ctx, { userId: u.id, id: o2.id })]);
  assert.equal(ctx.sent.length, 1); assert.equal(row(ctx, o2.id).status, 'completed');
  await assert.rejects(naira.buyTestPaid(ctx, { userId: u.id, id: o2.id }), { code: 'not_simulated' });
});

test('a Kora failure on pay in marks the order failed, and a provider outage on start is a clear error', async () => {
  const kora = fakeKora();
  const { ctx, u } = world({ kora });
  const o = await naira.buyStart(ctx, { userId: u.id, amountNgn: '5000' });
  kora.charge = { status: 'failed', amountPaidKobo: '0' };
  assert.equal((await naira.get(ctx, { userId: u.id, id: o.id })).status, 'failed');
  kora.initCharge = async () => { throw new KoraError('server', 'x', { unknown: true }); };
  await assert.rejects(naira.buyStart(ctx, { userId: u.id, amountNgn: '5000' }), { code: 'provider_down' });
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM naira_orders WHERE status = 'awaiting_payment'").get().n, 0, 'no order is left behind');
});

test('sell through Kora: the payout is sent once with the bank code, tracked, and a rejection or silence is not called success', async () => {
  const kora = fakeKora();
  const { ctx, u } = world({ kora });
  const go = async () => {
    const r = await naira.sellPrepare(ctx, { userId: u.id, amountMicro: '5000000', bank: BANK });
    ctx.chain.transfers.set(TX + r.orderId, null);
    ctx.chain.found = { txHash: '0x' + r.orderId.slice(2).padEnd(64, '1') };
    return naira.sellConfirm(ctx, { userId: u.id, id: r.orderId });
  };
  const a = await go();
  assert.equal(a.status, 'processing');
  const d = kora.calls.find((c) => c[0] === 'disburse')[1];
  assert.equal(d.bank, '058'); assert.equal(d.account, '0123456789'); assert.equal(d.amountKobo, 742500n); assert.equal(d.reference, a.id);
  assert.equal((await naira.get(ctx, { userId: u.id, id: a.id })).status, 'processing', 'pending is not done');
  kora.payout = { status: 'success' };
  assert.equal((await naira.get(ctx, { userId: u.id, id: a.id })).status, 'completed');
  kora.failDisburse = new KoraError('rejected', 'no funds');
  const sentBefore = ctx.sent.length;
  const b = await go();
  assert.equal(b.status, 'refunded'); assert.equal(row(ctx, b.id).detail, 'payout_rejected');
  assert.deepEqual(ctx.sent[sentBefore], { to: ADDR.alice, amountMicro: '5000000' }, 'a rejected payout returns the USDC to the user');
  assert.equal(b.refundTx, row(ctx, b.id).refund_tx);
  kora.failDisburse = new KoraError('server', 'x', { unknown: true });
  const c = await go();
  assert.equal(c.status, 'processing'); assert.equal(row(ctx, c.id).detail, 'payout_unconfirmed');
  kora.payout = { status: 'failed' };
  assert.equal((await naira.get(ctx, { userId: u.id, id: c.id })).status, 'refunded');
  const refunds = ctx.sent.length;
  await naira.get(ctx, { userId: u.id, id: c.id }); await naira.tick(ctx);
  assert.equal(ctx.sent.length, refunds, 'a refund is never paid twice');
  assert.ok(ctx.events.some((e) => /Cash out returned/.test(e.title || '')));
});

test('the background tick settles orders nobody is watching', async () => {
  const kora = fakeKora();
  const { ctx, u } = world({ kora });
  const o = await naira.buyStart(ctx, { userId: u.id, amountNgn: '5000' });
  kora.charge = { status: 'success', amountPaidKobo: '505000' };
  await naira.tick(ctx);
  assert.equal(row(ctx, o.id).status, 'completed');
});

test('the Kora client sends the secret key, maps statuses, and treats outages as unknown outcomes without leaking the key', async () => {
  assert.equal(makeKora({}), null);
  assert.equal(makeKora({ KORA_SECRET_KEY: 'sk_test_abcdefghij' }).test, true);
  assert.equal(makeKora({ KORA_SECRET_KEY: 'sk_live_abcdefghij' }).test, false);
  const seen = [];
  const reply = (status, body) => async (url, init) => { seen.push({ url, init }); return { ok: status < 400, status, json: async () => body }; };
  const k = makeKora({ KORA_SECRET_KEY: 'sk_test_abcdefghij' }, reply(200, { status: true, data: { amount_expected: 5050, amount: 5000, bank_account: { bank_name: 'Wema', account_number: '801', account_name: 'X', expiry_date_in_utc: '2026-10-20T12:30:00Z' } } }));
  const c = await k.initCharge({ reference: 'n_abc', amountKobo: 500000n, name: 'DOVI user', email: 'a@b.co' });
  assert.equal(c.amountExpectedKobo, '505000'); assert.equal(c.account.accountNumber, '801');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer sk_test_abcdefghij');
  assert.match(seen[0].url, /\/charges\/bank-transfer$/);
  const sent = JSON.parse(seen[0].init.body); assert.equal(sent.amount, 5000); assert.equal(sent.auto_complete, true); assert.equal(sent.currency, 'NGN'); assert.equal(sent.account_name, 'DOVI', 'the payment account shows DOVI, not the Kora merchant name');
  const q = makeKora({ KORA_SECRET_KEY: 'sk_test_abcdefghij' }, reply(200, { status: true, data: { status: 'success', amount_paid: 5050 } }));
  assert.deepEqual(await q.getCharge('n_abc'), { status: 'success', amountPaidKobo: '505000' });
  const down = makeKora({ KORA_SECRET_KEY: 'sk_test_abcdefghij' }, reply(503, {}));
  await assert.rejects(down.getPayout('n_abc'), (e) => e.unknown === true && !/sk_test/.test(e.message));
  const no = makeKora({ KORA_SECRET_KEY: 'sk_test_abcdefghij' }, reply(400, { status: false, message: 'Invalid account' }));
  await assert.rejects(no.disburse({ reference: 'abcde', amountKobo: 100000n, bank: '044', account: '1', name: 'A', email: 'a@b.co' }), (e) => e.code === 'rejected' && e.unknown === false);
  const net = makeKora({ KORA_SECRET_KEY: 'sk_test_abcdefghij' }, async () => { throw new Error('socket sk_test_abcdefghij'); });
  await assert.rejects(net.resolve({ bank: '058', account: '1' }), (e) => e.unknown === true && !/sk_test/.test(e.message));
});

test('the bank list is the full partner list, with OPay and the popular banks first and every code unique', () => {
  const { BANKS, bankName } = require('../server/banks');
  assert.ok(BANKS.length > 200);
  assert.equal(new Set(BANKS.map((b) => b.code)).size, BANKS.length);
  assert.deepEqual(BANKS.slice(0, 3).map((b) => b.name), ['GTBank', 'Access Bank', 'UBA']);
  assert.equal(bankName('305'), 'OPay'); assert.match(BANKS.find((b) => b.code === '305').words, /paycom/);
  assert.equal(bankName('100033'), 'PalmPay'); assert.equal(bankName('50211'), 'Kuda'); assert.equal(bankName('nope'), null);
  assert.ok(BANKS.every((b) => b.name === b.name.trim() && b.name.length > 1));
});

test('looking up an account name: found, not found, partner down, and test mode without a partner', async () => {
  const kora = fakeKora();
  const { ctx } = world({ kora });
  const r = await naira.resolveAccount(ctx, { bankCode: '305', accountNumber: '8012345678' });
  assert.deepEqual(r, { found: true, accountName: 'ADA OBI', lookupDown: false, simulated: true });
  kora.resolve = async () => { throw new KoraError('rejected', 'no account'); };
  assert.deepEqual(await naira.resolveAccount(ctx, { bankCode: '058', accountNumber: '0123456789' }), { found: false, accountName: null, lookupDown: false, simulated: true });
  kora.resolve = async () => { throw new KoraError('server', 'x', { unknown: true }); };
  assert.equal((await naira.resolveAccount(ctx, { bankCode: '058', accountNumber: '0123456789' })).lookupDown, true);
  await assert.rejects(naira.resolveAccount(ctx, { bankCode: 'zzz', accountNumber: '0123456789' }), { code: 'bad_bank' });
  await assert.rejects(naira.resolveAccount(ctx, { bankCode: '058', accountNumber: '123' }), { code: 'bad_account' });
  const sim = world();
  assert.deepEqual(await naira.resolveAccount(sim.ctx, { bankCode: '058', accountNumber: '0123456789' }), { found: false, accountName: null, lookupDown: false, simulated: true });
  const off = world({ env: { DOVI_NAIRA: '0' } });
  await assert.rejects(naira.resolveAccount(off.ctx, { bankCode: '058', accountNumber: '0123456789' }), { code: 'unavailable' });
});

test('cash out uses the bank name from the lookup, falls back to the typed name in test mode, and is strict with a live key', async () => {
  const kora = fakeKora();
  const { ctx, u } = world({ kora });
  const typed = await naira.sellPrepare(ctx, { userId: u.id, amountMicro: '5000000', bank: { bankCode: '305', accountNumber: '8012345678', accountName: '' } });
  assert.ok(typed.preview.lines.some((l) => l.label === 'Account name' && l.value === 'ADA OBI'), 'the looked up name wins and the typed name can be empty');
  assert.ok(typed.preview.lines.some((l) => l.label === 'Bank' && /OPay ending 5678/.test(l.value)));
  kora.resolve = async () => { throw new KoraError('rejected', 'no account'); };
  await assert.rejects(naira.sellPrepare(ctx, { userId: u.id, amountMicro: '5000000', bank: { bankCode: '058', accountNumber: '0123456789', accountName: '' } }), { code: 'bad_name' });
  const ok = await naira.sellPrepare(ctx, { userId: u.id, amountMicro: '5000000', bank: { bankCode: '058', accountNumber: '0123456789', accountName: 'Ada Obi' } });
  assert.ok(ok.preview.lines.some((l) => l.label === 'Account name' && l.value === 'Ada Obi'));
  const liveK = fakeKora({ test: false });
  const live = world({ kora: liveK, env: { DOVI_NAIRA_LIVE: '1' } });
  liveK.resolve = async () => { throw new KoraError('rejected', 'no account'); };
  await assert.rejects(naira.sellPrepare(live.ctx, { userId: live.u.id, amountMicro: '5000000', bank: { bankCode: '058', accountNumber: '0123456789', accountName: 'Ada Obi' } }), { code: 'account_not_found', status: 400 });
  liveK.resolve = async () => { throw new KoraError('server', 'x', { unknown: true }); };
  await assert.rejects(naira.sellPrepare(live.ctx, { userId: live.u.id, amountMicro: '5000000', bank: { bankCode: '058', accountNumber: '0123456789', accountName: 'Ada Obi' } }), { code: 'account_not_found', status: 502 });
});

test('a node that fails while confirming a cash out is retried, not shown as a server error', async () => {
  const { ctx, u } = world();
  const r = await naira.sellPrepare(ctx, { userId: u.id, amountMicro: '5000000', bank: BANK });
  ctx.chain.findTransfer = async () => { throw new Error('eth_getLogs is limited to a 200 range'); };
  await assert.rejects(naira.sellConfirm(ctx, { userId: u.id, id: r.orderId }), { code: 'not_confirmed', status: 409 });
  ctx.chain.getTransfer = async () => { throw new Error('rpc down'); };
  await assert.rejects(naira.sellConfirm(ctx, { userId: u.id, id: r.orderId, txHash: TX }), { code: 'not_confirmed', status: 409 });
  assert.equal(row(ctx, r.orderId).status, 'prepared', 'nothing moves until the transfer is seen');
});

test('if the refund itself cannot be sent the order is flagged, and a flagged failed payout can be refunded once by a person', async () => {
  const kora = fakeKora({ failDisburse: new KoraError('rejected', 'no funds') });
  const { ctx, u } = world({ kora });
  ctx.sendFail = new Error('treasury offline');
  const r = await naira.sellPrepare(ctx, { userId: u.id, amountMicro: '5000000', bank: BANK });
  ctx.chain.found = { txHash: '0x' + 'cd'.repeat(32) };
  const c = await naira.sellConfirm(ctx, { userId: u.id, id: r.orderId });
  assert.equal(c.status, 'needs_attention'); assert.equal(row(ctx, r.orderId).detail, 'refund_failed');
  await assert.rejects(naira.refundFailedPayout(ctx, { id: r.orderId }), { code: 'not_refundable' }, 'a refund failure is not retried blindly');
  row(ctx, r.orderId); ctx.db.prepare("UPDATE naira_orders SET detail = 'payout_failed' WHERE id = ?").run(r.orderId);
  ctx.sendFail = null;
  const done = await naira.refundFailedPayout(ctx, { id: r.orderId });
  assert.equal(done.status, 'refunded'); assert.equal(ctx.sent.length, 1);
  await assert.rejects(naira.refundFailedPayout(ctx, { id: r.orderId }), { code: 'not_refundable' });
});
