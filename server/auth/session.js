'use strict';
const COOKIE = 'dovi_sess';

function defaultSessions() {
  const cdpAuth = require('../../lib/cdp-auth');
  return { mint: (identity, jti) => cdpAuth.mintSession(identity, jti), verify: (token) => cdpAuth.verifySession(token), read: (token) => cdpAuth.readSession(token) };
}

function parseCookie(header, name = COOKIE) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(header || '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

function cookieFor(token, { secure = true, maxAge = 2592000 } = {}) {
  return COOKIE + '=' + encodeURIComponent(token) + '; HttpOnly; ' + (secure ? 'Secure; ' : '') + 'SameSite=Lax; Path=/; Max-Age=' + maxAge;
}

function clearCookie({ secure = true } = {}) {
  return COOKIE + '=; HttpOnly; ' + (secure ? 'Secure; ' : '') + 'SameSite=Lax; Path=/; Max-Age=0';
}

function deviceLabel(req) {
  const ua = String((req.headers && req.headers['user-agent']) || '');
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return (br + ' on ' + os).slice(0, 60);
}

function issueSession(ctx, req, identity, opts = {}) {
  const id = require('node:crypto').randomBytes(12).toString('hex');
  const token = ctx.sessions.mint(identity, id);
  const u = ctx.db.prepare('SELECT id FROM users WHERE cdp_sub = ?').get(identity);
  if (u) {
    const now = ctx.now ? ctx.now() : Date.now();
    ctx.db.prepare('INSERT OR IGNORE INTO user_sessions (id, user_id, label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(id, u.id, deviceLabel(req), now, now);
  }
  return cookieFor(token, opts);
}

function sessionInfo(ctx, req) {
  const token = parseCookie(req.headers && req.headers.cookie);
  if (!token || !ctx.sessions.read) return null;
  return ctx.sessions.read(token) || null;
}

function sessionIdentity(ctx, req) {
  const token = parseCookie(req.headers && req.headers.cookie);
  if (!token) return null;
  const identity = ctx.sessions.verify(token) || null;
  if (!identity || !ctx.sessions.read) return identity;
  const info = ctx.sessions.read(token);
  if (!info) return null;
  const u = ctx.db.prepare('SELECT id, sessions_valid_from FROM users WHERE cdp_sub = ?').get(identity);
  if (!u) return identity;
  if (u.sessions_valid_from && info.iatMs < u.sessions_valid_from) return null;
  if (info.jti) {
    const row = ctx.db.prepare('SELECT revoked_at, last_seen_at FROM user_sessions WHERE id = ?').get(info.jti);
    if (row && row.revoked_at) return null;
    const now = ctx.now ? ctx.now() : Date.now();
    if (row && now - Number(row.last_seen_at) > 5 * 60 * 1000) ctx.db.prepare('UPDATE user_sessions SET last_seen_at = ? WHERE id = ?').run(now, info.jti);
  }
  return identity;
}

module.exports = { COOKIE, defaultSessions, parseCookie, cookieFor, clearCookie, sessionIdentity, sessionInfo, issueSession, deviceLabel };
