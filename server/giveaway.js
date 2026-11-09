'use strict';
const crypto = require('node:crypto');
const { findUserByIdentity, userIdentities } = require('./identity');
const { audit } = require('./audit');
const { parseUsd, formatUsd } = require('./money');

class GiveawayError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.name = 'GiveawayError'; this.code = code; this.status = status; }
}

const MAX_WINNERS = 10;
const MIN_MS = 10 * 60 * 1000;
const MAX_MS = 7 * 24 * 3600 * 1000;
const MAX_OPEN = 3;
const MAX_ATTEMPTS = 6;
const nowOf = (ctx) => (ctx.now ? ctx.now() : Date.now());

const FOLLOW_CHECK_MAX = 80;

function parseGiveaway(text) {
  const raw = String(text || '').replace(/https?:\/\/\S+/g, ' ');
  if (!/@dovifinance\b/i.test(raw)) return null;
  const body = raw.replace(/@[A-Za-z0-9_]{1,15}/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/\b(giveaway|give away|raffle|winners?)\b/i.test(body) && !/\b(pick|select|choose|draw)\b.*\b(winners?|someone|a winner)\b/i.test(body)) return null;
  const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20 };
  const toN = (t) => (/^\d+$/.test(t) ? Number(t) : NUMW[String(t).toLowerCase()]);
  const wm = body.match(/\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\b(?!\s*(?:hours?|hrs?|h|days?|d|minutes?|mins?)\b)\s+(?:[A-Za-z]+\s+){0,2}?(?:lucky\s+)?winners?\b/i) || body.match(/\bwinners?\s*(?:[:=]|are|is|will be)?\s*(\d{1,3})\b/i);
  if (!wm && /\bwinners\b/i.test(body)) return { error: 'count', message: 'Tell me how many winners, for example "3 winners", and tag me again.' };
  const winners = wm ? toN(wm[1]) : 1;
  if (!Number.isInteger(winners) || winners < 1 || winners > MAX_WINNERS) return { error: 'winners', message: 'I can pick between 1 and ' + MAX_WINNERS + ' winners.' };
  let ms = 24 * 3600 * 1000;
  const dm = body.match(/\b(?:in|after|within|for|ends? in)\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|h|days?|d)\b/i) || body.match(/\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|days?|d)\b/i);
  if (dm) { const n = Number(dm[1]); const u = dm[2].toLowerCase(); ms = n * (u.startsWith('m') ? 60000 : u.startsWith('d') ? 86400000 : 3600000); }
  if (!(ms >= MIN_MS && ms <= MAX_MS)) return { error: 'duration', message: 'I can run a giveaway from 10 minutes to 7 days.' };
  const reqs = { like: /\b(likes?|liked)\b/i.test(body), rt: /\b(rt|rts|retweets?|reposts?)\b/i.test(body), comment: /\b(comments?|repl(?:y|ies))\b/i.test(body), quote: /\bquotes?\b/i.test(body), follow: /\bfollow(?:s|ed|ing)?\b/i.test(body) };
  if (!reqs.rt && !reqs.comment && !reqs.quote) { if (reqs.like) return { error: 'like_only', message: 'Likes cannot be checked on X, so I need a retweet, a reply or a quote as well.' }; reqs.rt = true; reqs.comment = true; }
  let prizeMicro = null;
  const pm = body.match(/\$\s*(\d{1,6}(?:\.\d{1,2})?)\b/) || body.match(/\b(\d{1,6}(?:\.\d{1,2})?)\s*(?:usdc|usd|dollars?)\b/i);
  if (pm) { try { prizeMicro = parseUsd(pm[1]).toString(); } catch { prizeMicro = null; } }
  return { winners, ms, reqs, prizeMicro };
}

function tweetIdFromUrl(text) {
  const m = String(text || '').match(/(?:twitter|x)\.com\/[A-Za-z0-9_]{1,15}\/status\/(\d{5,25})/) || String(text || '').match(/^(\d{5,25})$/);
  return m ? m[1] : null;
}

function openCount(ctx, userId) { return Number(ctx.db.prepare("SELECT COUNT(*) AS n FROM giveaways WHERE user_id = ? AND status = 'open'").get(userId).n); }

