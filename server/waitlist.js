'use strict';
const crypto = require('node:crypto');

class WaitlistError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.name = 'WaitlistError'; this.code = code; this.status = status; }
}

const COOKIE = 'dovi_wl';
const YEAR_S = 365 * 24 * 3600;
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const now = (ctx) => (ctx.now ? ctx.now() : Date.now());

function sessionKey(env) {
  const base = env.DOVI_WAITLIST_SECRET || env.X_CLIENT_SECRET || '';
  return crypto.createHmac('sha256', base).update('dovi-waitlist-session-v1').digest();
}
function mintSession(env, xId, nowMs) {
  const p = Buffer.from(JSON.stringify({ t: String(xId), e: Math.floor(nowMs / 1000) + YEAR_S })).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', sessionKey(env)).update(p).digest('base64url');
}
function readSession(env, token, nowMs) {
  const s = String(token || ''); const i = s.indexOf('.');
  if (i < 1 || !(env.DOVI_WAITLIST_SECRET || env.X_CLIENT_SECRET)) return null;
  const p = s.slice(0, i); const sig = Buffer.from(s.slice(i + 1), 'base64url');
  const want = crypto.createHmac('sha256', sessionKey(env)).update(p).digest();
  if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return null;
  try { const j = JSON.parse(Buffer.from(p, 'base64url').toString()); return j.e * 1000 > nowMs && /^\d+$/.test(j.t) ? j.t : null; } catch { return null; }
}
function cookieFor(token, secure) { return COOKIE + '=' + encodeURIComponent(token) + '; HttpOnly; ' + (secure ? 'Secure; ' : '') + 'SameSite=Lax; Path=/; Max-Age=' + YEAR_S; }
function clearCookie(secure) { return COOKIE + '=; HttpOnly; ' + (secure ? 'Secure; ' : '') + 'SameSite=Lax; Path=/; Max-Age=0'; }
function tokenFromReq(req) {
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)').exec((req.headers && req.headers.cookie) || '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

function newCode(db) {
  for (let n = 0; n < 20; n++) {
    let c = '';
    const b = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) c += CODE_CHARS[b[i] % CODE_CHARS.length];
    if (!db.prepare('SELECT 1 FROM waitlist WHERE ref_code = ?').get(c)) return c;
  }
  throw new WaitlistError('code_failed', 'Could not make your code. Please try again.', 500);
}

function normRef(v) { const c = String(v || '').trim().toUpperCase(); return /^[2-9A-HJKMNP-Z]{8}$/.test(c) ? c : null; }

function safeAvatar(url) {
  const u = String(url || '');
  return /^https:\/\/pbs\.twimg\.com\/[A-Za-z0-9_\/.\-]+$/.test(u) ? u.replace('_normal.', '_400x400.') : null;
}

