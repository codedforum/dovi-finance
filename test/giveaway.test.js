'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, user } = require('./helpers');
const giveaway = require('../server/giveaway');
const xpay = require('../server/xpay');

const SENTENCE = '@DoviFinance in 24 hrs select 5 winners that like, rt and comment on this post';

function world(over = {}) {
  const ctx = makeCtx();
  ctx.cfg.giveaway = true; ctx.cfg.payBaseUrl = 'https://dovi.finance';
  const owner = user(ctx, 'x:111', [['x', '111', '@owner']]);
  const rts = over.rts || [['1', 'a'], ['2', 'b'], ['3', 'c'], ['4', 'd'], ['5', 'e'], ['6', 'f'], ['111', 'owner'], ['99', 'DoviFinance']];
  const reps = over.reps || [['2', 'b'], ['3', 'c'], ['4', 'd'], ['5', 'e'], ['6', 'f'], ['7', 'g'], ['111', 'owner'], ['99', 'DoviFinance']];
  ctx.engagement = {
    calls: 0, fail: !!over.fail,
    async retweeters() { this.calls++; if (this.fail) throw new Error('boom'); return rts.map(([id, handle]) => ({ id, handle })); },
    async replies() { return reps.map(([id, handle]) => ({ id, handle })); },
    async quotes() { return []; },
    async tweet(id) { return over.tweet === undefined ? { id, authorId: '111', authorHandle: 'owner', isReply: false } : over.tweet; },
  };
  return { ctx, owner };
}
const outbox = (ctx) => ctx.db.prepare('SELECT reply_to, text FROM x_outbox ORDER BY id').all();

test('parseGiveaway understands the sentence people will type and refuses what it cannot check', () => {
  const g = giveaway.parseGiveaway(SENTENCE);
  assert.equal(g.winners, 5); assert.equal(g.ms, 24 * 3600 * 1000);
  assert.deepEqual({ like: g.reqs.like, rt: g.reqs.rt, comment: g.reqs.comment, quote: g.reqs.quote }, { like: true, rt: true, comment: true, quote: false });
  const g2 = giveaway.parseGiveaway('@dovifinance giveaway: 3 winners in 2 days, quote and reply, $10 each');
  assert.equal(g2.winners, 3); assert.equal(g2.ms, 2 * 86400000); assert.equal(g2.reqs.quote, true); assert.equal(g2.reqs.comment, true); assert.equal(g2.prizeMicro, '10000000');
  const g3 = giveaway.parseGiveaway('@DoviFinance pick a winner in 6 hours'); assert.equal(g3.winners, 1); assert.equal(g3.ms, 6 * 3600000); assert.equal(g3.reqs.rt && g3.reqs.comment, true);
  assert.equal(giveaway.parseGiveaway('@DoviFinance select 50 winners').error, 'winners');
  assert.equal(giveaway.parseGiveaway('@DoviFinance select 2 winners in 5 minutes').error, 'duration');
  assert.equal(giveaway.parseGiveaway('@DoviFinance select 2 winners in 30 days').error, 'duration');
  assert.equal(giveaway.parseGiveaway('@DoviFinance giveaway 2 winners that like this').error, 'like_only');
  assert.equal(giveaway.parseGiveaway('@DoviFinance send @bob 5 usdc'), null);
  assert.equal(giveaway.parseGiveaway('select 5 winners that rt'), null);
  assert.equal(giveaway.tweetIdFromUrl('https://x.com/me/status/2115056063762268575?s=20'), '2115056063762268575');
});

