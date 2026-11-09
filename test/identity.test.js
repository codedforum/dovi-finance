'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, user } = require('./helpers');
const { startXLogin, finishXLogin } = require('../server/auth/xlogin');
const { loginWithIdentity, userFromSession } = require('../server/auth/login');
const { resolveRecipient } = require('../server/auth/resolve');
const { IdentityTaken, userIdentities } = require('../server/identity');
const { parseCookie, cookieFor } = require('../server/auth/session');

function xCtx(over = {}) {
  const ctx = makeCtx({ env: { X_CLIENT_ID: 'cid', X_CLIENT_SECRET: 'sec', X_REDIRECT_URI: 'https://dovi.test/api/auth/x/callback' } });
  ctx.fetch = over.fetch || (async (url) => {
    if (String(url).includes('oauth2/token')) return { ok: true, json: async () => ({ access_token: 'tok' }) };
    if (String(url).includes('users/me')) return { ok: true, json: async () => ({ data: { id: '555', username: 'bob', name: 'Bob' } }) };
    throw new Error('unexpected ' + url);
  });
  return ctx;
}

test('X login builds a PKCE S256 url and rejects a bad or reused state', async () => {
  const ctx = xCtx();
  const { url, state, nonce } = startXLogin(ctx);
  const u = new URL(url);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), state);
  await assert.rejects(finishXLogin(ctx, { code: 'c', state: 'nope' }), (e) => e.code === 'x_bad_state');
  const ok = await finishXLogin(ctx, { code: 'c', state, nonce });
  assert.equal(ok.xId, '555');
  await assert.rejects(finishXLogin(ctx, { code: 'c', state, nonce }), (e) => e.code === 'x_bad_state');
});

test('X login state expires after ten minutes', async () => {
  const ctx = xCtx();
  const { state, nonce } = startXLogin(ctx);
  ctx.clock.t += 11 * 60 * 1000;
  await assert.rejects(finishXLogin(ctx, { code: 'c', state, nonce }), (e) => e.code === 'x_expired');
});

test('X login is refused when not configured, and failed token exchange is a clear error', async () => {
  const ctx = makeCtx();
  assert.throws(() => startXLogin(ctx), (e) => e.code === 'x_not_configured');
  const bad = xCtx({ fetch: async () => ({ ok: false, json: async () => ({}) }) });
  const { state, nonce } = startXLogin(bad);
  await assert.rejects(finishXLogin(bad, { code: 'c', state, nonce }), (e) => e.code === 'x_token_failed');
});

test('first X login creates a user keyed by the numeric id, a rename keeps the same user and updates the label', () => {
  const ctx = xCtx();
  const a = loginWithIdentity(ctx, { kind: 'x', providerId: '555', label: '@bob' });
  assert.equal(a.identity, 'x:555');
  const b = loginWithIdentity(ctx, { kind: 'x', providerId: '555', label: '@bobby' });
  assert.equal(b.user.id, a.user.id);
  assert.equal(userIdentities(ctx.db, a.user.id)[0].label, '@bobby');
});

test('linking X to an email user keeps the email wallet identity, and a second user cannot take the same X id', () => {
  const ctx = xCtx();
  const em = loginWithIdentity(ctx, { kind: 'email', providerId: 'a@b.co' });
  const linked = loginWithIdentity(ctx, { kind: 'x', providerId: '555', label: '@bob', linkToUserId: em.user.id });
  assert.equal(linked.identity, 'email:a@b.co');
  const later = loginWithIdentity(ctx, { kind: 'x', providerId: '555' });
  assert.equal(later.user.id, em.user.id);
  assert.equal(later.identity, 'email:a@b.co');
  const other = loginWithIdentity(ctx, { kind: 'email', providerId: 'c@d.co' });
  assert.throws(() => loginWithIdentity(ctx, { kind: 'x', providerId: '555', label: '@bob', linkToUserId: other.user.id }), IdentityTaken);
});

test('legacy session identities become users with the same wallet identity and sessions map back', () => {
  const ctx = xCtx();
  const u = userFromSession(ctx, 'google:abcDEF123');
  assert.equal(u.cdp_sub, 'google:abcDEF123');
  assert.equal(userFromSession(ctx, 'google:abcDEF123').id, u.id);
  assert.equal(userFromSession(ctx, null), null);
});

test('resolveRecipient: email is normalized, an X handle resolves to the numeric id, and failures are specific', async () => {
  const ctx = xCtx();
  const em = await resolveRecipient(ctx, ' Amara@Mail.com ');
  assert.deepEqual([em.kind, em.providerId, em.existingUserId], ['email', 'amara@mail.com', null]);
  ctx.fetch = async (url) => (String(url).endsWith('/amara') ? { status: 200, json: async () => ({ user: { id: '42', screen_name: 'Amara', protected: false } }) } : String(url).endsWith('/locked') ? { status: 200, json: async () => ({ user: { id: '43', screen_name: 'locked', protected: true } }) } : { status: 302, json: async () => ({}) });
  const x = await resolveRecipient(ctx, '@amara');
  assert.deepEqual([x.kind, x.providerId, x.label], ['x', '42', '@Amara']);
  await assert.rejects(resolveRecipient(ctx, '@ghost'), (e) => e.code === 'x_not_found');
  await assert.rejects(resolveRecipient(ctx, '@locked'), (e) => e.code === 'x_protected');
  await assert.rejects(resolveRecipient(ctx, 'not a handle!'), (e) => e.code === 'bad_handle');
});

