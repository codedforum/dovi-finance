'use strict';

function recordActivity(db, { userId, kind, ref = null, counterparty = null, amountMicro = null, amountText = null, status = 'done', now = Date.now() }) {
  db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, amount_text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, kind, ref, counterparty, amountMicro == null ? null : String(amountMicro), amountText, status, now);
}

const GROUPS = {
  sent: ['send', 'claim_funded', 'claim_sent', 'token_sent'],
  received: ['receive', 'claim_received', 'token_received'],
  returned: ['claim_returned', 'claim_expired', 'token_returned'],
  swaps: ['swap'],
  added: ['topup'],
  withdrawn: ['withdraw'],
};
const LABEL = { send: 'Sent', claim_funded: 'Sent', claim_sent: 'Claimed', receive: 'Received', claim_received: 'Received', claim_returned: 'Taken back', claim_expired: 'Expired', token_sent: 'Sent', token_received: 'Received', token_returned: 'Taken back', swap: 'Swapped', topup: 'Added money', withdraw: 'Withdrawn' };
const INBOUND = new Set(['receive', 'claim_received', 'claim_returned', 'topup', 'token_received', 'token_returned']);

function filterSql(userId, { before = null, q = '', group = '', since = null, until = null } = {}) {
  const where = ['user_id = ?']; const args = [userId];
  if (before != null && before !== '') { where.push('id < ?'); args.push(Number(before)); }
  const kinds = GROUPS[String(group || '')];
  if (kinds) { where.push('kind IN (' + kinds.map(() => '?').join(',') + ')'); args.push(...kinds); }
  const text = String(q || '').trim().slice(0, 60);
  if (text) { where.push("(counterparty LIKE ? ESCAPE '\\' OR ref LIKE ? ESCAPE '\\')"); const like = '%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%'; args.push(like, like); }
  const t = Number(since);
  if (Number.isFinite(t) && t > 0) { where.push('created_at >= ?'); args.push(t); }
  const u = Number(until);
  if (Number.isFinite(u) && u > 0) { where.push('created_at < ?'); args.push(u); }
  return { where: where.join(' AND '), args };
}

function listActivity(db, userId, { limit = 30, before = null, q = '', group = '', since = null } = {}) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 30));
  const f = filterSql(userId, { before, q, group, since });
  const rows = db.prepare('SELECT * FROM activity WHERE ' + f.where + ' ORDER BY id DESC LIMIT ?').all(...f.args, lim);
  return rows.map((r) => ({ id: r.id, kind: r.kind, ref: r.ref, counterparty: r.counterparty, amountMicro: r.amount_micro, amountText: r.amount_text || null, status: r.status, createdAt: r.created_at }));
}

function csvCell(v) {
  let t = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

function usdText(micro) {
  if (micro == null) return '';
  const m = BigInt(micro); const w = m / 1000000n; const f = String(m % 1000000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return w + '.' + f;
}

function exportCsv(db, userId, opts = {}) {
  const f = filterSql(userId, { ...opts, before: null });
  const rows = db.prepare('SELECT * FROM activity WHERE ' + f.where + ' ORDER BY id DESC LIMIT 5000').all(...f.args);
  const head = ['date_utc', 'type', 'direction', 'counterparty', 'amount_usd', 'status', 'reference', 'token_amount'];
  const lines = [head.join(',')].concat(rows.map((r) => [new Date(Number(r.created_at)).toISOString(), LABEL[r.kind] || r.kind, INBOUND.has(r.kind) ? 'in' : 'out', r.counterparty || '', usdText(r.amount_micro), r.status || '', r.ref || '', r.amount_text || ''].map(csvCell).join(',')));
  return lines.join('\r\n') + '\r\n';
}

module.exports = { recordActivity, listActivity, exportCsv, GROUPS };
