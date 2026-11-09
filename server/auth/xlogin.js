'use strict';
const crypto = require('node:crypto');

class XLoginError extends Error {
  constructor(code, message) { super(message || code); this.name = 'XLoginError'; this.code = code; }
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const TTL_MS = 10 * 60 * 1000;

const SAFE_PATH = /^\/(?![\/\\])[A-Za-z0-9_\-./?=&#%:,@]*$/;
const safePath = (p, fallback = '/app') => (typeof p === 'string' && p.length < 300 && SAFE_PATH.test(p) ? p : fallback);

function startXLogin(ctx, { linkUserId = null, returnTo = '/app', redirectUri = null, extra = null } = {}) {
  const x = ctx.cfg.x;
  const redirect = redirectUri || x.redirectUri;
  if (!x.clientId || !redirect) throw new XLoginError('x_not_configured', 'Sign in with X is not switched on yet.');
  const state = b64u(crypto.randomBytes(24));
  const nonce = b64u(crypto.randomBytes(18));
  const verifier = b64u(crypto.randomBytes(48));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const now = ctx.now ? ctx.now() : Date.now();
  ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)').run('xstate:' + state, JSON.stringify({ verifier, linkUserId, extra, redirectUri: redirect, returnTo: safePath(returnTo, '/app'), nsh: crypto.createHash('sha256').update(nonce).digest('hex'), t: now }), now);
  const q = new URLSearchParams({ response_type: 'code', client_id: x.clientId, redirect_uri: redirect, scope: 'users.read tweet.read', state, code_challenge: challenge, code_challenge_method: 'S256' });
  return { url: 'https://twitter.com/i/oauth2/authorize?' + q.toString(), state, nonce };
}

async function finishXLogin(ctx, { code, state, nonce = null }) {
  const f = ctx.fetch || fetch;
  const x = ctx.cfg.x;
  if (!code || !state) throw new XLoginError('x_bad_callback', 'The X sign in did not complete.');
  const row = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get('xstate:' + state);
  if (!row) throw new XLoginError('x_bad_state', 'That sign in link is not valid. Please try again.');
  ctx.db.prepare('DELETE FROM kv WHERE k = ?').run('xstate:' + state);
  const st = JSON.parse(row.v);
  const now = ctx.now ? ctx.now() : Date.now();
  if (now - st.t > TTL_MS) throw new XLoginError('x_expired', 'That sign in took too long. Please try again.');
  if (st.nsh && (!nonce || crypto.createHash('sha256').update(String(nonce)).digest('hex') !== st.nsh)) throw new XLoginError('x_bad_state', 'That sign in link is not valid. Please try again.');

  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: st.redirectUri || x.redirectUri, code_verifier: st.verifier, client_id: x.clientId });
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (x.clientSecret) headers.authorization = 'Basic ' + Buffer.from(x.clientId + ':' + x.clientSecret).toString('base64');
  const tr = await f('https://api.twitter.com/2/oauth2/token', { method: 'POST', headers, body });
  if (!tr.ok) throw new XLoginError('x_token_failed', 'X did not accept the sign in.');
  const tok = await tr.json();
  if (!tok.access_token) throw new XLoginError('x_token_failed', 'X did not accept the sign in.');
  const mr = await f('https://api.twitter.com/2/users/me?user.fields=profile_image_url', { headers: { authorization: 'Bearer ' + tok.access_token } });
  if (!mr.ok) throw new XLoginError('x_profile_failed', 'Could not read your X profile.');
  const me = (await mr.json()).data;
  if (!me || !/^\d+$/.test(String(me.id))) throw new XLoginError('x_profile_failed', 'Could not read your X profile.');
  return { xId: String(me.id), handle: me.username, name: me.name, avatar: me.profile_image_url || null, linkUserId: st.linkUserId, extra: st.extra || null, returnTo: st.returnTo };
}

module.exports = { startXLogin, finishXLogin, XLoginError, safePath };
