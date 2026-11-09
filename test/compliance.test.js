'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { makeCtx, user } = require('./helpers');
const { createApp } = require('../server/app');
const unsub = require('../server/unsubscribe');
const emails = require('../server/emails/templates');
const claims = require('../server/claims');
const datareq = require('../server/datarequests');

const OPEN = [];
test.after(async () => { for (const c of OPEN) { try { await c(); } catch { /* closed */ } } });

function boot(env = {}) {
  const ctx = makeCtx({ env: { DOVI_ENV: 'test', DOVI_ADMINS: 'email:admin@dovi.test', ...env } });
  ctx.env = {};
  const secret = 'test-secret';
  ctx.sessions = { mint: (id, jti) => { const p = Buffer.from(JSON.stringify({ id, jti: jti || null, iat: Date.now() })).toString('base64url'); return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('hex'); }, read: (t) => { const i = String(t).lastIndexOf('.'); const p = t.slice(0, i); if (t.slice(i + 1) !== crypto.createHmac('sha256', secret).update(p).digest('hex')) return null; try { const j = JSON.parse(Buffer.from(p, 'base64url').toString()); return { identity: j.id, jti: j.jti, iatMs: j.iat }; } catch { return null; } }, verify: (t) => { const r = ctx.sessions.read(t); return r ? r.identity : null; } };
  ctx.cdpAuth = { mintFor: (id) => 'jwt-for-' + id, jwks: () => ({ keys: [] }) };
  const { handler } = createApp(ctx);
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = 'http://127.0.0.1:' + server.address().port;
    const call = (method, path, { body, identity, raw, headers = {} } = {}) => fetch(base + path, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(identity ? { cookie: 'dovi_sess=' + encodeURIComponent(ctx.sessions.mint(identity)) } : {}), origin: ctx.cfg.publicUrl, ...headers }, body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined });
    const close = () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); };
    OPEN.push(close);
    resolve({ ctx, call, close });
  }));
}

