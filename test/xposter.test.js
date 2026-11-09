'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, user } = require('./helpers');
const { oauthHeader, makeXPoster, flushOutbox } = require('../server/xposter');
const xpay = require('../server/xpay');

test('oauth1 signature matches the published worked example', () => {
  const h = oauthHeader('POST', 'https://api.twitter.com/1.1/statuses/update.json',
    { consumerKey: 'xvz1evFS4wEEPTGEFPHBog', consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' },
    { include_entities: 'true', status: 'Hello Ladies + Gentlemen, a signed OAuth request!' }, 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', 1318622958);
  const sig = /oauth_signature="([^"]+)"/.exec(h)[1];
  assert.equal(decodeURIComponent(sig), 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
});

test('poster is off without all four credentials', () => {
  assert.equal(makeXPoster({}), null);
  assert.equal(makeXPoster({ X_POST_CONSUMER_KEY: 'a', X_POST_CONSUMER_SECRET: 'b', X_POST_ACCESS_TOKEN: 'c' }), null);
});

function fakeX({ username = 'DoviFinance', failStatus = 0 } = {}) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body, auth: opts.headers.authorization });
    if (url.endsWith('/2/users/me')) return { ok: true, status: 200, json: async () => ({ data: { username } }) };
    if (failStatus) return { ok: false, status: failStatus, json: async () => ({ detail: 'nope' }) };
    return { ok: true, status: 200, json: async () => ({ data: { id: '999' } }) };
  };
  return { f, calls };
}
const env = { X_POST_CONSUMER_KEY: 'a', X_POST_CONSUMER_SECRET: 'b', X_POST_ACCESS_TOKEN: 'c', X_POST_ACCESS_SECRET: 'd' };

test('reply verifies the account first, then posts a threaded reply with an oauth header', async () => {
  const x = fakeX(); const p = makeXPoster(env, x.f);
  const r = await p.reply('123', 'hello');
  assert.equal(r.id, '999');
  assert.equal(x.calls[0].url, 'https://api.x.com/2/users/me');
  assert.deepEqual(JSON.parse(x.calls[1].body), { text: 'hello', reply: { in_reply_to_tweet_id: '123' } });
  assert.match(x.calls[1].auth, /^OAuth oauth_consumer_key="a"/);
  await p.reply('124', 'again');
  assert.equal(x.calls.filter((c) => c.url.endsWith('/2/users/me')).length, 1);
});

test('reply asks X to drop the tags it would add on its own', async () => {
  const x = fakeX(); const p = makeXPoster(env, x.f);
  await p.reply('200', 'hello', ['1628067904083181570', 'bad id', '777']);
  assert.deepEqual(JSON.parse(x.calls[1].body).reply, { in_reply_to_tweet_id: '200', exclude_reply_user_ids: ['1628067904083181570', '777'] });
});

test('reply refuses to post from the wrong account', async () => {
  const x = fakeX({ username: 'smartcoded' }); const p = makeXPoster(env, x.f);
  await assert.rejects(p.reply('123', 'hello'), /x_wrong_account/);
  assert.equal(x.calls.length, 1);
});

function queue(ctx, n) { for (let i = 0; i < n; i++) xpay.queueReply(ctx, 't' + i, 'reply ' + i); }

test('outbox: sends at most 3 per run, marks sent, never replies twice to the same tweet', async () => {
  const ctx = makeCtx(); const x = fakeX(); ctx.xposter = makeXPoster(env, x.f);
  queue(ctx, 5); xpay.queueReply(ctx, 't0', 'dupe of t0');
  const a = await flushOutbox(ctx);
  assert.equal(a.sent, 3);
  const b = await flushOutbox(ctx);
  assert.equal(b.sent, 2);
  const sentTo = ctx.db.prepare("SELECT reply_to FROM x_outbox WHERE status = 'sent'").all().map((r) => r.reply_to);
  assert.equal(new Set(sentTo).size, sentTo.length);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM x_outbox WHERE status = 'skipped'").get().n, 1);
});

