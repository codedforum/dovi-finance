'use strict';
const path = require('node:path');
const { HttpError, makeRouter, json, readJson, clientIp, makeLimiter, originOk, secHeaders, serveStatic } = require('./http');
const { sessionIdentity, sessionInfo, issueSession, cookieFor, clearCookie, COOKIE } = require('./auth/session');
const { loginWithIdentity, userFromSession } = require('./auth/login');
const { startXLogin, finishXLogin, XLoginError } = require('./auth/xlogin');
const { resolveRecipient, lookupXHandle } = require('./auth/resolve');
const waitlist = require('./waitlist');
const paylinks = require('./paylinks');
const receipts = require('./receipts');
const giveaway = require('./giveaway');
const { parseUsd, formatUsd, MoneyError } = require('./money');
const { IdError, parseAddress } = require('./ids');
const { ChainNotLive } = require('./chains');
const { audit, recentAudit } = require('./audit');
const { setAddress, getAddress, userIdentities } = require('./identity');
const claims = require('./claims');
const send = require('./send');
const requests = require('./requests');
const batch = require('./batch');
const withdraw = require('./withdraw');
const naira = require('./naira');
const controls = require('./controls');
const tokens = require('./tokens');
const recovery = require('./recovery');
const swap = require('./swap');
const xpay = require('./xpay');
const agentkeys = require('./agentkeys');
const legal = require('./legal');
const unsub = require('./unsubscribe');
const datareq = require('./datarequests');
const mcp = require('./mcp');
const notifications = require('./notifications');
const { listActivity } = require('./activity');
const agent = require('./agent/engine');
const { earnings } = require('./indexer');

const PAGES = { '/': '/index.html', '/app': '/app.html', '/app/': '/app.html', '/help': '/help.html', '/terms': '/terms.html', '/privacy': '/privacy.html', '/notifications': '/notifications.html', '/live': '/live.html', '/announcement': '/announcement.html' };

const CDP_SDK_PINNED = 'https://esm.sh/@coinbase/cdp-core@0.0.128';
/* the wallet SDK is an exact version, never a floating one. An override is accepted only if it is an exact version of the same package or a path on this site */
function sdkUrl(ctx) {
  const o = String((ctx.env && ctx.env.DOVI_CDP_SDK_URL) || '').trim();
  return /^https:\/\/esm\.sh\/@coinbase\/cdp-core@\d+\.\d+\.\d+$/.test(o) || /^\/vendor\/[A-Za-z0-9._\/-]+\.m?js$/.test(o) ? o : CDP_SDK_PINNED;
}

