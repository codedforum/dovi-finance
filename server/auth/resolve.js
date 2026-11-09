'use strict';
const { normalizeHandle, IdError } = require('../ids');
const { findUserByIdentity } = require('../identity');

const PROFILE_TTL_MS = 5 * 60 * 1000;
function safeAvatar(url) {
  const u = String(url || '');
  return /^https:\/\/pbs\.twimg\.com\/[A-Za-z0-9_\/.\-]+$/.test(u) ? u.replace('_normal.', '_400x400.') : '';
}
function profileOf(u) {
  const followers = Number(u.followers);
  return {
    name: String(u.name || '').slice(0, 60),
    avatarUrl: safeAvatar(u.avatar_url),
    followers: Number.isFinite(followers) && followers >= 0 ? followers : null,
    verified: !!(u.verification && u.verification.verified),
    bio: String(u.description || '').replace(/\s+/g, ' ').slice(0, 140),
  };
}

async function lookupXHandle(ctx, handle) {
  const f = ctx.fetch || fetch;
  const cache = ctx.profileCache || (ctx.profileCache = new Map());
  const hit = cache.get(handle.toLowerCase());
  if (hit && (ctx.now ? ctx.now() : Date.now()) - hit.at < PROFILE_TTL_MS) return hit.value;
  let r;
  for (let i = 0; i < 4; i++) {
    try { r = await f('https://api.fxtwitter.com/' + encodeURIComponent(handle), { redirect: 'manual', headers: { 'user-agent': 'dovi/1.0' } }); }
    catch { throw new IdError('x_lookup_failed', 'Could not look up that X account right now. Try again in a moment.'); }
    if (r.status === 200) break;
    if (r.status !== 404 || i === 3) break;
    await new Promise((res) => setTimeout(res, ctx.lookupDelayMs == null ? 350 : ctx.lookupDelayMs));
  }
  if (r.status === 429 || r.status >= 500) throw new IdError('x_lookup_failed', 'Could not look up that X account right now. Try again in a moment.');
  if (r.status !== 200) throw new IdError('x_not_found', 'We could not find an X account called @' + handle + '.');
  const j = await r.json();
  const u = j && j.user;
  if (!u || !/^\d+$/.test(String(u.id))) throw new IdError('x_not_found', 'We could not find an X account called @' + handle + '.');
  if (u.protected) throw new IdError('x_protected', '@' + handle + ' has a protected account. Send to their email instead.');
  const value = { providerId: String(u.id), label: '@' + u.screen_name, profile: profileOf(u) };
  cache.set(handle.toLowerCase(), { at: ctx.now ? ctx.now() : Date.now(), value });
  return value;
}

async function resolveRecipient(ctx, text) {
  const h = normalizeHandle(text);
  if (h.kind === 'email') {
    const existing = findUserByIdentity(ctx.db, 'email', h.handle);
    return { kind: 'email', providerId: h.handle, label: h.handle, existingUserId: existing ? existing.id : null };
  }
  const x = await lookupXHandle(ctx, h.handle);
  const existing = findUserByIdentity(ctx.db, 'x', x.providerId);
  return { kind: 'x', providerId: x.providerId, label: x.label, profile: x.profile || null, existingUserId: existing ? existing.id : null };
}

module.exports = { resolveRecipient, lookupXHandle };
