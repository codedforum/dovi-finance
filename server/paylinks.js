'use strict';
const crypto = require('node:crypto');
const { userIdentities } = require('./identity');

class PaylinkError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.name = 'PaylinkError'; this.code = code; this.status = status; }
}

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_RE = /^[2-9a-hj-km-np-zA-HJ-NP-Z]{8}$/;
const MAX_LINKS = 20;
const now = (ctx) => (ctx.now ? ctx.now() : Date.now());

function newCode(db) {
  for (let n = 0; n < 10; n++) {
    let s = ''; for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!db.prepare('SELECT 1 FROM paylinks WHERE code = ?').get(s)) return s;
  }
  throw new PaylinkError('code_failed', 'Could not make a link. Please try again.', 500);
}

function xHandleOf(ctx, userId) {
  const x = userIdentities(ctx.db, userId).find((i) => i.kind === 'x');
  return x && x.label ? String(x.label) : null;
}

function cleanTitle(t) {
  const s = String(t == null ? '' : t).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 60) throw new PaylinkError('bad_title', 'Give the link a name between 2 and 60 characters.');
  return s;
}

function create(ctx, { userId, title, amountMicro = null }) {
  if (!xHandleOf(ctx, userId)) throw new PaylinkError('x_required', 'Link your X account first. Your payment links use your @handle.');
  const t = cleanTitle(title);
  const c = ctx.cfg.claim;
  let amt = null;
  if (amountMicro != null) {
    const a = BigInt(amountMicro);
    if (a < c.minAmountMicro || a > c.perClaimCapMicro) throw new PaylinkError('bad_amount', 'That amount is outside what DOVI allows per payment.');
    amt = a.toString();
  }
  const open = Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM paylinks WHERE user_id = ? AND active = 1').get(userId).n);
  if (open >= MAX_LINKS) throw new PaylinkError('too_many', 'You have ' + MAX_LINKS + ' active links. Turn one off first.');
  const code = newCode(ctx.db);
  ctx.db.prepare('INSERT INTO paylinks (code, user_id, title, amount_micro, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(code, userId, t, amt, now(ctx));
  return get(ctx, code);
}

function get(ctx, code) {
  if (!CODE_RE.test(String(code || ''))) return null;
  const r = ctx.db.prepare('SELECT * FROM paylinks WHERE code = ?').get(String(code));
  if (!r) return null;
  return { id: r.id, code: r.code, userId: r.user_id, title: r.title, amountMicro: r.amount_micro, active: !!r.active, createdAt: r.created_at, handle: xHandleOf(ctx, r.user_id) };
}

function stats(ctx, id) {
  const row = ctx.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CAST(p.amount_micro AS INTEGER)), 0) AS s
    FROM paylink_payments p LEFT JOIN claims c ON (p.kind = 'claim' AND c.id = p.ref)
    WHERE p.paylink_id = ? AND (p.kind = 'direct' OR c.status IN ('funded', 'claimed'))`).get(id);
  return { count: Number(row.n), totalMicro: String(row.s) };
}

function list(ctx, userId) {
  return ctx.db.prepare('SELECT * FROM paylinks WHERE user_id = ? ORDER BY id DESC').all(userId).map((r) => {
    const s = stats(ctx, r.id);
    return { code: r.code, title: r.title, amountMicro: r.amount_micro, active: !!r.active, createdAt: r.created_at, payments: s.count, totalMicro: s.totalMicro, url: ctx.cfg.payBaseUrl + '/p/' + r.code };
  });
}

function setActive(ctx, { userId, code, active }) {
  const l = get(ctx, code);
  if (!l || l.userId !== userId) throw new PaylinkError('not_found', 'That link was not found.', 404);
  if (active) {
    const open = Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM paylinks WHERE user_id = ? AND active = 1').get(userId).n);
    if (!l.active && open >= MAX_LINKS) throw new PaylinkError('too_many', 'You have ' + MAX_LINKS + ' active links. Turn one off first.');
  }
  ctx.db.prepare('UPDATE paylinks SET active = ? WHERE id = ?').run(active ? 1 : 0, l.id);
  return list(ctx, userId).find((x) => x.code === code);
}

function forPayment(ctx, { code, payerId, amountMicro }) {
  const l = get(ctx, code);
  if (!l || !l.active) throw new PaylinkError('link_off', 'This payment link is not active.', 404);
  if (!l.handle) throw new PaylinkError('link_off', 'This payment link is not active.', 404);
  if (l.userId === payerId) throw new PaylinkError('own_link', 'This is your own payment link.');
  if (l.amountMicro != null && BigInt(l.amountMicro) !== BigInt(amountMicro)) throw new PaylinkError('amount_fixed', 'This link has a fixed amount.');
  return { link: l, to: l.handle };
}

function record(ctx, { paylinkId, kind, ref, amountMicro, payerUserId }) {
  ctx.db.prepare('INSERT OR IGNORE INTO paylink_payments (paylink_id, kind, ref, amount_micro, payer_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(paylinkId, kind, String(ref), String(amountMicro), payerUserId, now(ctx));
}

function publicView(ctx, code) {
  const l = get(ctx, code);
  if (!l || !l.handle) return null;
  return { code: l.code, title: l.title, amountMicro: l.amountMicro, active: l.active, handle: l.handle };
}

module.exports = { PaylinkError, CODE_RE, create, get, list, setActive, forPayment, record, publicView, xHandleOf, stats };
