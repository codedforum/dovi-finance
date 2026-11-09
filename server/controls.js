'use strict';
/* Operator controls: hold an account, set per-account limits, and show a notice to everyone. Every change is audited. */
const { audit } = require('./audit');

class ControlError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }

const BANNER_KEY = 'banner';
const TONES = new Set(['info', 'warn']);
const MAX_USD_MICRO = 1000000000n;

function userRow(db, userId) {
  const u = db.prepare('SELECT id, display_name, created_at, frozen_at, admin_frozen_at, admin_frozen_reason FROM users WHERE id = ?').get(Number(userId));
  if (!u) throw new ControlError('no_user', 'No such account.', 404);
  return u;
}

function setHold(ctx, { userId, on, reason = null, actor }) {
  const u = userRow(ctx.db, userId);
  const now = ctx.now ? ctx.now() : Date.now();
  if (on) ctx.db.prepare('UPDATE users SET admin_frozen_at = ?, admin_frozen_reason = ? WHERE id = ?').run(now, reason ? String(reason).slice(0, 200) : null, u.id);
  else ctx.db.prepare('UPDATE users SET admin_frozen_at = NULL, admin_frozen_reason = NULL WHERE id = ?').run(u.id);
  audit(ctx.db, { actor, action: on ? 'admin.hold' : 'admin.release', subject: u.id, data: { reason: reason ? String(reason).slice(0, 200) : null } });
  return { userId: u.id, held: !!on };
}

function parseCap(v) {
  if (v === null || v === undefined || v === '') return null;
  let n;
  try { n = BigInt(v); } catch { throw new ControlError('bad_limit', 'Limits are whole micro-dollar amounts.'); }
  if (n < 0n || n > MAX_USD_MICRO * 1000n) throw new ControlError('bad_limit', 'That limit is out of range.');
  return n.toString();
}

function setLimits(ctx, { userId, perClaimMicro, perDayMicro, actor }) {
  const u = userRow(ctx.db, userId);
  const pc = parseCap(perClaimMicro); const pd = parseCap(perDayMicro);
  const now = ctx.now ? ctx.now() : Date.now();
  if (pc === null && pd === null) ctx.db.prepare('DELETE FROM user_limits WHERE user_id = ?').run(u.id);
  else ctx.db.prepare('INSERT INTO user_limits (user_id, per_claim_micro, per_day_micro, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET per_claim_micro = excluded.per_claim_micro, per_day_micro = excluded.per_day_micro, updated_at = excluded.updated_at').run(u.id, pc, pd, now);
  audit(ctx.db, { actor, action: 'admin.limits', subject: u.id, data: { perClaimMicro: pc, perDayMicro: pd } });
  return { userId: u.id, perClaimMicro: pc, perDayMicro: pd };
}

function limitsFor(db, userId) {
  const r = db.prepare('SELECT per_claim_micro, per_day_micro FROM user_limits WHERE user_id = ?').get(Number(userId));
  return { perClaim: r && r.per_claim_micro != null ? BigInt(r.per_claim_micro) : null, perDay: r && r.per_day_micro != null ? BigInt(r.per_day_micro) : null };
}

function cleanText(s, n) { return String(s == null ? '' : s).replace(/[\u2014\u2013\u00b7]/g, ',').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }

function setBanner(ctx, { text, tone = 'info', hours = null, actor }) {
  const now = ctx.now ? ctx.now() : Date.now();
  const t = cleanText(text, 200);
  if (!t) { ctx.db.prepare('DELETE FROM kv WHERE k = ?').run(BANNER_KEY); audit(ctx.db, { actor, action: 'admin.banner.clear' }); return { banner: null }; }
  const until = hours ? now + Math.min(Number(hours), 24 * 14) * 3600000 : null;
  const b = { text: t, tone: TONES.has(tone) ? tone : 'info', until };
  ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').run(BANNER_KEY, JSON.stringify(b), now);
  audit(ctx.db, { actor, action: 'admin.banner.set', data: b });
  return { banner: b };
}

function getBanner(ctx) {
  const r = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get(BANNER_KEY);
  if (!r) return null;
  let b; try { b = JSON.parse(r.v); } catch { return null; }
  const now = ctx.now ? ctx.now() : Date.now();
  if (!b || !b.text || (b.until && b.until < now)) return null;
  return { text: b.text, tone: b.tone === 'warn' ? 'warn' : 'info' };
}

function listUsers(ctx, { q = '', limit = 50 } = {}) {
  const like = '%' + String(q).replace(/[%_]/g, '') + '%';
  const rows = ctx.db.prepare('SELECT u.id, u.display_name, u.created_at, u.frozen_at, u.admin_frozen_at, u.admin_frozen_reason, l.per_claim_micro, l.per_day_micro FROM users u LEFT JOIN user_limits l ON l.user_id = u.id WHERE (? = \'%%\' OR u.display_name LIKE ? OR CAST(u.id AS TEXT) = ?) ORDER BY u.id DESC LIMIT ?').all(like, like, String(q), Math.min(Number(limit) || 50, 200));
  return rows.map((r) => ({ id: r.id, name: r.display_name, createdAt: r.created_at, selfFrozen: !!r.frozen_at, held: !!r.admin_frozen_at, holdReason: r.admin_frozen_reason, perClaimMicro: r.per_claim_micro, perDayMicro: r.per_day_micro }));
}

module.exports = { ControlError, setHold, setLimits, limitsFor, setBanner, getBanner, listUsers };
