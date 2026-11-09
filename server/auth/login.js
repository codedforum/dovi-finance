'use strict';
const { normalizeProviderId } = require('../ids');
const { findUserByIdentity, linkIdentity, upsertUser, userFromSessionIdentity } = require('../identity');
const { audit } = require('../audit');
const { HttpError } = require('../http');
const waitlist = require('../waitlist');

function displayNameFor(kind, providerId, label) {
  if (kind === 'x') return label || null;
  const mail = kind === 'email' ? providerId : (label && /@/.test(label) ? label : null);
  if (mail) return mail.split('@')[0].slice(0, 30);
  return null;
}

function ensureName(ctx, user, kind, providerId, label) {
  if (user.display_name) return user;
  const n = displayNameFor(kind, providerId, label);
  if (!n) return user;
  ctx.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(n, user.id);
  return { ...user, display_name: n };
}

function loginWithIdentity(ctx, { kind, providerId, label = null, linkToUserId = null, invite = null }) {
  const pid = normalizeProviderId(kind, providerId);
  const now = ctx.now ? ctx.now() : Date.now();
  const existing = findUserByIdentity(ctx.db, kind, pid);
  if (linkToUserId != null) {
    const linked = linkIdentity(ctx.db, { userId: linkToUserId, kind, providerId: pid, label, now });
    audit(ctx.db, { actor: 'user:' + linkToUserId, action: 'identity.link', subject: kind + ':' + pid });
    const u = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(linkToUserId);
    return { user: u, identity: u.cdp_sub, linked: true, label: linked.label };
  }
  if (existing) {
    if (label) linkIdentity(ctx.db, { userId: existing.id, kind, providerId: pid, label, now });
    return { user: ensureName(ctx, existing, kind, pid, label), identity: existing.cdp_sub, linked: false };
  }
  const inviter = invite ? waitlist.byCode(ctx, invite) : null;
  if (ctx.cfg.inviteOnly && !inviter) throw new HttpError(403, 'invite_required', 'DOVI is invite only right now. Enter an invite code from a friend.');
  const user = ensureName(ctx, userFromSessionIdentity(ctx.db, kind + ':' + pid, { label, now }), kind, pid, label);
  if (inviter) ctx.db.prepare('UPDATE users SET invited_by = ? WHERE id = ? AND invited_by IS NULL').run(inviter.id, user.id);
  audit(ctx.db, { actor: 'user:' + user.id, action: 'user.create', subject: kind + ':' + pid });
  return { user, identity: user.cdp_sub, linked: false };
}

function userFromSession(ctx, identity) {
  if (!identity) return null;
  const row = ctx.db.prepare('SELECT * FROM users WHERE cdp_sub = ?').get(identity);
  if (row) return row;
  return userFromSessionIdentity(ctx.db, identity, { now: ctx.now ? ctx.now() : Date.now() });
}

module.exports = { loginWithIdentity, userFromSession };
