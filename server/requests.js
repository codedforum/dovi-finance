'use strict';
const crypto = require('node:crypto');
const { resolveRecipient } = require('./auth/resolve');
const { checkLimits } = require('./limits');
const { formatUsd } = require('./money');
const { audit } = require('./audit');

class RequestError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.name = 'RequestError'; this.code = code; this.status = status; }
}

async function createRequest(ctx, { userId, text, amountMicro, note = null }) {
  const amount = BigInt(amountMicro);
  const lim = checkLimits(ctx.db, ctx.cfg, { userId, amountMicro: amount, now: ctx.now ? ctx.now() : Date.now() });
  if (!lim.ok && lim.reason !== 'day_cap' && lim.reason !== 'global_cap') throw new RequestError(lim.reason, lim.message || 'That amount is not allowed.');
  const target = await resolveRecipient(ctx, text);
  if (target.existingUserId === userId) throw new RequestError('self_request', 'You cannot request money from yourself.');
  const recent = ctx.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE from_user_id = ? AND created_at > ?').get(userId, (ctx.now ? ctx.now() : Date.now()) - 3600000).n;
  if (recent >= 10) throw new RequestError('too_many_requests', 'You have sent a lot of requests. Please wait a bit.', 429);
  const id = crypto.randomBytes(12).toString('hex');
  const now = ctx.now ? ctx.now() : Date.now();
  ctx.db.prepare('INSERT INTO requests (id, from_user_id, to_kind, to_provider_id, to_label, amount_micro, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, target.kind, target.providerId, target.label, amount.toString(), note ? String(note).slice(0, 140) : null, 'open', now);
  audit(ctx.db, { actor: 'user:' + userId, action: 'request.create', subject: id, data: { amount, to: target.label } });
  const me = ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
  if (target.existingUserId && ctx.notify) ctx.notify(target.existingUserId, { type: 'request_received', title: (me && me.display_name || 'Someone') + ' asked you for ' + formatUsd(amount), privateTitle: 'You have a payment request', body: note ? 'Note: ' + note : 'Open DOVI to pay or decline.', amountMicro: amount.toString(), action: { label: 'Review', href: '/app#requests' } });
  return { id, to: target.label, amountMicro: amount.toString(), delivered: !!target.existingUserId };
}

function listRequests(ctx, userId) {
  const mineOut = ctx.db.prepare('SELECT * FROM requests WHERE from_user_id = ? ORDER BY created_at DESC LIMIT 50').all(userId);
  const ids = ctx.db.prepare('SELECT kind, provider_id FROM identities WHERE user_id = ?').all(userId);
  const incoming = [];
  for (const i of ids) incoming.push(...ctx.db.prepare("SELECT * FROM requests WHERE to_kind = ? AND to_provider_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 50").all(i.kind, i.provider_id));
  const v = (r) => ({ id: r.id, to: r.to_label, amountMicro: r.amount_micro, note: r.note, status: r.status, createdAt: r.created_at });
  return { outgoing: mineOut.map(v), incoming: incoming.map((r) => ({ ...v(r), from: (ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(r.from_user_id) || {}).display_name || 'Someone' })) };
}

function decline(ctx, { userId, id }) {
  const r = ctx.db.prepare('SELECT * FROM requests WHERE id = ?').get(String(id));
  if (!r) throw new RequestError('not_found', 'Request not found.', 404);
  const mine = ctx.db.prepare('SELECT 1 FROM identities WHERE user_id = ? AND kind = ? AND provider_id = ?').get(userId, r.to_kind, r.to_provider_id);
  if (!mine && r.from_user_id !== userId) throw new RequestError('not_found', 'Request not found.', 404);
  ctx.db.prepare("UPDATE requests SET status = 'declined' WHERE id = ?").run(r.id);
  return { ok: true };
}

function settlePaid(ctx, { payerUserId, requesterUserId, amountMicro }) {
  if (!requesterUserId) return;
  const ids = ctx.db.prepare('SELECT kind, provider_id FROM identities WHERE user_id = ?').all(payerUserId);
  for (const i of ids) {
    const r = ctx.db.prepare("SELECT id FROM requests WHERE from_user_id = ? AND to_kind = ? AND to_provider_id = ? AND status = 'open' AND amount_micro = ? ORDER BY created_at LIMIT 1").get(requesterUserId, i.kind, i.provider_id, String(amountMicro));
    if (r) { ctx.db.prepare("UPDATE requests SET status = 'paid' WHERE id = ? AND status = 'open'").run(r.id); return; }
  }
}

module.exports = { RequestError, createRequest, listRequests, decline, settlePaid };