test('outbox: hourly cap, permanent failures stop being retried, transient ones stay queued', async () => {
  const ctx = makeCtx(); ctx.xposter = makeXPoster(env, fakeX({ failStatus: 403 }).f);
  queue(ctx, 2);
  await flushOutbox(ctx);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM x_outbox WHERE status = 'failed'").get().n, 2);
  const c2 = makeCtx(); c2.xposter = makeXPoster(env, fakeX({ failStatus: 503 }).f);
  queue(c2, 2);
  await flushOutbox(c2);
  assert.equal(c2.db.prepare("SELECT COUNT(*) AS n FROM x_outbox WHERE status = 'queued'").get().n, 2);
  const c3 = makeCtx(); c3.xposter = makeXPoster(env, fakeX().f);
  c3.db.exec("INSERT INTO x_outbox (reply_to, text, status, created_at, sent_at) " + Array.from({ length: 30 }, (_, i) => "SELECT 'old" + i + "', 'x', 'sent', 1, " + c3.now() + " WHERE 1").join(' UNION ALL ').replace('INSERT INTO x_outbox (reply_to, text, status, created_at, sent_at) SELECT', 'INSERT INTO x_outbox (reply_to, text, status, created_at, sent_at) SELECT'));
  queue(c3, 1);
  assert.equal((await flushOutbox(c3)).sent, 0);
});

