'use strict';
const crypto = require('node:crypto');
const claims = require('./claims');
const { userIdentities } = require('./identity');

class ReceiptError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.name = 'ReceiptError'; this.code = code; this.status = status; }
}

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_RE = /^[2-9a-hj-km-np-zA-HJ-NP-Z]{12}$/;
const now = (ctx) => (ctx.now ? ctx.now() : Date.now());

function newCode(db) {
  for (let n = 0; n < 10; n++) {
    let s = ''; for (let i = 0; i < 12; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!db.prepare('SELECT 1 FROM receipts WHERE code = ?').get(s)) return s;
  }
  throw new ReceiptError('code_failed', 'Could not make a link. Please try again.', 500);
}

function create(ctx, { userId, claimId }) {
  const d = claims.detailFor(ctx, String(claimId), userId);
  if (!['funded', 'claimed', 'returned'].includes(d.status)) throw new ReceiptError('not_ready', 'A proof link is available once the payment is sent.', 409);
  const have = ctx.db.prepare('SELECT code FROM receipts WHERE user_id = ? AND claim_id = ? AND revoked_at IS NULL').get(userId, d.claimId);
  if (have) return { code: have.code, url: ctx.cfg.payBaseUrl + '/r/' + have.code, existing: true };
  const srow = ctx.db.prepare('SELECT sender_user_id FROM claims WHERE id = ?').get(d.claimId);
  const sx = srow ? userIdentities(ctx.db, srow.sender_user_id).find((i) => i.kind === 'x' && i.label) : null;
  const su = srow ? ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(srow.sender_user_id) : null;
  const fromLabel = sx ? String(sx.label) : (su && su.display_name ? String(su.display_name).split('@')[0] : 'Sender');
  const snap = {
    role: d.role, status: d.status, amountMicro: d.amountMicro, feeMicro: d.chargedFeeMicro || '0',
    from: fromLabel, to: d.to, note: d.note || null, sentAt: d.fundedAt || null, claimedAt: d.claimedAt || null, returnedAt: d.returnedAt || null,
    txs: d.txs, explorerTx: d.explorerTx || '', network: ctx.cfg.base.testnet ? 'Base Sepolia' : 'Base', testnet: !!ctx.cfg.base.testnet,
  };
  const code = newCode(ctx.db);
  ctx.db.prepare('INSERT INTO receipts (code, user_id, claim_id, snapshot, created_at) VALUES (?, ?, ?, ?, ?)').run(code, userId, d.claimId, JSON.stringify(snap), now(ctx));
  return { code, url: ctx.cfg.payBaseUrl + '/r/' + code, existing: false };
}

function view(ctx, code, { count = true } = {}) {
  if (!CODE_RE.test(String(code || ''))) return null;
  const r = ctx.db.prepare('SELECT * FROM receipts WHERE code = ? AND revoked_at IS NULL').get(String(code));
  if (!r) return null;
  if (count) ctx.db.prepare('UPDATE receipts SET views = views + 1 WHERE id = ?').run(r.id);
  const snap = JSON.parse(r.snapshot);
  try {
    const c = ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(r.claim_id);
    if (c) {
      const live = claims.view(ctx, c);
      snap.status = live.status; snap.claimedAt = live.claimedAt || null; snap.returnedAt = live.returnedAt || null;
      if (live.chargedFeeMicro != null) snap.feeMicro = live.chargedFeeMicro;
    }
  } catch { /* keep the stored snapshot */ }
  return snap;
}

function revoke(ctx, { userId, code }) {
  const r = ctx.db.prepare('UPDATE receipts SET revoked_at = ? WHERE code = ? AND user_id = ? AND revoked_at IS NULL').run(now(ctx), String(code), userId);
  if (!Number(r.changes)) throw new ReceiptError('not_found', 'That link was not found.', 404);
  return { ok: true };
}

function forClaim(ctx, { userId, claimId }) {
  const r = ctx.db.prepare('SELECT code FROM receipts WHERE user_id = ? AND claim_id = ? AND revoked_at IS NULL').get(userId, String(claimId));
  return r ? { code: r.code, url: ctx.cfg.payBaseUrl + '/r/' + r.code } : null;
}

module.exports = { ReceiptError, CODE_RE, create, view, revoke, forClaim };
