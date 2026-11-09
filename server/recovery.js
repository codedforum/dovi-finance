'use strict';
/* Account recovery for people who lost access to the X account or email they signed up with. DOVI never signs for anyone:
   a recovery only re-points a verified new login at the existing account, after an operator approves it and a waiting time passes.
   The owner is told by every route we have and can cancel until the end of the wait. */
const crypto = require('node:crypto');
const { audit } = require('./audit');
const { normalizeProviderId } = require('./ids');
const { findUserByIdentity, userIdentities } = require('./identity');
const emails = require('./emails/templates');

class RecoveryError extends Error { constructor(code, message, status = 400) { super(message || code); this.name = 'RecoveryError'; this.code = code; this.status = status; } }

const nowMs = (ctx) => (ctx.now ? ctx.now() : Date.now());
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const on = (ctx) => !!(ctx.cfg.recovery && ctx.cfg.recovery.enabled);

function guessKind(text) {
  const t = String(text || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return { kind: 'email', providerId: t };
  return null;
}
function lostIdentity(ctx, lost) {
  const t = String(lost || '').trim();
  const em = guessKind(t);
  if (em) return { kind: 'email', providerId: normalizeProviderId('email', em.providerId) };
  const handle = t.replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new RecoveryError('bad_lost', 'Enter the X handle or the email you signed up with.');
  const row = ctx.db.prepare("SELECT kind, provider_id FROM identities WHERE kind = 'x' AND LOWER(label) IN (?, ?)").get('@' + handle.toLowerCase(), handle.toLowerCase());
  if (!row) throw new RecoveryError('not_found', 'We could not find an account for that. Check the spelling.', 404);
  return { kind: 'x', providerId: row.provider_id };
}

function notice(ctx, row, { title, body }) {
  const link = ctx.cfg.publicUrl + '/app?rcancel=' + row.__token;
  if (ctx.notify) ctx.notify(row.target_user_id, { ref: row.id, type: 'recovery', title, privateTitle: 'Account recovery request', body, action: { label: 'Open DOVI', href: '/app' } });
  if (!ctx.mailer) return;
  const to = new Set(userIdentities(ctx.db, row.target_user_id).filter((i) => i.kind === 'email').map((i) => i.provider_id));
  for (const addr of to) {
    const m = emails.render('recoveryNotice', { title, body, cancelLink: link }, { business: ctx.cfg.business });
    Promise.resolve(ctx.mailer.send({ to: addr, ...m })).catch(() => {});
  }
}

function request(ctx, { requesterUserId, lost, note }) {
  if (!on(ctx)) throw new RecoveryError('off', 'Account recovery is not switched on yet.', 503);
  const who = lostIdentity(ctx, lost);
  const target = findUserByIdentity(ctx.db, who.kind, who.providerId);
  if (!target) throw new RecoveryError('not_found', 'We could not find an account for that. Check the spelling.', 404);
  if (target.id === requesterUserId) throw new RecoveryError('same_account', 'That is the account you are signed in to.');
  const open = ctx.db.prepare("SELECT COUNT(*) n FROM recovery_requests WHERE requester_user_id = ? AND status IN ('pending','waiting')").get(requesterUserId).n;
  if (open) throw new RecoveryError('already_open', 'You already have a recovery request open.', 409);
  const recent = ctx.db.prepare("SELECT COUNT(*) n FROM recovery_requests WHERE target_user_id = ? AND created_at > ?").get(target.id, nowMs(ctx) - 30 * 86400000).n;
  if (recent >= 3) throw new RecoveryError('too_many', 'There have been several requests for that account. Contact support.', 429);
  const id = 'rec_' + crypto.randomBytes(9).toString('base64url');
  const token = crypto.randomBytes(24).toString('base64url');
  ctx.db.prepare("INSERT INTO recovery_requests (id, target_user_id, requester_user_id, lost_kind, lost_provider_id, note, status, cancel_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
    .run(id, target.id, requesterUserId, who.kind, who.providerId, note ? String(note).slice(0, 600) : null, sha(token), nowMs(ctx));
  audit(ctx.db, { actor: 'user:' + requesterUserId, action: 'recovery.request', subject: id, data: { target: target.id } });
  notice(ctx, { id, target_user_id: target.id, __token: token }, { title: 'Someone asked to recover your DOVI account', body: 'A person asked to move your DOVI account to a new login. The DOVI team is checking who they are. Nothing has changed.' });
  return view(ctx, ctx.db.prepare('SELECT * FROM recovery_requests WHERE id = ?').get(id));
}

function view(ctx, r) {
  return { id: r.id, status: r.status, createdAt: r.created_at, readyAt: r.ready_at || null, ready: r.status === 'waiting' && r.ready_at <= nowMs(ctx), closedReason: r.closed_reason || null };
}

function mine(ctx, userId) {
  return ctx.db.prepare('SELECT * FROM recovery_requests WHERE requester_user_id = ? ORDER BY created_at DESC LIMIT 5').all(userId).map((r) => view(ctx, r));
}

function adminList(ctx) {
  return ctx.db.prepare("SELECT r.*, t.display_name AS target_name, q.display_name AS requester_name FROM recovery_requests r JOIN users t ON t.id = r.target_user_id JOIN users q ON q.id = r.requester_user_id ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, r.created_at DESC LIMIT 50").all()
    .map((r) => ({ ...view(ctx, r), targetUserId: r.target_user_id, targetName: r.target_name, requesterUserId: r.requester_user_id, requesterName: r.requester_name, lost: r.lost_kind + ':' + r.lost_provider_id, note: r.note, revokeLost: !!r.revoke_lost, approvedBy: r.approved_by,
      requesterIdentities: userIdentities(ctx.db, r.requester_user_id).map((i) => i.kind + ':' + i.provider_id), targetIdentities: userIdentities(ctx.db, r.target_user_id).map((i) => i.kind + ':' + i.provider_id) }));
}

function approve(ctx, { id, actor, revokeLost = true }) {
  const r = ctx.db.prepare('SELECT * FROM recovery_requests WHERE id = ?').get(String(id));
  if (!r) throw new RecoveryError('not_found', 'No such request.', 404);
  if (r.status !== 'pending') throw new RecoveryError('bad_state', 'That request is not waiting for review.', 409);
  const token = crypto.randomBytes(24).toString('base64url');
  const t = nowMs(ctx); const ready = t + ctx.cfg.recovery.delayMs;
  ctx.db.prepare("UPDATE recovery_requests SET status = 'waiting', approved_by = ?, approved_at = ?, ready_at = ?, revoke_lost = ?, cancel_hash = ? WHERE id = ?").run(String(actor), t, ready, revokeLost ? 1 : 0, sha(token), r.id);
  audit(ctx.db, { actor, action: 'recovery.approve', subject: r.id, data: { readyAt: ready, revokeLost: !!revokeLost } });
  const days = Math.max(1, Math.round(ctx.cfg.recovery.delayMs / 3600000));
  notice(ctx, { id: r.id, target_user_id: r.target_user_id, __token: token }, { title: 'Your DOVI account will move to a new login', body: 'A recovery request was approved. The move happens after about ' + days + ' hours. If you did not ask for this, cancel it now.' });
  return view(ctx, ctx.db.prepare('SELECT * FROM recovery_requests WHERE id = ?').get(r.id));
}

function reject(ctx, { id, actor, reason }) {
  const r = ctx.db.prepare('SELECT * FROM recovery_requests WHERE id = ?').get(String(id));
  if (!r) throw new RecoveryError('not_found', 'No such request.', 404);
  if (!['pending', 'waiting'].includes(r.status)) throw new RecoveryError('bad_state', 'That request is already closed.', 409);
  ctx.db.prepare("UPDATE recovery_requests SET status = 'rejected', closed_at = ?, closed_reason = ? WHERE id = ?").run(nowMs(ctx), String(reason || 'rejected').slice(0, 200), r.id);
  audit(ctx.db, { actor, action: 'recovery.reject', subject: r.id, data: { reason } });
  return view(ctx, ctx.db.prepare('SELECT * FROM recovery_requests WHERE id = ?').get(r.id));
}

function cancelByToken(ctx, { token }) {
  const r = ctx.db.prepare("SELECT * FROM recovery_requests WHERE cancel_hash = ? AND status IN ('pending','waiting')").get(sha(token || ''));
  if (!r) throw new RecoveryError('not_found', 'That link is no longer valid.', 404);
  ctx.db.prepare("UPDATE recovery_requests SET status = 'cancelled', closed_at = ?, closed_reason = 'cancelled by the account owner' WHERE id = ?").run(nowMs(ctx), r.id);
  audit(ctx.db, { actor: 'user:' + r.target_user_id, action: 'recovery.cancel', subject: r.id });
  return { ok: true };
}

function cancelByOwner(ctx, { userId, id }) {
  const r = ctx.db.prepare("SELECT * FROM recovery_requests WHERE id = ? AND target_user_id = ? AND status IN ('pending','waiting')").get(String(id), userId);
  if (!r) throw new RecoveryError('not_found', 'No such request.', 404);
  ctx.db.prepare("UPDATE recovery_requests SET status = 'cancelled', closed_at = ?, closed_reason = 'cancelled by the account owner' WHERE id = ?").run(nowMs(ctx), r.id);
  audit(ctx.db, { actor: 'user:' + userId, action: 'recovery.cancel', subject: r.id });
  return { ok: true };
}

function incomingFor(ctx, userId) {
  return ctx.db.prepare("SELECT id, status, created_at, ready_at FROM recovery_requests WHERE target_user_id = ? AND status IN ('pending','waiting') ORDER BY created_at DESC").all(userId).map((r) => ({ id: r.id, status: r.status, createdAt: r.created_at, readyAt: r.ready_at || null }));
}

function isEmptyAccount(db, userId) {
  const q = (sql) => db.prepare(sql).get(userId, userId).n;
  return q('SELECT COUNT(*) n FROM claims WHERE sender_user_id = ? OR claimed_by_user_id = ?') === 0
    && q('SELECT COUNT(*) n FROM token_claims WHERE sender_user_id = ? OR claimed_by_user_id = ?') === 0
    && q('SELECT COUNT(*) n FROM naira_orders WHERE user_id = ? OR user_id = ?') === 0;
}

function complete(ctx, { id, requesterUserId }) {
  if (!on(ctx)) throw new RecoveryError('off', 'Account recovery is not switched on yet.', 503);
  const r = ctx.db.prepare('SELECT * FROM recovery_requests WHERE id = ? AND requester_user_id = ?').get(String(id), requesterUserId);
  if (!r) throw new RecoveryError('not_found', 'No such request.', 404);
  if (r.status === 'completed') return { ...view(ctx, r), relogin: true };
  if (r.status !== 'waiting') throw new RecoveryError('bad_state', r.status === 'pending' ? 'The DOVI team has not approved this yet.' : 'That request is closed.', 409);
  if (r.ready_at > nowMs(ctx)) throw new RecoveryError('too_early', 'The waiting time is not over yet.', 409);
  if (!isEmptyAccount(ctx.db, requesterUserId)) throw new RecoveryError('not_empty', 'This new account already has activity, so DOVI support has to finish this one.', 409);
  const t = nowMs(ctx);
  const tx = ctx.db.prepare.bind(ctx.db);
  ctx.db.exec('BEGIN IMMEDIATE');
  try {
    tx('UPDATE identities SET user_id = ? WHERE user_id = ?').run(r.target_user_id, requesterUserId);
    if (r.revoke_lost) tx('DELETE FROM identities WHERE user_id = ? AND kind = ? AND provider_id = ?').run(r.target_user_id, r.lost_kind, r.lost_provider_id);
    tx('UPDATE users SET sessions_valid_from = ? WHERE id IN (?, ?)').run(t, r.target_user_id, requesterUserId);
    tx('UPDATE user_sessions SET revoked_at = ? WHERE user_id IN (?, ?) AND revoked_at IS NULL').run(t, r.target_user_id, requesterUserId);
    tx("UPDATE recovery_requests SET status = 'completed', closed_at = ?, closed_reason = 'moved' WHERE id = ?").run(t, r.id);
    ctx.db.exec('COMMIT');
  } catch (e) { ctx.db.exec('ROLLBACK'); throw e; }
  audit(ctx.db, { actor: 'user:' + requesterUserId, action: 'recovery.complete', subject: r.id, data: { target: r.target_user_id, revokedLost: !!r.revoke_lost } });
  if (ctx.notify) ctx.notify(r.target_user_id, { ref: r.id, type: 'recovery', title: 'Your DOVI account moved to a new login', privateTitle: 'Your account moved', body: 'Sign in with the new login to continue.' });
  return { ...view(ctx, ctx.db.prepare('SELECT * FROM recovery_requests WHERE id = ?').get(r.id)), relogin: true };
}

module.exports = { RecoveryError, request, mine, adminList, approve, reject, cancelByToken, cancelByOwner, incomingFor, complete };