test('mention reader searches twitterapi.io only for payment wording since the last poll, drops our own tweets, and polling remembers the newest', async () => {
  const urls = [];
  const f = async (url) => { urls.push(url); return { ok: true, json: async () => ({ tweets: [
    { id: '1', text: '@DoviFinance send @bob 2 usdc', createdAt: 'Tue Oct 27 10:33:05 +0000 2026', author: { id: '111', userName: 'alice' } },
    { id: '2', text: 'we replied', createdAt: 'Tue Oct 27 10:34:05 +0000 2026', author: { id: '777', userName: 'DoviFinance' } }] }) }; };
  const reader = xpay.makeMentionReader({ TWITTERAPI_IO_KEY: 'k' }, f);
  const ctx = makeCtx(); ctx.mentions = reader; ctx.executor = {};
  let seen = [];
  const orig = xpay.processMention;
  const list = await reader.fetchMentions(1793000000);
  assert.equal(list.length, 1); assert.equal(list[0].authorHandle, 'alice');
  const qs = decodeURIComponent(urls[0]);
  assert.match(qs, /advanced_search/); assert.match(qs, /since_time:1793000000/);
  assert.match(qs, /@DoviFinance \(send OR pay OR give OR tip OR usdc OR usd/); assert.match(qs, /-from:DoviFinance/);
  assert.equal(xpay.makeMentionReader({}, f), null);
});

test('outbox: a giveaway winners post is not dropped just because the start reply to the same tweet was sent', async () => {
  const ctx = makeCtx(); const x = fakeX(); ctx.xposter = makeXPoster(env, x.f);
  xpay.queueReply(ctx, 'g1', 'Giveaway started.');
  xpay.queueReply(ctx, 'g1', 'Winners are @a and @b.', 'giveaway_draw');
  xpay.queueReply(ctx, 'g1', 'Giveaway started again.');
  const r = await flushOutbox(ctx);
  assert.equal(r.sent, 2);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM x_outbox WHERE status = 'skipped'").get().n, 1);
});

test('polling asks only for tweets after the newest id it has seen, so a processed mention is never paid for twice', async () => {
  const urls = [];
  const f = async (url) => { urls.push(decodeURIComponent(url)); return { ok: true, json: async () => ({ tweets: urls.length === 1 ? [{ id: '2117000000000000001', text: 'hi @DoviFinance', createdAt: 'Tue Nov 03 10:33:05 +0000 2026', author: { id: '111', userName: 'alice' } }] : [] }) }; };
  const ctx = makeCtx(); ctx.mentions = xpay.makeMentionReader({ TWITTERAPI_IO_KEY: 'k' }, f); ctx.executor = {};
  await xpay.pollMentions(ctx);
  await xpay.pollMentions(ctx);
  assert.match(urls[0], /since_time:/);
  assert.match(urls[1], /since_id:2117000000000000001/); assert.doesNotMatch(urls[1], /since_time/);
});

test('a stranger or an account with no limits or no funds gets one reply, then silence for six hours, and a burst of new strangers is capped', async () => {
  const ctx = makeCtx(); ctx.executor = {}; ctx.env = { DOVI_XPAY_ONBOARD: '1' };
  const mention = (id, aid, text = '@DoviFinance send @bob 2 usdc') => ({ id: String(id), text, authorId: String(aid), authorHandle: 'u' + aid, createdSec: 1793000000 });
  const r1 = await xpay.processMention(ctx, mention(1, 901));
  const r2 = await xpay.processMention(ctx, mention(2, 901));
  assert.equal(r1.status, 'needs_account'); assert.equal(r2.status, 'ignored'); assert.equal(r2.detail, 'cooldown');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM x_outbox").get().n, 1);
  for (let i = 0; i < 8; i++) await xpay.processMention(ctx, mention(10 + i, 1000 + i));
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM x_outbox").get().n, 6);
});

const { flushDms } = require('../server/xposter');
function dmCtx(poster) {
  const { makeCtx } = require('./helpers');
  const ctx = makeCtx(); ctx.xposter = poster;
  const add = (to, claim) => ctx.db.prepare("INSERT INTO x_dms (to_x_id, claim_id, text, status, created_at) VALUES (?, ?, 'hi', 'queued', ?)").run(to, claim, ctx.now());
  return { ctx, add };
}

test('dm posts to the conversation endpoint for that user id', async () => {
  const x = fakeX(); const p = makeXPoster(env, x.f);
  await p.dm('42', 'hello');
  assert.equal(x.calls[1].url, 'https://api.x.com/2/dm_conversations/with/42/messages');
  assert.deepEqual(JSON.parse(x.calls[1].body), { text: 'hello' });
  await assert.rejects(p.dm('not an id', 'x'), /bad_recipient/);
});

test('a closed inbox fails once and is not retried, a server error stays queued', async () => {
  let mode = 403;
  const { ctx, add } = dmCtx({ async dm() { const e = new Error('closed'); e.status = mode; throw e; } });
  add('1', 'c1'); add('2', 'c2');
  let r = await flushDms(ctx);
  assert.deepEqual(r, { sent: 0, failed: 2 });
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM x_dms WHERE status = 'failed'").get().n, 2);
  r = await flushDms(ctx); assert.deepEqual(r, { sent: 0, failed: 0 });
  mode = 500; add('3', 'c3');
  r = await flushDms(ctx);
  assert.equal(ctx.db.prepare("SELECT status FROM x_dms WHERE to_x_id = '3'").get().status, 'queued');
});

test('direct messages go out three per run and twenty per hour', async () => {
  const { ctx, add } = dmCtx({ async dm() { return { id: 'e' }; } });
  for (let i = 0; i < 5; i++) add(String(10 + i), 'k' + i);
  assert.equal((await flushDms(ctx)).sent, 3);
  assert.equal((await flushDms(ctx)).sent, 2);
});

test('a transient error pauses sending instead of retrying every cycle, and a wrong account keeps replies queued', async () => {
  const { makeCtx } = require('./helpers');
  const ctx = makeCtx(); let mode = 500;
  ctx.xposter = { async reply() { const e = new Error(mode === 0 ? 'x_wrong_account:other' : 'boom'); e.status = mode === 0 ? 403 : mode; throw e; } };
  ctx.db.prepare("INSERT INTO x_outbox (reply_to, text, status, created_at) VALUES ('1', 'a', 'queued', ?)").run(ctx.now());
  let r = await flushOutbox(ctx);
  assert.equal(r.sent, 0); assert.ok(ctx.xPauseUntil > ctx.now());
  assert.deepEqual(await flushOutbox(ctx), { paused: true });
  ctx.xPauseUntil = 0; mode = 0;
  await flushOutbox(ctx);
  assert.equal(ctx.db.prepare("SELECT status FROM x_outbox WHERE reply_to = '1'").get().status, 'queued', 'a credential problem never discards the reply');
  ctx.xPauseUntil = 0; ctx.db.prepare("UPDATE x_outbox SET created_at = ?").run(ctx.now() - 7 * 3600 * 1000);
  await flushOutbox(ctx);
  assert.equal(ctx.db.prepare("SELECT status FROM x_outbox WHERE reply_to = '1'").get().status, 'failed', 'replies older than six hours are dropped');
});

test('video upload runs INIT, chunked APPEND, FINALIZE and STATUS, then a top level post carries the media id', async () => {
  const env = { X_POST_CONSUMER_KEY: 'ck', X_POST_CONSUMER_SECRET: 'cs', X_POST_ACCESS_TOKEN: 'at', X_POST_ACCESS_SECRET: 'as', DOVI_X_HANDLE: 'DoviFinance' };
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url); const body = init.body;
    calls.push({ url: u, method: init.method || 'GET', auth: init.headers && init.headers.authorization, body: typeof body === 'string' ? body : (body ? '[form]' : null), appended: body && typeof body !== 'string' && body.get ? Number(body.get('segment_index')) : null });
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (u.endsWith('/2/users/me')) return ok({ data: { username: 'DoviFinance' } });
    if (u.includes('upload.twitter.com')) {
      if (init.method === 'POST' && typeof body === 'string' && body.includes('command=INIT')) return ok({ media_id_string: '12345' });
      if (init.method === 'POST' && typeof body !== 'string') return { ok: true, status: 204, json: async () => ({}) };
      if (init.method === 'POST' && body.includes('command=FINALIZE')) return ok({ processing_info: { state: 'pending', check_after_secs: 0 } });
      if (u.includes('command=STATUS')) return ok({ processing_info: { state: 'succeeded' } });
    }
    if (u.endsWith('/2/tweets')) return ok({ data: { id: '777' } });
    throw new Error('unexpected ' + u);
  };
  const { makeXPoster } = require('../server/xposter');
  const x = makeXPoster(env, f);
  const id = await x.uploadVideo(Buffer.alloc(10), { chunk: 4, pollMs: 1 });
  assert.equal(id, '12345');
  const seq = calls.filter((c) => c.url.includes('upload.twitter.com')).map((c) => (c.appended != null ? 'APPEND' + c.appended : (c.body || '').match(/command=(\w+)/)?.[1] || (c.url.match(/command=(\w+)/) || [])[1]));
  assert.deepEqual(seq, ['INIT', 'APPEND0', 'APPEND1', 'APPEND2', 'FINALIZE', 'STATUS']);
  assert.ok(calls.filter((c) => c.url.includes('upload.twitter.com')).every((c) => /^OAuth /.test(c.auth)));
  const p = await x.post('hello', { mediaId: id });
  assert.equal(p.id, '777');
  const tweet = calls.filter((c) => c.url.endsWith('/2/tweets')).pop();
  assert.deepEqual(JSON.parse(tweet.body), { text: 'hello', media: { media_ids: ['12345'] } });
  await assert.rejects(x.uploadVideo(Buffer.alloc(0)), /bad_video_size/);
});

