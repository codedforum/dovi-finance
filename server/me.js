'use strict';
const { utcDay } = require('./limits');

function sum(db, sql, ...args) {
  const r = db.prepare(sql).get(...args);
  return { n: Number(r.n), micro: String(r.s == null ? 0 : r.s) };
}

function summary(ctx, user) {
  const db = ctx.db; const id = user.id; const c = ctx.cfg.claim;
  const base = 'SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount_micro AS INTEGER)), 0) AS s FROM claims WHERE sender_user_id = ?';
  const sent = sum(db, base + " AND status IN ('funded','claimed','returned','expired')", id);
  const claimed = sum(db, base + " AND status = 'claimed'", id);
  const waiting = sum(db, base + " AND status IN ('funded','expired')", id);
  const returned = sum(db, base + " AND status = 'returned'", id);
  const fees = sum(db, "SELECT COUNT(*) AS n, COALESCE(SUM(CAST(fee_micro AS INTEGER)), 0) AS s FROM claims WHERE sender_user_id = ? AND status = 'claimed'", id);
  const received = sum(db, "SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount_micro AS INTEGER)), 0) AS s FROM activity WHERE user_id = ? AND kind IN ('claim_received','receive')", id);
  const direct = sum(db, "SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount_micro AS INTEGER)), 0) AS s FROM activity WHERE user_id = ? AND kind = 'send'", id);
  const used = db.prepare('SELECT spent_micro FROM limits_usage WHERE user_id = ? AND day = ?').get(id, utcDay(ctx.now()));
  const first = db.prepare('SELECT MIN(created_at) AS t FROM activity WHERE user_id = ?').get(id);
  return {
    memberSince: user.created_at,
    firstActivityAt: first && first.t ? Number(first.t) : null,
    stats: { sent, claimed, waiting, returned, feesPaid: fees, received, directSent: direct },
    limits: { perClaimMicro: c.perClaimCapMicro.toString(), perDayMicro: c.perUserDayCapMicro.toString(), spentTodayMicro: used ? String(used.spent_micro) : '0', minMicro: c.minAmountMicro.toString(), feeBps: Number(c.feeBps), feeMinMicro: c.feeMinMicro.toString() },
  };
}

module.exports = { summary };
