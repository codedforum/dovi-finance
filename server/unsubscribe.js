'use strict';
const crypto = require('node:crypto');

const nowMs = (ctx) => (ctx.now ? ctx.now() : Date.now());
const norm = (e) => String(e || '').trim().toLowerCase();

function key(ctx) {
  const row = ctx.db.prepare("SELECT v FROM kv WHERE k = 'unsub:key'").get();
  if (row) return Buffer.from(row.v, 'hex');
  const k = crypto.randomBytes(32);
  ctx.db.prepare("INSERT INTO kv (k, v, updated_at) VALUES ('unsub:key', ?, ?) ON CONFLICT(k) DO NOTHING").run(k.toString('hex'), nowMs(ctx));
  return Buffer.from(ctx.db.prepare("SELECT v FROM kv WHERE k = 'unsub:key'").get().v, 'hex');
}

function token(ctx, email) {
  const e = norm(email);
  const sig = crypto.createHmac('sha256', key(ctx)).update('unsub:' + e).digest('base64url').slice(0, 32);
  return Buffer.from(e).toString('base64url') + '.' + sig;
}

function verify(ctx, t) {
  const m = /^([A-Za-z0-9_-]{4,400})\.([A-Za-z0-9_-]{32})$/.exec(String(t || ''));
  if (!m) return null;
  const email = Buffer.from(m[1], 'base64url').toString('utf8');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  const want = crypto.createHmac('sha256', key(ctx)).update('unsub:' + norm(email)).digest('base64url').slice(0, 32);
  const a = Buffer.from(m[2]); const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? norm(email) : null;
}

const isOptedOut = (db, email) => !!db.prepare('SELECT 1 FROM email_optouts WHERE email = ?').get(norm(email));

function optOut(ctx, email, source = 'link') {
  ctx.db.prepare('INSERT INTO email_optouts (email, created_at, source) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING').run(norm(email), nowMs(ctx), source);
}

const link = (ctx, email) => ctx.cfg.publicUrl + '/unsubscribe?t=' + token(ctx, email);

function mask(email) { const [u, d] = String(email).split('@'); return (u.length <= 2 ? u[0] : u.slice(0, 2)) + '…@' + d; }

module.exports = { token, verify, isOptedOut, optOut, link, mask, norm };
