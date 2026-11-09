'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { makeCtx, user, ADDR } = require('./helpers');
const { createApp } = require('../server/app');
const { makeHub, makeNotifier } = require('../server/notifications');
const { userFromSession } = require('../server/auth/login');

const OPEN = [];
test.after(async () => { for (const c of OPEN) { try { await c(); } catch { /* already closed */ } } });

function boot(over = {}) {
  const ctx = makeCtx({ env: { DOVI_ENV: 'test', DOVI_ADMINS: 'email:admin@dovi.test', X_CLIENT_ID: 'cid', X_REDIRECT_URI: 'https://dovi.test/api/auth/x/callback', ...(over.env || {}) } });
  ctx.env = {};
  ctx.hub = makeHub({ heartbeatMs: 1e9 });
  ctx.notify = makeNotifier(ctx.db, ctx.hub, ctx.now);
  const secret = 'test-secret';
  ctx.sessions = { mint: (id, jti) => { const p = Buffer.from(JSON.stringify({ id, jti: jti || null, iat: Date.now() })).toString('base64url'); return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('hex'); }, read: (t) => { const i = String(t).lastIndexOf('.'); const p = t.slice(0, i); if (t.slice(i + 1) !== crypto.createHmac('sha256', secret).update(p).digest('hex')) return null; try { const j = JSON.parse(Buffer.from(p, 'base64url').toString()); return { identity: j.id, jti: j.jti, iatMs: j.iat }; } catch { return null; } }, verify: (t) => { const r = ctx.sessions.read(t); return r ? r.identity : null; } };
  ctx.cdpAuth = { mintFor: (id) => 'jwt-for-' + id, jwks: () => ({ keys: [] }) };
  ctx.cdpProxy = (req, res) => { res.writeHead(200); res.end('proxied'); };
  ctx.emailOtp = { start: async () => ({ sent: true, devCode: '123456' }), verify: (email, code) => { if (code !== '123456') throw new Error('Wrong code'); return { email: String(email).toLowerCase(), identity: 'email:' + String(email).toLowerCase() }; } };
  ctx.googleAuth = { verifyGoogleIdToken: async () => ({ sub: 'g123456', email: 'g@x.co', name: 'G' }) };
  ctx.onramp = { onrampUrl: async ({ chain, address }) => ({ url: 'https://pay.coinbase.com/?a=' + address + '&c=' + chain }), providers: () => [{ id: 'coinbase' }] };
  ctx.fetch = over.fetch || (async (url) => (String(url).endsWith('/bob') ? { status: 200, json: async () => ({ user: { id: '555', screen_name: 'bob', protected: false } }) } : { status: 302, json: async () => ({}) }));
  const { handler } = createApp(ctx);
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = 'http://127.0.0.1:' + server.address().port;
    const origin = ctx.cfg.publicUrl;
    const cookieFor = (identity) => 'dovi_sess=' + encodeURIComponent(ctx.sessions.mint(identity));
    let xs = null;
    const call = async (method, path, { body, identity, headers = {}, noOrigin } = {}) => {
      const jar = [identity ? cookieFor(identity) : null, headers.cookie, xs ? 'dovi_xs=' + xs : null].filter(Boolean).join('; ');
      const r = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(noOrigin ? {} : { origin }), ...headers, ...(jar ? { cookie: jar } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const m = /dovi_xs=([A-Za-z0-9_-]+)/.exec((r.headers.getSetCookie ? r.headers.getSetCookie() : []).join(';')); if (m) xs = m[1];
      return r;
    };
    const close = () => { ctx.hub.close(); server.closeAllConnections(); return new Promise((r) => server.close(r)); };
    OPEN.push(close);
    resolve({ ctx, base, call, cookieFor, close });
  }));
}

test('money routes need a session, and an unknown route is a clean 404', async () => {
  const s = await boot();
  for (const [m, p] of [['POST', '/api/claims/draft'], ['GET', '/api/me'], ['POST', '/api/agent'], ['GET', '/api/activity'], ['GET', '/api/notifications'], ['POST', '/api/send/prepare']]) {
    const r = await s.call(m, p, { body: m === 'POST' ? {} : undefined });
    assert.equal(r.status, 401, m + ' ' + p);
  }
  assert.equal((await s.call('GET', '/api/nope')).status, 404);
  await s.close();
});

test('REGRESSION: the CDP token is only minted for a verified session, never for a client-supplied id', async () => {
  const s = await boot();
  const anon = await s.call('POST', '/api/auth/cdp-jwt', { body: { id: 'email:victim@mail.com' } });
  assert.equal(anon.status, 401);
  const qs = await s.call('POST', '/api/auth/cdp-jwt?id=email:victim@mail.com');
  assert.equal(qs.status, 401);
  const mine = await s.call('POST', '/api/auth/cdp-jwt', { identity: 'email:me@mail.com', body: { id: 'email:victim@mail.com' } });
  assert.equal((await mine.json()).jwt, 'jwt-for-email:me@mail.com');
  await s.close();
});

