'use strict';
const crypto = require('node:crypto');
const { parseUsd, formatUsd } = require('./money');
const { utcDay } = require('./limits');
const { audit } = require('./audit');

class AgentKeyError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.name = 'AgentKeyError'; this.code = code; this.status = status; }
}

const nowMs = (ctx) => (ctx.now ? ctx.now() : Date.now());
const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
const MAX_KEYS = 10;

function dayStartMs(ctx) { return Date.parse(utcDay(nowMs(ctx)) + 'T00:00:00Z'); }

function spentToday(ctx, keyId) {
  const r = ctx.db.prepare("SELECT COALESCE(SUM(CAST(amount_micro AS INTEGER)), 0) AS s FROM claims WHERE agent_key_id = ? AND ((funded_at IS NOT NULL AND funded_at >= ?) OR (status = 'draft' AND created_at >= ?))").get(keyId, dayStartMs(ctx), Math.max(dayStartMs(ctx), nowMs(ctx) - 15 * 60 * 1000));
  return BigInt(r.s);
}

function view(ctx, row) {
  const spent = spentToday(ctx, row.id);
  const day = BigInt(row.per_day_micro);
  const expired = !!(row.expires_at && row.expires_at <= nowMs(ctx));
  return {
    id: row.id, name: row.name, prefix: row.prefix,
    perPaymentMicro: row.per_payment_micro, perDayMicro: row.per_day_micro,
    spentTodayMicro: spent.toString(), remainingTodayMicro: (day > spent ? day - spent : 0n).toString(),
    expiresAt: row.expires_at || null, revokedAt: row.revoked_at || null, lastUsedAt: row.last_used_at || null, createdAt: row.created_at,
    status: row.revoked_at ? 'revoked' : expired ? 'expired' : 'active',
  };
}

function list(ctx, userId) {
  return ctx.db.prepare('SELECT * FROM agent_keys WHERE user_id = ? ORDER BY created_at DESC').all(userId).map((r) => view(ctx, r));
}

function create(ctx, { userId, name, perPaymentMicro, perDayMicro, days }) {
  const c = ctx.cfg.claim;
  const nm = String(name || '').trim().slice(0, 40);
  if (!nm) throw new AgentKeyError('name_required', 'Give the key a name, for example the agent that will use it.');
  const ap = ctx.db.prepare('SELECT * FROM autopay WHERE user_id = ? AND enabled = 1').get(userId);
  if (!ap) throw new AgentKeyError('autopay_required', 'Turn on Pay from X first. Its limits are the ceiling for every agent key.', 409);
  const pp = BigInt(perPaymentMicro); const pd = BigInt(perDayMicro);
  if (pp < c.minAmountMicro) throw new AgentKeyError('below_minimum', 'The per payment limit must be at least ' + formatUsd(c.minAmountMicro) + '.');
  if (pp > BigInt(ap.per_payment_micro)) throw new AgentKeyError('above_autopay', 'That is above your Pay from X limit of ' + formatUsd(BigInt(ap.per_payment_micro)) + ' per payment.');
  if (pd < pp) throw new AgentKeyError('bad_limits', 'The daily limit cannot be lower than the per payment limit.');
  if (pd > BigInt(ap.per_day_micro)) throw new AgentKeyError('above_autopay', 'That is above your Pay from X limit of ' + formatUsd(BigInt(ap.per_day_micro)) + ' per day.');
  if (pp > c.perClaimCapMicro || pd > c.perUserDayCapMicro) throw new AgentKeyError('above_cap', 'That is above the beta limits.');
  const never = days === 'never' || days === 0;
  const d = never ? 0 : Number(days);
  if (!never && (!Number.isFinite(d) || d < 1 || d > 90)) throw new AgentKeyError('bad_expiry', 'Pick a lifetime from 1 to 90 days, or never.');
  if (ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_keys WHERE user_id = ? AND revoked_at IS NULL').get(userId).n >= MAX_KEYS) throw new AgentKeyError('too_many', 'You have ' + MAX_KEYS + ' active keys. Revoke one first.', 409);
  const secret = 'dvk_' + crypto.randomBytes(24).toString('base64url');
  const id = 'ak_' + crypto.randomBytes(6).toString('hex');
  const t = nowMs(ctx);
  ctx.db.prepare('INSERT INTO agent_keys (id, user_id, name, key_hash, prefix, per_payment_micro, per_day_micro, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, nm, hashKey(secret), secret.slice(0, 10), pp.toString(), pd.toString(), never ? null : t + Math.round(d * 86400000), t);
  audit(ctx.db, { actor: 'user:' + userId, action: 'agentkey.create', subject: id, data: { perPaymentMicro: pp.toString(), perDayMicro: pd.toString(), days: never ? 'never' : d } });
  return { key: secret, ...view(ctx, ctx.db.prepare('SELECT * FROM agent_keys WHERE id = ?').get(id)) };
}

function revoke(ctx, { userId, id }) {
  const row = ctx.db.prepare('SELECT * FROM agent_keys WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw new AgentKeyError('not_found', 'That key was not found.', 404);
  if (!row.revoked_at) {
    ctx.db.prepare('UPDATE agent_keys SET revoked_at = ? WHERE id = ?').run(nowMs(ctx), id);
    audit(ctx.db, { actor: 'user:' + userId, action: 'agentkey.revoke', subject: id });
  }
  return view(ctx, ctx.db.prepare('SELECT * FROM agent_keys WHERE id = ?').get(id));
}

function authenticate(ctx, secret) {
  const s = String(secret || '');
  if (!/^dvk_[A-Za-z0-9_-]{20,64}$/.test(s)) return null;
  const row = ctx.db.prepare('SELECT * FROM agent_keys WHERE key_hash = ?').get(hashKey(s));
  if (!row || row.revoked_at || (row.expires_at && row.expires_at <= nowMs(ctx))) return null;
  ctx.db.prepare('UPDATE agent_keys SET last_used_at = ? WHERE id = ?').run(nowMs(ctx), row.id);
  return row;
}

module.exports = { AgentKeyError, create, list, revoke, authenticate, spentToday, view, hashKey, parseUsd };
