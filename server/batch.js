'use strict';
const { encodeFunctionData } = require('viem');
const abi = require('./abi/DoviClaim.json');
const { ERC20_ABI } = require('./chain-client');
const { newClaimId, recipientHash, normalizeProviderId, parseAddress, IdError } = require('./ids');
const { feeFor, formatUsd, parseUsd, MoneyError } = require('./money');
const { resolveRecipient } = require('./auth/resolve');
const { userHasIdentity } = require('./identity');
const { utcDay } = require('./limits');
const { audit } = require('./audit');
const claims = require('./claims');
const { randomBytes } = require('node:crypto');

const MAX_ITEMS = 50;

class BatchError extends Error {
  constructor(code, message, status = 400, details = null) { super(message || code); this.name = 'BatchError'; this.code = code; this.status = status; this.details = details; }
}

const nowMs = (ctx) => (ctx.now ? ctx.now() : Date.now());
const nowSec = (ctx) => Math.floor(nowMs(ctx) / 1000);
const newBatchId = () => 'b_' + randomBytes(6).toString('hex');

async function pool(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); } }));
  return out;
}

function batchTxs(ctx, rows, totalMicro, expiry, lockUntil = null) {
  return [
    { to: ctx.cfg.base.usdc, value: '0', data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ctx.cfg.claim.contract, totalMicro] }), label: 'Approve' },
    { to: ctx.cfg.claim.contract, value: '0', data: lockUntil ? encodeFunctionData({ abi, functionName: 'createBatchLocked', args: [rows.map((r) => r.id), rows.map((r) => r.recipient_hash), rows.map((r) => BigInt(r.amount_micro)), BigInt(expiry), BigInt(lockUntil)] }) : encodeFunctionData({ abi, functionName: 'createBatch', args: [rows.map((r) => r.id), rows.map((r) => r.recipient_hash), rows.map((r) => BigInt(r.amount_micro)), BigInt(expiry)] }), label: 'Send' },
  ];
}

function itemView(ctx, r) {
  return { claimId: r.id, to: r.recipient_label, kind: r.recipient_kind, amountMicro: r.amount_micro, feeMicro: r.fee_micro, status: claims.effectiveStatus(r, ctx), link: claims.view(ctx, r).link, needsRelease: !!r.needs_release, released: !!r.released_at, lockUntil: r.lock_until || null, releaseRule: r.release_rule || null, releaseAt: r.release_at || null, postHours: r.post_hours || null, postId: r.post_id || null, releaseNote: r.release_note || null };
}

function summaryOf(ctx, b, rows) {
  const by = {};
  for (const r of rows) { const s = claims.effectiveStatus(r, ctx); by[s] = (by[s] || 0) + 1; }
  return {
    batchId: b.id, title: b.title, status: b.status, count: b.item_count, amountMicro: b.amount_micro, feeMicro: b.fee_micro,
    totalMicro: (BigInt(b.amount_micro) + BigInt(b.fee_micro)).toString(), expiry: b.expiry, createdAt: b.created_at, fundedAt: b.funded_at || null, counts: by, lockUntil: b.lock_until || null, payOnDelivery: !!b.pay_on_delivery, releaseMode: b.release_mode || null,
  };
}

