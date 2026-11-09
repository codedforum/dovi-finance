'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, user, ADDR } = require('./helpers');
const keys = require('../server/agentkeys');
const mcp = require('../server/mcp');
const { setAddress } = require('../server/identity');

function world() {
  const ctx = makeCtx();
  ctx.cfg.claim.perClaimCapMicro = 20000000n; ctx.cfg.claim.perUserDayCapMicro = 100000000n;
  const alice = user(ctx, 'x:111', [['x', '111', '@alice']]);
  setAddress(ctx.db, alice.id, 'base', ADDR.alice, ctx.now());
  ctx.fetch = async (url) => { const h = String(url).split('/').pop().toLowerCase(); const ids = { bob: '555', kofi: '43', alice: '111' }; return ids[h] ? { status: 200, json: async () => ({ user: { id: ids[h], screen_name: h, name: h } }) } : { status: 404, json: async () => ({}) }; };
  ctx.lookupDelayMs = 0;
  ctx.chain.onchainSetAutoPay(ADDR.alice, 5000000n, 10000000n);
  ctx.chain.onchainApprove(ADDR.alice, 100000000n);
  ctx.executor = { calls: [], async createClaimFor(a) { this.calls.push(a); ctx.chain.onchainCreate(a.id, { sender: a.payer, amount: a.amountMicro, fee: 100000n, expiry: a.expiry, recipientHash: a.recipientHash }); return { txHash: '0x' + 'ab'.repeat(32) }; } };
  ctx.db.prepare('INSERT INTO autopay (user_id, per_payment_micro, per_day_micro, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)').run(alice.id, '5000000', '10000000');
  return { ctx, alice };
}
const mk = (w, over = {}) => keys.create(w.ctx, { userId: w.alice.id, name: 'test agent', perPaymentMicro: 2000000n, perDayMicro: 3000000n, days: 7, ...over });
const call = async (w, secret, name, args = {}, id = 1) => {
  const row = keys.authenticate(w.ctx, secret);
  const r = await mcp.handleMessage(w.ctx, row, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  return { isError: r.result.isError, out: JSON.parse(r.result.content[0].text) };
};

test('a key is shown once, stored only as a hash, and cannot exceed the owner Pay from X limits', () => {
  const w = world();
  const k = mk(w);
  assert.match(k.key, /^dvk_/);
  const raw = JSON.stringify(w.ctx.db.prepare('SELECT * FROM agent_keys').all());
  assert.ok(!raw.includes(k.key.slice(4)), 'the secret is never stored');
  assert.ok(!JSON.stringify(keys.list(w.ctx, w.alice.id)).includes(k.key));
  assert.throws(() => mk(w, { perPaymentMicro: 6000000n, perDayMicro: 7000000n }), (e) => e.code === 'above_autopay');
  assert.throws(() => mk(w, { perDayMicro: 11000000n }), (e) => e.code === 'above_autopay');
  assert.throws(() => mk(w, { perPaymentMicro: 3000000n, perDayMicro: 2000000n }), (e) => e.code === 'bad_limits');
  assert.throws(() => mk(w, { name: '  ' }), (e) => e.code === 'name_required');
  assert.throws(() => mk(w, { days: 400 }), (e) => e.code === 'bad_expiry');
  w.ctx.db.prepare('UPDATE autopay SET enabled = 0').run();
  assert.throws(() => mk(w), (e) => e.code === 'autopay_required');
});

test('a key can be made to never expire and still stops the moment it is revoked', () => {
  const w = world();
  const k = mk(w, { days: 'never' });
  assert.equal(k.expiresAt, null); assert.equal(k.status, 'active');
  assert.ok(keys.authenticate(w.ctx, k.key));
  w.ctx.clock && (w.ctx.clock.t += 400 * 86400000);
  assert.ok(keys.authenticate(w.ctx, k.key));
  keys.revoke(w.ctx, { userId: w.alice.id, id: k.id });
  assert.equal(keys.authenticate(w.ctx, k.key), null);
});

test('authentication rejects unknown, revoked and expired keys', () => {
  const w = world();
  const k = mk(w);
  assert.ok(keys.authenticate(w.ctx, k.key));
  assert.equal(keys.authenticate(w.ctx, 'dvk_' + 'x'.repeat(32)), null);
  assert.equal(keys.authenticate(w.ctx, 'nope'), null);
  keys.revoke(w.ctx, { userId: w.alice.id, id: k.id });
  assert.equal(keys.authenticate(w.ctx, k.key), null);
  const k2 = mk(w);
  w.ctx.db.prepare('UPDATE agent_keys SET expires_at = 1 WHERE id = ?').run(k2.id);
  assert.equal(keys.authenticate(w.ctx, k2.key), null);
});

test('the protocol answers initialize and lists the five tools, notifications get no reply', async () => {
  const w = world(); const k = mk(w); const row = keys.authenticate(w.ctx, k.key);
  const i = await mcp.handleMessage(w.ctx, row, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(i.result.protocolVersion, '2025-06-18'); assert.equal(i.result.serverInfo.name, 'dovi-send');
  const l = await mcp.handleMessage(w.ctx, row, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(l.result.tools.map((t) => t.name).sort(), ['dovi_get_limits', 'dovi_get_payment', 'dovi_list_payments', 'dovi_quote_payment', 'dovi_send_payment']);
  assert.equal(await mcp.handleMessage(w.ctx, row, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await mcp.handleMessage(w.ctx, row, { jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
});

test('a send inside the limits goes through the executor once and reports what is left', async () => {
  const w = world(); const k = mk(w);
  const q = await call(w, k.key, 'dovi_quote_payment', { to: '@bob', amount_usd: '1.50' });
  assert.equal(q.isError, false); assert.equal(q.out.allowed, true); assert.equal(w.ctx.executor.calls.length, 0);
  const s = await call(w, k.key, 'dovi_send_payment', { to: '@bob', amount_usd: '1.50', idempotency_key: 'pay-0001-abcd' });
  assert.equal(s.isError, false); assert.equal(s.out.status, 'sent'); assert.equal(s.out.amount_usd, '$1.50');
  assert.equal(w.ctx.executor.calls.length, 1);
  assert.equal(s.out.remaining_today_usd, '$1.50');
  const row = w.ctx.db.prepare('SELECT source, agent_key_id FROM claims WHERE id = ?').get(s.out.claim_id);
  assert.equal(row.source, 'mcp'); assert.equal(row.agent_key_id, k.id);
  const g = await call(w, k.key, 'dovi_get_payment', { claim_id: s.out.claim_id });
  assert.equal(g.out.status, 'funded');
  assert.equal((await call(w, k.key, 'dovi_list_payments')).out.payments.length, 1);
});

test('the same idempotency key never sends twice', async () => {
  const w = world(); const k = mk(w);
  const a = await call(w, k.key, 'dovi_send_payment', { to: '@bob', amount_usd: '1', idempotency_key: 'same-key-0001' });
  const b = await call(w, k.key, 'dovi_send_payment', { to: '@bob', amount_usd: '1', idempotency_key: 'same-key-0001' });
  assert.equal(a.out.claim_id, b.out.claim_id); assert.equal(b.out.duplicate, true);
  assert.equal(w.ctx.executor.calls.length, 1);
  const bad = await call(w, k.key, 'dovi_send_payment', { to: '@bob', amount_usd: '1', idempotency_key: 'x' });
  assert.equal(bad.out.error, 'bad_idempotency_key');
});

test('the hard caps hold: per payment, per day, the owner limits, and no way for the agent to raise them', async () => {
  const w = world(); const k = mk(w);
  const over = await call(w, k.key, 'dovi_send_payment', { to: '@bob', amount_usd: '2.01', idempotency_key: 'over-0000001' });
  assert.equal(over.isError, true); assert.equal(over.out.error, 'above_key_limit');
  assert.equal((await call(w, k.key, 'dovi_send_payment', { to: '@bob', amount_usd: '2', idempotency_key: 'day-00000001' })).out.status, 'sent');
  const d2 = await call(w, k.key, 'dovi_send_payment', { to: '@kofi', amount_usd: '1.5', idempotency_key: 'day-00000002' });
  assert.equal(d2.isError, true); assert.equal(d2.out.error, 'above_key_day_limit');
  assert.equal((await call(w, k.key, 'dovi_send_payment', { to: '@kofi', amount_usd: '1', idempotency_key: 'day-00000003' })).out.status, 'sent');
  const d4 = await call(w, k.key, 'dovi_send_payment', { to: '@kofi', amount_usd: '1', idempotency_key: 'day-00000004' });
  assert.equal(d4.out.error, 'above_key_day_limit');
  assert.equal(w.ctx.executor.calls.length, 2);
  const lim = await call(w, k.key, 'dovi_get_limits');
  assert.equal(lim.out.remaining_today_usd, '$0.00');
  assert.ok(!mcp.TOOLS.some((t) => /limit|raise|key/i.test(t.name) && t.name !== 'dovi_get_limits'), 'no tool can change limits');
});

test('a frozen owner, a turned off Pay from X, a bad recipient and an unknown account are all refused with nothing sent', async () => {
  const w = world(); const k = mk(w);
  const r = async (args) => call(w, k.key, 'dovi_send_payment', { idempotency_key: 'ref-' + Math.random().toString(36).slice(2, 12), amount_usd: '1', ...args });
  assert.equal((await r({ to: 'not a handle!' })).out.error, 'bad_recipient');
  assert.equal((await r({ to: '@nobodyhere' })).out.error, 'recipient_not_found');
  assert.equal((await r({ to: '@alice' })).out.error, 'self_send');
  assert.equal((await r({ to: '@bob', amount_usd: 'abc' })).out.error, 'bad_amount');
  w.ctx.db.prepare('UPDATE users SET frozen_at = 1 WHERE id = ?').run(w.alice.id);
  assert.equal((await r({ to: '@bob' })).out.error, 'account_frozen');
  w.ctx.db.prepare('UPDATE users SET frozen_at = NULL WHERE id = ?').run(w.alice.id);
  w.ctx.db.prepare('UPDATE autopay SET enabled = 0').run();
  assert.equal((await r({ to: '@bob' })).out.error, 'autopay_off');
  assert.equal(w.ctx.executor.calls.length, 0);
});

test('one key cannot read another key payments, and a failed send stays reserved against the cap for 15 minutes and stays listed', async () => {
  const w = world(); const k1 = mk(w); const k2 = mk(w, { name: 'other' });
  const s = await call(w, k1.key, 'dovi_send_payment', { to: '@bob', amount_usd: '1', idempotency_key: 'own-00000001' });
  assert.equal((await call(w, k2.key, 'dovi_get_payment', { claim_id: s.out.claim_id })).out.error, 'not_found');
  w.ctx.executor.createClaimFor = async () => { throw new Error('rpc down'); };
  const f = await call(w, k2.key, 'dovi_send_payment', { to: '@kofi', amount_usd: '1', idempotency_key: 'fail-0000001' });
  assert.equal(f.out.error, 'send_failed');
  assert.equal((await call(w, k2.key, 'dovi_get_limits')).out.spent_today_usd, '$1.00');
  const listed = (await call(w, k2.key, 'dovi_list_payments')).out.payments;
  assert.equal(listed.length, 1);
  assert.match(f.out.message || JSON.stringify(f.out), /Payment id /);
});

test('over HTTP a missing or wrong key gets 401 and a good key gets the JSON-RPC answer', async () => {
  const w = world(); const k = mk(w);
  const out = [];
  const res = () => { const r = { code: null, body: '', writeHead(c) { r.code = c; }, end(b) { r.body = b || ''; } }; return r; };
  const helpers = { json: (rs, status, body) => { rs.code = status; rs.body = JSON.stringify(body); }, secHeaders: () => ({}) };
  const r1 = res(); await mcp.handleHttp(w.ctx, { headers: {} }, r1, { jsonrpc: '2.0', id: 1, method: 'ping' }, helpers);
  assert.equal(r1.code, 401);
  const r2 = res(); await mcp.handleHttp(w.ctx, { headers: { authorization: 'Bearer dvk_' + 'z'.repeat(32) } }, r2, { jsonrpc: '2.0', id: 1, method: 'ping' }, helpers);
  assert.equal(r2.code, 401);
  const r3 = res(); await mcp.handleHttp(w.ctx, { headers: { authorization: 'Bearer ' + k.key } }, r3, { jsonrpc: '2.0', id: 7, method: 'ping' }, helpers);
  assert.equal(r3.code, 200); assert.equal(JSON.parse(r3.body).id, 7);
  const r4 = res(); await mcp.handleHttp(w.ctx, { headers: { authorization: 'Bearer ' + k.key } }, r4, { jsonrpc: '2.0', method: 'notifications/initialized' }, helpers);
  assert.equal(r4.code, 202); void out;
});