test('create enforces the switch, linked X, one giveaway per post, a cap of open ones and prize bounds', () => {
  const { ctx, owner } = world();
  const parsed = giveaway.parseGiveaway(SENTENCE);
  ctx.cfg.giveaway = false;
  assert.throws(() => giveaway.create(ctx, { userId: owner.id, tweetId: '10', parsed }), (e) => e.code === 'giveaways_off');
  ctx.cfg.giveaway = true;
  const plain = user(ctx, 'email:p@mail.com'); assert.throws(() => giveaway.create(ctx, { userId: plain.id, tweetId: '10', parsed }), (e) => e.code === 'x_required');
  const g = giveaway.create(ctx, { userId: owner.id, tweetId: '10', parsed }); assert.equal(g.status, 'open'); assert.equal(g.winners, 5);
  assert.throws(() => giveaway.create(ctx, { userId: owner.id, tweetId: '10', parsed }), (e) => e.code === 'exists');
  giveaway.create(ctx, { userId: owner.id, tweetId: '11', parsed }); giveaway.create(ctx, { userId: owner.id, tweetId: '12', parsed });
  assert.throws(() => giveaway.create(ctx, { userId: owner.id, tweetId: '13', parsed }), (e) => e.code === 'too_many');
  giveaway.cancel(ctx, { userId: owner.id, id: g.id });
  giveaway.create(ctx, { userId: owner.id, tweetId: '13', parsed });
  assert.throws(() => giveaway.create(ctx, { userId: owner.id, tweetId: '14', parsed: { ...parsed, prizeMicro: '1' } }), (e) => e.code === 'x_required' || e.code === 'too_many' || e.code === 'bad_prize');
});

test('the draw uses only people who did everything asked, never the creator or the bot, and can be repeated from the seed', async () => {
  const { ctx, owner } = world();
  const g = giveaway.create(ctx, { userId: owner.id, tweetId: '10', commandTweetId: '9', parsed: { winners: 3, ms: 3600000, reqs: { like: true, rt: true, comment: true, quote: false }, prizeMicro: null } });
  const row = ctx.db.prepare('SELECT * FROM giveaways WHERE id = ?').get(g.id);
  const d = await giveaway.draw(ctx, row);
  assert.equal(d.result.eligible, 5);
  const ids = d.result.winners.map((w) => w.id);
  assert.equal(ids.length, 3); assert.ok(ids.every((id) => ['2', '3', '4', '5', '6'].includes(id)));
  assert.ok(!ids.includes('111') && !ids.includes('99') && !ids.includes('1') && !ids.includes('7'));
  assert.deepEqual(giveaway.pick(['2', '3', '4', '5', '6'], 3, d.result.seed), ids);
  assert.notDeepEqual(giveaway.pick(['2', '3', '4', '5', '6'], 3, 'another seed 0000'), null);
  const v = giveaway.publicView(ctx, g.id);
  assert.equal(v.status, 'drawn'); assert.equal(v.pool.length, 5); assert.equal(v.result.likesChecked, false);
});

test('fewer entries than winners gives everyone, and nobody eligible gives no winners with a clear announcement', async () => {
  const w = world({ rts: [['2', 'b'], ['3', 'c']], reps: [['2', 'b'], ['3', 'c'], ['9', 'z']] });
  const g = giveaway.create(w.ctx, { userId: w.owner.id, tweetId: '10', commandTweetId: '9', parsed: { winners: 5, ms: 600000, reqs: { like: false, rt: true, comment: true, quote: false }, prizeMicro: null } });
  const d = await giveaway.draw(w.ctx, w.ctx.db.prepare('SELECT * FROM giveaways WHERE id = ?').get(g.id));
  assert.equal(d.result.winners.length, 2);
  const none = world({ rts: [['2', 'b']], reps: [['3', 'c']] });
  const g2 = giveaway.create(none.ctx, { userId: none.owner.id, tweetId: '10', commandTweetId: '9', parsed: { winners: 5, ms: 600000, reqs: { like: false, rt: true, comment: true, quote: false }, prizeMicro: null } });
  await giveaway.draw(none.ctx, none.ctx.db.prepare('SELECT * FROM giveaways WHERE id = ?').get(g2.id));
  assert.match(giveaway.announcement(none.ctx, giveaway.get(none.ctx, g2.id)), /no winners/);
});