async function draftBatch(ctx, { userId, senderAddress, title, items, lockSeconds = null, payOnDelivery = false, autoRelease = null }) {
  ctx.registry.assertLive('base');
  if (!ctx.cfg.claim.contract) throw new BatchError('not_configured', 'Payments are not switched on yet.', 503);
  const sender = parseAddress(senderAddress);
  if (!Array.isArray(items) || !items.length) throw new BatchError('empty', 'Add at least one payment.');
  if (items.length > MAX_ITEMS) throw new BatchError('too_many', 'A batch can hold up to ' + MAX_ITEMS + ' payments. Split it into more batches.');
  const c = ctx.cfg.claim;
  const problems = [];
  const parsed = items.map((it, i) => {
    const line = i + 1;
    try {
      const amount = parseUsd(String(it && it.amount != null ? it.amount : ''));
      if (amount < c.minAmountMicro) throw new BatchError('below_minimum', 'The minimum is ' + formatUsd(c.minAmountMicro) + '.');
      if (amount > c.perClaimCapMicro) throw new BatchError('above_cap', 'The beta limit per payment is ' + formatUsd(c.perClaimCapMicro) + '.');
      let postId = null;
      if (autoRelease && autoRelease.mode === 'post') {
        postId = require('./giveaway').tweetIdFromUrl(it && it.post);
        if (!postId) throw new BatchError('post_required', 'Add the link to their post on this line.');
      }
      return { line, to: String(it && it.to || '').trim(), amount, postId };
    } catch (e) { problems.push({ line, message: e.message }); return null; }
  });
  const resolved = await pool(parsed, 4, async (p) => {
    if (!p) return null;
    try {
      const r = await resolveRecipient(ctx, p.to);
      const pid = normalizeProviderId(r.kind, r.providerId);
      if (userHasIdentity(ctx.db, userId, r.kind, pid)) throw new BatchError('self_send', 'You cannot pay yourself.');
      return { ...p, kind: r.kind, pid, label: r.label };
    } catch (e) { problems.push({ line: p.line, message: e instanceof IdError || e instanceof MoneyError || e instanceof BatchError ? e.message : 'Could not check that recipient.' }); return null; }
  });
  const seen = new Map();
  for (const r of resolved) {
    if (!r) continue;
    const k = r.kind + ':' + r.pid;
    if (seen.has(k)) problems.push({ line: r.line, message: 'Listed twice, same as line ' + seen.get(k) + '.' }); else seen.set(k, r.line);
  }
  if (problems.length) throw new BatchError('invalid_lines', 'Fix these lines and try again.', 400, problems.sort((a, b) => a.line - b.line));

  const amountTotal = resolved.reduce((s, r) => s + r.amount, 0n);
  const feeTotal = resolved.reduce((s, r) => s + feeFor(r.amount, c), 0n);
  const day = ctx.db.prepare('SELECT spent_micro FROM limits_usage WHERE user_id = ? AND day = ?').get(userId, utcDay(nowMs(ctx)));
  const spent = day ? BigInt(day.spent_micro) : 0n;
  if (spent + amountTotal > c.perUserDayCapMicro) throw new BatchError('day_cap', 'The beta limit per day is ' + formatUsd(c.perUserDayCapMicro) + '. This batch is ' + formatUsd(amountTotal) + (spent ? ' and you have sent ' + formatUsd(spent) + ' today.' : '.'));
  const locked = ctx.db.prepare("SELECT COALESCE(SUM(CAST(amount_micro AS INTEGER) + CAST(fee_micro AS INTEGER)), 0) AS s FROM claims WHERE status = 'funded'").get().s;
  if (BigInt(locked) + amountTotal + feeTotal > c.globalCapMicro) throw new BatchError('global_cap', 'DOVI is at its beta limit for now. Try again soon.');

  const lockUntil = claims.lockFor(ctx, lockSeconds);
  const auto = claims.autoFor(ctx, autoRelease);
  if (auto) payOnDelivery = true;
  const t = nowMs(ctx); const expiry = nowSec(ctx) + c.expirySeconds; const batchId = newBatchId();
  const rows = [];
  ctx.db.exec('BEGIN IMMEDIATE');
  try {
    ctx.db.prepare("INSERT INTO batches (id, user_id, title, status, item_count, amount_micro, fee_micro, expiry, created_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)").run(batchId, userId, title ? String(title).slice(0, 80) : null, resolved.length, amountTotal.toString(), feeTotal.toString(), expiry, t);
    for (const r of resolved) {
      const id = newClaimId(); const fee = feeFor(r.amount, c);
      ctx.db.prepare("INSERT INTO claims (id, sender_user_id, sender_address, recipient_kind, recipient_hash, recipient_provider_id, recipient_label, amount_micro, fee_micro, chain, status, expiry, created_at, updated_at, batch_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'base', 'draft', ?, ?, ?, ?, 'batch')")
        .run(id, userId, sender, r.kind, recipientHash(r.kind, r.pid), r.pid, String(r.label).slice(0, 80), r.amount.toString(), fee.toString(), expiry, t, t, batchId);
      ctx.db.prepare('UPDATE claims SET short = ?, lock_until = ?, needs_release = ? WHERE id = ?').run(claims.newShort(ctx.db), lockUntil, payOnDelivery ? 1 : 0, id);
      if (auto) ctx.db.prepare('UPDATE claims SET release_rule = ?, release_at = ?, post_hours = ?, post_id = ? WHERE id = ?').run(auto.rule, auto.at, auto.hours, r.postId || null, id);
      rows.push(ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(id));
    }
    ctx.db.prepare('UPDATE batches SET lock_until = ?, pay_on_delivery = ?, release_mode = ? WHERE id = ?').run(lockUntil, payOnDelivery ? 1 : 0, auto ? auto.rule : null, batchId);
    ctx.db.exec('COMMIT');
  } catch (e) { ctx.db.exec('ROLLBACK'); throw e; }
  audit(ctx.db, { actor: 'user:' + userId, action: 'batch.draft', subject: batchId, data: { count: rows.length, amountTotal, feeTotal } });
  const b = ctx.db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  return { ...summaryOf(ctx, b, rows), items: rows.map((r) => itemView(ctx, r)), txs: batchTxs(ctx, rows, amountTotal + feeTotal, expiry, lockUntil),
    preview: { lines: [{ label: 'Payments', value: String(rows.length) }, { label: 'They receive', value: formatUsd(amountTotal) }, { label: 'DOVI fee', value: formatUsd(feeTotal) }, { label: 'You pay', value: formatUsd(amountTotal + feeTotal) }], note: 'The fee is only charged for payments that get claimed. Anything not claimed in time can be taken back in full.' } };
}

