'use strict';
const fs = require('node:fs');
const path = require('node:path');

const TYPES = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml; charset=utf-8', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.name = 'HttpError'; this.status = status; this.code = code; }
}

function makeRouter() {
  const routes = [];
  return {
    add(method, pattern, handler, opts = {}) {
      const keys = [];
      const re = new RegExp('^' + pattern.replace(/\/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
      routes.push({ method, re, keys, handler, opts });
    },
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (m) { const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); return { route: r, params }; }
      }
      return null;
    },
    hasPath(pathname) { return routes.some((r) => r.re.test(pathname)); },
  };
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

function readJson(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new HttpError(413, 'body_too_large', 'That request is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!n) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch { reject(new HttpError(400, 'bad_json', 'That request was not valid.')); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const remote = req.socket && req.socket.remoteAddress || '';
  if (/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(remote)) {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    if (xff) return xff;
  }
  return remote || 'unknown';
}

function makeLimiter(now = Date.now) {
  const hits = new Map();
  return function hit(key, max, windowMs) {
    const t = now();
    const rec = hits.get(key);
    if (!rec || t - rec.start >= windowMs) { hits.set(key, { start: t, n: 1 }); return true; }
    rec.n++;
    if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    return rec.n <= max;
  };
}

function originOk(req, publicUrl) {
  const o = req.headers.origin;
  if (!o) return false;
  try {
    const a = new URL(o); const b = new URL(publicUrl);
    if (a.origin === b.origin) return true;
    const loop = (h) => h === 'localhost' || h === '127.0.0.1';
    return loop(a.hostname) && loop(b.hostname) && a.protocol === b.protocol && a.port === b.port;
  } catch { return false; }
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://esm.sh https://accounts.google.com https://apis.google.com",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
  "font-src 'self' data:",
  "img-src 'self' data: https:",
  "connect-src 'self' https://esm.sh https://accounts.google.com",
  "frame-src 'self' https://accounts.google.com https://pay.coinbase.com",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  'report-uri /api/csp-report',
].join('; ');

function secHeaders() {
  return { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'content-security-policy-report-only': CSP, 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY', 'permissions-policy': 'camera=(), microphone=(), geolocation=()' };
}

function serveStatic(publicDir, urlPath, req, res, aliases = {}) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return false; }
  if (aliases[p]) p = aliases[p];
  const abs = path.resolve(publicDir, '.' + p);
  if (!abs.startsWith(publicDir + path.sep)) return false;
  let st;
  try { st = fs.statSync(abs); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(abs).toLowerCase();
  const versioned = /[?&]v=/.test(req.url || '');
  const rel = abs.slice(publicDir.length);
  let cache = 'no-cache';
  if (versioned || rel.startsWith(path.sep + 'fonts' + path.sep) || /-2026\d{4}[-.]/.test(rel)) cache = 'public, max-age=31536000, immutable';
  else if (rel.startsWith(path.sep + 'brand' + path.sep) || /\.(svg|png|webp|jpg|woff2)$/.test(ext) || ext === '.json') cache = 'public, max-age=86400, stale-while-revalidate=604800';
  const etag = 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
  if (cache === 'no-cache' && req.headers && req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': cache, ...secHeaders() }); res.end(); return true; }
  res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': cache, 'content-length': st.size, ...(cache === 'no-cache' ? { etag } : {}), ...secHeaders() });
  if (req.method === 'HEAD') { res.end(); return true; }
  const rs = fs.createReadStream(abs); rs.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); }); rs.pipe(res);
  return true;
}

module.exports = { HttpError, makeRouter, json, readJson, clientIp, makeLimiter, originOk, secHeaders, serveStatic, CSP, TYPES };
