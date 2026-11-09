'use strict';
const crypto = require('node:crypto');

const API = 'https://api.x.com';
const enc = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function oauthHeader(method, url, creds, query = {}, nonce = crypto.randomBytes(16).toString('hex'), ts = Math.floor(Date.now() / 1000)) {
  const p = { oauth_consumer_key: creds.consumerKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(ts), oauth_token: creds.token, oauth_version: '1.0' };
  const all = { ...query, ...p };
  const base = [method.toUpperCase(), enc(url), enc(Object.keys(all).sort().map((k) => enc(k) + '=' + enc(all[k])).join('&'))].join('&');
  p.oauth_signature = crypto.createHmac('sha1', enc(creds.consumerSecret) + '&' + enc(creds.tokenSecret)).update(base).digest('base64');
  return 'OAuth ' + Object.keys(p).sort().map((k) => enc(k) + '="' + enc(p[k]) + '"').join(', ');
}

function makeXPoster(env = process.env, f = fetch) {
  const creds = { consumerKey: env.X_POST_CONSUMER_KEY, consumerSecret: env.X_POST_CONSUMER_SECRET, token: env.X_POST_ACCESS_TOKEN, tokenSecret: env.X_POST_ACCESS_SECRET };
  if (!creds.consumerKey || !creds.consumerSecret || !creds.token || !creds.tokenSecret) return null;
  const handle = String(env.DOVI_X_HANDLE || 'DoviFinance').toLowerCase();
  let verified = false;
  async function call(method, path, body) {
    const url = API + path;
    const r = await f(url, { method, headers: { authorization: oauthHeader(method, url, creds), 'content-type': 'application/json', 'user-agent': 'dovi/1.0' }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { j = null; }
    if (!r.ok) { const e = new Error((j && (j.detail || j.title)) || 'x ' + r.status); e.status = r.status; throw e; }
    return j;
  }
  async function assertAccount() {
    if (verified) return;
    const j = await call('GET', '/2/users/me');
    const got = String(j && j.data && j.data.username || '').toLowerCase();
    if (got !== handle) throw new Error('x_wrong_account:' + got);
    verified = true;
  }
  return {
    handle,
    verify: async () => { await assertAccount(); return handle; },
    async dm(toXId, text) {
      await assertAccount();
      if (!/^\d{1,25}$/.test(String(toXId))) throw Object.assign(new Error('bad_recipient'), { status: 400 });
      const j = await call('POST', '/2/dm_conversations/with/' + String(toXId) + '/messages', { text: String(text).slice(0, 9000) });
      return { id: j && j.data && j.data.dm_event_id };
    },
    /* uploads one mp4 with the classic chunked upload and waits until X has processed it; returns the media id */
    async uploadVideo(bytes, { chunk = 4 * 1024 * 1024, pollMs = 2000, tries = 60 } = {}) {
      await assertAccount();
      const UP = 'https://upload.twitter.com/1.1/media/upload.json';
      const form = async (params) => {
        const r = await f(UP, { method: 'POST', headers: { authorization: oauthHeader('POST', UP, creds, params), 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'dovi/1.0' }, body: new URLSearchParams(params).toString() });
        let j = null; try { j = await r.json(); } catch { j = null; }
        if (!r.ok) { const e = new Error((j && (j.error || (j.errors && j.errors[0] && j.errors[0].message))) || 'x upload ' + r.status); e.status = r.status; throw e; }
        return j || {};
      };
      const total = bytes.length;
      if (!total || total > 512 * 1024 * 1024) throw new Error('bad_video_size');
      const init = await form({ command: 'INIT', total_bytes: String(total), media_type: 'video/mp4', media_category: 'tweet_video' });
      const id = String(init.media_id_string || init.media_id || '');
      if (!/^\d+$/.test(id)) throw new Error('x_upload_no_id');
      for (let i = 0, off = 0; off < total; i++, off += chunk) {
        const fd = new FormData();
        fd.append('command', 'APPEND'); fd.append('media_id', id); fd.append('segment_index', String(i));
        fd.append('media', new Blob([bytes.subarray(off, Math.min(total, off + chunk))], { type: 'application/octet-stream' }), 'chunk.bin');
        const r = await f(UP, { method: 'POST', headers: { authorization: oauthHeader('POST', UP, creds), 'user-agent': 'dovi/1.0' }, body: fd });
        if (!r.ok) { const e = new Error('x append ' + r.status); e.status = r.status; throw e; }
      }
      let info = (await form({ command: 'FINALIZE', media_id: id })).processing_info;
      for (let n = 0; info && n < tries; n++) {
        if (info.state === 'succeeded') break;
        if (info.state === 'failed') throw new Error('x_video_failed:' + String(info.error && info.error.message || '').slice(0, 80));
        await new Promise((r) => setTimeout(r, Math.max(pollMs, Number(info.check_after_secs || 0) * (pollMs > 100 ? 1000 : 0))));
        const q = { command: 'STATUS', media_id: id };
        const r = await f(UP + '?' + new URLSearchParams(q).toString(), { headers: { authorization: oauthHeader('GET', UP, creds, q), 'user-agent': 'dovi/1.0' } });
        let j = null; try { j = await r.json(); } catch { j = null; }
        if (!r.ok) { const e = new Error('x status ' + r.status); e.status = r.status; throw e; }
        info = j && j.processing_info;
      }
      if (info && info.state !== 'succeeded') throw new Error('x_video_timeout');
      return id;
    },
    /* a top level post, optionally with an uploaded video */
    async post(text, { mediaId = null } = {}) {
      await assertAccount();
      const body = { text: String(text).slice(0, 280) };
      if (mediaId) body.media = { media_ids: [String(mediaId)] };
      const j = await call('POST', '/2/tweets', body);
      return { id: j && j.data && j.data.id };
    },
    async reply(tweetId, text, exclude = []) {
      await assertAccount();
      const reply = { in_reply_to_tweet_id: String(tweetId) };
      const ids = (exclude || []).map(String).filter((x) => /^\d{1,25}$/.test(x)).slice(0, 50);
      if (ids.length) reply.exclude_reply_user_ids = ids;
      const j = await call('POST', '/2/tweets', { text: String(text).slice(0, 280), reply });
      return { id: j && j.data && j.data.id };
    },
  };
}

const MAX_PER_RUN = 3;
const MAX_PER_HOUR = 30;
const STALE_REPLY_MS = 6 * 3600 * 1000;
const STALE_DM_MS = 24 * 3600 * 1000;

async function flushOutbox(ctx) {
  if (!ctx.xposter) return { skipped: true };
  const now = ctx.now ? ctx.now() : Date.now();
  if (ctx.xPauseUntil && now < ctx.xPauseUntil) return { paused: true };
  ctx.db.prepare("UPDATE x_outbox SET status = 'failed' WHERE status = 'queued' AND created_at < ?").run(now - STALE_REPLY_MS);
  const sentLastHour = ctx.db.prepare("SELECT COUNT(*) AS n FROM x_outbox WHERE status = 'sent' AND sent_at > ?").get(now - 3600000).n;
  let budget = Math.min(MAX_PER_RUN, Math.max(0, MAX_PER_HOUR - sentLastHour));
  const rows = ctx.db.prepare("SELECT * FROM x_outbox WHERE status = 'queued' ORDER BY id LIMIT ?").all(budget);
  let sent = 0; let failed = 0;
  for (const r of rows) {
    const dup = ctx.db.prepare("SELECT 1 FROM x_outbox WHERE reply_to = ? AND status = 'sent' AND COALESCE(kind, '') = COALESCE(?, '')").get(r.reply_to, r.kind || null);
    if (dup) { ctx.db.prepare("UPDATE x_outbox SET status = 'skipped' WHERE id = ?").run(r.id); continue; }
    try {
      let ex = []; try { ex = r.exclude ? JSON.parse(r.exclude) : []; } catch { ex = []; }
      await ctx.xposter.reply(r.reply_to, r.text, ex);
      ctx.db.prepare("UPDATE x_outbox SET status = 'sent', sent_at = ? WHERE id = ?").run(ctx.now ? ctx.now() : Date.now(), r.id); sent++;
    } catch (e) {
      const permanent = (e.status === 403 || e.status === 400) && !/x_wrong_account/.test(e.message);
      ctx.db.prepare('UPDATE x_outbox SET status = ? WHERE id = ?').run(permanent ? 'failed' : 'queued', r.id);
      if (permanent) { failed++; continue; }
      ctx.xPauseUntil = (ctx.now ? ctx.now() : Date.now()) + (e.status === 429 ? 300000 : 120000);
      break;
    }
  }
  return { sent, failed };
}

const MAX_DM_PER_RUN = 3;
const MAX_DM_PER_HOUR = 300;

function tellSender(ctx, dm) {
  try {
    const c = dm.claim_id ? ctx.db.prepare('SELECT sender_user_id, recipient_label FROM claims WHERE id = ?').get(dm.claim_id) : null;
    if (c && ctx.notify) ctx.notify(c.sender_user_id, { ref: dm.claim_id, type: 'dm_failed', title: 'Could not message ' + c.recipient_label, privateTitle: 'A message could not be sent', body: 'Their X messages are closed. Share your claim link with them yourself.', action: { label: 'Open Activity', href: '/app#activity' } });
  } catch { /* the sender is told on the next screen load anyway */ }
}

/* direct messages to payment recipients: a closed inbox fails once and is not retried */
async function flushDms(ctx) {
  if (!ctx.xposter || typeof ctx.xposter.dm !== 'function') return { skipped: true };
  const now = ctx.now ? ctx.now() : Date.now();
  if (ctx.xDmPauseUntil && now < ctx.xDmPauseUntil) return { paused: true };
  ctx.db.prepare("UPDATE x_dms SET status = 'failed', error = 'stale' WHERE status = 'queued' AND created_at < ?").run(now - STALE_DM_MS);
  const sentLastHour = ctx.db.prepare("SELECT COUNT(*) AS n FROM x_dms WHERE status = 'sent' AND sent_at > ?").get(now - 3600000).n;
  const budget = Math.min(MAX_DM_PER_RUN, Math.max(0, MAX_DM_PER_HOUR - sentLastHour));
  let sent = 0; let failed = 0;
  for (const r of ctx.db.prepare("SELECT * FROM x_dms WHERE status = 'queued' ORDER BY id LIMIT ?").all(budget)) {
    try {
      await ctx.xposter.dm(r.to_x_id, r.text);
      ctx.db.prepare("UPDATE x_dms SET status = 'sent', sent_at = ? WHERE id = ?").run(ctx.now ? ctx.now() : Date.now(), r.id); sent++;
    } catch (e) {
      const permanent = (e.status === 403 || e.status === 400 || e.status === 404) && !/x_wrong_account/.test(e.message);
      ctx.db.prepare('UPDATE x_dms SET status = ?, error = ? WHERE id = ?').run(permanent ? 'failed' : 'queued', String(e && e.message || e).slice(0, 160), r.id);
      if (permanent) { failed++; tellSender(ctx, r); continue; }
      ctx.xDmPauseUntil = (ctx.now ? ctx.now() : Date.now()) + (e.status === 429 ? 300000 : 120000);
      break;
    }
  }
  return { sent, failed };
}

module.exports = { makeXPoster, oauthHeader, flushOutbox, flushDms, MAX_PER_HOUR };