function releaseBatch(ctx, { batchId, userId }) {
  const b = ctx.db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  if (!b || b.user_id !== userId) throw new BatchError('batch_not_found', 'That batch was not found.', 404);
  if (!b.pay_on_delivery) throw new BatchError('no_release', 'This batch does not need your approval.', 409);
  let n = 0;
  for (const r of ctx.db.prepare("SELECT * FROM claims WHERE batch_id = ? AND needs_release = 1 AND released_at IS NULL AND status = 'funded'").all(batchId)) {
    try { claims.release(ctx, { claimId: r.id, userId }); n++; } catch (e) { if (!(e instanceof claims.ClaimError)) throw e; }
  }
  return { released: n, batch: detail(ctx, { batchId, userId }) };
}

async function confirmBatchFunded(ctx, { batchId, userId, txHash }) {
  const b = ctx.db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  if (!b || b.user_id !== userId) throw new BatchError('batch_not_found', 'That batch was not found.', 404);
  const rows = ctx.db.prepare('SELECT * FROM claims WHERE batch_id = ?').all(batchId);
  if (b.status === 'funded') return detail(ctx, { batchId, userId });
  const pending = rows.filter((r) => r.status === 'draft');
  const notYet = [];
  await pool(pending, 5, async (r) => {
    try { await claims.confirmFunded(ctx, { claimId: r.id, userId, txHash }); } catch (e) { if (e instanceof claims.ClaimError && (e.code === 'not_funded_yet' || e.code === 'mismatch')) notYet.push(r.id); else throw e; }
  });
  if (notYet.length) throw new BatchError('not_funded_yet', 'The batch is not confirmed on Base yet.', 409);
  ctx.db.prepare("UPDATE batches SET status = 'funded', fund_tx = ?, funded_at = ? WHERE id = ?").run(txHash || null, nowMs(ctx), batchId);
  audit(ctx.db, { actor: 'user:' + userId, action: 'batch.funded', subject: batchId, data: { txHash, count: rows.length } });
  return detail(ctx, { batchId, userId });
}

function detail(ctx, { batchId, userId }) {
  const b = ctx.db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  if (!b || b.user_id !== userId) throw new BatchError('batch_not_found', 'That batch was not found.', 404);
  const rows = ctx.db.prepare('SELECT * FROM claims WHERE batch_id = ? ORDER BY rowid').all(batchId);
  return { ...summaryOf(ctx, b, rows), items: rows.map((r) => itemView(ctx, r)) };
}

function list(ctx, userId) {
  return ctx.db.prepare("SELECT * FROM batches WHERE user_id = ? AND status = 'funded' ORDER BY created_at DESC LIMIT 50").all(userId)
    .map((b) => summaryOf(ctx, b, ctx.db.prepare('SELECT * FROM claims WHERE batch_id = ?').all(b.id)));
}

module.exports = { BatchError, MAX_ITEMS, draftBatch, confirmBatchFunded, detail, list, releaseBatch };
