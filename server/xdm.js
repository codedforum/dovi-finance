'use strict';
/* direct message to an X recipient of a claim: queued once per claim, sent by the poster with its own caps */
const { audit } = require('./audit');
const PER_SENDER_DAY = 2000;
const GLOBAL_DAY = 2000;
const MAX_QUEUED = 300;
const nowMs = (ctx) => (ctx.now ? ctx.now() : Date.now());

function dmText({ amt, from, link, days }) {
  return [
    '\u{1F4B8} You have ' + amt + ' waiting on DOVI',
    '',
    from + ' sent you ' + amt + ' in USDC.',
    '',
    'How to claim it:',
    '1. Open your claim link below',
    '2. Sign in with this X account (no wallet needed)',
    '3. Tap Claim and choose where it goes',
    '',
    link,
    '',
    'It is held safely for ' + days + ' days, then it goes back to ' + from + '.',
    'This is a test payment on Base Sepolia, so no real money yet.',
  ].join('\n');
}

/* a display name is user typed: letters, digits, spaces, underscore and hyphen only, so it can never carry a link or a tag */
function safeName(s) {
  const t = String(s == null ? '' : s).normalize('NFKC').replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return t || 'Someone';
}

function queueClaimDm(ctx, row, { from, link, amt }) {
  if (ctx.env && ctx.env.DOVI_XDM === '0') return false;
  if (row.recipient_kind !== 'x' || !/^\d+$/.test(String(row.recipient_provider_id))) return false;
  const used = ctx.db.prepare('SELECT COUNT(*) AS n FROM x_dms d JOIN claims c ON c.id = d.claim_id WHERE c.sender_user_id = ? AND d.created_at > ?').get(row.sender_user_id, nowMs(ctx) - 86400000).n;
  const senderCap = Number(ctx.env && ctx.env.DOVI_XDM_PER_SENDER) > 0 ? Number(ctx.env.DOVI_XDM_PER_SENDER) : PER_SENDER_DAY;
  if (used >= senderCap) { audit(ctx.db, { actor: 'system', action: 'xdm.capped', subject: row.id, data: { reason: 'sender_day', cap: senderCap } }); return false; }
  const day = ctx.db.prepare("SELECT COUNT(*) AS n FROM x_dms WHERE created_at > ?").get(nowMs(ctx) - 86400000).n;
  const queued = ctx.db.prepare("SELECT COUNT(*) AS n FROM x_dms WHERE status = 'queued'").get().n;
  if (day >= GLOBAL_DAY || queued >= MAX_QUEUED) { audit(ctx.db, { actor: 'system', action: 'xdm.capped', subject: row.id, data: { reason: day >= GLOBAL_DAY ? 'global_day' : 'queue_full' } }); return false; }
  const days = Math.max(1, Math.round((Number(row.expiry) - Math.floor(nowMs(ctx) / 1000)) / 86400));
  const r = ctx.db.prepare('INSERT OR IGNORE INTO x_dms (to_x_id, claim_id, text, status, created_at) VALUES (?, ?, ?, ?, ?)').run(String(row.recipient_provider_id), row.id, dmText({ amt, from, link, days }), 'queued', nowMs(ctx));
  return r.changes > 0;
}

module.exports = { dmText, queueClaimDm, safeName, PER_SENDER_DAY };
