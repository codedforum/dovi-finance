'use strict';
const { audit } = require('./audit');

class DataRequestError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.name = 'DataRequestError'; this.code = code; this.status = status; }
}

const nowMs = (ctx) => (ctx.now ? ctx.now() : Date.now());
const DAY = 86400000;
const KINDS = ['delete'];
const STATUSES = ['open', 'done', 'declined'];

const view = (r) => ({ id: r.id, kind: r.kind, status: r.status, detail: r.detail || null, note: r.admin_note || null, createdAt: r.created_at, updatedAt: r.updated_at, dueAt: r.due_at });

function list(ctx, userId) {
  return ctx.db.prepare('SELECT * FROM data_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(userId).map(view);
}

function create(ctx, { userId, kind, detail }) {
  if (!KINDS.includes(kind)) throw new DataRequestError('bad_kind', 'That request type is not available.');
  const open = ctx.db.prepare("SELECT 1 FROM data_requests WHERE user_id = ? AND kind = ? AND status = 'open'").get(userId, kind);
  if (open) throw new DataRequestError('already_open', 'You already have an open deletion request.', 409);
  const t = nowMs(ctx);
  const info = ctx.db.prepare('INSERT INTO data_requests (user_id, kind, status, detail, created_at, updated_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, kind, 'open', detail ? String(detail).slice(0, 500) : null, t, t, t + 30 * DAY);
  audit(ctx.db, { actor: 'user:' + userId, action: 'datarequest.create', subject: String(info.lastInsertRowid), data: { kind } });
  return view(ctx.db.prepare('SELECT * FROM data_requests WHERE id = ?').get(info.lastInsertRowid));
}

function cancel(ctx, { userId, id }) {
  const r = ctx.db.prepare('SELECT * FROM data_requests WHERE id = ? AND user_id = ?').get(id, userId);
  if (!r) throw new DataRequestError('not_found', 'That request was not found.', 404);
  if (r.status !== 'open') throw new DataRequestError('not_open', 'That request is already closed.', 409);
  ctx.db.prepare("UPDATE data_requests SET status = 'declined', admin_note = 'Cancelled by you', updated_at = ? WHERE id = ?").run(nowMs(ctx), id);
  audit(ctx.db, { actor: 'user:' + userId, action: 'datarequest.cancel', subject: String(id) });
  return view(ctx.db.prepare('SELECT * FROM data_requests WHERE id = ?').get(id));
}

function adminList(ctx) {
  return ctx.db.prepare("SELECT r.*, (SELECT label FROM identities i WHERE i.user_id = r.user_id ORDER BY i.id LIMIT 1) AS who FROM data_requests r ORDER BY (r.status = 'open') DESC, r.due_at ASC LIMIT 200").all().map((r) => ({ ...view(r), userId: r.user_id, who: r.who || null }));
}

function adminSet(ctx, { id, status, note, actor }) {
  if (!STATUSES.includes(status)) throw new DataRequestError('bad_status', 'Status must be open, done or declined.');
  const r = ctx.db.prepare('SELECT * FROM data_requests WHERE id = ?').get(id);
  if (!r) throw new DataRequestError('not_found', 'That request was not found.', 404);
  ctx.db.prepare('UPDATE data_requests SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?').run(status, note ? String(note).slice(0, 300) : null, nowMs(ctx), id);
  audit(ctx.db, { actor, action: 'datarequest.' + status, subject: String(id) });
  return view(ctx.db.prepare('SELECT * FROM data_requests WHERE id = ?').get(id));
}

/* a copy of the data DOVI holds about one account, built from fixed column lists so no secret or hash can leak into it */
function exportData(ctx, userId) {
  const q = (sql, ...a) => ctx.db.prepare(sql).all(...a);
  const u = ctx.db.prepare('SELECT id, display_name, status, created_at, frozen_at FROM users WHERE id = ?').get(userId);
  const out = {
    generatedAt: new Date(nowMs(ctx)).toISOString(),
    about: 'A copy of the data DOVI holds about your account. Payments on Base are also public on the blockchain.',
    account: u,
    signInIdentities: q('SELECT kind, label, verified_at FROM identities WHERE user_id = ?', userId),
    walletAddresses: q('SELECT chain, address FROM addresses WHERE user_id = ?', userId),
    paymentsSent: q('SELECT id, recipient_label, amount_micro, fee_micro, status, note, created_at, funded_at, claimed_at, returned_at, expired_at, source FROM claims WHERE sender_user_id = ? ORDER BY created_at', userId),
    paymentsReceived: q('SELECT id, amount_micro, fee_micro, status, claimed_at FROM claims WHERE claimed_by_user_id = ? ORDER BY created_at', userId),
    batches: q('SELECT id, title, status, item_count, amount_micro, fee_micro, created_at FROM batches WHERE user_id = ?', userId),
    requestsSent: q('SELECT id, to_label, amount_micro, note, status, created_at FROM requests WHERE from_user_id = ?', userId),
    withdrawals: q('SELECT id, route, to_address, amount_micro, status, created_at FROM withdrawals WHERE user_id = ?', userId),
    payLinks: q('SELECT code, title, amount_micro, active, created_at FROM paylinks WHERE user_id = ?', userId),
    activity: q('SELECT kind, counterparty, amount_micro, status, created_at FROM activity WHERE user_id = ? ORDER BY created_at DESC LIMIT 500', userId),
    notifications: q('SELECT type, title, body, amount_micro, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 500', userId),
    notificationSettings: ctx.db.prepare('SELECT money, claims, quiet_on, quiet_start, quiet_end FROM notification_prefs WHERE user_id = ?').get(userId) || null,
    askMessages: q('SELECT raw, status, created_at FROM intents WHERE user_id = ? ORDER BY created_at DESC LIMIT 500', userId),
    signedInDevices: q('SELECT label, created_at, last_seen_at, revoked_at FROM user_sessions WHERE user_id = ?', userId),
    payFromX: ctx.db.prepare('SELECT per_payment_micro, per_day_micro, enabled FROM autopay WHERE user_id = ?').get(userId) || null,
    agentKeys: q('SELECT name, prefix, per_payment_micro, per_day_micro, expires_at, revoked_at, last_used_at, created_at FROM agent_keys WHERE user_id = ?', userId),
    reportsYouSent: q('SELECT subject, detail, created_at FROM reports WHERE user_id = ?', userId),
    dataRequests: list(ctx, userId),
  };
  const ids = q('SELECT kind, provider_id FROM identities WHERE user_id = ?', userId);
  const x = ids.find((i) => i.kind === 'x');
  out.waitlist = x ? (ctx.db.prepare('SELECT x_handle, email, ref_code, created_at FROM waitlist WHERE x_id = ?').get(x.provider_id) || null) : null;
  return out;
}

module.exports = { DataRequestError, list, create, cancel, adminList, adminSet, exportData, view };