test('state changing requests need a matching Origin and bodies are bounded and validated', async () => {
  const s = await boot();
  userFromSession(s.ctx, 'email:a@b.co');
  assert.equal((await s.call('POST', '/api/agent', { identity: 'email:a@b.co', body: { text: 'balance' }, noOrigin: true })).status, 403);
  assert.equal((await s.call('POST', '/api/agent', { identity: 'email:a@b.co', body: { text: 'balance' }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await s.call('POST', '/api/agent', { identity: 'email:a@b.co', body: { text: 'balance' } })).status, 200);
  const big = await fetch(s.base + '/api/agent', { method: 'POST', headers: { origin: s.ctx.cfg.publicUrl, cookie: s.cookieFor('email:a@b.co'), 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(100000) }) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  const bad = await fetch(s.base + '/api/agent', { method: 'POST', headers: { origin: s.ctx.cfg.publicUrl, cookie: s.cookieFor('email:a@b.co'), 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  await s.close();
});

test('login routes are rate limited', async () => {
  const s = await boot();
  let last;
  for (let i = 0; i < 10; i++) last = await s.call('POST', '/api/auth/email/start', { body: { email: 'a@b.co' } });
  assert.equal(last.status, 429);
  await s.close();
});

test('email login creates the user, sets an HttpOnly cookie, and the session identity is the wallet identity', async () => {
  const s = await boot();
  const r = await s.call('POST', '/api/auth/email/verify', { body: { email: 'Amara@Mail.com', code: '123456' } });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /dovi_sess=.*HttpOnly/);
  const cookie = sc.split(';')[0];
  const me = await (await fetch(s.base + '/api/me', { headers: { cookie } })).json();
  assert.equal(me.user.identities[0].label, 'amara@mail.com');
  const bad = await s.call('POST', '/api/auth/email/verify', { body: { email: 'a@b.co', code: '000000' } });
  assert.equal(bad.status, 400);
  await s.close();
});

test('X sign in redirects to X, and the callback sets the session and keeps the id when the handle changes', async () => {
  const s = await boot({ fetch: async (url) => (String(url).includes('oauth2/token') ? { ok: true, json: async () => ({ access_token: 't' }) } : { ok: true, json: async () => ({ data: { id: '555', username: 'bob_new', name: 'Bob' } }) }) });
  const start = await s.call('GET', '/api/auth/x/start');
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.hostname, 'twitter.com');
  const state = loc.searchParams.get('state');
  const cb = await s.call('GET', '/api/auth/x/callback?code=abc&state=' + state);
  assert.equal(cb.status, 302);
  assert.match(cb.headers.get('set-cookie'), /dovi_sess=/);
  const u = s.ctx.db.prepare("SELECT * FROM identities WHERE kind = 'x'").get();
  assert.equal(u.provider_id, '555'); assert.equal(u.label, '@bob_new');
  const bad = await s.call('GET', '/api/auth/x/callback?code=abc&state=nope');
  assert.match(bad.headers.get('location'), /login_error=x_bad_state/);
  await s.close();
});

test('status and chains are generated from the registry and say Base only', async () => {
  const s = await boot();
  const st = await (await s.call('GET', '/api/status')).json();
  assert.deepEqual(st.live, ['base']);
  assert.deepEqual(st.soon.sort(), ['arc', 'robinhood', 'sui', 'solana'].sort());
  assert.equal(st.statusLine, 'Live on Base. Solana, Sui, Arc, Robinhood Chain coming soon.');
  assert.equal(st.claims.feeBps, 100); assert.equal(st.claims.maxFeeBps, 150);
  const ch = await (await s.call('GET', '/api/chains')).json();
  assert.equal(ch.chains.find((c) => c.id === 'solana').status, 'soon');
  assert.ok(ch.chains.every((c) => !('chainId' in c)));
  await s.close();
});

test('removed features are gone: launch, trade and raise routes return 404', async () => {
  const s = await boot();
  for (const p of ['/api/launch/config', '/api/launch/tokens', '/api/trade/build', '/api/launch/build', '/api/raise']) assert.equal((await s.call('GET', p)).status, 404, p);
  await s.close();
});

test('static files cannot escape the public folder and unknown paths are 404', async () => {
  const s = await boot();
  assert.equal((await fetch(s.base + '/..%2Fserver%2Fconfig.js')).status, 404);
  assert.equal((await fetch(s.base + '/../server/config.js')).status, 404);
  assert.equal((await fetch(s.base + '/server/config.js')).status, 404);
  assert.equal((await fetch(s.base + '/healthz')).status, 200);
  await s.close();
});

test('admin routes need the allowlist, and flipping a testnet chain live is refused and audited as nothing', async () => {
  const s = await boot();
  assert.equal((await s.call('GET', '/api/admin/earnings', { identity: 'email:nobody@x.co' })).status, 403);
  assert.equal((await s.call('GET', '/api/admin/earnings', { identity: 'email:admin@dovi.test' })).status, 200);
  const bad = await s.call('POST', '/api/admin/chain', { identity: 'email:admin@dovi.test', body: { id: 'arc', status: 'live' } });
  assert.equal(bad.status, 400);
  const off = await s.call('POST', '/api/admin/chain', { identity: 'email:admin@dovi.test', body: { id: 'base', status: 'off' } });
  assert.equal(off.status, 200);
  const paused = await s.call('POST', '/api/claims/resolve', { identity: 'email:admin@dovi.test', body: { to: 'a@b.co' } });
  assert.equal(paused.status, 200);
  const draft = await s.call('POST', '/api/claims/draft', { identity: 'email:admin@dovi.test', body: { to: 'a@b.co', amount: '5', address: ADDR.alice } });
  assert.equal(draft.status, 503);
  assert.equal((await draft.json()).error, 'chain_not_live');
  assert.equal(s.ctx.db.prepare("SELECT status FROM chain_status WHERE id = 'base'").get().status, 'off');
  await s.close();
});

test('full flow over HTTP: draft, fund, public view, wrong user refused, right user claims, activity and notifications appear', async () => {
  const s = await boot();
  const alice = userFromSession(s.ctx, 'email:alice@mail.com');
  const bobId = 'x:555';
  userFromSession(s.ctx, bobId);
  s.ctx.db.prepare("INSERT OR IGNORE INTO identities (user_id, kind, provider_id, label, verified_at) SELECT id, 'x', '555', '@bob', 1 FROM users WHERE cdp_sub = 'x:555'").run();
  const a = 'email:alice@mail.com';
  const d = await (await s.call('POST', '/api/claims/draft', { identity: a, body: { to: '@bob', amount: '5', address: ADDR.alice, idempotencyKey: 'k1' } })).json();
  assert.equal(d.status, 'draft'); assert.equal(d.preview.lines[2].value, '$5.10');
  const row = s.ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(d.claimId);
  s.ctx.chain.onchainCreate(d.claimId, { sender: ADDR.alice, amount: row.amount_micro, fee: row.fee_micro, expiry: row.expiry, recipientHash: row.recipient_hash });
  assert.equal((await (await s.call('POST', '/api/claims/' + d.claimId + '/funded', { identity: a, body: { txHash: '0x' + '1'.repeat(64) } })).json()).status, 'funded');
  const pubv = await (await s.call('GET', '/api/claims/' + d.claimId)).json();
  assert.equal(pubv.status, 'funded'); assert.ok(!('sender_address' in pubv) && !('recipientHash' in pubv));
  const carol = 'email:carol@mail.com';
  assert.equal((await s.call('POST', '/api/claims/' + d.claimId + '/prepare-claim', { identity: carol, body: { address: ADDR.carol } })).status, 403);
  const pc = await s.call('POST', '/api/claims/' + d.claimId + '/prepare-claim', { identity: bobId, body: { address: ADDR.bob } });
  assert.equal(pc.status, 200);
  assert.ok((await pc.json()).attestation);
  s.ctx.chain.onchainClaim(d.claimId);
  assert.equal((await (await s.call('POST', '/api/claims/' + d.claimId + '/claimed', { identity: bobId, body: { txHash: '0x' + '2'.repeat(64) } })).json()).status, 'claimed');
  const act = await (await s.call('GET', '/api/activity', { identity: a })).json();
  assert.equal(act.activity[0].kind, 'claim_sent');
  const nt = await (await s.call('GET', '/api/notifications', { identity: a })).json();
  assert.ok(nt.unread >= 2);
  const read = await (await s.call('POST', '/api/notifications/read', { identity: a, body: { ids: 'all' } })).json();
  assert.equal(read.unread, 0);
  assert.equal(alice.id > 0, true);
  await s.close();
});

test('the live notification stream delivers a new event to the signed-in user only', async () => {
  const s = await boot();
  const u = userFromSession(s.ctx, 'email:a@b.co');
  const other = userFromSession(s.ctx, 'email:z@b.co');
  const ac = new AbortController();
  const r = await fetch(s.base + '/api/notifications/stream', { headers: { cookie: s.cookieFor('email:a@b.co') }, signal: ac.signal });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader();
  await reader.read();
  s.ctx.notify(other.id, { type: 'system', title: 'secret for z', privateTitle: 'x', body: 'b' });
  s.ctx.notify(u.id, { type: 'system', title: 'hello a', privateTitle: 'x', body: 'b' });
  const { value } = await reader.read();
  const text = Buffer.from(value).toString();
  assert.match(text, /hello a/); assert.doesNotMatch(text, /secret for z/);
  ac.abort();
  await s.close();
});

test('direct send to an existing DOVI user has no fee, and unknown recipients fall back to a claim', async () => {
  const s = await boot();
  const a = 'email:alice@mail.com';
  const alice = userFromSession(s.ctx, a);
  const bob = userFromSession(s.ctx, 'x:555');
  s.ctx.db.prepare("UPDATE identities SET label = '@bob' WHERE user_id = ?").run(bob.id);
  const none = await (await s.call('POST', '/api/send/prepare', { identity: a, body: { to: '@bob', amount: '3', address: ADDR.alice } })).json();
  assert.equal(none.mode, 'claim');
  await s.call('POST', '/api/me/address', { identity: 'x:555', body: { address: ADDR.bob } });
  await s.call('POST', '/api/me/address', { identity: a, body: { address: ADDR.alice } });
  const p = await (await s.call('POST', '/api/send/prepare', { identity: a, body: { to: '@bob', amount: '3', address: ADDR.alice } })).json();
  assert.equal(p.mode, 'direct'); assert.equal(p.preview.lines[2].value, '$0.00');
  const tx = '0x' + '9'.repeat(64);
  const miss = await s.call('POST', '/api/send/confirmed', { identity: a, body: { txHash: tx, to: ADDR.bob, amount: '3' } });
  assert.equal(miss.status, 409);
  s.ctx.chain.transfers.set(tx, { status: 'success', transfers: [{ token: s.ctx.cfg.base.usdc, from: ADDR.alice, to: ADDR.bob, value: '3000000' }] });
  const ok = await s.call('POST', '/api/send/confirmed', { identity: a, body: { txHash: tx, to: ADDR.bob, amount: '3', label: '@bob' } });
  assert.equal(ok.status, 200);
  const dup = await (await s.call('POST', '/api/send/confirmed', { identity: a, body: { txHash: tx, to: ADDR.bob, amount: '3' } })).json();
  assert.equal(dup.duplicate, true);
  const carol = 'email:carol@mail.com'; userFromSession(s.ctx, carol);
  await s.call('POST', '/api/me/address', { identity: carol, body: { address: ADDR.carol || '0x' + 'c'.repeat(40) } });
  const stolen = await s.call('POST', '/api/send/confirmed', { identity: carol, body: { txHash: tx, to: ADDR.bob, amount: '3' } });
  assert.equal(stolen.status, 409);
  const stolen2 = await s.call('POST', '/api/send/confirmed', { identity: carol, body: { address: ADDR.alice, to: ADDR.bob, amount: '3' } });
  assert.equal(stolen2.status, 403);
  assert.equal(s.ctx.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind IN ('send','receive')").get().n, 2);
  const tx2 = '0x' + '8'.repeat(64);
  const none2 = await s.call('POST', '/api/send/confirmed', { identity: a, body: { address: ADDR.alice, to: ADDR.bob, amount: '3' } });
  assert.equal(none2.status, 409);
  s.ctx.chain.found = { txHash: tx2 };
  const viaLookup = await (await s.call('POST', '/api/send/confirmed', { identity: a, body: { address: ADDR.alice, to: ADDR.bob, amount: '3', label: '@bob' } })).json();
  assert.equal(viaLookup.txHash, tx2);
  assert.equal(alice.id > 0, true);
  await s.close();
});

test('requests reach an existing user and cannot be self-addressed', async () => {
  const s = await boot();
  const a = 'email:alice@mail.com';
  userFromSession(s.ctx, a);
  const bob = userFromSession(s.ctx, 'x:555');
  s.ctx.db.prepare("UPDATE identities SET label = '@bob' WHERE user_id = ?").run(bob.id);
  const r = await (await s.call('POST', '/api/requests', { identity: a, body: { to: '@bob', amount: '4', note: 'lunch' } })).json();
  assert.equal(r.delivered, true);
  const inc = await (await s.call('GET', '/api/requests', { identity: 'x:555' })).json();
  assert.equal(inc.incoming.length, 1);
  assert.equal((await s.call('POST', '/api/requests', { identity: a, body: { to: 'alice@mail.com', amount: '4' } })).status, 400);
  await s.close();
});

test('the agent route returns a preview then an approvable action over HTTP', async () => {
  const s = await boot();
  const a = 'email:alice@mail.com';
  userFromSession(s.ctx, a);
  const r = await (await s.call('POST', '/api/agent', { identity: a, body: { text: 'send 5 to @bob' } })).json();
  assert.equal(r.ok, true);
  const ap = await (await s.call('POST', '/api/agent/' + r.intentId + '/approve', { identity: a })).json();
  assert.equal(ap.action.type, 'create_claim');
  const nope = await (await s.call('POST', '/api/agent', { identity: a, body: { text: 'swap 5 usdc for eth' } })).json();
  assert.equal(nope.ok, false);
  await s.close();
});

test('the test USDC faucet exists only on the test network and reports a spent daily limit', async () => {
  const main = await boot();
  const id = 'email:a@x.co'; userFromSession(main.ctx, id);
  assert.equal((await main.call('POST', '/api/faucet/usdc', { identity: id, body: { address: ADDR.alice } })).status, 404);
  const tn = await boot();
  tn.ctx.cfg.base.testnet = true;
  userFromSession(tn.ctx, id);
  tn.ctx.faucet = { requestTestUsdc: async () => ({ granted: 10, reason: '' }) };
  const ok = await tn.call('POST', '/api/faucet/usdc', { identity: id, body: { address: ADDR.alice } });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).usdc, 10);
  tn.ctx.faucet = { requestTestUsdc: async () => ({ granted: 0, reason: 'rate limit' }) };
  assert.equal((await tn.call('POST', '/api/faucet/usdc', { identity: id, body: { address: ADDR.alice } })).status, 429);
  assert.equal((await tn.call('POST', '/api/faucet/usdc', { body: { address: ADDR.alice } })).status, 401);
});

const dripBoot = async (identity) => {
  const tn = await boot(); tn.ctx.cfg.base.testnet = true; userFromSession(tn.ctx, identity);
  tn.ctx.faucet = { requestTestUsdc: async () => ({ granted: 0, reason: 'project limit' }) };
  tn.ctx.sent = [];
  tn.ctx.executor = { address: async () => ADDR.bob, sendUsdc: async (x) => { tn.ctx.sent.push(x); return { txHash: '0x1' }; } };
  tn.ctx.chain = { usdcBalance: async () => 50000000n };
  return tn;
};
const dripCall = (tn, identity, address) => tn.call('POST', '/api/faucet/usdc', { identity, body: { address } });

test('when the shared faucet is at its limit a new account gets one starter amount from the executor wallet', async () => {
  const id = 'email:drip@x.co'; const tn = await dripBoot(id);
  const first = await dripCall(tn, id, ADDR.alice);
  assert.equal(first.status, 200); const j = await first.json(); assert.equal(j.usdc, 5); assert.equal(j.starter, true);
  assert.equal(tn.ctx.sent.length, 1); assert.equal(tn.ctx.sent[0].amountMicro, 5000000n);
  assert.equal((await dripCall(tn, id, ADDR.alice)).status, 429); assert.equal(tn.ctx.sent.length, 1);
});

test('the starter amount is skipped when the executor wallet is low, and a failed send can be retried', async () => {
  const id = 'email:drip2@x.co'; const tn = await dripBoot(id);
  tn.ctx.chain = { usdcBalance: async () => 1000000n };
  assert.equal((await dripCall(tn, id, ADDR.bob)).status, 429);
  tn.ctx.chain = { usdcBalance: async () => 50000000n };
  tn.ctx.executor.sendUsdc = async () => { throw new Error('rpc'); };
  assert.equal((await dripCall(tn, id, ADDR.bob)).status, 429);
  tn.ctx.executor.sendUsdc = async (x) => { tn.ctx.sent.push(x); return {}; };
  const ok = await dripCall(tn, id, ADDR.bob); assert.equal(ok.status, 200); assert.equal(tn.ctx.sent.length, 1);
});

test('CSP reports are counted per directive and blocked origin, capped, and only admins can read them', async () => {
  const s = await boot();
  const post = (b) => fetch(s.base + '/api/csp-report', { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: JSON.stringify(b) });
  assert.equal((await post({ 'csp-report': { 'effective-directive': 'connect-src', 'blocked-uri': 'https://api.example.com/path?x=1' } })).status, 200);
  assert.equal((await post([{ type: 'csp-violation', body: { effectiveDirective: 'connect-src', blockedURL: 'https://api.example.com/other' } }])).status, 200);
  assert.equal((await post({ 'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'inline' } })).status, 200);
  assert.equal((await post({ nonsense: true })).status, 200);
  const list = await s.call('GET', '/api/admin/csp', { identity: 'email:admin@dovi.test' });
  const j = await list.json();
  const c = j.violations.find((v) => v.directive === 'connect-src' && v.blocked === 'https://api.example.com');
  assert.equal(c.count, 2);
  assert.ok(j.violations.find((v) => v.directive === 'script-src' && v.blocked === 'inline'));
  assert.equal((await s.call('GET', '/api/admin/csp', { identity: 'email:someone@else.co' })).status, 403);
  assert.equal((await s.call('GET', '/api/admin/csp')).status, 401);
});

test('a signed in X user can link an email, and the same email cannot be linked to a second account', async () => {
  const s = await boot();
  const a = await s.call('POST', '/api/auth/email/verify', { identity: 'x:555', body: { email: 'Bob@Mail.com', code: '123456', link: true } });
  assert.equal(a.status, 200);
  const j = await a.json(); assert.equal(j.linked, true); assert.equal(a.headers.get('set-cookie'), null);
  s.ctx.db.prepare("INSERT OR IGNORE INTO users (cdp_sub, created_at) VALUES ('x:555', 1)").run();
  const mine = await (await s.call('GET', '/api/me', { identity: 'x:555' })).json();
  assert.ok(mine.user.identities.some((i) => i.kind === 'email' && i.label === 'bob@mail.com'));
  const login = await s.call('POST', '/api/auth/email/verify', { body: { email: 'bob@mail.com', code: '123456' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const again = await (await fetch(s.base + '/api/me', { headers: { cookie } })).json();
  assert.equal(again.user.id, mine.user.id);
  const other = await s.call('POST', '/api/auth/email/verify', { identity: 'email:someone@else.com', body: { email: 'bob@mail.com', code: '123456', link: true } });
  assert.equal(other.status, 409);
  assert.equal((await other.json()).error, 'identity_taken');
  const anon = await s.call('POST', '/api/auth/email/verify', { body: { email: 'bob@mail.com', code: '123456', link: true } });
  assert.equal(anon.status, 401);
  await s.close();
});

test('X link from a signed in email user adds the X identity to the same account and returns with linked=x', async () => {
  const s = await boot({ fetch: async (url) => (String(url).includes('oauth2/token') ? { ok: true, json: async () => ({ access_token: 't' }) } : { ok: true, json: async () => ({ data: { id: '777', username: 'amara', name: 'Amara' } }) }) });
  const login = await s.call('POST', '/api/auth/email/verify', { body: { email: 'amara@mail.com', code: '123456' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const me0 = await (await fetch(s.base + '/api/me', { headers: { cookie } })).json();
  const start = await s.call('GET', '/api/auth/x/start?return=' + encodeURIComponent('/app#account'), { headers: { cookie } });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const cb = await s.call('GET', '/api/auth/x/callback?code=abc&state=' + state);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/app?linked=x#account');
  assert.doesNotMatch(cb.headers.get('set-cookie') || '', /dovi_sess=/);
  const me1 = await (await fetch(s.base + '/api/me', { headers: { cookie } })).json();
  assert.equal(me1.user.id, me0.user.id);
  assert.deepEqual(me1.user.identities.map((i) => i.kind).sort(), ['email', 'x']);
  await s.close();
});

test('waitlist: X login joins with a permanent code, a referral counts once, email is saved, the cookie lasts a year', async () => {
  const people = { c1: { id: '1001', username: 'ada', name: 'Ada', profile_image_url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' }, c2: { id: '1002', username: 'bo', name: 'Bo' } };
  const s = await boot({ fetch: async (url, init) => {
    if (String(url).includes('oauth2/token')) return { ok: true, json: async () => ({ access_token: String(init.body).match(/code=(c\d)/)[1] }) };
    return { ok: true, json: async () => ({ data: people[String(init.headers.authorization).replace('Bearer ', '')] }) };
  } });
  s.ctx.env = { X_CLIENT_SECRET: 'sec' };
  s.ctx.cfg.x.clientSecret = 'sec';
  const origin = 'https://dovi.finance';
  const join = async (code, ref) => {
    const st = await s.call('GET', '/api/waitlist/x/start' + (ref ? '?ref=' + ref : ''));
    assert.equal(st.status, 302);
    const loc = new URL(st.headers.get('location'));
    assert.equal(loc.searchParams.get('redirect_uri'), 'https://dovi.finance/api/waitlist/x/callback');
    return s.call('GET', '/api/waitlist/x/callback?code=' + code + '&state=' + loc.searchParams.get('state'), { noOrigin: true });
  };
  const cfg = await (await fetch(s.base + '/api/waitlist/config')).json(); assert.equal(cfg.x, true);
  const a = await join('c1');
  assert.equal(a.status, 302); assert.match(a.headers.get('location'), /^\/waitlist\?joined=1/);
  const sc = a.headers.get('set-cookie'); assert.match(sc, /dovi_wl=.*HttpOnly/); assert.match(sc, /Max-Age=31536000/);
  const ca = sc.split(';')[0];
  const me = await (await fetch(s.base + '/api/waitlist/me', { headers: { cookie: ca } })).json();
  assert.equal(me.profile.handle, '@ada'); assert.equal(me.profile.position, 1); assert.match(me.profile.refCode, /^[2-9A-HJKMNP-Z]{8}$/);
  assert.match(me.profile.avatarUrl, /_400x400/);
  const again = await join('c1');
  assert.equal(again.headers.get('location'), '/waitlist');
  assert.equal((await (await fetch(s.base + '/api/waitlist/me', { headers: { cookie: again.headers.get('set-cookie').split(';')[0] } })).json()).profile.refCode, me.profile.refCode);
  const b = await join('c2', me.profile.refCode);
  assert.equal(b.status, 302);
  const me2 = await (await fetch(s.base + '/api/waitlist/me', { headers: { cookie: ca } })).json();
  assert.equal(me2.profile.referrals, 1);
  assert.equal((await fetch(s.base + '/api/waitlist/me')).status, 401);
  assert.equal((await fetch(s.base + '/api/waitlist/me', { headers: { cookie: 'dovi_wl=' + ca.split('=')[1].replace(/.$/, 'x') } })).status, 401);
  const post = (path, body, cookie) => fetch(s.base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body || {}) });
  assert.equal((await post('/api/waitlist/email', { email: 'nope' }, ca)).status, 400);
  assert.equal((await (await post('/api/waitlist/email', { email: 'Ada@Mail.com' }, ca)).json()).profile.email, 'ada@mail.com');
  const locked = await post('/api/waitlist/email', { email: 'other@mail.com' }, ca);
  assert.equal(locked.status, 409); assert.equal((await locked.json()).error, 'email_locked');
  assert.equal((await (await fetch(s.base + '/api/waitlist/me', { headers: { cookie: ca } })).json()).profile.email, 'ada@mail.com');
  assert.equal((await post('/api/waitlist/email', { email: 'a@b.co' })).status, 401);
  const evil = await fetch(s.base + '/api/waitlist/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.test', cookie: ca }, body: JSON.stringify({ email: 'x@y.co' }) });
  assert.equal(evil.status, 403);
  const bad = await s.call('GET', '/api/waitlist/x/callback?code=c1&state=nope', { noOrigin: true });
  assert.match(bad.headers.get('location'), /^\/waitlist\?error=x_bad_state/);
  await s.close();
});

test('Ask: a free daily message limit is counted per user, answers carry the usage, and the limit message is a clean refusal', async () => {
  const s = await boot();
  s.ctx.cfg.askDailyFree = 3;
  const id = 'email:ask@mail.com';
  const ask = (text) => s.call('POST', '/api/agent', { identity: id, body: { text } });
  const u0 = await (await s.call('GET', '/api/agent/usage', { identity: id })).json();
  assert.equal(u0.limit, 3); assert.equal(u0.remaining, 3);
  for (let i = 0; i < 3; i++) { const r = await (await ask('show my history')).json(); assert.equal(r.usage.remaining, 2 - i); }
  const over = await (await ask('show my history')).json();
  assert.equal(over.ok, false); assert.equal(over.code, 'ask_limit'); assert.equal(over.usage.remaining, 0); assert.ok(over.usage.resetsAt > s.ctx.now());
  const other = await (await s.call('POST', '/api/agent', { identity: 'email:other@mail.com', body: { text: 'show my history' } })).json();
  assert.equal(other.usage.remaining, 2);
  const counts = s.ctx.db.prepare('SELECT intent, SUM(n) AS n FROM ask_intents GROUP BY intent').all();
  assert.equal(counts.find((c) => c.intent === 'history').n, 4);
  assert.deepEqual(Object.keys(s.ctx.db.prepare('SELECT * FROM ask_intents').get()).sort(), ['day', 'intent', 'n']);
  await s.close();
});

test('payment links: need a linked X, are public by code, enforce a fixed amount, count funded payments, and can be turned off', async () => {
  const s = await boot();
  const bob = 'x:555';
  userFromSession(s.ctx, bob);
  s.ctx.db.prepare("UPDATE identities SET label = '@bob' WHERE kind = 'x' AND provider_id = '555'").run();
  userFromSession(s.ctx, 'email:alice@mail.com');
  const mk = (identity, body) => s.call('POST', '/api/paylinks', { identity, body });
  { const r0 = await mk('email:carol@mail.com', { title: 'Logo work' }); const t0 = await r0.text(); assert.equal(r0.status, 400, 'BODY ' + t0); }
  assert.equal((await mk(bob, { title: 'x' })).status, 400);
  assert.equal((await mk(bob, { title: 'Logo work', amount: '99999999' })).status, 400);
  const fr = await mk(bob, { title: 'Logo work', amount: '5' }); const fj = await fr.json(); assert.equal(fr.status, 200, 'BODY ' + JSON.stringify(fj)); const fixed = fj.link;
  const open = (await (await mk(bob, { title: 'Tip jar' })).json()).link;
  assert.match(fixed.url, /\/p\/[2-9a-hj-km-np-zA-HJ-NP-Z]{8}$/); assert.equal(fixed.amountMicro, '5000000'); assert.equal(open.amountMicro, null);
  const pub = await (await fetch(s.base + '/api/paylinks/' + fixed.code)).json();
  assert.equal(pub.handle, '@bob'); assert.equal(pub.title, 'Logo work'); assert.equal(pub.amountMicro, '5000000');
  assert.ok(!JSON.stringify(pub).includes('mail'));
  const plHtml = await (await fetch(s.base + '/p/' + fixed.code)).text();
  assert.match(plHtml, /<title>Logo work \| Pay @bob on DOVI<\/title>/); assert.match(plHtml, /\$5\.00 to @bob in dollars/);
  assert.equal((await fetch(s.base + '/api/paylinks/AAAAAAAA')).status, 404);
  const alice = 'email:alice@mail.com';
  const wrong = await s.call('POST', '/api/claims/draft', { identity: alice, body: { paylink: fixed.code, to: '@someone', amount: '6', address: ADDR.alice } });
  assert.equal(wrong.status, 400); assert.equal((await wrong.json()).error, 'amount_fixed');
  const own = await s.call('POST', '/api/claims/draft', { identity: bob, body: { paylink: fixed.code, amount: '5', address: ADDR.bob || ADDR.alice } });
  assert.equal(own.status, 400); assert.equal((await own.json()).error, 'own_link');
  const d = await (await s.call('POST', '/api/claims/draft', { identity: alice, body: { paylink: fixed.code, to: '@ignored', amount: '5', address: ADDR.alice, idempotencyKey: 'pl1' } })).json();
  assert.ok(d.claimId, JSON.stringify(d));
  const rec = () => s.ctx.db.prepare("SELECT COUNT(*) n FROM paylink_payments").get().n;
  assert.equal(Number(rec()), 1);
  let list = (await (await s.call('GET', '/api/paylinks', { identity: bob })).json());
  assert.equal(list.handle, '@bob'); assert.match(list.payMeUrl, /\/pay\/bob$/);
  assert.equal(list.links.find((l) => l.code === fixed.code).payments, 0);
  s.ctx.db.prepare("UPDATE claims SET status = 'funded' WHERE id = ?").run(d.claimId);
  list = (await (await s.call('GET', '/api/paylinks', { identity: bob })).json());
  const row = list.links.find((l) => l.code === fixed.code); assert.equal(row.payments, 1); assert.equal(row.totalMicro, '5000000');
  assert.equal((await s.call('POST', '/api/paylinks/' + fixed.code + '/active', { identity: alice, body: { active: false } })).status, 404);
  const off = await (await s.call('POST', '/api/paylinks/' + fixed.code + '/active', { identity: bob, body: { active: false } })).json();
  assert.equal(off.link.active, false);
  assert.equal((await fetch(s.base + '/api/paylinks/' + fixed.code)).status, 404);
  const gone = await s.call('POST', '/api/claims/draft', { identity: alice, body: { paylink: fixed.code, amount: '5', address: ADDR.alice } });
  assert.equal(gone.status, 404);
  await s.close();
});

test('pay-me page routes serve the pay page, and the test network says noindex', async () => {
  const s = await boot();
  s.ctx.cfg.base.testnet = true;
  for (const p of ['/pay/bob', '/pay/@bob', '/p/2bcDEFgh']) { const r = await fetch(s.base + p); assert.equal(r.status, 200, p); assert.match(r.headers.get('x-robots-tag') || '', /noindex/); }
  assert.equal((await fetch(s.base + '/p/short')).status, 404);
  assert.match(await (await fetch(s.base + '/robots.txt')).text(), /Disallow: \//);
  await s.close();
});

test('pay pages carry link preview tags on the public domain and hand the payment to the app by URL', async () => {
  const s = await boot();
  s.ctx.cfg.payBaseUrl = 'https://dovi.finance'; s.ctx.cfg.ogImage = 'https://dovi.finance/assets/og.jpg';
  const html = await (await fetch(s.base + '/pay/bob')).text();
  assert.match(html, /<title>Pay @bob on DOVI<\/title>/); assert.match(html, /property="og:url" content="https:\/\/dovi\.finance\/pay\/bob"/);
  assert.match(html, /property="og:image" content="https:\/\/dovi\.finance\/assets\/og\.jpg"/); assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /name="dovi-app" content="http/);
  assert.equal((html.match(/<title>/g) || []).length, 1);
  const evil = await (await fetch(s.base + '/pay/%3Cscript%3E')).status; assert.equal(evil, 404);
  await s.close();
});

test('recent recipients lists only the signed in user\'s own latest counterparties, newest first', async () => {
  const s = await boot();
  const a = userFromSession(s.ctx, 'email:alice@mail.com'); const b = userFromSession(s.ctx, 'email:bob2@mail.com');
  const ins = (uid, kind, who, t) => s.ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uid, kind, 'r' + t, who, '1000000', 'done', t);
  ins(a.id, 'send', '@old', 1); ins(a.id, 'claim_funded', 'x@y.co', 3); ins(a.id, 'send', '@old', 5); ins(a.id, 'receive', '@notme', 6); ins(b.id, 'send', '@secret', 7);
  const r = await (await s.call('GET', '/api/recipients/recent', { identity: 'email:alice@mail.com' })).json();
  assert.deepEqual(r.recent.map((x) => x.label), ['@old', 'x@y.co']);
  assert.equal((await s.call('GET', '/api/recipients/recent')).status, 401);
  await s.close();
});

test('activity: filters by group, text and date, pages with before, and exports a safe CSV', async () => {
  const s = await boot();
  const u = userFromSession(s.ctx, 'email:alice@mail.com'); const other = userFromSession(s.ctx, 'email:zed@mail.com');
  const day = 86400000; const t0 = s.ctx.now();
  const ins = (uid, kind, who, micro, at, ref) => s.ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uid, kind, ref || 'r' + at, who, micro, 'done', at);
  ins(u.id, 'send', '@bob', '5000000', t0 - 40 * day); ins(u.id, 'receive', '@kofi', '2500000', t0 - 5 * day); ins(u.id, 'topup', 'Coinbase', '10000000', t0 - 2 * day);
  ins(u.id, 'claim_returned', '=cmd|x', '1000000', t0 - 1 * day, 'ref,with"quote'); ins(other.id, 'send', '@secret', '9000000', t0);
  const id = 'email:alice@mail.com';
  const get = async (qs) => (await (await s.call('GET', '/api/activity' + qs, { identity: id })).json()).activity;
  assert.equal((await get('')).length, 4);
  assert.deepEqual((await get('?group=sent')).map((x) => x.counterparty), ['@bob']);
  assert.deepEqual((await get('?group=added')).map((x) => x.kind), ['topup']);
  assert.deepEqual((await get('?q=kofi')).map((x) => x.counterparty), ['@kofi']);
  assert.equal((await get('?q=%25')).length, 0);
  assert.equal((await get('?since=' + (t0 - 10 * day))).length, 3);
  const page1 = await get('?limit=2'); assert.equal(page1.length, 2);
  const page2 = await get('?limit=2&before=' + page1[1].id); assert.equal(page2.length, 2); assert.ok(!page2.some((x) => page1.some((y) => y.id === x.id)));
  const csv = await s.call('GET', '/api/activity/export?group=returned', { identity: id });
  assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(csv.headers.get('content-disposition'), /attachment; filename="dovi-activity-/);
  const text = await csv.text();
  assert.match(text, /date_utc,type,direction,counterparty,amount_usd,status,reference/);
  assert.match(text, /'=cmd\|x/); assert.match(text, /"ref,with""quote"/); assert.ok(!text.includes('@secret'));
  assert.equal((await s.call('GET', '/api/activity/export')).status, 401);
  await s.close();
});

test('top up: confirmed from the chain balance, recorded once in Activity, never more than arrived', async () => {
  const s = await boot();
  const id = 'email:alice@mail.com'; userFromSession(s.ctx, id);
  await s.call('POST', '/api/me/address', { identity: id, body: { address: ADDR.alice } });
  const post = (body) => s.call('POST', '/api/topup/confirmed', { identity: id, body: { address: ADDR.alice, provider: 'faucet', ...body } });
  assert.equal((await post({ before: '7000000', after: '7000000' })).status, 400);
  const r = await (await post({ before: '1000000', after: '99000000' })).json();
  assert.equal(r.addedMicro, '6000000');
  const again = await (await post({ before: '1000000', after: '99000000' })).json(); assert.equal(again.duplicate, true);
  const list = (await (await s.call('GET', '/api/activity', { identity: id })).json()).activity;
  assert.equal(list.filter((x) => x.kind === 'topup').length, 1); assert.equal(list[0].counterparty, 'Test faucet');
  assert.equal((await s.call('POST', '/api/topup/confirmed', { body: {} })).status, 401);
  await s.close();
});

test('referral: an X-linked app user gets the same permanent code the waitlist uses, others are asked to link X', async () => {
  const s = await boot({ fetch: async (url, init) => (String(url).includes('oauth2/token') ? { ok: true, json: async () => ({ access_token: 't' }) } : { ok: true, json: async () => ({ data: { id: '888', username: 'dayo', name: 'Dayo' } }) }) });
  s.ctx.env = { X_CLIENT_SECRET: 'sec' }; s.ctx.cfg.x.clientSecret = 'sec';
  userFromSession(s.ctx, 'x:888'); s.ctx.db.prepare("UPDATE identities SET label = '@dayo' WHERE kind = 'x' AND provider_id = '888'").run();
  userFromSession(s.ctx, 'email:plain@mail.com');
  assert.equal((await (await s.call('GET', '/api/referral', { identity: 'email:plain@mail.com' })).json()).linked, false);
  const a = await (await s.call('GET', '/api/referral', { identity: 'x:888' })).json();
  assert.equal(a.linked, true); assert.match(a.code, /^[2-9A-HJKMNP-Z]{8}$/); assert.equal(a.onWaitlist, false); assert.equal(a.position, null); assert.equal(a.referrals, 0);
  const b = await (await s.call('GET', '/api/referral', { identity: 'x:888' })).json(); assert.equal(b.code, a.code);
  const st = await s.call('GET', '/api/waitlist/x/start'); const state = new URL(st.headers.get('location')).searchParams.get('state');
  const cb = await s.call('GET', '/api/waitlist/x/callback?code=c1&state=' + state, { noOrigin: true });
  assert.equal(cb.status, 302);
  const c = await (await s.call('GET', '/api/referral', { identity: 'x:888' })).json();
  assert.equal(c.code, a.code); assert.equal(c.onWaitlist, true); assert.equal(c.position, 1);
  assert.equal((await s.call('GET', '/api/referral')).status, 401);
  await s.close();
});

test('sessions: each login is a listed device, one can be turned off, and logout everywhere signs out every older token', async () => {
  const s = await boot();
  const ua = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 Chrome/120 Safari/537.36' };
  const login = async (email) => { const r = await fetch(s.base + '/api/auth/email/verify', { method: 'POST', headers: { 'content-type': 'application/json', origin: s.ctx.cfg.publicUrl, ...ua }, body: JSON.stringify({ email, code: '123456' }) }); return r.headers.get('set-cookie').split(';')[0]; };
  const a = await login('sess@mail.com'); const b = await login('sess@mail.com');
  const list = async (cookie) => (await (await fetch(s.base + '/api/sessions', { headers: { cookie } })).json()).sessions;
  const la = await list(a);
  assert.equal(la.length, 2); assert.equal(la.filter((x) => x.current).length, 1); assert.match(la[0].label, /Chrome on Mac/);
  const other = la.find((x) => !x.current);
  const rv = await fetch(s.base + '/api/sessions/' + other.id + '/revoke', { method: 'POST', headers: { cookie: a, origin: s.ctx.cfg.publicUrl, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(rv.status, 200);
  assert.equal((await fetch(s.base + '/api/me', { headers: { cookie: b } })).status === 401 || (await fetch(s.base + '/api/me', { headers: { cookie: a } })).status === 401, true);
  const stillA = (await fetch(s.base + '/api/me', { headers: { cookie: a } })).status; const stillB = (await fetch(s.base + '/api/me', { headers: { cookie: b } })).status;
  assert.equal(stillA + stillB, 200 + 401);
  const live = stillA === 200 ? a : b; const c = await login('sess@mail.com');
  const out = await fetch(s.base + '/api/sessions/logout-all', { method: 'POST', headers: { cookie: c, origin: s.ctx.cfg.publicUrl, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(out.status, 200); assert.match(out.headers.get('set-cookie') || '', /Max-Age=0/);
  assert.equal((await fetch(s.base + '/api/me', { headers: { cookie: live } })).status, 401);
  assert.equal((await fetch(s.base + '/api/me', { headers: { cookie: c } })).status, 401);
  await new Promise((r) => setTimeout(r, 5));
  const d = await login('sess@mail.com');
  assert.equal((await fetch(s.base + '/api/me', { headers: { cookie: d } })).status, 200);
  await s.close();
});

test('notification settings: a turned off group creates nothing, security always arrives, quiet hours keep the row but skip the live push', async () => {
  const s = await boot();
  const u = userFromSession(s.ctx, 'email:nf@mail.com'); const id = 'email:nf@mail.com';
  const pushed = []; const real = s.ctx.hub.emit; s.ctx.hub.emit = (uid, v) => { pushed.push(v.type); return real.call(s.ctx.hub, uid, v); };
  const set = (body) => s.call('POST', '/api/notification-settings', { identity: id, body });
  assert.equal((await (await s.call('GET', '/api/notification-settings', { identity: id })).json()).money, true);
  await set({ money: false });
  assert.equal(s.ctx.notify(u.id, { type: 'payment_received', title: 'x' }), null);
  assert.ok(s.ctx.notify(u.id, { type: 'security_login', title: 'new login' }));
  await set({ money: true, claims: true, quietOn: true, quietStart: 0, quietEnd: 1439, tzOffset: 0 });
  s.ctx.notify(u.id, { type: 'claim_created', title: 'quiet' });
  const rows = (await (await s.call('GET', '/api/notifications', { identity: id })).json()).notifications.map((n) => n.type);
  assert.ok(rows.includes('claim_created')); assert.ok(!pushed.includes('claim_created'));
  assert.equal((await set({ money: 'x', quietStart: 99999 })).status, 200);
  assert.equal((await (await s.call('GET', '/api/notification-settings', { identity: id })).json()).quietStart, 0);
  assert.equal((await s.call('POST', '/api/notification-settings', { body: {} })).status, 401);
  await s.close();
});

test('invite only: a new account needs a real code, an existing account does not, and the code is credited', async () => {
  const s = await boot();
  s.ctx.cfg.inviteOnly = true;
  s.ctx.db.prepare("INSERT INTO waitlist (x_id, x_handle, ref_code, created_at, last_seen_at) VALUES ('1', '@host', 'K7M2QX9P', 1, 1)").run();
  const verify = (email, invite) => fetch(s.base + '/api/auth/email/verify', { method: 'POST', headers: { 'content-type': 'application/json', origin: s.ctx.cfg.publicUrl }, body: JSON.stringify({ email, code: '123456', invite }) });
  const no = await verify('new@mail.com'); assert.equal(no.status, 403); assert.equal((await no.json()).error, 'invite_required');
  assert.equal((await verify('new@mail.com', 'ZZZZZZZZ')).status, 403);
  const yes = await verify('new@mail.com', 'k7m2qx9p'); assert.equal(yes.status, 200);
  assert.equal(Number(s.ctx.db.prepare('SELECT COUNT(*) n FROM users WHERE invited_by IS NOT NULL').get().n), 1);
  assert.equal((await verify('new@mail.com')).status, 200);
  const cfg = await (await fetch(s.base + '/api/public/cdp-config')).json(); assert.equal(cfg.inviteOnly, true);
  await s.close();
});

test('freeze: sending routes refuse with 423 while frozen, receiving and take backs stay open, and unfreeze restores sending', async () => {
  const s = await boot();
  const id = 'email:fz@mail.com'; userFromSession(s.ctx, id);
  const me = async () => (await (await s.call('GET', '/api/me', { identity: id })).json()).user;
  assert.equal((await me()).frozen, false);
  assert.equal((await s.call('POST', '/api/account/freeze', { identity: id, body: {} })).status, 200);
  assert.equal((await me()).frozen, true);
  for (const [p, b] of [['/api/claims/draft', { to: '@bob', amount: '5', address: ADDR.alice }], ['/api/send/prepare', { to: '@bob', amount: '5', address: ADDR.alice }], ['/api/batches/draft', { items: [] }], ['/api/withdraw/prepare', { route: 'public' }]]) {
    const r = await s.call('POST', p, { identity: id, body: b }); assert.equal(r.status, 423, p); assert.equal((await r.json()).error, 'account_frozen');
  }
  const back = await s.call('POST', '/api/claims/0x' + '11'.repeat(32) + '/prepare-reclaim', { identity: id, body: {} });
  assert.notEqual(back.status, 423);
  assert.equal((await s.call('POST', '/api/account/unfreeze', { identity: id, body: {} })).status, 200);
  const ok = await s.call('POST', '/api/send/prepare', { identity: id, body: { to: '@bob', amount: '5', address: ADDR.alice } });
  assert.notEqual(ok.status, 423);
  assert.equal((await s.call('POST', '/api/account/freeze', { body: {} })).status, 401);
  await s.close();
});

test('proof receipts: only a party to the payment can share it, the public page has no private data, and it can be turned off', async () => {
  const s = await boot();
  const alice = 'email:alice@mail.com'; const bob = 'x:555';
  const a = userFromSession(s.ctx, alice); userFromSession(s.ctx, bob); userFromSession(s.ctx, 'email:eve@mail.com');
  s.ctx.db.prepare("UPDATE identities SET label = '@bob' WHERE kind = 'x' AND provider_id = '555'").run();
  const d = await (await s.call('POST', '/api/claims/draft', { identity: alice, body: { to: '@bob', amount: '5', address: ADDR.alice, idempotencyKey: 'rc1' } })).json();
  const mk = (identity) => s.call('POST', '/api/receipts', { identity, body: { claimId: d.claimId } });
  assert.equal((await mk(alice)).status, 409);
  s.ctx.db.prepare("UPDATE claims SET status = 'funded', fund_tx = ? WHERE id = ?").run('0x' + 'ab'.repeat(32), d.claimId);
  assert.equal((await mk('email:eve@mail.com')).status, 404);
  const r = await (await mk(alice)).json();
  assert.match(r.code, /^[2-9a-hj-km-np-zA-HJ-NP-Z]{12}$/); assert.match(r.url, /\/r\/[2-9a-zA-Z]{12}$/);
  assert.equal((await (await mk(alice)).json()).code, r.code);
  const pub = await (await fetch(s.base + '/api/receipt/' + r.code)).json();
  assert.equal(pub.amountMicro, '5000000'); assert.equal(pub.status, 'funded'); assert.equal(pub.role, 'sender'); assert.equal(pub.txs.send, '0x' + 'ab'.repeat(32));
  const raw = JSON.stringify(pub); assert.ok(!raw.includes(d.claimId) && !raw.includes('claimId') && !raw.includes('/c/'));
  const page = await (await fetch(s.base + '/r/' + r.code)).text(); assert.match(page, /<title>Receipt: \$5\.00 sent to @bob \| DOVI<\/title>/); assert.match(page, /twitter:card/);
  assert.equal((await fetch(s.base + '/api/receipt/AAAAAAAAAAAA')).status, 404);
  assert.equal((await s.call('POST', '/api/receipts/' + r.code + '/revoke', { identity: 'email:eve@mail.com', body: {} })).status, 404);
  assert.equal((await s.call('POST', '/api/receipts/' + r.code + '/revoke', { identity: alice, body: {} })).status, 200);
  assert.equal((await fetch(s.base + '/api/receipt/' + r.code)).status, 404);
  assert.equal((await s.call('GET', '/api/claims/' + d.claimId + '/receipt', { identity: alice })).status, 200);
  await s.close();
});

test('giveaway routes: only the owner of a post can start one, the public record has no private data, winners become a payout list, and the page carries a preview', async () => {
  const s = await boot();
  s.ctx.cfg.giveaway = true; s.ctx.cfg.payBaseUrl = 'https://dovi.finance';
  s.ctx.engagement = { async tweet(id) { return id === '30000' ? { id, authorId: '999', isReply: false } : id === '30100' ? { id, authorId: '555', isReply: true } : { id, authorId: '555', isReply: false }; }, async retweeters() { return [{ id: '1', handle: 'a' }, { id: '2', handle: 'b' }, { id: '3', handle: 'c' }]; }, async replies() { return [{ id: '1', handle: 'a' }, { id: '2', handle: 'b' }, { id: '3', handle: 'c' }]; }, async quotes() { return []; } };
  const bob = 'x:555'; userFromSession(s.ctx, bob); s.ctx.db.prepare("UPDATE identities SET label = '@bob' WHERE kind = 'x' AND provider_id = '555'").run();
  const post = (body, identity = bob) => s.call('POST', '/api/giveaways', { identity, body });
  const base = { tweet: 'https://x.com/bob/status/20000', winners: 2, hours: 1, rt: true, comment: true, like: true, prize: '5' };
  assert.equal((await post(base, 'email:nox@mail.com')).status, 400);
  assert.equal((await post({ ...base, tweet: 'nonsense' })).status, 400);
  assert.equal((await post({ ...base, rt: false, comment: false, quote: false })).status, 400);
  assert.equal((await post({ ...base, tweet: 'https://x.com/x/status/30000' })).status, 403);
  assert.equal((await post({ ...base, tweet: 'https://x.com/bob/status/30100' })).status, 400);
  assert.equal((await post({ ...base, winners: 50 })).status, 400);
  const ok = await (await post(base)).json(); assert.equal(ok.giveaway.winners, 2); assert.equal(ok.giveaway.prizeMicro, '5000000'); assert.match(ok.giveaway.url, /^https:\/\/dovi\.finance\/g\/\d+$/);
  const pub0 = await (await fetch(s.base + '/api/giveaway/' + ok.giveaway.id)).json(); assert.equal(pub0.status, 'open'); assert.equal(pub0.creator, '@bob'); assert.ok(!JSON.stringify(pub0).includes('user_id'));
  assert.equal((await s.call('GET', '/api/giveaways/' + ok.giveaway.id + '/pay', { identity: bob })).status, 409);
  s.ctx.clock && (s.ctx.clock.t += 3700000); s.ctx.now = () => Date.now() + 3700000;
  const done = await require('../server/giveaway').drawDue(s.ctx); assert.equal(done.processed[0].status, 'drawn');
  const pay = await (await s.call('GET', '/api/giveaways/' + ok.giveaway.id + '/pay', { identity: bob })).json();
  assert.equal(pay.lines.length, 2); assert.ok(pay.lines.every((l) => /^@[abc] 5$/.test(l)));
  assert.equal((await s.call('GET', '/api/giveaways/' + ok.giveaway.id + '/pay', { identity: 'email:eve@mail.com' })).status, 404);
  const pub = await (await fetch(s.base + '/api/giveaway/' + ok.giveaway.id)).json(); assert.equal(pub.status, 'drawn'); assert.equal(pub.pool.length, 3); assert.equal(pub.result.winners.length, 2);
  const page = await (await fetch(s.base + '/g/' + ok.giveaway.id)).text(); assert.match(page, /<title>Giveaway winners from @bob \| DOVI<\/title>/); assert.match(page, /twitter:card/);
  assert.equal((await fetch(s.base + '/api/giveaway/99999')).status, 404);
  assert.equal((await s.call('POST', '/api/giveaways/' + ok.giveaway.id + '/cancel', { identity: bob, body: {} })).status, 404);
  s.ctx.cfg.giveaway = false; assert.equal((await post({ ...base, tweet: 'https://x.com/bob/status/20100' })).status, 503);
  await s.close();
});

test('request log: redacts claim codes and hashes, records status, timing and user, and skips static files', async () => {
  const { makeReqLog, redact } = require('../server/reqlog');
  assert.equal(redact('/c/2bcDEFgh'), '/c/:code'); assert.equal(redact('/p/2bcDEFghJK'), '/p/:code'); assert.equal(redact('/r/2bcDEFghJKmn'), '/r/:code');
  assert.equal(redact('/api/claims/0x' + 'ab'.repeat(32) + '/detail'), '/api/claims/:hash/detail'); assert.equal(redact('/api/paylinks/2bcDEFgh'), '/api/paylinks/:code'); assert.equal(redact('/pay/bob'), '/pay/bob');
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'dovi-log-'));
  const logger = makeReqLog({ DOVI_REQUEST_LOG: '1', DOVI_LOG_DIR: dir });
  assert.equal(makeReqLog({}), null);
  const s = await boot(); s.ctx.reqlog = logger;
  const r = await s.call('GET', '/api/status'); assert.match(r.headers.get('x-request-id'), /^[0-9a-f]{12}$/);
  await s.call('GET', '/api/me', { identity: 'email:log@mail.com' }); await fetch(s.base + '/js/api.js'); await fetch(s.base + '/c/2bcDEFgh');
  await new Promise((res) => setTimeout(res, 50));
  const lines = require('node:fs').readFileSync(require('node:path').join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.p === '/api/status' && l.s === 200 && typeof l.ms === 'number'));
  assert.ok(lines.some((l) => l.p === '/c/:code')); assert.ok(!lines.some((l) => l.p.startsWith('/js/'))); assert.ok(lines.some((l) => l.p === '/api/me' && l.u != null));
  assert.ok(!JSON.stringify(lines).includes('2bcDEFgh'));
  await s.close();
});

test('live numbers: payments counted from escrow contract events, cached for a minute, with no private data', async () => {
  const s = await boot();
  const a = userFromSession(s.ctx, 'email:alice@mail.com');
  const ins = (id, status, amt, label, f, c) => s.ctx.db.prepare("INSERT INTO claims (id, sender_user_id, sender_address, recipient_kind, recipient_provider_id, recipient_label, recipient_hash, amount_micro, fee_micro, expiry, status, funded_at, claimed_at, created_at, updated_at) VALUES (?, ?, '0x0000000000000000000000000000000000000001', 'x', ?, ?, ?, ?, '100000', 9999999999, ?, ?, ?, 1, 1)").run(id, a.id, label, label, '0x' + '00'.repeat(32), amt, status, f, c);
  ins('0x' + '01'.repeat(32), 'claimed', '5000000', '@a', 1000, 61000); ins('0x' + '02'.repeat(32), 'claimed', '2000000', '@b', 1000, 121000); ins('0x' + '03'.repeat(32), 'returned', '1000000', '@c', 1000, null); ins('0x' + '04'.repeat(32), 'funded', '3000000', '@d', 1000, null); ins('0x' + '05'.repeat(32), 'draft', '9000000', '@e', null, null);
  const ev = s.ctx.db.prepare('INSERT INTO chain_events (tx_hash, log_index, kind, claim_id, amount_micro, fee_micro, block_time) VALUES (?, 0, ?, ?, ?, NULL, NULL)');
  [['01', 'created', '5000000'], ['02', 'created', '2000000'], ['03', 'created', '1000000'], ['04', 'created', '3000000'], ['11', 'claimed', '5000000'], ['12', 'claimed', '2000000'], ['13', 'reclaimed', '1000000']].forEach(([n, k, amt]) => ev.run('0x' + n.repeat(32), k, '0x' + n.repeat(32), amt));
  const d = await (await fetch(s.base + '/api/public/stats')).json();
  assert.equal(d.payments.sent, 4); assert.equal(d.payments.totalMicro, '11000000'); assert.equal(d.payments.claimed, 2); assert.equal(d.payments.returned, 1); assert.equal(d.payments.waiting, 1);
  assert.equal(d.claimRatePct, 67); assert.equal(d.handlesPaid, 2); assert.equal(d.avgClaimSeconds, 90);
  const raw = JSON.stringify(d); assert.ok(!raw.includes('@a') && !raw.includes('alice') && !raw.includes('0x01'));
  s.ctx.db.prepare("UPDATE claims SET status = 'claimed', claimed_at = 2000 WHERE id = ?").run('0x' + '04'.repeat(32));
  assert.equal((await (await fetch(s.base + '/api/public/stats')).json()).payments.claimed, 2);
  assert.equal((await fetch(s.base + '/live')).status, 200);
  await s.close();
});

test('Ask answers a greeting with what it can do, and a typo with the balance request', async () => {
  const s = await boot(); const id = 'email:hi@mail.com';
  const a = await (await s.call('POST', '/api/agent', { identity: id, body: { text: 'hello' } })).json(); assert.equal(a.ok, true); assert.equal(a.intent, 'help'); assert.match(a.message, /balance/);
  const b = await (await s.call('POST', '/api/agent', { identity: id, body: { text: 'whats my hodlng' } })).json(); assert.equal(b.intent, 'balance');
  await s.close();
});

test('claim notifications carry the claim so View can open that exact payment', async () => {
  const s = await boot();
  const id = 'email:nr@mail.com'; userFromSession(s.ctx, id);
  const d = await (await s.call('POST', '/api/claims/draft', { identity: id, body: { to: 'zed@mail.com', amount: '2', address: ADDR.alice, idempotencyKey: 'nr1' } })).json();
  const row = s.ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(d.claimId);
  s.ctx.chain.onchainCreate(d.claimId, { sender: ADDR.alice, amount: row.amount_micro, fee: row.fee_micro, expiry: row.expiry, recipientHash: row.recipient_hash });
  const fr = await s.call('POST', '/api/claims/' + d.claimId + '/funded', { identity: id, body: {} }); assert.equal(fr.status, 200, await fr.text());
  const list = (await (await s.call('GET', '/api/notifications', { identity: id })).json()).notifications;
  const n = list.find((x) => x.type === 'claim_created');
  assert.ok(n, JSON.stringify(list.map((x) => x.type))); assert.equal(n.ref, d.claimId); assert.equal(n.action.href, '/app?claim=' + d.claimId + '#activity');
  await s.close();
});

test('statements: a month summarises only that user, in UTC, with fees from claimed payments, and rejects bad months', async () => {
  const s = await boot();
  const a = userFromSession(s.ctx, 'email:alice@mail.com'); const o = userFromSession(s.ctx, 'email:other@mail.com');
  const D = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h);
  const ins = (uid, kind, who, micro, at) => s.ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uid, kind, 'r' + at + kind, who, micro, 'done', at);
  const now = s.ctx.now(); const d0 = new Date(now); const ym = d0.getUTCFullYear() + '-' + String(d0.getUTCMonth() + 1).padStart(2, '0');
  const start = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1);
  ins(a.id, 'claim_funded', '@bob', '5000000', start + 1000); ins(a.id, 'send', '@kofi', '2000000', start + 2000); ins(a.id, 'receive', '@lena', '3000000', start + 3000); ins(a.id, 'claim_returned', '@bob', '1000000', start + 4000); ins(a.id, 'topup', 'Coinbase', '10000000', start + 5000); ins(a.id, 'withdraw', '0xabc', '4000000', start + 6000); ins(a.id, 'claim_sent', '@bob', '5000000', start + 7000);
  ins(a.id, 'send', '@old', '9000000', start - 86400000); ins(o.id, 'send', '@secret', '7000000', start + 1000);
  s.ctx.db.prepare("INSERT INTO claims (id, sender_user_id, sender_address, recipient_kind, recipient_provider_id, recipient_label, recipient_hash, amount_micro, fee_micro, expiry, status, funded_at, claimed_at, created_at, updated_at) VALUES (?, ?, '0x0000000000000000000000000000000000000001', 'x', '1', '@bob', ?, '5000000', '100000', 9999999999, 'claimed', 1000, ?, 1, 1)").run('0x' + '0a'.repeat(32), a.id, '0x' + '00'.repeat(32), start + 7000);
  const id = 'email:alice@mail.com';
  const l = await (await s.call('GET', '/api/statements', { identity: id })).json(); assert.equal(l.months[0], ym);
  const st = await (await s.call('GET', '/api/statements/' + ym, { identity: id })).json();
  assert.equal(st.totals.sentMicro, '7000000'); assert.equal(st.totals.sentCount, 2); assert.equal(st.totals.receivedMicro, '3000000'); assert.equal(st.totals.returnedMicro, '1000000'); assert.equal(st.totals.addedMicro, '10000000'); assert.equal(st.totals.withdrawnMicro, '4000000'); assert.equal(st.feesMicro, '100000');
  assert.equal(st.rows.length, 7); assert.ok(!JSON.stringify(st).includes('@secret') && !JSON.stringify(st).includes('@old'));
  assert.equal(st.rows[0].type, 'Sent'); assert.equal(st.rows.find((r) => r.type === 'Received').direction, 'in');
  assert.equal((await s.call('GET', '/api/statements/2099-01', { identity: id })).status, 404); assert.equal((await s.call('GET', '/api/statements/nope', { identity: id })).status, 404); assert.equal((await s.call('GET', '/api/statements/' + ym)).status, 401);
  const csv = await (await s.call('GET', '/api/activity/export?since=' + start + '&until=' + (start + 3500), { identity: id })).text();
  assert.equal(csv.trim().split('\r\n').length, 4);
  await s.close();
});

test('a wallet address that belongs to one account cannot be claimed by another, and topups only count for the caller own address', async () => {
  const s = await boot();
  const a = 'email:alice@mail.com'; const b = 'email:bob@mail.com'; userFromSession(s.ctx, a); userFromSession(s.ctx, b);
  assert.equal((await s.call('POST', '/api/me/address', { identity: a, body: { address: ADDR.alice } })).status, 200);
  assert.equal((await s.call('POST', '/api/me/address', { identity: b, body: { address: ADDR.alice } })).status, 409);
  const t = await s.call('POST', '/api/topup/confirmed', { identity: b, body: { address: ADDR.alice, provider: 'faucet', before: '0', after: '1000000' } });
  assert.equal(t.status, 403);
});

test('naira quote: indicative rate with its source, cached, and a clear unavailable answer when the source is down', async () => {
  const calls = [];
  const s = await boot({ fetch: async (url) => { calls.push(String(url)); return { ok: true, json: async () => ({ rates: { NGN: 1500.5 }, time_last_update_unix: 1793750000 }) }; } });
  const a = await (await s.call('GET', '/api/public/fx')).json();
  assert.equal(a.available, true); assert.equal(a.rate, 1500.5); assert.equal(a.source, 'ExchangeRate-API'); assert.equal(a.indicative, true);
  await s.call('GET', '/api/public/fx');
  assert.equal(calls.length, 1);
  const s2 = await boot({ fetch: async () => { throw new Error('down'); } });
  const b = await (await s2.call('GET', '/api/public/fx')).json();
  assert.equal(b.available, false);
});

test('Circle faucet client sends the documented request and never leaks the key', async () => {
  const { makeCircleFaucet } = require('../lib/circle-faucet');
  assert.equal(makeCircleFaucet({}).enabled, false);
  assert.equal((await makeCircleFaucet({}).requestUsdc(ADDR.alice)).reason, 'no_key');
  let seen;
  const ok = makeCircleFaucet({ CIRCLE_API_KEY: 'TEST_KEY:ID:SECRET' }, async (u, o) => { seen = { u, o }; return { status: 204 }; });
  assert.equal((await ok.requestUsdc(ADDR.alice)).ok, true);
  assert.equal(seen.u, 'https://api.circle.com/v1/faucet/drips');
  assert.equal(seen.o.headers.Authorization, 'Bearer TEST_KEY:ID:SECRET');
  assert.deepEqual(JSON.parse(seen.o.body), { address: ADDR.alice, blockchain: 'BASE-SEPOLIA', usdc: true });
  assert.match(seen.o.headers['X-Request-Id'], /^[0-9a-f-]{36}$/);
  const bad = makeCircleFaucet({ CIRCLE_API_KEY: 'TEST_KEY:ID:SECRET' }, async () => ({ status: 400, text: async () => 'bad Bearer TEST_KEY:ID:SECRET here' }));
  const r = await bad.requestUsdc(ADDR.alice); assert.equal(r.ok, false); assert.equal(r.reason, 'http_400'); assert.ok(!JSON.stringify(r).includes('SECRET'));
  const net = makeCircleFaucet({ CIRCLE_API_KEY: 'k' }, async () => { throw new Error('down'); });
  assert.equal((await net.requestUsdc(ADDR.alice)).reason, 'network');
});

test('the Circle faucet is tried first, once per account a day, and a refusal falls through to the other faucets', async () => {
  const id = 'email:circ@x.co'; const tn = await dripBoot(id);
  let calls = 0; tn.ctx.circleFaucet = { enabled: true, requestUsdc: async () => { calls++; return { ok: true }; } };
  const first = await dripCall(tn, id, ADDR.alice); const j = await first.json();
  assert.equal(first.status, 200); assert.equal(j.circle, true); assert.equal(j.usdc, 20); assert.equal(calls, 1);
  assert.equal(tn.ctx.sent.length, 0);
  const again = await dripCall(tn, id, ADDR.alice); assert.equal(again.status, 200); assert.equal(calls, 1);
  assert.equal((await again.json()).starter, true);
  const id2 = 'email:circ2@x.co'; userFromSession(tn.ctx, id2);
  tn.ctx.circleFaucet = { enabled: true, requestUsdc: async () => ({ ok: false, reason: 'http_400' }) };
  const fall = await dripCall(tn, id2, ADDR.bob); assert.equal(fall.status, 200); assert.equal((await fall.json()).starter, true);
});

test('parallel faucet requests from one account send the starter amount once and count the day once', async () => {
  const id = 'email:race@x.co'; const tn = await dripBoot(id);
  tn.ctx.executor.sendUsdc = async (x) => { await new Promise((r) => setTimeout(r, 30)); tn.ctx.sent.push(x); return {}; };
  const res = await Promise.all([1, 2, 3].map(() => dripCall(tn, id, ADDR.alice)));
  assert.equal(res.filter((r) => r.status === 200).length, 1);
  assert.equal(tn.ctx.sent.length, 1);
  const day = new Date(tn.ctx.now()).toISOString().slice(0, 10);
  assert.equal(tn.ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get('drip:day:' + day).v, '1');
});

test('a starter send that was broadcast but not confirmed keeps its reservation, one that never left is given back', async () => {
  const id = 'email:bcast@x.co'; const tn = await dripBoot(id);
  tn.ctx.executor.sendUsdc = async () => { const e = new Error('timeout'); e.broadcast = true; throw e; };
  assert.equal((await dripCall(tn, id, ADDR.alice)).status, 429);
  tn.ctx.executor.sendUsdc = async (x) => { tn.ctx.sent.push(x); return {}; };
  assert.equal((await dripCall(tn, id, ADDR.alice)).status, 429); assert.equal(tn.ctx.sent.length, 0);
  const id2 = 'email:neverleft@x.co'; userFromSession(tn.ctx, id2);
  tn.ctx.executor.sendUsdc = async () => { throw new Error('rpc'); };
  assert.equal((await dripCall(tn, id2, ADDR.bob)).status, 429);
  const day = new Date(tn.ctx.now()).toISOString().slice(0, 10);
  assert.equal(tn.ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get('drip:day:' + day).v, '1');
});

test('giveaway wording: the real announcement post reads as 5 winners, a missing count is asked for and never guessed', () => {
  const { parseGiveaway } = require('../server/giveaway');
  const real = "I'm testing the next @DoviFinance features this week, and I'm paying 5 of you to try them.\n\nThe giveaway:\n1. Follow @DoviFinance\n2. Comment on this post in the next 24 hours\n3. I draw 5 random winners and each gets $5 in DOVI test USDC";
  const r = parseGiveaway(real);
  assert.equal(r.winners, 5); assert.equal(r.prizeMicro, '5000000'); assert.equal(r.ms, 24 * 3600 * 1000); assert.equal(r.reqs.follow, true); assert.equal(r.reqs.comment, true);
  assert.equal(parseGiveaway('@DoviFinance giveaway 3 winners reply to this, $10 each').winners, 3);
  assert.equal(parseGiveaway('@DoviFinance giveaway, pick five lucky winners, retweet').winners, 5);
  assert.equal(parseGiveaway('@DoviFinance giveaway winners: 4 rt').winners, 4);
  assert.equal(parseGiveaway('@DoviFinance giveaway pick a winner, reply').winners, 1);
  assert.equal(parseGiveaway('@DoviFinance giveaway in 24 hours pick winners comment').error, 'count');
});

test('a follow requirement is enforced at the draw, and the public reply names it', async () => {
  const s = await boot();
  s.ctx.cfg.giveaway = true; s.ctx.cfg.payBaseUrl = 'https://dovi.finance';
  const followers = new Set(['b', 'd']);
  s.ctx.engagement = { async tweet(id) { return { id, authorId: '555', isReply: false }; }, async retweeters() { return []; }, async quotes() { return []; }, async replies() { return ['a', 'b', 'c', 'd', 'e'].map((h, i) => ({ id: String(i + 1), handle: h })); }, async follows(user) { return followers.has(user); } };
  const bob = 'x:555'; const u = userFromSession(s.ctx, bob); s.ctx.db.prepare("UPDATE identities SET label = '@bob' WHERE kind = 'x' AND provider_id = '555'").run();
  const gw = require('../server/giveaway');
  const g = gw.create(s.ctx, { userId: u.id || u, tweetId: '20000', parsed: { winners: 5, ms: 3600000, reqs: { like: false, rt: false, comment: true, quote: false, follow: true }, prizeMicro: '5000000' } });
  s.ctx.now = () => Date.now() + 3700000;
  await gw.drawDue(s.ctx);
  const v = gw.get(s.ctx, g.id);
  assert.equal(v.status, 'drawn'); assert.equal(v.result.followChecked, true);
  assert.deepEqual(v.result.winners.map((w) => w.handle).sort(), ['b', 'd']);
  assert.match(gw.announcement(s.ctx, v), /followed us and replied/);
  const said = []; await gw.fromMention(s.ctx, { id: '777', authorId: '555', text: 'x', replyToId: null }, gw.parseGiveaway('@DoviFinance giveaway 5 random winners, follow and reply, $5 each'), { queueReply: (c, id, t) => said.push(t), done: () => {} });
  assert.ok(said.some((t) => /pick 5 winners/.test(t) && /follow us and reply to this post/.test(t)), said.join(' | '));
});

test('an operator hold blocks sending, cannot be undone by the account, and the notice is public', async () => {
  const s = await boot();
  const ADMIN = 'email:admin@dovi.test'; const BOB = 'email:bob@x.co';
  assert.equal((await s.call('GET', '/api/me', { identity: BOB })).status, 200);
  const bobRow = s.ctx.db.prepare('SELECT id FROM users ORDER BY id DESC LIMIT 1').get();
  const users = await (await s.call('GET', '/api/admin/users?q=', { identity: ADMIN })).json();
  assert.ok(users.users.some((u) => u.id === bobRow.id));
  assert.equal((await s.call('POST', '/api/admin/users/' + bobRow.id + '/hold', { identity: BOB, body: { on: true } })).status, 403);
  assert.equal((await s.call('POST', '/api/admin/users/' + bobRow.id + '/hold', { identity: ADMIN, body: { on: true, reason: 'review' } })).status, 200);
  const d = await s.call('POST', '/api/claims/draft', { identity: BOB, body: { to: 'a@b.co', amount: '5', address: ADDR.alice } });
  assert.equal(d.status, 423); assert.equal((await d.json()).error, 'account_on_hold');
  assert.equal((await s.call('POST', '/api/admin/users/' + bobRow.id + '/hold', { identity: ADMIN, body: { on: false } })).status, 200);
  assert.equal((await s.call('POST', '/api/admin/banner', { identity: ADMIN, body: { text: 'Short pause tonight', tone: 'warn', hours: 2 } })).status, 200);
  const b = await (await s.call('GET', '/api/banner', {})).json();
  assert.equal(b.banner.text, 'Short pause tonight');
});

test('logout revokes the session on the server, so a copied cookie stops working', async () => {
  const s = await boot();
  const r = await fetch(s.base + '/api/auth/email/verify', { method: 'POST', headers: { 'content-type': 'application/json', origin: s.ctx.cfg.publicUrl }, body: JSON.stringify({ email: 'out@mail.com', code: '123456' }) });
  const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
  assert.equal((await fetch(s.base + '/api/me', { headers: { cookie } })).status, 200);
  const out = await fetch(s.base + '/api/auth/logout', { method: 'POST', headers: { cookie, origin: s.ctx.cfg.publicUrl, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(out.status, 200);
  assert.equal((await fetch(s.base + '/api/me', { headers: { cookie } })).status, 401, 'the old cookie still works after logout');
  await s.close();
});
