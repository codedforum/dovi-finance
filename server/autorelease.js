'use strict';
const claims = require('./claims');
const { audit } = require('./audit');

const CHECK_EVERY_MS = 55 * 60 * 1000;
const nowOf = (ctx) => (ctx.now ? ctx.now() : Date.now());

function makePostChecker(env = process.env, f = fetch) {
  return {
    async check(postId) {
      const r = await f('https://api.fxtwitter.com/status/' + encodeURIComponent(postId), { redirect: 'manual', headers: { 'user-agent': 'dovi/1.0' } });
      if (r.status === 404) return { status: 'missing' };
      if (r.status !== 200) throw new Error('post check ' + r.status);
      const j = await r.json();
      const t = j && j.tweet;
      if (!t || !t.author) return { status: 'missing' };
      return { status: 'ok', authorId: String(t.author.id), createdSec: Number(t.created_timestamp) || Math.floor(new Date(t.created_at).getTime() / 1000) || 0 };
    },
  };
}

function notifySender(ctx, row, title, body) {
  if (ctx.notify) { try { ctx.notify(row.sender_user_id, { ref: row.id, type: 'system', title, privateTitle: 'A scheduled payout was updated', body, amountMicro: row.amount_micro, action: { label: 'View', href: '/app?claim=' + row.id + '#activity' } }); } catch { /* best effort */ } }
}

async function releaseDue(ctx) {
  const t = nowOf(ctx); const tSec = Math.floor(t / 1000);
  const rows = ctx.db.prepare("SELECT * FROM claims WHERE status = 'funded' AND needs_release = 1 AND released_at IS NULL AND release_rule IS NOT NULL AND expiry > ? AND ((release_rule = 'time' AND release_at <= ?) OR (release_rule = 'post' AND (release_checked_at IS NULL OR release_checked_at <= ?))) ORDER BY created_at LIMIT 60").all(tSec, tSec, t - CHECK_EVERY_MS);
  const out = [];
  for (const row of rows) {
    const sender = ctx.db.prepare('SELECT frozen_at, admin_frozen_at FROM users WHERE id = ?').get(row.sender_user_id);
    if (sender && (sender.frozen_at || sender.admin_frozen_at)) { out.push({ id: row.id, status: 'held_frozen' }); continue; }
    let due = false;
    if (row.release_rule === 'time') due = row.release_at != null && row.release_at <= tSec;
    else if (row.release_rule === 'post') {
      if (row.release_checked_at && t - row.release_checked_at < CHECK_EVERY_MS) continue;
      if (!ctx.postChecker) continue;
      let c;
      try { c = await ctx.postChecker.check(row.post_id); } catch { out.push({ id: row.id, status: 'check_failed' }); continue; }
      ctx.db.prepare('UPDATE claims SET release_checked_at = ? WHERE id = ?').run(t, row.id);
      if (c.status === 'missing') {
        if (row.release_note !== 'missing') { ctx.db.prepare("UPDATE claims SET release_note = 'missing' WHERE id = ?").run(row.id); notifySender(ctx, row, 'A post was not found', row.recipient_label + '\'s post could not be found, so the payment is on hold. It releases when the post is back and old enough, or you can approve it yourself.'); }
        out.push({ id: row.id, status: 'post_missing' }); continue;
      }
      if (row.recipient_kind === 'x' && String(c.authorId) !== String(row.recipient_provider_id)) {
        if (row.release_note !== 'wrong_author') { ctx.db.prepare("UPDATE claims SET release_note = 'wrong_author' WHERE id = ?").run(row.id); notifySender(ctx, row, 'A post is not from the right person', 'The post for ' + row.recipient_label + ' was written by someone else, so the payment is on hold.'); }
        out.push({ id: row.id, status: 'wrong_author' }); continue;
      }
      due = c.createdSec > 0 && tSec - c.createdSec >= Number(row.post_hours) * 3600;
    }
    if (!due) continue;
    try {
      const fresh = ctx.db.prepare('SELECT release_rule, released_at, status FROM claims WHERE id = ?').get(row.id);
      if (!fresh || !fresh.release_rule || fresh.released_at || fresh.status !== 'funded') continue;
      claims.release(ctx, { claimId: row.id, userId: row.sender_user_id });
      audit(ctx.db, { actor: 'system', action: 'claim.auto_released', subject: row.id, data: { rule: row.release_rule } });
      notifySender(ctx, row, 'Released to ' + row.recipient_label, 'Your scheduled payout was approved automatically. They can claim it now.');
      out.push({ id: row.id, status: 'released' });
    } catch (e) { out.push({ id: row.id, status: 'error', error: String(e.code || e.message).slice(0, 60) }); }
  }
  return { processed: out };
}

function cancelAuto(ctx, { claimId, userId }) {
  const row = ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(String(claimId));
  if (!row || row.sender_user_id !== userId) throw new claims.ClaimError('claim_not_found', 'That payment was not found.', 404);
  ctx.db.prepare('UPDATE claims SET release_rule = NULL, release_at = NULL, post_id = NULL, post_hours = NULL, release_note = NULL WHERE id = ?').run(row.id);
  audit(ctx.db, { actor: 'user:' + userId, action: 'claim.auto_cancel', subject: row.id });
  return claims.view(ctx, ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(row.id));
}

module.exports = { releaseDue, cancelAuto, makePostChecker };