test('the legal pages exist, link to each other, and show business details only when they are set', async () => {
  const s = await boot();
  for (const p of ['/privacy', '/terms', '/refunds', '/cookies', '/data-request']) {
    const r = await s.call('GET', p); assert.equal(r.status, 200, p);
    const t = await r.text(); assert.match(t, /Skip to content/); assert.match(t, /href="\/refunds"/); assert.match(t, /href="\/cookies"/); assert.match(t, /href="\/data-request"/);
  }
  const priv = await (await s.call('GET', '/privacy')).text();
  assert.match(priv, /being finalised/); assert.doesNotMatch(priv, /Operator:/);
  assert.match(await (await s.call('GET', '/cookies')).text(), /dovi_sess/);
  assert.match(priv, new RegExp('href="' + s.ctx.cfg.publicUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/app"'), 'links into the app are absolute');
  await s.close();
  const t = await boot({ DOVI_LEGAL_NAME: 'Acme Ltd', DOVI_LEGAL_ADDRESS: '1 Main St', DOVI_CONTACT_EMAIL: 'help@acme.test', DOVI_LEGAL_COUNTRY: 'Nigeria' });
  const p2 = await (await t.call('GET', '/terms')).text();
  assert.match(p2, /Acme Ltd/); assert.match(p2, /1 Main St/); assert.match(p2, /mailto:help@acme.test/); assert.doesNotMatch(p2, /being finalised/);
  await t.close();
});

test('payment emails carry an unsubscribe link and the one click header, security alerts do not', () => {
  const opts = { unsubUrl: 'https://dovi.test/unsubscribe?t=abc', business: { name: 'Acme Ltd', address: '1 Main St' } };
  const m = emails.render('claimInvite', { fromName: 'Amara', amountMicro: 5000000n, link: 'https://dovi.test/c/x', expiry: Math.floor(Date.now() / 1000) + 86400 }, opts);
  assert.match(m.html, /Unsubscribe from DOVI emails/); assert.match(m.text, /Unsubscribe: https:\/\/dovi.test\/unsubscribe/); assert.match(m.html, /Acme Ltd/);
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click'); assert.match(m.headers['List-Unsubscribe'], /^<https:\/\/dovi.test/);
  const a = emails.render('securityAlert', { what: 'A new device signed in', when: 'now', link: 'https://dovi.test/app' }, opts);
  assert.doesNotMatch(a.html, /Unsubscribe from DOVI emails/); assert.equal(a.headers, undefined);
});

test('unsubscribe tokens cannot be forged, the link asks first, and one click works and sticks', async () => {
  const s = await boot();
  const t = unsub.token(s.ctx, 'Zed@Mail.com');
  assert.equal(unsub.verify(s.ctx, t), 'zed@mail.com');
  assert.equal(unsub.verify(s.ctx, t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(unsub.verify(s.ctx, Buffer.from('victim@mail.com').toString('base64url') + '.' + 'x'.repeat(32)), null);
  const g = await s.call('GET', '/unsubscribe?t=' + t); assert.equal(g.status, 200);
  const gt = await g.text(); assert.match(gt, /Unsubscribe/); assert.match(gt, /ze…@mail.com/); assert.equal(unsub.isOptedOut(s.ctx.db, 'zed@mail.com'), false, 'a GET never unsubscribes');
  assert.equal((await s.call('GET', '/unsubscribe?t=bad')).status, 400);
  const p = await s.call('POST', '/unsubscribe?t=' + t, { raw: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: undefined } });
  assert.equal(p.status, 200); assert.equal(unsub.isOptedOut(s.ctx.db, 'zed@mail.com'), true);
  await s.close();
});

test('an opted out address gets no payment email, and a security alert still goes out', async () => {
  const w = makeCtx({}); const sent = [];
  w.mailer = { async send(m) { sent.push(m); } };
  unsub.optOut(w, 'zed@mail.com');
  const alice = user(w, 'email:alice@mail.com', [['email', 'alice@mail.com', 'alice@mail.com']]); void alice;
  const send = (kind, data) => claims.mail(w, 'zed@mail.com', kind, data, 'ref');
  send('claimInvite', { fromName: 'A', amountMicro: 1000000n, link: 'https://x/c/1', expiry: Math.floor(Date.now() / 1000) + 99999 });
  send('securityAlert', { what: 'x', when: 'now', link: 'https://x' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1); assert.match(sent[0].subject, /Security alert/);
});

test('a deletion request is recorded once, can be cancelled, and the export has no secrets or hashes', async () => {
  const s = await boot();
  const id = 'email:amy@mail.com';
  const amy = user(s.ctx, id, [['email', 'amy@mail.com', 'amy@mail.com']]);
  s.ctx.db.prepare("INSERT INTO agent_keys (id, user_id, name, key_hash, prefix, per_payment_micro, per_day_micro, created_at) VALUES ('ak_1', ?, 'k', 'SECRETHASH', 'dvk_abcd', '1000000', '2000000', 1)").run(amy.id);
  s.ctx.db.prepare("INSERT INTO intents (user_id, source, raw, typed, status, created_at) VALUES (?, 'ask', 'whats my balance', '{}', 'done', 1)").run(amy.id);
  assert.equal((await s.call('POST', '/api/account/data-request', { body: {} })).status, 401);
  const r1 = await s.call('POST', '/api/account/data-request', { identity: id, body: { kind: 'delete', detail: 'please' } });
  assert.equal(r1.status, 200); const j1 = await r1.json(); assert.equal(j1.request.status, 'open'); assert.ok(j1.request.dueAt - j1.request.createdAt >= 29 * 86400000);
  assert.equal((await s.call('POST', '/api/account/data-request', { identity: id, body: { kind: 'delete' } })).status, 409);
  assert.equal((await s.call('POST', '/api/account/data-request', { identity: id, body: { kind: 'nope' } })).status, 400);
  const ex = await s.call('GET', '/api/account/export', { identity: id });
  assert.equal(ex.status, 200); assert.match(ex.headers.get('content-disposition'), /attachment/);
  const txt = await ex.text(); const data = JSON.parse(txt);
  assert.equal(data.signInIdentities[0].label, 'amy@mail.com'); assert.equal(data.askMessages[0].raw, 'whats my balance'); assert.equal(data.agentKeys[0].prefix, 'dvk_abcd');
  assert.ok(!txt.includes('SECRETHASH'), 'no key hash in the export'); assert.ok(!/key_hash|cdp_sub|recipient_hash|idempotency/.test(txt));
  const c = await s.call('POST', '/api/account/data-request/' + j1.request.id + '/cancel', { identity: id, body: {} });
  assert.equal((await c.json()).request.status, 'declined');
  const other = user(s.ctx, 'email:bo@mail.com', [['email', 'bo@mail.com', 'bo@mail.com']]); void other;
  assert.equal((await s.call('POST', '/api/account/data-request/' + j1.request.id + '/cancel', { identity: 'email:bo@mail.com', body: {} })).status, 404);
  await s.close();
});

test('only an admin can list and close deletion requests', async () => {
  const s = await boot();
  const id = 'email:cat@mail.com'; const cat = user(s.ctx, id, [['email', 'cat@mail.com', 'cat@mail.com']]);
  const r = datareq.create(s.ctx, { userId: cat.id, kind: 'delete' });
  assert.equal((await s.call('GET', '/api/admin/data-requests', { identity: id })).status, 403);
  const adminUser = user(s.ctx, 'email:admin@dovi.test', [['email', 'admin@dovi.test', 'admin@dovi.test']]); void adminUser;
  const l = await s.call('GET', '/api/admin/data-requests', { identity: 'email:admin@dovi.test' });
  assert.equal(l.status, 200); assert.equal((await l.json()).requests[0].who, 'cat@mail.com');
  const d = await s.call('POST', '/api/admin/data-requests/' + r.id, { identity: 'email:admin@dovi.test', body: { status: 'done', note: 'erased' } });
  assert.equal((await d.json()).request.status, 'done');
  await s.close();
});

test('the wallet SDK URL is an exact version and an unsafe override is ignored', async () => {
  const s = await boot();
  const url = async (c) => (await (await c.call('GET', '/api/public/cdp-config')).json()).sdkUrl;
  assert.match(await url(s), /^https:\/\/esm\.sh\/@coinbase\/cdp-core@\d+\.\d+\.\d+$/);
  await s.close();
  const t = await boot(); t.ctx.env = { DOVI_CDP_SDK_URL: 'https://evil.example/sdk.js' };
  assert.match(await url(t), /^https:\/\/esm\.sh\/@coinbase\/cdp-core@/);
  t.ctx.env = { DOVI_CDP_SDK_URL: 'https://esm.sh/@coinbase/cdp-core@0.0.130' };
  assert.equal(await url(t), 'https://esm.sh/@coinbase/cdp-core@0.0.130');
  t.ctx.env = { DOVI_CDP_SDK_URL: 'https://esm.sh/@coinbase/cdp-core' };
  assert.match(await url(t), /@0\.0\.128$/);
  await t.close();
});

test('a statement downloads as a real PDF with a valid cross reference table and the right figures', async () => {
  const { statementPdf } = require('../server/pdf');
  const st = { label: 'October 2026', holder: 'Amy (test)', network: 'Base Sepolia', testnet: true, generatedAt: Date.UTC(2026, 10, 1), feesMicro: '100000', truncated: false,
    totals: { sentMicro: '1000000', sentCount: 1, receivedMicro: '0', receivedCount: 0, returnedMicro: '0', returnedCount: 0, addedMicro: '5000000', addedCount: 1, withdrawnMicro: '0', withdrawnCount: 0 },
    rows: Array.from({ length: 80 }, (_, i) => ({ type: 'Sent', direction: i % 2 ? 'in' : 'out', counterparty: 'ana (x) \\ \u00e9', amountMicro: '1500000', status: 'done', at: Date.UTC(2026, 9, 5, 12, i % 60) })) };
  const buf = statementPdf(st); const txt = buf.toString('latin1');
  assert.ok(txt.startsWith('%PDF-1.4')); assert.ok(txt.trimEnd().endsWith('%%EOF'));
  const sx = Number(/startxref\n(\d+)/.exec(txt)[1]); assert.equal(txt.slice(sx, sx + 4), 'xref');
  const count = Number(/\/Size (\d+)/.exec(txt)[1]);
  const offs = [...txt.slice(sx).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
  assert.equal(offs.length, count - 1);
  offs.forEach((o, i) => assert.equal(txt.slice(o, o + (i + 1 + ' 0 obj').length), (i + 1) + ' 0 obj', 'object ' + (i + 1)));
  assert.ok(/\/Count 2 /.test(txt), 'a long list paginates'); assert.match(txt, /DOVI statement/); assert.match(txt, /\$5\.00/); assert.match(txt, /test network/); assert.match(txt, /ana \\\(x\\\)/, 'parentheses are escaped');
  const s = await boot(); const id = 'email:pdf@mail.com'; user(s.ctx, id, [['email', 'pdf@mail.com', 'pdf@mail.com']]);
  const ym = new Date(s.ctx.now()).toISOString().slice(0, 7);
  assert.equal((await s.call('GET', '/api/statements/' + ym + '/pdf')).status, 401);
  const r = await s.call('GET', '/api/statements/' + ym + '/pdf', { identity: id });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf'); assert.match(r.headers.get('content-disposition'), /dovi-statement-/);
  assert.ok(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString() === '%PDF-');
  assert.equal((await s.call('GET', '/api/statements/2999-01/pdf', { identity: id })).status, 404);
  await s.close();
});

test('waitlist announcement: dry run counts only, opted out and already sent people are skipped, every email has the unsubscribe link and the waitlist reason', async () => {
  const waitlist = require('../server/waitlist');
  const ctx = makeCtx({ env: { DOVI_ENV: 'test' } });
  ctx.cfg.publicUrl = 'https://dovi.test';
  const ins = ctx.db.prepare('INSERT INTO waitlist (x_id, x_handle, name, email, ref_code, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 1, 1)');
  ins.run('1', 'a', 'Ada Obi', 'a@mail.com', 'AAAAAA'); ins.run('2', 'b', 'Bo', 'b@mail.com', 'BBBBBB'); ins.run('3', 'c', 'Cy', null, 'CCCCCC'); ins.run('4', 'd', 'Di', 'd@mail.com', 'DDDDDD');
  unsub.optOut(ctx, 'b@mail.com');
  const sent = []; ctx.mailer = { send: async (m) => { if (m.to === 'd@mail.com') throw new Error('smtp down'); sent.push(m); } };
  const content = { subject: 'DOVI is open', headline: 'DOVI is open', paragraphs: ['You can sign in now.'], ctaLabel: 'Open DOVI', ctaHref: 'https://dovi.test/app' };
  const dry = await waitlist.announce(ctx, { campaign: 'launch-1', content });
  assert.deepEqual([dry.eligible, dry.optedOut, dry.withoutEmail, dry.sent], [2, 1, 1, 0]);
  assert.equal(sent.length, 0);
  const real = await waitlist.announce(ctx, { campaign: 'launch-1', content, send: true });
  assert.deepEqual([real.sent, real.failed], [1, 1]);
  assert.equal(sent[0].to, 'a@mail.com'); assert.match(sent[0].subject, /DOVI is open/); assert.match(sent[0].html, /Hi Ada,/);
  assert.match(sent[0].html, /you joined the DOVI waitlist/); assert.match(sent[0].html, /\/unsubscribe\?t=/); assert.match(sent[0].text, /Unsubscribe: https:\/\/dovi\.test\/unsubscribe/);
  assert.match(sent[0].headers['List-Unsubscribe-Post'], /One-Click/);
  const again = await waitlist.announce(ctx, { campaign: 'launch-1', content, send: true });
  assert.deepEqual([again.alreadySent, again.sent, again.failed], [1, 0, 1]);
  await assert.rejects(waitlist.announce(ctx, { campaign: 'x', content }), /Campaign needs/);
});

test('judges page is public, shows live counts and the contract link, and has no forbidden punctuation', async () => {
  const { ctx, call, close } = await boot({ DOVI_CLAIM_CONTRACT: '0x07e5bE5687b739024f28bf8c85faf1d6E14fDbd4' });
  const r = await call('GET', '/judges');
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /Try DOVI in 60 seconds/);
  assert.match(html, /payments sent/);
  assert.match(html, /0x07e5bE5687b739024f28bf8c85faf1d6E14fDbd4/);
  const text = html.replace(/<[^>]+>/g, '');
  assert.ok(!/[—·]/.test(text));
  await close();
});

test('announcement page is public, names the test network, and makes no mainnet or live-swap claim', async () => {
  const { call, close } = await boot();
  const r = await call('GET', '/announcement');
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /DOVI is live on the/);
  assert.match(html, /0x07e5bE5687b739024f28bf8c85faf1d6E14fDbd4/);
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ');
  assert.ok(!/[—–·]/.test(text));
  assert.match(text, /Mainnet\./);
  assert.match(text, /Not live yet/);
  await close();
});