function join(ctx, x, refCode, source = 'waitlist') {
  const db = ctx.db; const t = now(ctx);
  const handle = x.handle ? '@' + String(x.handle).replace(/^@/, '') : null;
  const name = x.name ? String(x.name).slice(0, 60) : null;
  const avatar = safeAvatar(x.avatar);
  const have = db.prepare('SELECT * FROM waitlist WHERE x_id = ?').get(x.xId);
  if (have) {
    db.prepare('UPDATE waitlist SET x_handle = ?, name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url), last_seen_at = ? WHERE id = ?').run(handle, name, avatar, t, have.id);
    if (source === 'waitlist' && have.source === 'app') db.prepare("UPDATE waitlist SET source = 'waitlist' WHERE id = ?").run(have.id);
    return { row: db.prepare('SELECT * FROM waitlist WHERE id = ?').get(have.id), created: false };
  }
  let by = null;
  const rc = normRef(refCode);
  if (rc) { const r = db.prepare('SELECT id FROM waitlist WHERE ref_code = ?').get(rc); if (r) by = r.id; }
  const info = db.prepare('INSERT INTO waitlist (x_id, x_handle, name, avatar_url, ref_code, referred_by, created_at, last_seen_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(x.xId, handle, name, avatar, newCode(db), by, t, t, source);
  return { row: db.prepare('SELECT * FROM waitlist WHERE id = ?').get(Number(info.lastInsertRowid)), created: true };
}

function profile(ctx, row) {
  const db = ctx.db;
  const position = Number(db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE id <= ?').get(row.id).n);
  const referrals = Number(db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE referred_by = ?').get(row.id).n);
  const site = (ctx.env && ctx.env.WAITLIST_SITE_URL) || 'https://dovi.finance';
  return { name: row.name, handle: row.x_handle, avatarUrl: row.avatar_url, email: row.email, refCode: row.ref_code, refLink: site.replace(/\/+$/, '') + '/?ref=' + row.ref_code, referrals, position, joinedAt: row.created_at };
}

function setEmail(ctx, row, email) {
  if (row.email) throw new WaitlistError('email_locked', 'Your email is already saved and cannot be changed here.', 409);
  const e = String(email || '').trim().toLowerCase();
  if (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new WaitlistError('bad_email', 'Enter a valid email address.');
  ctx.db.prepare('UPDATE waitlist SET email = ?, email_added_at = ? WHERE id = ?').run(e, now(ctx), row.id);
  return ctx.db.prepare('SELECT * FROM waitlist WHERE id = ?').get(row.id);
}

function me(ctx, req) {
  const id = readSession(ctx.env || {}, tokenFromReq(req), now(ctx));
  if (!id) return null;
  return ctx.db.prepare('SELECT * FROM waitlist WHERE x_id = ?').get(id) || null;
}

function byCode(ctx, code) {
  const c = normRef(code);
  return c ? ctx.db.prepare('SELECT * FROM waitlist WHERE ref_code = ?').get(c) || null : null;
}

function forAppUser(ctx, userId) {
  const { userIdentities } = require('./identity');
  const x = userIdentities(ctx.db, userId).find((i) => i.kind === 'x');
  if (!x) return null;
  const have = ctx.db.prepare('SELECT * FROM waitlist WHERE x_id = ?').get(String(x.provider_id));
  if (have) return have;
  const u = ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
  return join(ctx, { xId: String(x.provider_id), handle: x.label ? String(x.label).replace(/^@/, '') : null, name: u && u.display_name && !String(u.display_name).startsWith('@') ? u.display_name : null, avatar: null }, null, 'app').row;
}

function announceRecipients(ctx, campaign) {
  const unsub = require('./unsubscribe');
  const rows = ctx.db.prepare('SELECT w.id, w.name, w.email FROM waitlist w WHERE w.email IS NOT NULL ORDER BY w.id').all();
  const sent = new Set(ctx.db.prepare('SELECT waitlist_id FROM waitlist_sends WHERE campaign = ?').all(campaign).map((r) => r.waitlist_id));
  const out = { eligible: [], optedOut: 0, alreadySent: 0, withoutEmail: ctx.db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE email IS NULL').get().n };
  for (const r of rows) {
    if (sent.has(r.id)) out.alreadySent += 1;
    else if (unsub.isOptedOut(ctx.db, r.email)) out.optedOut += 1;
    else out.eligible.push(r);
  }
  return out;
}

async function announce(ctx, { campaign, content, send = false }) {
  if (!/^[a-z0-9-]{3,40}$/.test(String(campaign || ''))) throw new WaitlistError('bad_campaign', 'Campaign needs 3 to 40 lowercase letters, digits or dashes.');
  const emails = require('./emails/templates'); const unsub = require('./unsubscribe'); const { audit } = require('./audit');
  const plan = announceRecipients(ctx, campaign);
  const report = { campaign, eligible: plan.eligible.length, optedOut: plan.optedOut, alreadySent: plan.alreadySent, withoutEmail: plan.withoutEmail, sent: 0, failed: 0 };
  if (!send) return report;
  if (!ctx.mailer) throw new WaitlistError('no_mailer', 'No mailer is configured.', 503);
  for (const r of plan.eligible) {
    const m = emails.render('waitlistNote', { ...content, name: r.name }, { unsubUrl: unsub.link(ctx, r.email), business: ctx.cfg.business });
    try {
      await ctx.mailer.send({ to: r.email, ...m });
      ctx.db.prepare('INSERT OR IGNORE INTO waitlist_sends (campaign, waitlist_id, sent_at) VALUES (?, ?, ?)').run(campaign, r.id, now(ctx));
      report.sent += 1;
    } catch { report.failed += 1; }
  }
  audit(ctx.db, { actor: 'system', action: 'waitlist.announced', subject: campaign, data: { sent: report.sent, failed: report.failed } });
  return report;
}

module.exports = { announce, announceRecipients, byCode, forAppUser, WaitlistError, mintSession, readSession, cookieFor, clearCookie, join, profile, setEmail, me, normRef, COOKIE };