function create(ctx, { userId, tweetId, commandTweetId = null, parsed }) {
  if (!ctx.cfg.giveaway) throw new GiveawayError('giveaways_off', 'Giveaways are not switched on yet.', 503);
  if (!userIdentities(ctx.db, userId).some((i) => i.kind === 'x')) throw new GiveawayError('x_required', 'Link your X account first.');
  if (ctx.db.prepare("SELECT 1 FROM giveaways WHERE tweet_id = ? AND status != 'cancelled'").get(String(tweetId))) throw new GiveawayError('exists', 'A giveaway already runs on that post.');
  if (openCount(ctx, userId) >= MAX_OPEN) throw new GiveawayError('too_many', 'You have ' + MAX_OPEN + ' open giveaways. Wait for one to end or cancel it.');
  if (parsed.prizeMicro != null) {
    const c = ctx.cfg.claim; const p = BigInt(parsed.prizeMicro);
    if (p < c.minAmountMicro || p > c.perClaimCapMicro) throw new GiveawayError('bad_prize', 'The prize per winner must be between ' + formatUsd(c.minAmountMicro) + ' and ' + formatUsd(c.perClaimCapMicro) + '.');
  }
  const t = nowOf(ctx);
  const r = ctx.db.prepare('INSERT INTO giveaways (user_id, tweet_id, command_tweet_id, winners, ends_at, reqs, prize_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(userId, String(tweetId), commandTweetId ? String(commandTweetId) : null, parsed.winners, t + parsed.ms, JSON.stringify(parsed.reqs), parsed.prizeMicro, 'open', t);
  const id = Number(r.lastInsertRowid);
  audit(ctx.db, { actor: 'user:' + userId, action: 'giveaway.create', subject: String(id), data: { winners: parsed.winners, hours: Math.round(parsed.ms / 36000) / 100 } });
  return get(ctx, id);
}

function rowView(ctx, r) {
  const result = r.result ? JSON.parse(r.result) : null;
  return { id: r.id, tweetId: r.tweet_id, winners: r.winners, endsAt: r.ends_at, reqs: JSON.parse(r.reqs), prizeMicro: r.prize_micro, status: r.status, createdAt: r.created_at, drawnAt: r.drawn_at, result, url: ctx.cfg.payBaseUrl + '/g/' + r.id };
}
function get(ctx, id) { const r = ctx.db.prepare('SELECT * FROM giveaways WHERE id = ?').get(Number(id)); return r ? rowView(ctx, r) : null; }
function list(ctx, userId) { return ctx.db.prepare('SELECT * FROM giveaways WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(userId).map((r) => rowView(ctx, r)); }

function cancel(ctx, { userId, id }) {
  const r = ctx.db.prepare("UPDATE giveaways SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'open'").run(Number(id), userId);
  if (!Number(r.changes)) throw new GiveawayError('not_found', 'That giveaway is not open.', 404);
  return get(ctx, id);
}

function shuffle(ids, seed) {
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const h = crypto.createHmac('sha256', seed).update('i:' + i).digest();
    const j = Number(h.readBigUInt64BE(0) % BigInt(i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(poolIds, winners, seed) { return shuffle(poolIds.slice().sort(), seed).slice(0, winners); }

async function draw(ctx, row) {
  const reqs = JSON.parse(row.reqs);
  const reader = ctx.engagement;
  if (!reader) throw new Error('no engagement reader');
  const sets = [];
  const handles = new Map();
  const add = (list, set) => { for (const u of list) { if (!u.id) continue; set.add(String(u.id)); if (u.handle) handles.set(String(u.id), u.handle); } };
  if (reqs.rt) { const s = new Set(); add(await reader.retweeters(row.tweet_id), s); sets.push(s); }
  if (reqs.comment) { const s = new Set(); add(await reader.replies(row.tweet_id), s); sets.push(s); }
  if (reqs.quote) { const s = new Set(); add(await reader.quotes(row.tweet_id), s); sets.push(s); }
  let pool = sets.length ? [...sets[0]].filter((id) => sets.every((s) => s.has(id))) : [];
  const creator = userIdentities(ctx.db, row.user_id).find((i) => i.kind === 'x');
  const bot = String((ctx.env && ctx.env.DOVI_X_HANDLE) || 'DoviFinance').toLowerCase();
  pool = pool.filter((id) => !(creator && String(creator.provider_id) === id) && String(handles.get(id) || '').toLowerCase() !== bot);
  const seed = crypto.randomBytes(16).toString('hex');
  const order = pick(pool, pool.length, seed);
  let winners; let followChecked = 0;
  if (reqs.follow && reader.follows) {
    winners = [];
    for (const id of order) {
      if (winners.length >= row.winners || followChecked >= FOLLOW_CHECK_MAX) break;
      const h = handles.get(id); if (!h) continue;
      followChecked += 1;
      if (await reader.follows(h, bot)) winners.push(id);
    }
  } else winners = order.slice(0, row.winners);
  const poolHash = crypto.createHash('sha256').update(pool.slice().sort().join(',')).digest('hex');
  const result = { eligible: pool.length, seed, poolHash, winners: winners.map((id) => ({ id, handle: handles.get(id) || null })), drawnAt: nowOf(ctx), likesChecked: false, followChecked: !!(reqs.follow && reader.follows), followLooked: followChecked };
  const ins = ctx.db.prepare('INSERT OR IGNORE INTO giveaway_pool (giveaway_id, x_id, handle) VALUES (?, ?, ?)');
  for (const id of pool.slice(0, 5000)) ins.run(row.id, id, handles.get(id) || null);
  const won = ctx.db.prepare("UPDATE giveaways SET status = 'drawn', result = ?, drawn_at = ? WHERE id = ? AND status = 'open'").run(JSON.stringify(result), result.drawnAt, row.id);
  if (!Number(won.changes)) return null;
  audit(ctx.db, { actor: 'system', action: 'giveaway.draw', subject: String(row.id), data: { eligible: pool.length, winners: winners.length } });
  return { id: row.id, result };
}

function announcement(ctx, g) {
  const r = g.result; const names = r.winners.map((w) => '@' + w.handle).filter((x) => x.length > 1);
  const need = [g.reqs.follow && 'followed us', g.reqs.rt && 'retweeted', g.reqs.comment && 'replied', g.reqs.quote && 'quoted'].filter(Boolean).join(' and ');
  if (!names.length) return 'Giveaway ended. Nobody met the requirements, so there are no winners. Draw record: ' + g.url;
  const head = 'Giveaway winners, picked at random from ' + r.eligible + ' people who ' + need + ': ';
  const tail = '. Likes cannot be checked on X. Draw record: ' + g.url;
  let text = head + names.join(' ') + tail;
  if (text.length > 270) text = 'Giveaway winners: ' + names.join(' ') + '. Draw record: ' + g.url;
  return text.slice(0, 270);
}

async function drawDue(ctx) {
  if (!ctx.cfg.giveaway || !ctx.engagement) return { skipped: true };
  const due = ctx.db.prepare("SELECT * FROM giveaways WHERE status = 'open' AND ends_at <= ? ORDER BY ends_at LIMIT 5").all(nowOf(ctx));
  const out = [];
  for (const row of due) {
    try {
      const d = await draw(ctx, row);
      const g = get(ctx, row.id);
      const { queueReply } = require('./xpay');
      queueReply(ctx, row.command_tweet_id || row.tweet_id, announcement(ctx, g), 'giveaway_draw');
      if (ctx.notify) { try { ctx.notify(row.user_id, { type: 'system', title: 'Your giveaway picked ' + d.result.winners.length + (d.result.winners.length === 1 ? ' winner' : ' winners'), privateTitle: 'Your giveaway has ended', body: row.prize_micro ? 'Pay them in one tap from Giveaways.' : 'See the draw record in Giveaways.', action: { label: 'Open', href: '/app#giveaways' } }); } catch { /* notify is best effort */ } }
      out.push({ id: row.id, status: 'drawn' });
    } catch (e) {
      const attempts = row.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      ctx.db.prepare('UPDATE giveaways SET attempts = ?, status = ?, ends_at = ? WHERE id = ?').run(attempts, failed ? 'failed' : 'open', nowOf(ctx) + attempts * 5 * 60 * 1000, row.id);
      out.push({ id: row.id, status: failed ? 'failed' : 'retry', error: String(e.message || e).slice(0, 80) });
    }
  }
  return { processed: out };
}

function payLines(ctx, { userId, id }) {
  const g = get(ctx, id);
  if (!g || ctx.db.prepare('SELECT user_id FROM giveaways WHERE id = ?').get(Number(id)).user_id !== userId) throw new GiveawayError('not_found', 'That giveaway was not found.', 404);
  if (g.status !== 'drawn' || !g.prizeMicro) throw new GiveawayError('nothing_to_pay', 'This giveaway has no prize to pay.', 409);
  const each = (BigInt(g.prizeMicro) / 1000000n) + (BigInt(g.prizeMicro) % 1000000n ? '.' + String(BigInt(g.prizeMicro) % 1000000n).padStart(6, '0').replace(/0+$/, '') : '');
  return { lines: g.result.winners.filter((w) => w.handle).map((w) => '@' + w.handle + ' ' + each) };
}

function publicView(ctx, id) {
  const r = ctx.db.prepare('SELECT * FROM giveaways WHERE id = ?').get(Number(id));
  if (!r || r.status === 'cancelled') return null;
  const v = rowView(ctx, r);
  const creator = userIdentities(ctx.db, r.user_id).find((i) => i.kind === 'x' && i.label);
  const pool = v.status === 'drawn' ? ctx.db.prepare('SELECT x_id, handle FROM giveaway_pool WHERE giveaway_id = ? ORDER BY x_id LIMIT 5000').all(r.id).map((p) => ({ id: p.x_id, handle: p.handle })) : [];
  return { id: v.id, status: v.status, winners: v.winners, endsAt: v.endsAt, reqs: v.reqs, prizeMicro: v.prizeMicro, drawnAt: v.drawnAt, creator: creator ? creator.label : null, tweetUrl: 'https://x.com/i/status/' + v.tweetId, result: v.result, pool };
}

async function fromMention(ctx, m, parsed, { queueReply, done }) {
  if (!ctx.cfg.giveaway) return done('ignored');
  if (parsed.error) { queueReply(ctx, m.id, parsed.message); return done('rejected', 'giveaway_' + parsed.error); }
  const user = findUserByIdentity(ctx.db, 'x', String(m.authorId));
  if (!user) { queueReply(ctx, m.id, 'Set up DOVI first with this X account, then tag me again: ' + ctx.cfg.publicUrl + '/app'); return done('needs_account'); }
  if (user.frozen_at || user.admin_frozen_at) { queueReply(ctx, m.id, 'Your DOVI account is paused, so I did not start that giveaway.'); return done('rejected', 'account_frozen'); }
  let target = String(m.id);
  if (m.replyToId) {
    let parent = null;
    try { parent = ctx.engagement && ctx.engagement.tweet ? await ctx.engagement.tweet(m.replyToId) : null; } catch { parent = null; }
    if (!parent || String(parent.authorId) !== String(m.authorId)) { queueReply(ctx, m.id, 'I can only run a giveaway on your own post. Tag me under it from your account.'); return done('rejected', 'not_your_post'); }
    target = String(m.replyToId);
  }
  let g;
  try { g = create(ctx, { userId: user.id, tweetId: target, commandTweetId: m.id, parsed }); } catch (e) {
    if (e instanceof GiveawayError) { queueReply(ctx, m.id, e.message); return done('rejected', 'giveaway_' + e.code); }
    throw e;
  }
  const hrs = Math.round(parsed.ms / 360000) / 10;
  const need = [parsed.reqs.rt && 'retweet', parsed.reqs.comment && 'reply to', parsed.reqs.quote && 'quote'].filter(Boolean).join(' and ') + ' this post';
  const needAll = parsed.reqs.follow ? 'follow us and ' + need : need;
  queueReply(ctx, m.id, 'Giveaway started. I will pick ' + parsed.winners + (parsed.winners === 1 ? ' winner' : ' winners') + ' at random in ' + hrs + ' hours from people who ' + needAll + '. Likes cannot be checked on X. Record: ' + g.url);
  return done('giveaway', null);
}

function makeEngagementReader(env = process.env, f = fetch) {
  const key = env.TWITTERAPI_IO_KEY;
  if (!key) return null;
  const get = async (path, params) => {
    const r = await f('https://api.twitterapi.io' + path + '?' + new URLSearchParams(params).toString(), { headers: { 'X-API-Key': key, 'user-agent': 'dovi/1.0' } });
    if (!r.ok) throw new Error(path + ' ' + r.status);
    return r.json();
  };
  const pages = async (path, tweetId, pick, maxPages) => {
    const out = []; let cursor = '';
    for (let i = 0; i < maxPages; i++) {
      const j = await get(path, { tweetId: String(tweetId), cursor });
      out.push(...pick(j));
      if (!(j.has_next_page && j.next_cursor)) break;
      cursor = j.next_cursor;
    }
    return out;
  };
  const user = (u) => (u && u.id ? { id: String(u.id), handle: u.userName || u.screen_name || null } : null);
  return {
    retweeters: (id) => pages('/twitter/tweet/retweeters', id, (j) => (j.users || []).map(user).filter(Boolean), 25),
    replies: (id) => pages('/twitter/tweet/replies', id, (j) => (j.tweets || j.replies || []).map((t) => user(t.author)).filter(Boolean), 60),
    quotes: (id) => pages('/twitter/tweet/quotes', id, (j) => (j.tweets || []).map((t) => user(t.author)).filter(Boolean), 25),
    async follows(userName, target) {
      const j = await get('/twitter/user/check_follow_relationship', { source_user_name: String(userName), target_user_name: String(target) });
      return !!(j && j.data && j.data.following);
    },
    async tweet(id) {
      const j = await get('/twitter/tweets', { tweet_ids: String(id) });
      const t = (j.tweets || [])[0];
      return t ? { id: String(t.id), authorId: String(t.author && t.author.id), authorHandle: t.author && t.author.userName, isReply: !!t.isReply } : null;
    },
  };
}

module.exports = { GiveawayError, parseGiveaway, tweetIdFromUrl, create, get, list, cancel, shuffle, pick, draw, drawDue, announcement, payLines, publicView, fromMention, makeEngagementReader, MAX_WINNERS };