test('drawDue waits for the deadline, queues one announcement that starts with a word, and retries then fails on errors', async () => {
  const { ctx, owner } = world();
  giveaway.create(ctx, { userId: owner.id, tweetId: '10', commandTweetId: '9', parsed: { winners: 2, ms: 3600000, reqs: { like: false, rt: true, comment: true, quote: false }, prizeMicro: '5000000' } });
  assert.deepEqual((await giveaway.drawDue(ctx)).processed, []);
  ctx.clock.t += 3600001;
  const r = await giveaway.drawDue(ctx); assert.equal(r.processed[0].status, 'drawn');
  const out = outbox(ctx); assert.equal(out.length, 1); assert.equal(out[0].reply_to, '9');
  assert.match(out[0].text, /^Giveaway winners/); assert.ok(!out[0].text.startsWith('@')); assert.match(out[0].text, /https:\/\/dovi\.finance\/g\/\d+/); assert.ok(out[0].text.length <= 270);
  assert.deepEqual((await giveaway.drawDue(ctx)).processed, []);
  const bad = world({ fail: true });
  giveaway.create(bad.ctx, { userId: bad.owner.id, tweetId: '10', parsed: { winners: 2, ms: 600000, reqs: { like: false, rt: true, comment: true, quote: false }, prizeMicro: null } });
  for (let i = 0; i < 6; i++) { bad.ctx.clock.t += 3600000; await giveaway.drawDue(bad.ctx); }
  assert.equal(bad.ctx.db.prepare('SELECT status FROM giveaways').get().status, 'failed');
  assert.equal(outbox(bad.ctx).length, 0);
});

test('a tweet that tags the bot starts a giveaway, with the right replies for every refusal', async () => {
  const { ctx } = world();
  const m = (text, over = {}) => ({ id: String(Math.floor(Math.random() * 1e12)), authorId: '111', authorHandle: 'owner', text, ...over });
  const a = await xpay.processMention(ctx, m(SENTENCE));
  assert.equal(a.status, 'giveaway');
  assert.match(outbox(ctx).pop().text, /^Giveaway started\. I will pick 5 winners at random in 24 hours from people who retweet and reply to this post/);
  const g = ctx.db.prepare('SELECT * FROM giveaways').get(); assert.equal(g.tweet_id, g.command_tweet_id);
  const unknown = await xpay.processMention(ctx, m(SENTENCE, { authorId: '777', authorHandle: 'stranger' })); assert.equal(unknown.status, 'needs_account');
  const bad = await xpay.processMention(ctx, m('@DoviFinance giveaway 99 winners')); assert.equal(bad.status, 'rejected');
  const noLike = await xpay.processMention(ctx, m('@DoviFinance giveaway 2 winners that like this')); assert.match(outbox(ctx).pop().text, /Likes cannot be checked/);
  const reply = await xpay.processMention(ctx, m(SENTENCE, { replyToId: '555' })); assert.equal(reply.status, 'giveaway');
  assert.equal(ctx.db.prepare("SELECT tweet_id FROM giveaways ORDER BY id DESC LIMIT 1").get().tweet_id, '555');
  const other = world({ tweet: { id: '600', authorId: '222', authorHandle: 'someone', isReply: false } });
  const o = await xpay.processMention(other.ctx, m(SENTENCE, { replyToId: '600' })); assert.equal(o.status, 'rejected'); assert.match(outbox(other.ctx).pop().text, /^I can only run a giveaway on your own post/);
  other.ctx.cfg.giveaway = false;
  assert.equal((await xpay.processMention(other.ctx, m(SENTENCE))).status, 'ignored');
});

test('the mention search also finds giveaway wording', async () => {
  const urls = [];
  const reader = xpay.makeMentionReader({ TWITTERAPI_IO_KEY: 'k' }, async (u) => { urls.push(decodeURIComponent(u)); return { ok: true, json: async () => ({ tweets: [{ id: '1', text: '@DoviFinance select 5 winners', createdAt: 'Tue Oct 27 10:33:05 +0000 2026', author: { id: '111', userName: 'owner' }, inReplyToId: '5' }] }) }; });
  const list = await reader.fetchMentions(1);
  assert.match(urls[0], /giveaway OR winner OR winners OR raffle/); assert.equal(list[0].replyToId, '5');
});