function createApp(ctx) {
  const router = makeRouter();
  const hit = makeLimiter(ctx.now);
  const secure = ctx.cfg.publicUrl.startsWith('https://');
  const xsCookie = (nonce) => 'dovi_xs=' + nonce + '; Path=/; Max-Age=600; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
  const xsClear = () => 'dovi_xs=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
  const xsRead = (req) => { const m = /(?:^|;\s*)dovi_xs=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || ''); return m ? m[1] : null; };

  const pub = (method, pattern, handler, opts) => router.add(method, pattern, handler, { ...opts, auth: false });
  const authed = (method, pattern, handler, opts) => router.add(method, pattern, handler, { ...opts, auth: true });
  const admin = (method, pattern, handler, opts) => router.add(method, pattern, handler, { ...opts, auth: true, admin: true });

  pub('POST', '/api/csp-report', async ({ body }) => {
    const r = Array.isArray(body) ? (body[0] && body[0].body) : (body['csp-report'] || body);
    if (!r || typeof r !== 'object') return { ok: true };
    const clean = (v, n) => String(v == null ? '' : v).replace(/[^\x20-\x7e]/g, '').slice(0, n);
    const dir = clean(r['effective-directive'] || r.effectiveDirective || r['violated-directive'], 40);
    let blocked = clean(r['blocked-uri'] || r.blockedURL, 200);
    try { blocked = new URL(blocked).origin; } catch { /* keywords such as inline or eval stay as they are */ }
    if (!dir) return { ok: true };
    const k = 'csp:' + dir + '|' + blocked;
    const have = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
    if (!have && ctx.db.prepare("SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'csp:%'").get().n >= 300) return { ok: true };
    ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(kv.v AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at').run(k, '1', ctx.now());
    return { ok: true };
  }, { rl: ['public', 60] });
  admin('GET', '/api/admin/csp', async () => ({ violations: ctx.db.prepare("SELECT k, v, updated_at FROM kv WHERE k LIKE 'csp:%' ORDER BY CAST(v AS INTEGER) DESC LIMIT 100").all().map((r) => { const [directive, blocked] = r.k.slice(4).split('|'); return { directive, blocked, count: Number(r.v), lastSeen: r.updated_at }; }) }));
  pub('GET', '/healthz', async () => ({ ok: true }));
  pub('GET', '/api/chains', async () => ({ chains: ctx.registry.publicView(), statusLine: ctx.registry.statusLine() }));
  pub('GET', '/api/status', async () => {
    const c = ctx.cfg.claim;
    return {
      environment: ctx.cfg.doviEnv, wallet: 'coinbase-cdp', walletless: true,
      live: ctx.registry.listChains().filter((x) => x.status === 'live').map((x) => x.id),
      soon: ctx.registry.listChains().filter((x) => x.status === 'soon').map((x) => x.id),
      statusLine: ctx.registry.statusLine(),
      claims: { enabled: !!c.contract && ctx.registry.isLive('base'), feeBps: Number(c.feeBps), feeMinMicro: c.feeMinMicro.toString(), maxFeeBps: Number(c.maxFeeBps), minAmountMicro: c.minAmountMicro.toString(), perClaimCapMicro: c.perClaimCapMicro.toString(), expirySeconds: c.expirySeconds, beta: true },
    };
  });
  pub('GET', '/api/public/cdp-config', async () => ({
    enabled: Boolean(ctx.env.CDP_PROJECT_ID) || !!ctx.devMock, projectId: ctx.env.DOVI_CDP_PROJECT_ID || ctx.env.CDP_PROJECT_ID || null,
    sdkUrl: sdkUrl(ctx), chains: ctx.registry.listChains().filter((x) => x.status === 'live').map((x) => x.id),
    network: ctx.cfg.base.cdpNetwork, chainId: ctx.cfg.base.chainId, testnet: !!ctx.cfg.base.testnet,
    googleClientId: ctx.env.GOOGLE_CLIENT_ID || null, emailAuth: true, lockEnabled: !!ctx.cfg.claim.lockEnabled, inviteOnly: !!ctx.cfg.inviteOnly, xAuth: !!(ctx.cfg.x.clientId && ctx.cfg.x.redirectUri), mock: !!ctx.devMock,
  }));

  const assertActive = (user) => { if (user && user.admin_frozen_at) throw new HttpError(423, 'account_on_hold', 'Your account is on hold, so sending is paused. Contact support from the Help page.'); if (user && user.frozen_at) throw new HttpError(423, 'account_frozen', 'Your account is frozen, so sending is paused. Unfreeze it in Account to continue.'); };

  /* auth */
  pub('POST', '/api/auth/email/start', async ({ body }) => {
    let r;
    try { r = await ctx.emailOtp.start(body.email); } catch (e) { throw new HttpError(400, 'email_failed', String(e.message || 'Could not send the code.')); }
    return { ok: true, sent: r.sent };
  }, { rl: ['auth', 8] });
  pub('POST', '/api/auth/email/verify', async ({ body, user, req }) => {
    let v;
    try { v = ctx.emailOtp.verify(body.email, body.code); } catch (e) { throw new HttpError(400, 'bad_code', String(e.message || 'That code did not work.')); }
    if (body.link) {
      if (!user) throw new HttpError(401, 'sign_in_required', 'Sign in first.');
      let l;
      try { l = loginWithIdentity(ctx, { kind: 'email', providerId: v.email, label: v.email, linkToUserId: user.id }); } catch (e) {
        if (e && e.code === 'identity_taken') throw new HttpError(409, 'identity_taken', 'That email is already linked to another DOVI account.');
        throw e;
      }
      audit(ctx.db, { actor: 'user:' + user.id, action: 'auth.email.link' });
      return { ok: true, linked: true, email: v.email, label: l.label };
    }
    const l = loginWithIdentity(ctx, { kind: 'email', providerId: v.email, label: v.email, invite: body.invite });
    audit(ctx.db, { actor: 'user:' + l.user.id, action: 'auth.email' });
    return { ok: true, email: v.email, __cookie: issueSession(ctx, req, l.identity, { secure }) };
  }, { rl: ['auth', 12], soft: true });
  pub('POST', '/api/auth/google', async ({ body, req }) => {
    const clientId = ctx.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new HttpError(400, 'google_not_configured', 'Google sign in is not switched on yet.');
    let g;
    try { g = await ctx.googleAuth.verifyGoogleIdToken(body.credential, clientId); } catch (e) { throw new HttpError(401, 'google_failed', 'Google sign in did not work. Please try again.'); }
    const l = loginWithIdentity(ctx, { kind: 'google', providerId: g.sub, label: g.email || null, invite: body.invite });
    audit(ctx.db, { actor: 'user:' + l.user.id, action: 'auth.google' });
    return { ok: true, email: g.email, name: g.name, __cookie: issueSession(ctx, req, l.identity, { secure }) };
  }, { rl: ['auth', 12] });
  pub('GET', '/api/auth/x/start', async ({ req, user, query, res }) => {
    const inv = query.get('invite'); const { url, nonce } = startXLogin(ctx, { linkUserId: user ? user.id : null, returnTo: query.get('return') || '/app', extra: inv && waitlist.normRef(inv) ? { kind: 'login', invite: waitlist.normRef(inv) } : null });
    return { __redirect: url, __cookie: xsCookie(nonce) };
  }, { rl: ['auth', 12], soft: true });
  pub('GET', '/api/auth/x/callback', async ({ query, req }) => {
    try {
      const r = await finishXLogin(ctx, { code: query.get('code'), state: query.get('state'), nonce: xsRead(req) });
      if (r.extra && r.extra.kind === 'waitlist') throw new XLoginError('x_bad_state', 'That sign in link is not valid. Please try again.');
      const l = loginWithIdentity(ctx, { kind: 'x', providerId: r.xId, label: '@' + r.handle, linkToUserId: r.linkUserId, invite: r.extra && r.extra.invite });
      if (!r.linkUserId && l.user.display_name == null) ctx.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('@' + r.handle, l.user.id);
      audit(ctx.db, { actor: 'user:' + l.user.id, action: 'auth.x' });
      const back = r.returnTo || '/app';
      if (r.linkUserId) {
        const h = back.indexOf('#'); const path = h < 0 ? back : back.slice(0, h); const hash = h < 0 ? '' : back.slice(h);
        return { __redirect: path + (path.includes('?') ? '&' : '?') + 'linked=x' + hash, __cookie: xsClear() };
      }
      return { __redirect: back, __cookie: [issueSession(ctx, req, l.identity, { secure }), xsClear()] };
    } catch (e) {
      if (e instanceof XLoginError || e.code === 'identity_taken' || e.code === 'invite_required') return { __redirect: '/app?login_error=' + encodeURIComponent(e.code || 'x_failed') };
      throw e;
    }
  }, { rl: ['auth', 20] });

  /* waitlist (served on dovi.finance through a proxy) */
  const wlRedirect = () => (ctx.env && ctx.env.WAITLIST_X_REDIRECT_URI) || 'https://dovi.finance/api/waitlist/x/callback';
  pub('GET', '/api/waitlist/config', async () => ({
    x: !!(ctx.cfg.x.clientId && ctx.cfg.x.clientSecret), count: Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n),
  }), { rl: ['wl', 60] });
  pub('GET', '/api/waitlist/x/start', async ({ query }) => {
    let url; let nonce;
    try { ({ url, nonce } = startXLogin(ctx, { redirectUri: wlRedirect(), returnTo: '/waitlist', extra: { kind: 'waitlist', ref: waitlist.normRef(query.get('ref')) } })); } catch (e) { if (e instanceof XLoginError) return { __redirect: '/waitlist?error=' + encodeURIComponent(e.code) }; throw e; }
    return { __redirect: url, __cookie: xsCookie(nonce) };
  }, { rl: ['wl', 20] });
  pub('GET', '/api/waitlist/x/callback', async ({ query, req }) => {
    try {
      const r = await finishXLogin(ctx, { code: query.get('code'), state: query.get('state'), nonce: xsRead(req) });
      if (!r.extra || r.extra.kind !== 'waitlist') throw new XLoginError('x_bad_state', 'That sign in link is not valid.');
      const j = waitlist.join(ctx, r, r.extra.ref);
      if (j.created) audit(ctx.db, { actor: 'wl:' + j.row.id, action: 'waitlist.join', subject: j.row.referred_by ? 'ref:' + j.row.referred_by : null });
      return { __redirect: '/waitlist' + (j.created ? '?joined=1' : ''), __cookie: [waitlist.cookieFor(waitlist.mintSession(ctx.env, r.xId, ctx.now()), secure), xsClear()] };
    } catch (e) {
      if (e instanceof XLoginError) return { __redirect: '/waitlist?error=' + encodeURIComponent(e.code || 'x_failed') };
      throw e;
    }
  }, { rl: ['wl', 30] });
  pub('GET', '/api/waitlist/me', async ({ req }) => {
    const row = waitlist.me(ctx, req);
    if (!row) throw new HttpError(401, 'wl_sign_in_required', 'Sign in with X first.');
    ctx.db.prepare('UPDATE waitlist SET last_seen_at = ? WHERE id = ?').run(ctx.now(), row.id);
    return { profile: waitlist.profile(ctx, row) };
  }, { rl: ['wl', 60] });
  pub('POST', '/api/waitlist/email', async ({ req, body }) => {
    const row = waitlist.me(ctx, req);
    if (!row) throw new HttpError(401, 'wl_sign_in_required', 'Sign in with X first.');
    return { ok: true, profile: waitlist.profile(ctx, waitlist.setEmail(ctx, row, body && body.email)) };
  }, { rl: ['wl', 20] });
  pub('POST', '/api/waitlist/logout', async () => ({ ok: true, __cookie: waitlist.clearCookie(secure) }), { rl: ['wl', 30] });
  admin('GET', '/api/admin/waitlist', async () => ({
    count: Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n),
    withEmail: Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE email IS NOT NULL').get().n),
    referred: Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE referred_by IS NOT NULL').get().n),
    recent: ctx.db.prepare('SELECT id, x_handle, email, ref_code, referred_by, created_at FROM waitlist ORDER BY id DESC LIMIT 50').all(),
  }));

  pub('POST', '/api/auth/cdp-jwt', async ({ identity }) => {
    if (!identity) throw new HttpError(401, 'sign_in_required', 'Sign in first.');
    return { jwt: ctx.cdpAuth.mintFor(identity) };
  }, { rl: ['auth', 30] });
  pub('GET', '/api/auth/me', async ({ identity }) => ({ identity }));
  pub('POST', '/api/auth/logout', async ({ req }) => {
    const info = sessionInfo(ctx, req);
    if (info && info.jti) ctx.db.prepare('UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(ctx.now ? ctx.now() : Date.now(), info.jti);
    return { ok: true, __cookie: clearCookie({ secure }) };
  });
  pub('GET', '/.well-known/jwks.json', async () => ctx.cdpAuth.jwks());

  /* me */
  authed('GET', '/api/me', async ({ user }) => ({
    user: { id: user.id, frozen: !!user.frozen_at, held: !!user.admin_frozen_at, name: user.display_name, identities: userIdentities(ctx.db, user.id).map((i) => ({ kind: i.kind, label: i.label || i.provider_id })), address: getAddress(ctx.db, user.id, 'base') },
    unread: notifications.unreadCount(ctx.db, user.id),
  }));
  authed('GET', '/api/me/summary', async ({ user }) => {
    const out = require('./me').summary(ctx, user);
    const x = userIdentities(ctx.db, user.id).find((i) => i.kind === 'x');
    out.profile = null;
    if (x) { try { out.profile = (await lookupXHandle(ctx, String(x.label || '').replace(/^@/, ''))).profile; } catch { out.profile = null; } }
    return out;
  }, { rl: ['money', 30] });
  authed('POST', '/api/me/address', async ({ user, body }) => {
    ctx.registry.assertLive('base');
    const a = parseAddress(body.address);
    setAddress(ctx.db, user.id, 'base', a, ctx.now());
    return { ok: true, address: a };
  });
  authed('GET', '/api/wallet/balance', async ({ query }) => {
    ctx.registry.assertLive('base');
    const a = parseAddress(query.get('address'));
    return { chain: 'base', symbol: 'USDC', micro: String(await (ctx.chain || ctx.reader).usdcBalance(a)) };
  }, { rl: ['bal', 240] });
  authed('POST', '/api/faucet/usdc', async ({ user, body }) => {
    if (!ctx.cfg.base.testnet) throw new HttpError(404, 'not_found', 'Not found.');
    const a = parseAddress(body.address);
    const c = await require('./drip').circleDrip(ctx, user.id, a).catch(() => null);
    if (c && c.usdc) return { ok: true, usdc: c.usdc, circle: true };
    const r = await (ctx.faucet || require('../lib/faucet')).requestTestUsdc(a);
    if (!r.granted) {
      const d = await require('./drip').starterDrip(ctx, user.id, a).catch(() => null);
      if (d && d.micro) return { ok: true, usdc: Number(d.micro) / 1e6, starter: true };
      throw new HttpError(429, 'faucet_limit', d && d.already ? 'You already got your starter test USDC. Get more from the Circle faucet at faucet.circle.com (20 at a time).' : 'The shared test faucet is at its limit right now. Get test USDC from the Circle faucet at faucet.circle.com (20 at a time).');
    }
    return { ok: true, usdc: r.granted };
  }, { rl: ['money', 3] });
  authed('POST', '/api/onramp/url', async ({ body }) => {
    ctx.registry.assertLive('base');
    if (ctx.cfg.base.testnet) return { url: 'https://faucet.circle.com/', faucet: true };
    return ctx.onramp.onrampUrl({ chain: 'base', address: parseAddress(body.address), provider: body.provider, amount: body.amount });
  }, { rl: ['money', 20] });
  pub('GET', '/api/onramp/providers', async () => { try { return { providers: ctx.onramp.providers() }; } catch { return { providers: [] }; } });


  authed('POST', '/api/topup/confirmed', async ({ user, body }) => {
    const address = parseAddress(body.address);
    const mine = getAddress(ctx.db, user.id, 'base');
    if (!mine || mine.toLowerCase() !== address.toLowerCase()) throw new HttpError(403, 'not_your_address', 'That address is not on your account.');
    const before = BigInt(String(body.before || '0')); const after = BigInt(String(body.after || '0'));
    if (after <= before) throw new HttpError(400, 'bad_topup', 'Nothing was added.');
    const current = BigInt(await (ctx.chain || ctx.reader).usdcBalance(address));
    const added = after - before < current - before ? after - before : current - before;
    if (added <= 0n) throw new HttpError(409, 'not_confirmed', 'We could not see that money arrive yet.');
    const ref = 'topup:' + address.toLowerCase() + ':' + after.toString();
    if (ctx.db.prepare("SELECT 1 FROM activity WHERE user_id = ? AND kind = 'topup' AND ref = ?").get(user.id, ref)) return { ok: true, duplicate: true };
    const prov = { faucet: 'Test faucet', coinbase: 'Coinbase', transak: 'Transak' }[String(body.provider)] || 'Add money';
    ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(user.id, 'topup', ref, prov, added.toString(), 'done', ctx.now());
    return { ok: true, addedMicro: added.toString() };
  }, { rl: ['money', 30] });

  authed('GET', '/api/referral', async ({ user }) => {
    const row = waitlist.forAppUser(ctx, user.id);
    if (!row) return { linked: false };
    const p = waitlist.profile(ctx, row);
    const appInvited = Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE invited_by = ?').get(row.id).n);
    return { linked: true, handle: p.handle, code: p.refCode, link: p.refLink, referrals: p.referrals + appInvited, appInvited, onWaitlist: row.source === 'waitlist', position: row.source === 'waitlist' ? p.position : null, email: row.email || null };
  }, { rl: ['money', 30] });

  /* sessions and notification settings */
  authed('GET', '/api/sessions', async ({ user, req }) => {
    const cur = sessionInfo(ctx, req);
    return { sessions: ctx.db.prepare('SELECT id, label, created_at, last_seen_at FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL AND created_at > ? ORDER BY last_seen_at DESC LIMIT 20').all(user.id, ctx.now() - 31 * 86400000).map((r) => ({ id: r.id, label: r.label || 'Device', createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: !!(cur && cur.jti === r.id) })) };
  });
  authed('POST', '/api/sessions/:id/revoke', async ({ user, params, req }) => {
    const r = ctx.db.prepare('UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(ctx.now(), String(params.id), user.id);
    if (!Number(r.changes)) throw new HttpError(404, 'not_found', 'That device was not found.');
    audit(ctx.db, { actor: 'user:' + user.id, action: 'session.revoke' });
    const cur = sessionInfo(ctx, req);
    return { ok: true, ...(cur && cur.jti === String(params.id) ? { __cookie: clearCookie({ secure }), signedOut: true } : {}) };
  }, { rl: ['auth', 30] });
  authed('POST', '/api/sessions/logout-all', async ({ user }) => {
    const now = ctx.now();
    ctx.db.prepare('UPDATE users SET sessions_valid_from = ? WHERE id = ?').run(now, user.id);
    ctx.db.prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, user.id);
    audit(ctx.db, { actor: 'user:' + user.id, action: 'session.logout_all' });
    return { ok: true, __cookie: clearCookie({ secure }) };
  }, { rl: ['auth', 10] });
  const prefView = (userId) => { const p = ctx.db.prepare('SELECT * FROM notification_prefs WHERE user_id = ?').get(userId) || {}; return { money: p.money == null ? true : !!p.money, claims: p.claims == null ? true : !!p.claims, quietOn: !!p.quiet_on, quietStart: p.quiet_start == null ? 1320 : p.quiet_start, quietEnd: p.quiet_end == null ? 420 : p.quiet_end, tzOffset: p.tz_offset || 0 }; };
  authed('GET', '/api/notification-settings', async ({ user }) => prefView(user.id));
  authed('POST', '/api/notification-settings', async ({ user, body }) => {
    const cur = prefView(user.id);
    const bool = (v, d) => (v == null ? d : !!v);
    const mins = (v, d) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n < 1440 ? n : d; };
    const tz = Number(body.tzOffset); const tzOffset = Number.isInteger(tz) && tz >= -720 && tz <= 840 ? tz : cur.tzOffset;
    ctx.db.prepare('INSERT INTO notification_prefs (user_id, money, claims, quiet_on, quiet_start, quiet_end, tz_offset) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET money = excluded.money, claims = excluded.claims, quiet_on = excluded.quiet_on, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, tz_offset = excluded.tz_offset')
      .run(user.id, bool(body.money, cur.money) ? 1 : 0, bool(body.claims, cur.claims) ? 1 : 0, bool(body.quietOn, cur.quietOn) ? 1 : 0, mins(body.quietStart, cur.quietStart), mins(body.quietEnd, cur.quietEnd), tzOffset);
    return prefView(user.id);
  }, { rl: ['money', 30] });

  /* account freeze */
  authed('POST', '/api/account/freeze', async ({ user }) => {
    ctx.db.prepare('UPDATE users SET frozen_at = COALESCE(frozen_at, ?) WHERE id = ?').run(ctx.now(), user.id);
    audit(ctx.db, { actor: 'user:' + user.id, action: 'account.freeze' });
    try { ctx.notify(user.id, { type: 'system', title: 'Your account is frozen', privateTitle: 'Your account is frozen', body: 'Sending is paused. You can still receive money and take payments back.' }); } catch { /* notify is best effort */ }
    return { ok: true, frozen: true };
  }, { rl: ['auth', 10] });
  authed('POST', '/api/account/unfreeze', async ({ user }) => {
    ctx.db.prepare('UPDATE users SET frozen_at = NULL WHERE id = ?').run(user.id);
    audit(ctx.db, { actor: 'user:' + user.id, action: 'account.unfreeze' });
    return { ok: true, frozen: false };
  }, { rl: ['auth', 10] });

  /* proof receipt pages */
  authed('POST', '/api/receipts', async ({ user, body }) => receipts.create(ctx, { userId: user.id, claimId: body.claimId }), { rl: ['money', 20] });
  authed('POST', '/api/receipts/:code/revoke', async ({ user, params }) => receipts.revoke(ctx, { userId: user.id, code: params.code }), { rl: ['money', 20] });
  authed('GET', '/api/claims/:id/receipt', async ({ user, params }) => ({ receipt: receipts.forClaim(ctx, { userId: user.id, claimId: params.id }) }));
  pub('GET', '/api/receipt/:code', async ({ params }) => {
    const v = receipts.view(ctx, params.code);
    if (!v) throw new HttpError(404, 'receipt_off', 'This receipt link is not active.');
    return v;
  }, { rl: ['pay', 60] });

  /* giveaways */
  pub('GET', '/api/giveaway/:id', async ({ params }) => {
    const v = giveaway.publicView(ctx, params.id);
    if (!v) throw new HttpError(404, 'not_found', 'That giveaway was not found.');
    return v;
  }, { rl: ['pay', 60] });
  authed('GET', '/api/giveaways', async ({ user }) => ({ enabled: !!ctx.cfg.giveaway, giveaways: giveaway.list(ctx, user.id), maxWinners: giveaway.MAX_WINNERS }));
  authed('POST', '/api/giveaways', async ({ user, body }) => {
    assertActive(user);
    if (!ctx.cfg.giveaway) throw new HttpError(503, 'giveaways_off', 'Giveaways are not switched on yet.');
    const tweetId = giveaway.tweetIdFromUrl(body.tweet);
    if (!tweetId) throw new HttpError(400, 'bad_tweet', 'Paste the link to your post, like https://x.com/you/status/123.');
    const winners = Number(body.winners); const hours = Number(body.hours);
    if (!Number.isInteger(winners) || winners < 1 || winners > giveaway.MAX_WINNERS) throw new HttpError(400, 'winners', 'Pick between 1 and ' + giveaway.MAX_WINNERS + ' winners.');
    if (!(hours >= 1 / 6 && hours <= 168)) throw new HttpError(400, 'duration', 'A giveaway runs from 10 minutes to 7 days.');
    const reqs = { like: !!body.like, rt: !!body.rt, comment: !!body.comment, quote: !!body.quote, follow: false };
    if (!reqs.rt && !reqs.comment && !reqs.quote) throw new HttpError(400, 'requirements', 'Choose at least one thing that can be checked: retweet, reply or quote. Likes cannot be checked on X.');
    let prizeMicro = null; if (body.prize) prizeMicro = parseUsd(body.prize).toString();
    const x = require('./identity').userIdentities(ctx.db, user.id).find((i) => i.kind === 'x');
    if (!x) throw new HttpError(400, 'x_required', 'Link your X account first.');
    let t = null;
    try { t = ctx.engagement && ctx.engagement.tweet ? await ctx.engagement.tweet(tweetId) : null; } catch { t = null; }
    if (!t) throw new HttpError(503, 'cannot_check', 'I could not check that post right now. Try again in a minute.');
    if (String(t.authorId) !== String(x.provider_id)) throw new HttpError(403, 'not_your_post', 'That post is not from your linked X account.');
    if (t.isReply) throw new HttpError(400, 'not_original', 'Use the original post, not a reply.');
    const g = giveaway.create(ctx, { userId: user.id, tweetId, parsed: { winners, ms: Math.round(hours * 3600000), reqs, prizeMicro } });
    return { giveaway: g };
  }, { rl: ['money', 10] });
  authed('POST', '/api/giveaways/:id/cancel', async ({ user, params }) => ({ giveaway: giveaway.cancel(ctx, { userId: user.id, id: params.id }) }), { rl: ['money', 20] });
  authed('GET', '/api/giveaways/:id/pay', async ({ user, params }) => giveaway.payLines(ctx, { userId: user.id, id: params.id }));

  pub('GET', '/api/public/fx', async () => require('./fx').ngnQuote(ctx), { rl: ['pay', 60] });
  pub('GET', '/api/public/stats', async () => require('./stats').cached(ctx), { rl: ['pay', 60] });
  authed('GET', '/api/statements', async ({ user }) => ({ months: require('./statements').months(ctx, user.id) }));
  authed('GET', '/api/statements/:month/pdf', async ({ user, params, res }) => {
    const st = require('./statements').build(ctx, user.id, params.month);
    if (!st) throw new HttpError(404, 'bad_month', 'That month is not available.');
    audit(ctx.db, { actor: 'user:' + user.id, action: 'statement.pdf', subject: params.month });
    const pdf = require('./pdf').statementPdf(st);
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="dovi-statement-' + params.month + '.pdf"', 'content-length': pdf.length, 'cache-control': 'no-store', ...secHeaders() });
    res.end(pdf);
    return { __handled: true };
  }, { rl: ['money', 20] });
  authed('GET', '/api/statements/:month', async ({ user, params }) => {
    const st = require('./statements').build(ctx, user.id, params.month);
    if (!st) throw new HttpError(404, 'bad_month', 'That month is not available.');
    audit(ctx.db, { actor: 'user:' + user.id, action: 'statement.view', subject: params.month });
    return st;
  }, { rl: ['money', 30] });
  /* pay-me and payment links */
  pub('GET', '/api/pay/handle/:handle', async ({ params }) => {
    let x;
    try { x = await lookupXHandle(ctx, String(params.handle).replace(/^@/, '').slice(0, 15)); } catch (e) { throw new HttpError(404, e.code || 'not_found', e.message || 'We could not find that account.'); }
    return { handle: x.label, profile: x.profile || null };
  }, { rl: ['pay', 40] });
  pub('GET', '/api/paylinks/:code', async ({ params }) => {
    const v = paylinks.publicView(ctx, params.code);
    if (!v || !v.active) throw new HttpError(404, 'link_off', 'This payment link is not active.');
    let profile = null;
    try { profile = (await lookupXHandle(ctx, v.handle.replace(/^@/, ''))).profile || null; } catch { profile = null; }
    return { code: v.code, title: v.title, amountMicro: v.amountMicro, handle: v.handle, profile };
  }, { rl: ['pay', 40] });
  authed('GET', '/api/paylinks', async ({ user }) => ({ handle: paylinks.xHandleOf(ctx, user.id), payMeUrl: paylinks.xHandleOf(ctx, user.id) ? ctx.cfg.payBaseUrl + '/pay/' + paylinks.xHandleOf(ctx, user.id).replace(/^@/, '') : null, links: paylinks.list(ctx, user.id) }));
  authed('POST', '/api/paylinks', async ({ user, body }) => {
    const made = paylinks.create(ctx, { userId: user.id, title: body.title, amountMicro: body.amount ? parseUsd(body.amount) : null });
    return { link: paylinks.list(ctx, user.id).find((x) => x.code === made.code) };
  }, { rl: ['money', 20] });
  authed('POST', '/api/paylinks/:code/active', async ({ user, params, body }) => ({ link: paylinks.setActive(ctx, { userId: user.id, code: params.code, active: !!body.active }) }), { rl: ['money', 30] });

  authed('GET', '/api/recipients/recent', async ({ user }) => ({
    recent: ctx.db.prepare("SELECT counterparty AS label, MAX(created_at) AS at FROM activity WHERE user_id = ? AND counterparty IS NOT NULL AND counterparty != '' AND kind IN ('send', 'claim_funded') GROUP BY counterparty ORDER BY at DESC LIMIT 6").all(user.id).map((r) => ({ label: r.label })),
  }));

  /* claims and sends */
  authed('POST', '/api/claims/resolve', async ({ body }) => {
    const r = await resolveRecipient(ctx, body.to);
    return { kind: r.kind, label: r.label, hasAccount: !!r.existingUserId };
  }, { rl: ['money', 40] });
  authed('POST', '/api/recipient/preview', async ({ body }) => {
    const r = await resolveRecipient(ctx, body.to);
    return { kind: r.kind, label: r.label, hasAccount: !!r.existingUserId, profile: r.profile || null };
  }, { rl: ['money', 40] });
  authed('POST', '/api/claims/:id/auto-cancel', async ({ user, params }) => require('./autorelease').cancelAuto(ctx, { claimId: params.id, userId: user.id }), { rl: ['money', 30] });
  authed('POST', '/api/claims/:id/release', async ({ user, params }) => claims.release(ctx, { claimId: params.id, userId: user.id }), { rl: ['money', 60] });
  authed('POST', '/api/batches/:id/release', async ({ user, params }) => batch.releaseBatch(ctx, { batchId: params.id, userId: user.id }), { rl: ['money', 30] });
  authed('POST', '/api/claims/draft', async ({ user, body }) => {
    assertActive(user);
    const amount = parseUsd(body.amount);
    const pl = body.paylink ? paylinks.forPayment(ctx, { code: String(body.paylink), payerId: user.id, amountMicro: amount }) : null;
    const r = await resolveRecipient(ctx, pl ? pl.to : body.to);
    const d = claims.createDraft(ctx, { userId: user.id, senderAddress: body.address, kind: r.kind, providerId: r.providerId, label: r.label, amountMicro: amount, idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey).slice(0, 80) : null, note: body.note || (pl ? pl.link.title : undefined), lockSeconds: body.lockHours ? Math.round(Number(body.lockHours) * 3600) : null, needsRelease: !!body.payOnDelivery, autoRelease: body.autoRelease && body.autoRelease.mode === 'time' ? { mode: 'time', at: Number(body.autoRelease.at) } : null });
    if (pl && d && d.claimId) paylinks.record(ctx, { paylinkId: pl.link.id, kind: 'claim', ref: d.claimId, amountMicro: amount, payerUserId: user.id });
    return d;
  }, { rl: ['money', 30] });
  authed('GET', '/api/claims/incoming', async ({ user }) => ({ incoming: claims.incomingFor(ctx, user.id) }), { rl: ['bal', 240] });
  authed('POST', '/api/claims/:id/funded', async ({ user, params, body }) => claims.confirmFunded(ctx, { claimId: params.id, userId: user.id, txHash: body.txHash }), { rl: ['money', 60] });
  pub('GET', '/api/claims/:id', async ({ params }) => {
    const v = claims.publicView(ctx, params.id);
    if (v.kind === 'x') { try { const h = String(v.to || '').replace(/^@/, ''); v.toProfile = (await lookupXHandle(ctx, h)).profile; } catch { v.toProfile = null; } }
    return v;
  }, { rl: ['public', 120] });
  authed('GET', '/api/claims/:id/detail', async ({ user, params }) => claims.detailFor(ctx, params.id, user.id), { rl: ['money', 60] });
  authed('POST', '/api/claims/:id/prepare-claim', async ({ user, params, body }) => claims.prepareClaim(ctx, { claimId: params.id, userId: user.id, recipientAddress: body.address }), { rl: ['money', 20] });
  authed('POST', '/api/claims/:id/claimed', async ({ user, params, body }) => claims.confirmClaimed(ctx, { claimId: params.id, userId: user.id, txHash: body.txHash }), { rl: ['money', 60] });
  authed('POST', '/api/claims/:id/prepare-reclaim', async ({ user, params }) => claims.prepareReclaimChecked(ctx, { claimId: params.id, userId: user.id }), { rl: ['money', 20] });
  authed('POST', '/api/claims/:id/reclaimed', async ({ user, params, body }) => claims.confirmReclaimed(ctx, { claimId: params.id, userId: user.id, txHash: body.txHash }), { rl: ['money', 60] });
  /* swap in the test pool */
  authed('GET', '/api/swap/options', async () => swap.options(ctx), { rl: ['bal', 120] });
  authed('POST', '/api/swap/quote', async ({ body }) => { const q = await swap.quote(ctx, { from: body.from, to: body.to, amount: body.amount, slippageBps: body.slippageBps }); return q.view; }, { rl: ['bal', 120] });
  authed('POST', '/api/swap/prepare', async ({ user, body }) => { assertActive(user); return swap.prepare(ctx, { userId: user.id, from: body.from, to: body.to, amount: body.amount, address: body.address, slippageBps: body.slippageBps }); }, { rl: ['money', 30] });
  authed('POST', '/api/swap/confirmed', async ({ user, body }) => swap.confirm(ctx, { userId: user.id, from: body.from, to: body.to, amount: body.amount, address: body.address }), { rl: ['money', 60] });
  /* account recovery */
  authed('POST', '/api/recovery/request', async ({ user, body }) => recovery.request(ctx, { requesterUserId: user.id, lost: body.lost, note: body.note }), { rl: ['auth', 5] });
  authed('GET', '/api/recovery/mine', async ({ user }) => ({ enabled: !!ctx.cfg.recovery.enabled, mine: recovery.mine(ctx, user.id), incoming: recovery.incomingFor(ctx, user.id) }), { rl: ['bal', 60] });
  authed('POST', '/api/recovery/:id/complete', async ({ user, params }) => recovery.complete(ctx, { id: params.id, requesterUserId: user.id }), { rl: ['auth', 10] });
  authed('POST', '/api/recovery/:id/cancel', async ({ user, params }) => recovery.cancelByOwner(ctx, { userId: user.id, id: params.id }), { rl: ['auth', 10] });
  pub('POST', '/api/recovery/cancel', async ({ body }) => recovery.cancelByToken(ctx, { token: String(body.token || '').slice(0, 80) }), { rl: ['auth', 10] });
  admin('GET', '/api/admin/recovery', async () => ({ requests: recovery.adminList(ctx) }));
  admin('POST', '/api/admin/recovery/:id/approve', async ({ user, params, body }) => recovery.approve(ctx, { id: params.id, actor: 'admin:' + user.id, revokeLost: body.revokeLost !== false }));
  admin('POST', '/api/admin/recovery/:id/reject', async ({ user, params, body }) => recovery.reject(ctx, { id: params.id, actor: 'admin:' + user.id, reason: body.reason }));
  /* extra tokens */
  authed('GET', '/api/tokens', async ({ user }) => {
    const o = tokens.options(ctx);
    const addr = getAddress(ctx.db, user.id, 'base');
    return { ...o, balances: o.enabled && addr ? await tokens.balances(ctx, addr) : {} };
  }, { rl: ['bal', 120] });
  authed('GET', '/api/tokens/mine', async ({ user }) => tokens.listFor(ctx, user.id), { rl: ['bal', 120] });
  pub('GET', '/api/tokens/claim/:id', async ({ params }) => tokens.publicView(ctx, params.id), { rl: ['public', 120] });
  authed('POST', '/api/tokens/draft', async ({ user, body }) => {
    assertActive(user);
    const r = await resolveRecipient(ctx, body.to);
    await tokens.checkBalance(ctx, { symbol: body.symbol, amount: body.amount, address: body.address });
    return tokens.createDraft(ctx, { userId: user.id, senderAddress: body.address, symbol: body.symbol, amount: body.amount, kind: r.kind, providerId: r.providerId, label: r.label, idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey).slice(0, 80) : null, note: body.note });
  }, { rl: ['money', 30] });
  authed('POST', '/api/tokens/:id/funded', async ({ user, params, body }) => tokens.confirmFunded(ctx, { claimId: params.id, userId: user.id, txHash: body.txHash }), { rl: ['money', 60] });
  authed('POST', '/api/tokens/:id/prepare-claim', async ({ user, params, body }) => { assertActive(user); return tokens.prepareClaim(ctx, { claimId: params.id, userId: user.id, recipientAddress: body.address }); }, { rl: ['money', 20] });
  authed('POST', '/api/tokens/:id/claimed', async ({ user, params, body }) => tokens.confirmClaimed(ctx, { claimId: params.id, userId: user.id, txHash: body.txHash }), { rl: ['money', 60] });
  authed('POST', '/api/tokens/:id/prepare-reclaim', async ({ user, params }) => tokens.prepareReclaim(ctx, { claimId: params.id, userId: user.id }), { rl: ['money', 20] });
  authed('POST', '/api/tokens/:id/reclaimed', async ({ user, params, body }) => tokens.confirmReclaimed(ctx, { claimId: params.id, userId: user.id, txHash: body.txHash }), { rl: ['money', 60] });
  authed('GET', '/api/claims', async ({ user }) => ({ claims: claims.listForSender(ctx, user.id) }));
  authed('POST', '/api/send/prepare', async ({ user, body }) => {
    assertActive(user);
    const amount = parseUsd(body.amount);
    const pl = body.paylink ? paylinks.forPayment(ctx, { code: String(body.paylink), payerId: user.id, amountMicro: amount }) : null;
    return send.prepareDirect(ctx, { userId: user.id, senderAddress: body.address, text: pl ? pl.to : body.to, amountMicro: amount });
  }, { rl: ['money', 30] });
  authed('POST', '/api/send/confirmed', async ({ user, body }) => {
    const amount = parseUsd(body.amount);
    const out = await send.confirmDirect(ctx, { userId: user.id, txHash: body.txHash || null, from: body.address || null, to: parseAddress(body.to), amountMicro: amount, label: body.label });
    const pl = body.paylink ? paylinks.get(ctx, String(body.paylink)) : null;
    if (pl && pl.userId !== user.id && out && (out.txHash || body.txHash || out.id)) paylinks.record(ctx, { paylinkId: pl.id, kind: 'direct', ref: out.txHash || body.txHash || out.id, amountMicro: amount, payerUserId: user.id });
    return out;
  }, { rl: ['money', 60] });
  authed('POST', '/api/batches/draft', async ({ user, body }) => assertActive(user) || batch.draftBatch(ctx, { userId: user.id, senderAddress: body.address, title: body.title, items: body.items, lockSeconds: body.lockHours ? Math.round(Number(body.lockHours) * 3600) : null, payOnDelivery: !!body.payOnDelivery, autoRelease: body.autoRelease && ['time', 'post'].includes(body.autoRelease.mode) ? { mode: body.autoRelease.mode, at: Number(body.autoRelease.at), hours: Number(body.autoRelease.hours) } : null }), { rl: ['money', 10] });
  authed('POST', '/api/batches/:id/funded', async ({ user, params, body }) => batch.confirmBatchFunded(ctx, { batchId: params.id, userId: user.id, txHash: body.txHash }), { rl: ['money', 90] });
  authed('GET', '/api/batches', async ({ user }) => ({ batches: batch.list(ctx, user.id), max: batch.MAX_ITEMS }));
  authed('GET', '/api/batches/:id', async ({ user, params }) => batch.detail(ctx, { batchId: params.id, userId: user.id }), { rl: ['money', 60] });
  authed('GET', '/api/withdraw/options', async () => withdraw.options(ctx));
  authed('POST', '/api/withdraw/prepare', async ({ user, body }) => assertActive(user) || withdraw.prepare(ctx, { userId: user.id, route: body.route, to: body.to, amountMicro: parseUsd(body.amount) }), { rl: ['money', 20] });
  authed('POST', '/api/withdraw/:id/confirm', async ({ user, params, body }) => withdraw.confirm(ctx, { userId: user.id, id: params.id, txHash: body.txHash }), { rl: ['money', 90] });
  authed('GET', '/api/withdraw/:id', async ({ user, params }) => withdraw.get(ctx, { userId: user.id, id: params.id }), { rl: ['money', 90] });
  authed('GET', '/api/withdraw', async ({ user }) => ({ withdrawals: withdraw.list(ctx, user.id) }));
  authed('GET', '/api/naira/options', async () => naira.options(ctx), { rl: ['bal', 120] });
  authed('POST', '/api/naira/buy', async ({ user, body }) => assertActive(user) || naira.buyStart(ctx, { userId: user.id, amountNgn: body.amountNgn }), { rl: ['money', 20] });
  authed('POST', '/api/naira/buy/:id/test-paid', async ({ user, params }) => naira.buyTestPaid(ctx, { userId: user.id, id: params.id }), { rl: ['money', 20] });
  authed('POST', '/api/naira/sell/prepare', async ({ user, body }) => assertActive(user) || naira.sellPrepare(ctx, { userId: user.id, amountMicro: parseUsd(body.amount), bank: body.bank || {} }), { rl: ['money', 20] });
  authed('POST', '/api/naira/sell/:id/confirm', async ({ user, params, body }) => naira.sellConfirm(ctx, { userId: user.id, id: params.id, txHash: body.txHash }), { rl: ['money', 90] });
  authed('POST', '/api/naira/resolve', async ({ body }) => naira.resolveAccount(ctx, { bankCode: body.bankCode, accountNumber: body.accountNumber }), { rl: ['money', 40] });
  authed('GET', '/api/naira/orders/:id', async ({ user, params }) => naira.get(ctx, { userId: user.id, id: params.id }), { rl: ['money', 120] });
  authed('GET', '/api/naira/orders', async ({ user }) => ({ orders: naira.list(ctx, user.id) }));
  authed('GET', '/api/autopay', async ({ user }) => xpay.getSettings(ctx, user.id));
  authed('POST', '/api/autopay/prepare', async ({ user, body }) => xpay.prepareEnable(ctx, { userId: user.id, perPaymentMicro: parseUsd(body.perPayment), perDayMicro: parseUsd(body.perDay) }), { rl: ['money', 40] });
  authed('POST', '/api/autopay/confirm', async ({ user, body }) => xpay.confirmEnable(ctx, { userId: user.id, perPaymentMicro: parseUsd(body.perPayment), perDayMicro: parseUsd(body.perDay) }), { rl: ['money', 90] });
  authed('POST', '/api/autopay/prepare-off', async ({ user }) => xpay.prepareDisable(ctx, { userId: user.id }), { rl: ['money', 40] });
  const sendHtml = (res, status, html) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...secHeaders() }); res.end(html); return { __handled: true }; };
  router.add('GET', '/unsubscribe', async ({ res, query }) => { const t = query.get('t'); const email = unsub.verify(ctx, t); return sendHtml(res, email ? 200 : 400, email ? legal.unsubConfirm(ctx, t, email) : legal.unsubBad(ctx)); }, { auth: false, rl: ['public', 60] });
  router.add('POST', '/unsubscribe', async ({ res, query }) => { const email = unsub.verify(ctx, query.get('t')); if (!email) return sendHtml(res, 400, legal.unsubBad(ctx)); unsub.optOut(ctx, email, 'link'); audit(ctx.db, { actor: 'system', action: 'email.unsubscribed', subject: unsub.mask(email) }); return sendHtml(res, 200, legal.unsubDone(ctx, email)); }, { auth: false, rl: ['public', 30] });
  authed('GET', '/api/account/data-requests', async ({ user }) => ({ requests: datareq.list(ctx, user.id) }));
  authed('POST', '/api/account/data-request', async ({ user, body }) => ({ request: datareq.create(ctx, { userId: user.id, kind: body.kind || 'delete', detail: body.detail }) }), { rl: ['money', 10] });
  authed('POST', '/api/account/data-request/:id/cancel', async ({ user, params }) => ({ request: datareq.cancel(ctx, { userId: user.id, id: Number(params.id) }) }), { rl: ['money', 20] });
  authed('GET', '/api/account/export', async ({ user, res }) => {
    const data = datareq.exportData(ctx, user.id);
    audit(ctx.db, { actor: 'user:' + user.id, action: 'datarequest.export' });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="dovi-my-data-' + new Date(ctx.now()).toISOString().slice(0, 10) + '.json"', 'cache-control': 'no-store', ...secHeaders() });
    res.end(JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return { __handled: true };
  }, { rl: ['money', 10] });
  admin('GET', '/api/admin/data-requests', async () => ({ requests: datareq.adminList(ctx) }));
  admin('POST', '/api/admin/data-requests/:id', async ({ params, body, identity }) => ({ request: datareq.adminSet(ctx, { id: Number(params.id), status: body.status, note: body.note, actor: 'admin:' + identity }) }));
  authed('GET', '/api/agent-keys', async ({ user }) => ({ keys: agentkeys.list(ctx, user.id), mcpUrl: ctx.cfg.publicUrl + '/mcp', available: !!ctx.executor }));
  authed('POST', '/api/agent-keys', async ({ user, body }) => agentkeys.create(ctx, { userId: user.id, name: body.name, perPaymentMicro: parseUsd(body.perPayment), perDayMicro: parseUsd(body.perDay), days: body.days }), { rl: ['money', 20] });
  authed('POST', '/api/agent-keys/:id/revoke', async ({ user, params }) => agentkeys.revoke(ctx, { userId: user.id, id: params.id }), { rl: ['money', 40] });
  router.add('POST', '/mcp', async ({ req, res, body }) => { await mcp.handleHttp(ctx, req, res, body, { json, secHeaders }); return { __handled: true }; }, { auth: false, rl: ['mcp', 120] });
  router.add('GET', '/mcp', async () => { throw new HttpError(405, 'method_not_allowed', 'Use POST with a JSON-RPC body.'); }, { auth: false });
  authed('POST', '/api/autopay/confirm-off', async ({ user }) => xpay.confirmDisable(ctx, { userId: user.id }), { rl: ['money', 90] });
  authed('POST', '/api/requests', async ({ user, body }) => requests.createRequest(ctx, { userId: user.id, text: body.to, amountMicro: parseUsd(body.amount), note: body.note }), { rl: ['money', 20] });
  authed('GET', '/api/requests', async ({ user }) => requests.listRequests(ctx, user.id));
  authed('POST', '/api/requests/:id/decline', async ({ user, params }) => requests.decline(ctx, { userId: user.id, id: params.id }));

  /* activity, notifications, agent, reports */
  const actFilter = (query) => ({ q: query.get('q') || '', group: query.get('group') || '', since: query.get('since'), until: query.get('until') });
  authed('GET', '/api/activity', async ({ user, query }) => ({ activity: listActivity(ctx.db, user.id, { limit: query.get('limit'), before: query.get('before'), ...actFilter(query) }) }));
  authed('GET', '/api/activity/export', async ({ user, query, res }) => {
    const csv = require('./activity').exportCsv(ctx.db, user.id, actFilter(query));
    audit(ctx.db, { actor: 'user:' + user.id, action: 'activity.export' });
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="dovi-activity-' + new Date(ctx.now()).toISOString().slice(0, 10) + '.csv"', 'cache-control': 'no-store', ...secHeaders() });
    res.end('\ufeff' + csv);
    return { __handled: true };
  }, { rl: ['money', 20] });
  authed('GET', '/api/notifications', async ({ user, query }) => ({ notifications: notifications.listNotifications(ctx.db, user.id, { limit: query.get('limit'), before: query.get('before'), group: query.get('group') }), unread: notifications.unreadCount(ctx.db, user.id) }));
  authed('POST', '/api/notifications/read', async ({ user, body }) => ({ marked: notifications.markRead(ctx.db, user.id, body.ids === 'all' ? 'all' : body.ids, ctx.now()), unread: notifications.unreadCount(ctx.db, user.id) }));
  authed('GET', '/api/notifications/stream', async ({ user, req, res }) => { ctx.hub.subscribe(ctx.db, user.id, res, req.headers['last-event-id']); return { __handled: true }; });
  const askDay = () => new Date(ctx.now()).toISOString().slice(0, 10);
  const askUsage = (userId) => {
    const limit = ctx.cfg.askDailyFree;
    const row = ctx.db.prepare('SELECT n FROM ask_usage WHERE user_id = ? AND day = ?').get(userId, askDay());
    const used = row ? Number(row.n) : 0;
    const t = new Date(ctx.now()); const resetsAt = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1);
    return { limit, used, remaining: Math.max(0, limit - used), resetsAt };
  };
  authed('GET', '/api/agent/usage', async ({ user }) => askUsage(user.id));
  authed('POST', '/api/agent', async ({ user, body }) => {
    const u = askUsage(user.id);
    if (u.remaining <= 0) return { ok: false, code: 'ask_limit', message: 'You have used your ' + u.limit + ' free messages for today. They reset at midnight UTC.', usage: u };
    ctx.db.prepare('INSERT INTO ask_usage (user_id, day, n) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET n = n + 1').run(user.id, askDay());
    const r = await agent.handle(ctx, user.id, body.text);
    ctx.db.prepare('INSERT INTO ask_intents (day, intent, n) VALUES (?, ?, 1) ON CONFLICT(day, intent) DO UPDATE SET n = n + 1').run(askDay(), String(r.intent || r.code || 'other').slice(0, 40));
    return { ...r, usage: askUsage(user.id) };
  }, { rl: ['money', 30] });
  authed('POST', '/api/agent/:id/approve', async ({ user, params }) => assertActive(user) || agent.approve(ctx, user.id, params.id), { rl: ['money', 30] });
  pub('POST', '/api/report', async ({ user, body }) => {
    const subject = String(body.subject || '').trim().slice(0, 120); const detail = String(body.detail || '').trim().slice(0, 2000);
    if (subject.length < 3 || detail.length < 10) throw new HttpError(400, 'report_too_short', 'Please add a short subject and a few details.');
    ctx.db.prepare('INSERT INTO reports (user_id, subject, detail, created_at) VALUES (?, ?, ?, ?)').run(user ? user.id : null, subject, detail, ctx.now());
    return { ok: true };
  }, { rl: ['report', 5], soft: true });

  /* admin */
  admin('GET', '/api/admin/earnings', async () => earnings(ctx));
  admin('GET', '/api/admin/claims', async () => ({
    byStatus: ctx.db.prepare('SELECT status, COUNT(*) AS n FROM claims GROUP BY status').all(),
    recent: ctx.db.prepare('SELECT id, status, amount_micro, fee_micro, recipient_label, expiry, created_at FROM claims ORDER BY created_at DESC LIMIT 25').all(),
    audit: recentAudit(ctx.db, 20),
  }));
  admin('POST', '/api/admin/chain', async ({ user, body }) => {
    try { ctx.registry.setStatus(String(body.id), String(body.status), 'admin:' + user.id); } catch (e) { throw new HttpError(400, 'refused', String(e.message)); }
    ctx.db.prepare('INSERT INTO chain_status (id, status, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at').run(body.id, body.status, ctx.now());
    audit(ctx.db, { actor: 'admin:' + user.id, action: 'chain.status', subject: body.id, data: { status: body.status } });
    return { ok: true, chains: ctx.registry.publicView() };
  });
  admin('GET', '/api/admin/x-outbox', async () => ({ queued: ctx.db.prepare("SELECT id, reply_to, text, status, created_at FROM x_outbox ORDER BY id DESC LIMIT 50").all(), mentions: ctx.db.prepare('SELECT tweet_id, author_handle, status, detail, claim_id, created_at FROM x_mentions ORDER BY created_at DESC LIMIT 50').all() }));
  admin('POST', '/api/admin/x-outbox/:id/sent', async ({ params }) => { ctx.db.prepare("UPDATE x_outbox SET status = 'sent', sent_at = ? WHERE id = ?").run(ctx.now ? ctx.now() : Date.now(), Number(params.id)); return { ok: true }; });
  admin('GET', '/api/admin/users', async ({ query }) => ({ users: controls.listUsers(ctx, { q: query ? query.get('q') || '' : '', limit: query ? query.get('limit') : null }) }));
  admin('POST', '/api/admin/users/:id/hold', async ({ user, params, body }) => controls.setHold(ctx, { userId: params.id, on: !!body.on, reason: body.reason, actor: 'admin:' + user.id }));
  admin('POST', '/api/admin/users/:id/limits', async ({ user, params, body }) => controls.setLimits(ctx, { userId: params.id, perClaimMicro: body.perClaimMicro, perDayMicro: body.perDayMicro, actor: 'admin:' + user.id }));
  admin('POST', '/api/admin/banner', async ({ user, body }) => controls.setBanner(ctx, { text: body.text, tone: body.tone, hours: body.hours, actor: 'admin:' + user.id }));
  pub('GET', '/api/banner', async () => ({ banner: controls.getBanner(ctx) }), { soft: true });
  admin('POST', '/api/admin/sweep', async () => claims.sweep(ctx));

  const waitlistOrigins = new Set(String((ctx.env && ctx.env.DOVI_WAITLIST_ORIGINS) || 'https://dovi.finance,https://www.dovi.finance').split(',').map((x) => x.trim()).filter(Boolean));
  const waitlistOriginOk = (req) => waitlistOrigins.has(String(req.headers.origin || ''));


  const attr = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function servePayPage(req, res, pathname) {
    let html;
    try { html = require('node:fs').readFileSync(require('node:path').join(ctx.cfg.publicDir, 'pay.html'), 'utf8'); } catch { return false; }
    let title = 'Pay on DOVI'; let desc = 'Pay in dollars with just an X handle or an email. They claim with one login. No wallet needed.';
    try {
      const code = /^\/p\/(.+)$/.exec(pathname);
      if (code) {
        const v = paylinks.publicView(ctx, code[1]);
        if (v && v.active) { title = v.title + ' | Pay ' + v.handle + ' on DOVI'; desc = (v.amountMicro ? formatUsd(BigInt(v.amountMicro)) + ' to ' : 'Pay ') + v.handle + ' in dollars. Sign in, check the details and approve. No wallet needed.'; }
      } else {
        const h = '@' + pathname.split('/')[2].replace(/^@/, '');
        title = 'Pay ' + h + ' on DOVI'; desc = 'Pay ' + h + ' in dollars with just their X handle. They claim with one login. No wallet needed.';
      }
    } catch { /* keep defaults */ }
    const img = ctx.cfg.ogImage || (ctx.cfg.publicUrl + '/brand/dovi-og-background-20260828.png');
    const self = ctx.cfg.payBaseUrl + pathname;
    const meta = '<title>' + attr(title) + '</title><meta name="description" content="' + attr(desc) + '"><meta name="dovi-app" content="' + attr(ctx.cfg.publicUrl) + '"><meta property="og:url" content="' + attr(self) + '"><meta property="og:type" content="website"><meta property="og:site_name" content="DOVI"><meta property="og:title" content="' + attr(title) + '"><meta property="og:description" content="' + attr(desc) + '"><meta property="og:image" content="' + attr(img) + '"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="' + attr(title) + '"><meta name="twitter:description" content="' + attr(desc) + '"><meta name="twitter:image" content="' + attr(img) + '">';
    html = html.replace(/<title>[\s\S]*?<\/title>/, () => meta);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...secHeaders() });
    if (req.method === 'HEAD') { res.end(); return true; }
    res.end(html); return true;
  }


  async function serveProofPage(req, res, pathname) {
    let html;
    try { html = require('node:fs').readFileSync(require('node:path').join(ctx.cfg.publicDir, 'proof.html'), 'utf8'); } catch { return false; }
    let title = 'DOVI receipt'; let desc = 'A payment receipt shared from DOVI. Anyone can check it on the block explorer.';
    try {
      const v = receipts.view(ctx, pathname.split('/')[2], { count: false });
      if (v) { title = 'Receipt: ' + formatUsd(BigInt(v.amountMicro)) + (v.role === 'sender' ? ' sent to ' + v.to : ' from ' + v.from) + ' | DOVI'; desc = 'A DOVI payment receipt on ' + v.network + '. The transactions can be checked on the block explorer.'; }
    } catch { /* keep defaults */ }
    const img = ctx.cfg.ogImage || (ctx.cfg.publicUrl + '/brand/dovi-og-background-20260828.png');
    const meta = '<title>' + attr(title) + '</title><meta name="description" content="' + attr(desc) + '"><meta name="dovi-app" content="' + attr(ctx.cfg.publicUrl) + '"><meta property="og:url" content="' + attr(ctx.cfg.payBaseUrl + pathname) + '"><meta property="og:type" content="website"><meta property="og:site_name" content="DOVI"><meta property="og:title" content="' + attr(title) + '"><meta property="og:description" content="' + attr(desc) + '"><meta property="og:image" content="' + attr(img) + '"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="' + attr(title) + '"><meta name="twitter:description" content="' + attr(desc) + '"><meta name="twitter:image" content="' + attr(img) + '">';
    html = html.replace(/<title>[\s\S]*?<\/title>/, () => meta);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...secHeaders() });
    if (req.method === 'HEAD') { res.end(); return true; }
    res.end(html); return true;
  }


  async function serveGiveawayPage(req, res, pathname) {
    let html;
    try { html = require('node:fs').readFileSync(require('node:path').join(ctx.cfg.publicDir, 'giveaway.html'), 'utf8'); } catch { return false; }
    let title = 'DOVI giveaway'; let desc = 'A giveaway draw run by DOVI. The winners are picked at random and the draw can be checked.';
    try { const v = giveaway.publicView(ctx, pathname.split('/')[2]); if (v) { title = (v.status === 'drawn' ? 'Giveaway winners' : 'Giveaway') + (v.creator ? ' from ' + v.creator : '') + ' | DOVI'; desc = v.winners + (v.winners === 1 ? ' winner' : ' winners') + ' picked at random from people who retweeted and replied. The draw record is public.'; } } catch { /* keep defaults */ }
    const img = ctx.cfg.ogImage || (ctx.cfg.publicUrl + '/brand/dovi-og-background-20260828.png');
    const meta = '<title>' + attr(title) + '</title><meta name="description" content="' + attr(desc) + '"><meta name="dovi-app" content="' + attr(ctx.cfg.publicUrl) + '"><meta property="og:url" content="' + attr(ctx.cfg.payBaseUrl + pathname) + '"><meta property="og:type" content="website"><meta property="og:site_name" content="DOVI"><meta property="og:title" content="' + attr(title) + '"><meta property="og:description" content="' + attr(desc) + '"><meta property="og:image" content="' + attr(img) + '"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="' + attr(title) + '"><meta name="twitter:description" content="' + attr(desc) + '"><meta name="twitter:image" content="' + attr(img) + '">';
    html = html.replace(/<title>[\s\S]*?<\/title>/, () => meta);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...secHeaders() });
    if (req.method === 'HEAD') { res.end(); return true; }
    res.end(html); return true;
  }

  async function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); return res.end('{"error":"bad_request","message":"Bad request."}'); }
    const pathname = url.pathname;
    if (ctx.cfg.base.testnet) res.setHeader('x-robots-tag', 'noindex, nofollow');
    const t0 = Date.now(); const rid = require('node:crypto').randomBytes(6).toString('hex');
    res.setHeader('x-request-id', rid);
    if (ctx.reqlog) res.on('finish', () => ctx.reqlog({ ts: new Date(t0).toISOString(), rid, m: req.method, p: require('./reqlog').redact(pathname), s: res.statusCode, ms: Date.now() - t0, u: req.__uid || null }));
    const fail = (e) => {
      const known = e instanceof HttpError || e instanceof controls.ControlError || e instanceof tokens.TokenError || e instanceof recovery.RecoveryError || e instanceof swap.SwapError || e instanceof claims.ClaimError || e instanceof send.SendError || e instanceof requests.RequestError || e instanceof batch.BatchError || e instanceof withdraw.WithdrawError || e instanceof naira.NairaError || e instanceof xpay.XPayError || e instanceof agentkeys.AgentKeyError || e instanceof datareq.DataRequestError || e instanceof waitlist.WaitlistError || e instanceof paylinks.PaylinkError || e instanceof receipts.ReceiptError || e instanceof giveaway.GiveawayError || e instanceof MoneyError || e instanceof IdError || e instanceof ChainNotLive || (e && e.code === 'identity_taken');
      const status = e instanceof ChainNotLive ? 503 : (e.status || (known ? 400 : 500));
      if (!known) console.error('[dovi] unhandled', e && e.stack || e);
      const code = e instanceof ChainNotLive ? 'chain_not_live' : (e.code || 'server_error');
      const message = e instanceof ChainNotLive ? 'DOVI is paused on this network right now. Please try again soon.' : (known ? e.message : 'Something went wrong. Please try again.');
      if (!res.headersSent) json(res, status, e && e.details ? { error: code, message, details: e.details } : { error: code, message }, secHeaders());
    };
    try {
      if (pathname.startsWith('/cdpapi') || pathname.startsWith('/cdpwallet')) return ctx.cdpProxy(req, res, url);
      const m = router.match(req.method === 'HEAD' ? 'GET' : req.method, pathname);
      if (m) {
        const { route, params } = m;
        if (req.method !== 'GET' && req.method !== 'HEAD' && !originOk(req, ctx.cfg.publicUrl) && !(pathname.startsWith('/api/waitlist/') && waitlistOriginOk(req)) && !(req.url.startsWith('/api/waitlist/x/callback')) && !(req.url.startsWith('/api/auth/x/callback')) && !(req.url.startsWith('/api/csp-report')) && pathname !== '/mcp' && pathname !== '/unsubscribe') throw new HttpError(403, 'bad_origin', 'That request was blocked.');
        if (route.opts.rl) { const [bucket, max] = route.opts.rl; if (!hit(bucket + ':' + route.re.source + ':' + clientIp(req), max, 60000)) throw new HttpError(429, 'rate_limited', 'Too many requests. Please slow down.'); }
        const identity = sessionIdentity(ctx, req);
        const user = identity ? userFromSession(ctx, identity) : null;
        req.__uid = user ? user.id : null;
        if (route.opts.auth && !user) throw new HttpError(401, 'sign_in_required', 'Please sign in.');
        if (route.opts.admin && !(ctx.cfg.admins.includes(String(identity).toLowerCase()) || ctx.cfg.admins.includes('user:' + user.id))) throw new HttpError(403, 'forbidden', 'Not allowed.');
        const body = req.method === 'POST' && pathname !== '/unsubscribe' ? await readJson(req) : {};
        const out = await route.handler({ req, res, params, query: url.searchParams, body, identity, user });
        if (out && out.__handled) return;
        if (out && out.__redirect) { const h = { location: out.__redirect, 'cache-control': 'no-store' }; if (out.__cookie) h['set-cookie'] = out.__cookie; res.writeHead(302, h); return res.end(); }
        const h = { ...secHeaders() };
        if (out && out.__cookie) { h['set-cookie'] = out.__cookie; delete out.__cookie; }
        return json(res, 200, out, h);
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && pathname.replace(/\/$/, '') === '/judges') { sendHtml(res, 200, legal.judges(ctx)); return; }
      const LEGAL = { '/privacy': 'privacy', '/privacy.html': 'privacy', '/terms': 'terms', '/terms.html': 'terms', '/refunds': 'refunds', '/cookies': 'cookies', '/data-request': 'data-request' };
      if ((req.method === 'GET' || req.method === 'HEAD') && LEGAL[pathname.replace(/\/$/, '')]) { const html = legal.render(ctx, LEGAL[pathname.replace(/\/$/, '')]); if (html) { sendHtml(res, 200, html); return; } }
      const gvPage = /^\/g\/\d{1,10}$/.test(pathname);
      if (gvPage && (req.method === 'GET' || req.method === 'HEAD')) { if (await serveGiveawayPage(req, res, pathname)) return; }
      const proofPage = /^\/r\/[2-9a-hj-km-np-zA-HJ-NP-Z]{12}$/.test(pathname);
      if (proofPage && (req.method === 'GET' || req.method === 'HEAD')) { if (await serveProofPage(req, res, pathname)) return; }
      const payPage = /^\/(?:pay\/@?[A-Za-z0-9_]{1,15}|p\/[2-9a-hj-km-np-zA-HJ-NP-Z]{8})$/.test(pathname);
      if (payPage && (req.method === 'GET' || req.method === 'HEAD')) { if (await servePayPage(req, res, pathname)) return; }
      if (pathname === '/robots.txt' && ctx.cfg.base.testnet) { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' }); return res.end('User-agent: *\nDisallow: /\n'); }
      const claimPage = /^\/(?:claim\/0x[0-9a-f]{64}|c\/[2-9a-hj-km-np-zA-HJ-NP-Z]{8})$/.exec(pathname);
      if (claimPage && (req.method === 'GET' || req.method === 'HEAD')) { if (serveStatic(ctx.cfg.publicDir, '/claim.html', req, res)) return; }
      if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/waitlist') { res.writeHead(302, { location: '/app', 'cache-control': 'no-store' }); res.end(); return; }
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(ctx.cfg.publicDir, pathname, req, res, PAGES)) return;
      if (pathname.startsWith('/api/')) return json(res, 404, { error: 'not_found', message: 'Not found.' });
      return json(res, 404, { error: 'not_found', message: 'Not found.' }, secHeaders());
    } catch (e) { fail(e); }
  }
  return { handler, router };
}

module.exports = { createApp };
