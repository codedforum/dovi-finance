'use strict';

const CATS = { send: 'sent', claim_funded: 'sent', receive: 'received', claim_received: 'received', claim_returned: 'returned', topup: 'added', withdraw: 'withdrawn' };
const LABEL = { send: 'Sent', claim_funded: 'Sent', claim_sent: 'Claimed by recipient', receive: 'Received', claim_received: 'Received', claim_returned: 'Taken back', claim_expired: 'Expired', topup: 'Added money', withdraw: 'Withdrawn' };
const INBOUND = new Set(['receive', 'claim_received', 'claim_returned', 'topup']);

function monthRange(ym, nowMs) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(ym || ''));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]);
  const start = Date.UTC(y, mo - 1, 1); const end = Date.UTC(y, mo, 1);
  if (start > nowMs || y < 2020) return null;
  return { start, end, label: new Date(start).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
}

function months(ctx, userId) {
  const first = ctx.db.prepare('SELECT MIN(created_at) AS t FROM activity WHERE user_id = ?').get(userId);
  const now = new Date(ctx.now());
  const out = [];
  const start = first && first.t ? new Date(Number(first.t)) : now;
  let y = now.getUTCFullYear(); let m = now.getUTCMonth();
  for (let i = 0; i < 24; i++) {
    const t = Date.UTC(y, m, 1);
    if (t < Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)) break;
    out.push(y + '-' + String(m + 1).padStart(2, '0'));
    m--; if (m < 0) { m = 11; y--; }
  }
  return out;
}

function build(ctx, userId, ym) {
  const r = monthRange(ym, ctx.now());
  if (!r) return null;
  const rows = ctx.db.prepare('SELECT * FROM activity WHERE user_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at ASC, id ASC LIMIT 2000').all(userId, r.start, r.end);
  const totals = { sentMicro: 0n, sentCount: 0, receivedMicro: 0n, receivedCount: 0, returnedMicro: 0n, returnedCount: 0, addedMicro: 0n, addedCount: 0, withdrawnMicro: 0n, withdrawnCount: 0 };
  for (const a of rows) {
    const c = CATS[a.kind]; if (!c || a.amount_micro == null) continue;
    totals[c + 'Micro'] += BigInt(a.amount_micro); totals[c + 'Count']++;
  }
  const fee = ctx.db.prepare("SELECT COALESCE(SUM(CAST(fee_micro AS INTEGER)), 0) AS s FROM claims WHERE sender_user_id = ? AND status = 'claimed' AND claimed_at >= ? AND claimed_at < ?").get(userId, r.start, r.end);
  const u = ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
  return {
    month: ym, label: r.label, from: r.start, to: r.end - 1, holder: (u && u.display_name) || null,
    network: ctx.cfg.base.testnet ? 'Base Sepolia' : 'Base', testnet: !!ctx.cfg.base.testnet, generatedAt: ctx.now(),
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])), feesMicro: String(fee.s),
    rows: rows.map((a) => ({ id: a.id, type: LABEL[a.kind] || a.kind, direction: INBOUND.has(a.kind) ? 'in' : 'out', counterparty: a.counterparty || null, amountMicro: a.amount_micro, status: a.status, at: a.created_at, ref: a.ref || null })),
    truncated: rows.length >= 2000,
  };
}

module.exports = { build, months, monthRange };