test('video upload stops on a processing failure and never posts under the wrong account', async () => {
  const env = { X_POST_CONSUMER_KEY: 'ck', X_POST_CONSUMER_SECRET: 'cs', X_POST_ACCESS_TOKEN: 'at', X_POST_ACCESS_SECRET: 'as', DOVI_X_HANDLE: 'DoviFinance' };
  const { makeXPoster } = require('../server/xposter');
  const wrong = makeXPoster(env, async (u) => ({ ok: true, status: 200, json: async () => ({ data: { username: 'someoneelse' } }) }));
  await assert.rejects(wrong.post('x'), /x_wrong_account/);
  await assert.rejects(wrong.uploadVideo(Buffer.alloc(5)), /x_wrong_account/);
  const bad = makeXPoster(env, async (u, init = {}) => {
    const ok = (j) => ({ ok: true, status: 200, json: async () => j }); const b = init.body;
    if (String(u).endsWith('/2/users/me')) return ok({ data: { username: 'DoviFinance' } });
    if (typeof b === 'string' && b.includes('command=INIT')) return ok({ media_id_string: '9' });
    if (typeof b !== 'string' && b) return { ok: true, status: 204, json: async () => ({}) };
    if (typeof b === 'string' && b.includes('command=FINALIZE')) return ok({ processing_info: { state: 'in_progress', check_after_secs: 0 } });
    return ok({ processing_info: { state: 'failed', error: { message: 'bad codec' } } });
  });
  await assert.rejects(bad.uploadVideo(Buffer.alloc(5), { pollMs: 1 }), /x_video_failed:bad codec/);
});
