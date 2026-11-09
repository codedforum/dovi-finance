'use strict';
const { MoneyError, parseUsd, formatUsd } = require('./money');

function utcDay(ts = Date.now()) { return new Date(ts).toISOString().slice(0, 10); }

function checkLimits(db, cfg, { userId, amountMicro, firstTimeRecipient = false, now = Date.now() }) {
  let a;
  try { a = typeof amountMicro === 'bigint' ? amountMicro : BigInt(amountMicro); } catch { return { ok: false, reason: 'bad_amount' }; }
  const c = cfg.claim;
  if (a <= 0n) return { ok: false, reason: 'bad_amount' };
  if (a < c.minAmountMicro) return { ok: false, reason: 'below_minimum', message: 'The minimum is ' + formatUsd(c.minAmountMicro) + '.' };
  const ov = db.prepare('SELECT per_claim_micro, per_day_micro FROM user_limits WHERE user_id = ?').get(userId);
  const perClaimCap = ov && ov.per_claim_micro != null ? BigInt(ov.per_claim_micro) : c.perClaimCapMicro;
  const perDayCap = ov && ov.per_day_micro != null ? BigInt(ov.per_day_micro) : c.perUserDayCapMicro;
  if (a > perClaimCap) return { ok: false, reason: 'above_cap', message: 'The limit per payment on your account is ' + formatUsd(perClaimCap) + '.' };
  const row = db.prepare('SELECT spent_micro FROM limits_usage WHERE user_id = ? AND day = ?').get(userId, utcDay(now));
  const draftWindow = now - 30 * 60 * 1000;
  const drafts = db.prepare("SELECT COALESCE(SUM(CAST(amount_micro AS INTEGER)), 0) AS s FROM claims WHERE sender_user_id = ? AND status = 'draft' AND created_at > ?").get(userId, draftWindow).s;
  const spent = (row ? BigInt(row.spent_micro) : 0n) + BigInt(drafts);
  if (spent + a > perDayCap) return { ok: false, reason: 'day_cap', message: 'The limit per day on your account is ' + formatUsd(perDayCap) + '.' };
  const locked = db.prepare("SELECT COALESCE(SUM(CAST(amount_micro AS INTEGER) + CAST(fee_micro AS INTEGER)), 0) AS s FROM claims WHERE status IN ('funded', 'expired') OR (status = 'draft' AND created_at > ?)").get(draftWindow).s;
  if (BigInt(locked) + a > c.globalCapMicro) return { ok: false, reason: 'global_cap', message: 'DOVI is at its beta limit for now. Try again soon.' };
  return { ok: true, firstTimeRecipient: !!firstTimeRecipient };
}

function recordSpend(db, userId, amountMicro, ts = Date.now()) {
  const day = utcDay(ts);
  const row = db.prepare('SELECT spent_micro FROM limits_usage WHERE user_id = ? AND day = ?').get(userId, day);
  const next = (row ? BigInt(row.spent_micro) : 0n) + BigInt(amountMicro);
  db.prepare('INSERT INTO limits_usage (user_id, day, spent_micro) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET spent_micro = excluded.spent_micro').run(userId, day, next.toString());
}

module.exports = { checkLimits, recordSpend, utcDay, parseUsd };