test('resolveRecipient flags an existing DOVI user so the first-time recipient warning can be skipped', async () => {
  const ctx = xCtx();
  const u = user(ctx, 'x:42', [['x', '42', '@amara']]);
  ctx.fetch = async () => ({ status: 200, json: async () => ({ user: { id: '42', screen_name: 'amara' } }) });
  assert.equal((await resolveRecipient(ctx, '@amara')).existingUserId, u.id);
});

test('session cookie round trip is HttpOnly and survives encoding', () => {
  const c = cookieFor('a.b.c');
  assert.match(c, /HttpOnly/);
  assert.equal(parseCookie('x=1; dovi_sess=' + encodeURIComponent('a.b.c') + '; y=2'), 'a.b.c');
  assert.equal(parseCookie(undefined), null);
});

test('new users get a friendly display name: the X handle, or the part of the email before the @', () => {
  const ctx = xCtx();
  assert.equal(loginWithIdentity(ctx, { kind: 'x', providerId: '555', label: '@bob' }).user.display_name, '@bob');
  assert.equal(loginWithIdentity(ctx, { kind: 'email', providerId: 'Amara.Obi@Mail.com' }).user.display_name, 'amara.obi');
  assert.equal(loginWithIdentity(ctx, { kind: 'google', providerId: 'g12345', label: 'kofi@mail.com' }).user.display_name, 'kofi');
});

test('resolveRecipient retries a flaky 404 and still reports a real miss', async () => {
  const ctx = xCtx(); ctx.lookupDelayMs = 0;
  let n = 0;
  ctx.fetch = async () => (++n < 3 ? { status: 404, json: async () => ({}) } : { status: 200, json: async () => ({ user: { id: '7', screen_name: 'flaky', protected: false } }) });
  assert.equal((await resolveRecipient(ctx, '@flaky')).providerId, '7');
  assert.equal(n, 3);
  n = 0; ctx.fetch = async () => { n++; return { status: 404, json: async () => ({}) }; };
  await assert.rejects(resolveRecipient(ctx, '@ghost'), (e) => e.code === 'x_not_found');
  assert.equal(n, 4);
  ctx.fetch = async () => ({ status: 429, json: async () => ({}) });
  await assert.rejects(resolveRecipient(ctx, '@busy'), (e) => e.code === 'x_lookup_failed');
});

test('X profile is trimmed, avatar is only a twimg https url and is upsized, and results are cached', async () => {
  const ctx = xCtx();
  let calls = 0;
  const user = { id: '9', screen_name: 'Kofi', protected: false, name: 'Kofi A', followers: 1520, verification: { verified: true }, description: 'a  b\nc', avatar_url: 'https://pbs.twimg.com/profile_images/1/abc_normal.jpg' };
  ctx.fetch = async () => { calls++; return { status: 200, json: async () => ({ user }) }; };
  const r = await resolveRecipient(ctx, '@kofi');
  assert.deepEqual(r.profile, { name: 'Kofi A', avatarUrl: 'https://pbs.twimg.com/profile_images/1/abc_400x400.jpg', followers: 1520, verified: true, bio: 'a b c' });
  await resolveRecipient(ctx, '@KOFI');
  assert.equal(calls, 1);
  user.avatar_url = 'https://evil.example/x.png';
  ctx.profileCache.clear();
  assert.equal((await resolveRecipient(ctx, '@kofi')).profile.avatarUrl, '');
});

test('an X callback without the browser cookie from the start is refused, and the return path cannot leave the site', async () => {
  const ctx = makeCtx({ env: { X_CLIENT_ID: 'cid', X_CLIENT_SECRET: 'sec', X_REDIRECT_URI: 'https://dovi.test/api/auth/x/callback' } });
  ctx.fetch = async (u) => (String(u).includes('token') ? { ok: true, json: async () => ({ access_token: 't' }) } : { ok: true, json: async () => ({ data: { id: '9', username: 'z' } }) });
  const a = startXLogin(ctx, { returnTo: '//evil.example/x' });
  assert.equal(JSON.parse(ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get('xstate:' + a.state).v).returnTo, '/app');
  await assert.rejects(finishXLogin(ctx, { code: 'c', state: a.state }), (e) => e.code === 'x_bad_state');
  const b = startXLogin(ctx, { returnTo: '/app#account' });
  await assert.rejects(finishXLogin(ctx, { code: 'c', state: b.state, nonce: 'wrong' }), (e) => e.code === 'x_bad_state');
});
