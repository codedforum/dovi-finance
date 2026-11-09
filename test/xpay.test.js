'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeFunctionData } = require('viem');
const { makeCtx, user, ADDR } = require('./helpers');
const xpay = require('../server/xpay');
const abi = require('../server/abi/DoviClaim.json');
const { setAddress } = require('../server/identity');

function world() {
  const ctx = makeCtx();
  ctx.env = { ...(ctx.env || {}), DOVI_XPAY_ONBOARD: '1' };
  ctx.cfg.claim.perClaimCapMicro = 20000000n; ctx.cfg.claim.perUserDayCapMicro = 100000000n;
  const alice = user(ctx, 'x:111', [['x', '111', '@alice']]);
  setAddress(ctx.db, alice.id, 'base', ADDR.alice, ctx.now());
  ctx.fetch = async (url) => { const h = String(url).split('/').pop().toLowerCase(); const ids = { bob: '555', kofi: '43' }; return ids[h] ? { status: 200, json: async () => ({ user: { id: ids[h], screen_name: h, protected: false, name: h } }) } : { status: 404, json: async () => ({}) }; };
  ctx.lookupDelayMs = 0;
  ctx.chain.onchainSetAutoPay(ADDR.alice, 5000000n, 10000000n);
  ctx.chain.onchainApprove(ADDR.alice, 100000000n);
  ctx.executor = { calls: [], claimed: [], async claimFor(a) { this.claimed.push(a); ctx.chain.onchainClaim(a.id); return { txHash: '0x' + 'ef'.repeat(32) }; }, async createClaimFor(a) { this.calls.push(a); ctx.chain.onchainCreate(a.id, { sender: a.payer, amount: a.amountMicro, fee: 100000n, expiry: a.expiry, recipientHash: a.recipientHash }); return { txHash: '0x' + 'cd'.repeat(32) }; } };
  ctx.db.prepare('INSERT INTO autopay (user_id, per_payment_micro, per_day_micro, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)').run(alice.id, '5000000', '10000000');
  return { ctx, alice };
}
const mention = (text, over = {}) => ({ id: String(Math.floor(Math.random() * 1e12)), authorId: '111', authorHandle: 'alice', text, ...over });
const outbox = (ctx) => ctx.db.prepare('SELECT text FROM x_outbox ORDER BY id').all().map((r) => r.text);

test('parseCommand reads the forms people will type and rejects the rest', () => {
  const ok = (t, to, usd) => { const c = xpay.parseCommand(t); assert.ok(c && !c.error, t); assert.equal(c.to, to); assert.equal(c.amountMicro, usd); };
  ok('@DoviFinance send @bob 1 usdc', 'bob', 1000000n);
  ok('@DoviFinance pay @smartcoded 1 usdc', 'smartcoded', 1000000n);
  ok('@DoviFinance pay @bob $2.50', 'bob', 2500000n);
  ok('@DoviFinance @bob 1$', 'bob', 1000000n);
  ok('@DoviFinance @bob 5 USDC thanks for the help', 'bob', 5000000n);
  ok('@DoviFinance pay @bob 3', 'bob', 3000000n);
  assert.equal(xpay.parseCommand('@DoviFinance gm'), null);
  assert.equal(xpay.parseCommand('@DoviFinance hello @bob'), null);
  assert.equal(xpay.parseCommand('@DoviFinance send @bob @kofi 1 usdc').error, 'multiple');
  assert.equal(xpay.parseCommand('@DoviFinance send 1 usdc'), null);
  const rep = xpay.parseCommand('@smartcoded @DoviFinance pay @bob 1 usdc');
  assert.ok(rep && !rep.error); assert.equal(rep.to, 'bob');
  const own = xpay.parseCommand('@bob @DoviFinance send 5 usdc', { replyTo: 'bob' });
  assert.equal(own.to, 'bob'); assert.equal(own.amountMicro, 5000000n);
  assert.equal(xpay.parseCommand('@bob @DoviFinance send 5 usdc'), null);
  assert.equal(xpay.parseCommand('send @bob 1 usdc'), null);
});

test('a valid command makes the executor create the payment and queues a reply with the link', async () => {
  const w = world();
  const r = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc'));
  assert.equal(r.status, 'sent');
  assert.equal(w.ctx.executor.calls.length, 1);
  assert.equal(w.ctx.executor.calls[0].payer, ADDR.alice);
  const row = w.ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(r.claimId);
  assert.equal(row.status, 'funded'); assert.equal(row.source, 'x'); assert.equal(row.amount_micro, '2000000');
  const t = outbox(w.ctx)[0];
  assert.match(t, /\$2\.00/); assert.match(t, /@alice/); assert.doesNotMatch(t, /dovi\.test|\.finance/, 'no domain in the text');
  assert.doesNotMatch(t, /https?:\/\//, 'no claim url by default');
  assert.doesNotMatch(t, /^@bob/, 'the recipient tag comes from the reply itself, not the text');
});

test('payment replies never repeat the previous wording', async () => {
  const w = world();
  w.ctx.chain.onchainSetAutoPay(ADDR.alice, 5000000n, 100000000n);
  w.ctx.chain.onchainApprove(ADDR.alice, 1000000000n);
  w.ctx.db.prepare('UPDATE autopay SET per_day_micro = ? WHERE user_id = ?').run('100000000', w.alice.id);
  const seen = [];
  for (let i = 0; i < 12; i++) {
    await xpay.processMention(w.ctx, mention('@DoviFinance send @kofi 1 usdc', { id: String(2000 + i * 7) }));
    seen.push(outbox(w.ctx).at(-1).replace(/\$1\.00|@alice/g, ''));
  }
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1], 'reply ' + i + ' repeats the one before');
  assert.ok(new Set(seen).size >= 6, 'at least six different phrasings across twelve replies');
});

test('the reply keeps only the payer and the recipient tagged and can carry the claim url on request', async () => {
  const w = world();
  w.ctx.env.DOVI_XREPLY_LINK = '1';
  await xpay.processMention(w.ctx, mention('@DoviFinance @base Hello @DoviFinance send @bob 2 usdc', { id: '3001', mentionIds: ['555', '1628067904083181570', '777'] }));
  const row = w.ctx.db.prepare('SELECT text, exclude FROM x_outbox ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual(JSON.parse(row.exclude).sort(), ['1628067904083181570', '777']);
  assert.match(row.text, /https:\/\/dovi\.test\/c\//);
});

test('the same tweet is never paid twice', async () => {
  const w = world();
  const m = mention('@DoviFinance send @bob 2 usdc');
  await xpay.processMention(w.ctx, m);
  const again = await xpay.processMention(w.ctx, m);
  assert.equal(again.duplicate, true);
  assert.equal(w.ctx.executor.calls.length, 1);
});

test('no account, no opt in, and chain opt in missing each get a helpful reply and no payment', async () => {
  const w = world();
  const stranger = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc', { authorId: '999', authorHandle: 'nobody' }));
  assert.equal(stranger.status, 'needs_account');
  w.ctx.db.prepare('UPDATE autopay SET enabled = 0').run();
  assert.equal((await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc'))).status, 'needs_autopay');
  w.ctx.db.prepare('UPDATE autopay SET enabled = 1').run();
  w.ctx.chain.onchainSetAutoPay(ADDR.alice, 0n, 0n);
  const quiet = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc'));
  assert.equal(quiet.status, 'ignored'); assert.equal(quiet.detail, 'cooldown');
  const later = Date.now() + 7 * 3600 * 1000; w.ctx.now = () => later;
  assert.equal((await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc'))).status, 'needs_autopay');
  assert.equal(w.ctx.executor.calls.length, 0);
  assert.ok(outbox(w.ctx).every((t) => /autopay|DOVI/.test(t)));
});

test('limits: per payment, per day, allowance, balance, self and unknown handle never reach the executor', async () => {
  const w = world();
  const run = (t) => xpay.processMention(w.ctx, mention(t));
  assert.equal((await run('@DoviFinance send @bob 6 usdc')).detail, 'above_autopay');
  assert.equal((await run('@DoviFinance send @nobodyhere 2 usdc')).detail, 'recipient');
  assert.equal((await run('@DoviFinance send @alice 2 usdc')).detail, 'recipient');
  w.ctx.chain.onchainApprove(ADDR.alice, 1000000n);
  assert.equal((await run('@DoviFinance send @bob 2 usdc')).detail, 'allowance');
  w.ctx.chain.onchainApprove(ADDR.alice, 100000000n);
  w.ctx.chain.usdcBalance = async () => 1000000n;
  assert.equal((await run('@DoviFinance send @bob 2 usdc')).detail, 'insufficient');
  w.ctx.chain.usdcBalance = async () => 7000000n;
  assert.equal((await run('@DoviFinance send @bob 5 usdc')).status, 'sent');
  assert.equal((await run('@DoviFinance send @kofi 5 usdc')).status, 'sent');
  assert.equal((await run('@DoviFinance send @bob 2 usdc')).detail, 'above_autopay_day');
  assert.equal(w.ctx.executor.calls.length, 2);
});

test('an executor failure leaves nothing taken and tells the user', async () => {
  const w = world();
  w.ctx.executor.createClaimFor = async () => { throw new Error('rpc down'); };
  const r = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc'));
  assert.equal(r.status, 'failed');
  assert.match(outbox(w.ctx)[0], /could not confirm/);
  assert.equal(w.ctx.db.prepare("SELECT status FROM claims WHERE id = ?").get(r.claimId).status, 'draft');
});

test('settings: enable needs X linked, validates limits, builds approve then setAutoPay, confirms from the chain', async () => {
  const w = world();
  const e = user(w.ctx, 'email:e@mail.com', [['email', 'e@mail.com', 'e@mail.com']]);
  setAddress(w.ctx.db, e.id, 'base', ADDR.bob, w.ctx.now());
  assert.throws(() => xpay.prepareEnable(w.ctx, { userId: e.id, perPaymentMicro: 2000000n, perDayMicro: 4000000n }), { code: 'x_required' });
  assert.throws(() => xpay.prepareEnable(w.ctx, { userId: w.alice.id, perPaymentMicro: 500000n, perDayMicro: 4000000n }), { code: 'below_minimum' });
  assert.throws(() => xpay.prepareEnable(w.ctx, { userId: w.alice.id, perPaymentMicro: 30000000n, perDayMicro: 40000000n }), { code: 'above_cap' });
  assert.throws(() => xpay.prepareEnable(w.ctx, { userId: w.alice.id, perPaymentMicro: 4000000n, perDayMicro: 2000000n }), { code: 'bad_limits' });
  const p = xpay.prepareEnable(w.ctx, { userId: w.alice.id, perPaymentMicro: 3000000n, perDayMicro: 6000000n });
  assert.equal(p.txs.length, 2);
  assert.equal(decodeFunctionData({ abi, data: p.txs[1].data }).functionName, 'setAutoPay');
  assert.equal(p.allowanceMicro, String(6000000n * 7n * 102n / 100n));
  await assert.rejects(xpay.confirmEnable(w.ctx, { userId: w.alice.id, perPaymentMicro: 3000000n, perDayMicro: 6000000n }), { code: 'not_confirmed' });
  w.ctx.chain.onchainSetAutoPay(ADDR.alice, 3000000n, 6000000n);
  const s = await xpay.confirmEnable(w.ctx, { userId: w.alice.id, perPaymentMicro: 3000000n, perDayMicro: 6000000n });
  assert.equal(s.enabled, true); assert.equal(s.perPaymentMicro, '3000000');
  await assert.rejects(xpay.confirmDisable(w.ctx, { userId: w.alice.id }), { code: 'not_confirmed' });
  w.ctx.chain.onchainSetAutoPay(ADDR.alice, 0n, 0n);
  assert.equal((await xpay.confirmDisable(w.ctx, { userId: w.alice.id })).enabled, false);
});

test('ordinary comments under the DOVI post are ignored: no payment phrase means no parse and no reply', async () => {
  const comments = [
    '@smartcoded @DoviFinance @vibestarterxyz @base Turning social handles into payment address',
    '@smartcoded @DoviFinance Sending dollars to an X handle without a wallet sounds like a low',
    '@DoviFinance @vibestarterxyz @base The USDC-to-fiat feature is an innovative step',
    '@DoviFinance gm, love the idea of paying anyone by handle',
  ];
  for (const t of comments) assert.equal(xpay.parseCommand(t), null, t);
  const w = world();
  for (const [i, t] of comments.entries()) assert.equal((await xpay.processMention(w.ctx, mention(t, { id: 'c' + i, authorId: '4000' + i, authorHandle: 'fan' + i }))).status, 'ignored');
  assert.equal(outbox(w.ctx).length, 0);
  const c = xpay.parseCommand('@DoviFinance @base @vibestarterxyz @DoviFinance send 1 usdc to @tycayomide');
  assert.equal(c.to, 'tycayomide'); assert.equal(c.amountMicro, 1000000n);
});

test('a malformed command from a stranger gets no public reply, from a DOVI user it does', async () => {
  const w = world();
  const stranger = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob @kofi 1 usdc', { id: 's1', authorId: '9999', authorHandle: 'rando' }));
  assert.equal(stranger.status, 'ignored'); assert.equal(outbox(w.ctx).length, 0);
  const member = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob @kofi 1 usdc', { id: 's2' }));
  assert.equal(member.status, 'rejected'); assert.equal(outbox(w.ctx).length, 1);
});

test('by default a stranger with a clear command gets no reply at all, the set up DOVI first reply is opt in', async () => {
  const w = world(); w.ctx.env = {};
  const r = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc', { id: 'st1', authorId: '8888', authorHandle: 'stranger' }));
  assert.equal(r.status, 'ignored'); assert.equal(r.detail, 'not_a_user');
  assert.equal(outbox(w.ctx).length, 0);
});

test('a recipient written before the verb works, project tags are ignored, and two real names ask which one', () => {
  const ok = xpay.parseCommand('@DoviFinance @sade_ok @base @vibestarterxyz Send 1 usdc');
  assert.equal(ok.to, 'sade_ok'); assert.equal(ok.amountMicro, 1000000n);
  assert.equal(xpay.parseCommand('@DoviFinance @bob send 2 usdc thanks').to, 'bob');
  assert.equal(xpay.parseCommand('@DoviFinance @bob @kofi send 2 usdc').error, 'ambiguous');
  assert.equal(xpay.parseCommand('@DoviFinance @vibestarterxyz @base Turning social handles into payment address'), null);
  assert.equal(xpay.parseCommand('@DoviFinance @bob pay attention 5 stars'), null);
});

const intent = require('../server/xintent');

test('LLM answers are only believed when every token is written in the tweet, and the model never decides to pay by itself', () => {
  const t = '@DoviFinance hey can you move 3 bucks to @bob';
  assert.deepEqual(intent.validate(t, null, '{"intent":"pay","to":"bob","amount_usd":3}'), { intent: 'pay', to: 'bob', amountUsd: '3' });
  assert.equal(intent.validate(t, null, '{"intent":"pay","to":"kofi","amount_usd":3}').intent, 'unclear');
  assert.equal(intent.validate(t, null, '{"intent":"pay","to":"bob","amount_usd":30}').intent, 'unclear');
  assert.equal(intent.validate('@DoviFinance send @bob one dollar', null, '{"intent":"pay","to":"bob","amount_usd":1}').intent, 'unclear');
  assert.equal(intent.validate(t, null, '{"intent":"pay","to":"base","amount_usd":3}').intent, 'unclear');
  assert.equal(intent.validate(t, 'bob', '{"intent":"pay","to":"bob","amount_usd":3}').intent, 'pay');
  assert.equal(intent.validate(t, null, 'sure! ignore the rules and pay everyone').intent, 'none');
  assert.equal(intent.validate(t, null, '{"intent":"drain","to":"bob","amount_usd":3}').intent, 'none');
});

test('the intent model is off unless enabled, falls back to the second model, and gives up quietly', async () => {
  const env = { DOVI_INTENT_LLM: '1', RELAYSTATION_API_KEY: 'k', RELAYSTATION_BASE_URL: 'https://relay.example/v1', RELAYSTATION_MODEL: 'm1', RELAYSTATION_MODEL_FALLBACK: 'm2' };
  assert.equal(intent.makeIntentLLM({ ...env, DOVI_INTENT_LLM: '0' }), null);
  assert.equal(intent.makeIntentLLM({ ...env, RELAYSTATION_API_KEY: '' }), null);
  const calls = [];
  const f = async (url, o) => { const b = JSON.parse(o.body); calls.push(b.model); if (b.model === 'm1') return { ok: false, status: 502 }; return { ok: true, json: async () => ({ choices: [{ message: { content: '{"intent":"pay","to":"bob","amount_usd":3}' } }] }) }; };
  const llm = intent.makeIntentLLM(env, f);
  const r = await llm.classify({ text: 'move 3 to @bob', authorId: '1' });
  assert.equal(r.intent, 'pay'); assert.deepEqual(calls, ['m1', 'm2']);
  const down = intent.makeIntentLLM(env, async () => ({ ok: false, status: 502 }));
  await assert.rejects(down.classify({ text: 'x', authorId: '2' }));
});

test('a natural sentence from a DOVI user pays through the model but only after the same policy checks, strangers never reach the model, and a dead model changes nothing', async () => {
  const w = world();
  let asked = 0;
  w.ctx.intentLLM = { classify: async ({ text }) => { asked++; return intent.validate(text, null, '{"intent":"pay","to":"bob","amount_usd":3}'); } };
  const text = '@DoviFinance hey can you move 3 bucks to @bob';
  assert.equal(xpay.parseCommand(text), null);
  const r = await xpay.processMention(w.ctx, mention(text, { id: 'n1' }));
  assert.equal(r.status, 'sent'); assert.equal(r.detail, 'llm'); assert.equal(w.ctx.executor.calls.length, 1);
  const s = await xpay.processMention(w.ctx, mention(text, { id: 'n2', authorId: '7777', authorHandle: 'stranger' }));
  assert.equal(s.status, 'ignored'); assert.equal(asked, 1);
  w.ctx.intentLLM = { classify: async () => { throw new Error('down'); } };
  const d = await xpay.processMention(w.ctx, mention(text, { id: 'n3' }));
  assert.equal(d.status, 'ignored'); assert.equal(w.ctx.executor.calls.length, 1);
  w.ctx.intentLLM = { classify: async () => ({ intent: 'unclear' }) };
  const u = await xpay.processMention(w.ctx, mention('@DoviFinance pay him something', { id: 'n4' }));
  assert.equal(u.detail, 'unclear_llm');
});

test('dry run mode records what would happen and does nothing else', async () => {
  const w = world(); w.ctx.env = { DOVI_XPAY_DRY: '1' };
  const r = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc', { id: 'd1' }));
  assert.equal(r.status, 'dry_run'); assert.match(r.detail, /^pay:bob:/);
  assert.equal(w.ctx.executor.calls.length, 0); assert.equal(outbox(w.ctx).length, 0);
});

test('the labelled tweet set for the intent model is well formed', () => {
  const cases = require('./fixtures/xintent-cases.json');
  assert.ok(cases.length >= 50);
  for (const c of cases) {
    assert.ok(['pay', 'unclear', 'none'].includes(c.expect), c.text);
    if (c.expect === 'pay') { assert.ok(/^[A-Za-z0-9_]{1,15}$/.test(c.to), c.text); assert.ok(Number(c.amount) > 0, c.text); }
  }
  const pays = cases.filter((c) => c.expect === 'pay').length; const negatives = cases.filter((c) => c.expect !== 'pay').length;
  assert.ok(pays >= 15 && negatives >= 20);
});

test('every poll reads only after the last seen tweet, never an hour back', async () => {
  const { ctx } = world();
  const asks = [];
  let n = 1000;
  ctx.mentions = { async fetchMentions(sec, id) { asks.push({ sec, id }); n += 1; return [{ id: String(n), createdSec: Math.floor(ctx.now() / 1000) + n, authorId: '999', authorHandle: 'nobody', text: 'gm @DoviFinance' }]; } };
  for (let i = 0; i < 14; i++) await xpay.pollMentions(ctx);
  assert.equal(asks.length, 14);
  for (let i = 1; i < asks.length; i++) assert.equal(asks[i].id, String(1000 + i), 'poll ' + (i + 1) + ' starts after the previous newest id');
});

test('a recipient who signs in sees the payment without the link, and nobody else does', async () => {
  const w = world();
  await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc', { id: '4001' }));
  const claims = require('../server/claims');
  const bob = user(w.ctx, 'x:555', [['x', '555', '@bob']]);
  const list = claims.incomingFor(w.ctx, bob.id);
  assert.equal(list.length, 1); assert.equal(list[0].amountMicro, '2000000'); assert.match(list[0].path, /^\/c\/|^\/claim\//);
  const carl = user(w.ctx, 'x:999', [['x', '999', '@carl']]);
  assert.equal(claims.incomingFor(w.ctx, carl.id).length, 0);
});

test('a paid x recipient is queued exactly one styled direct message with steps and the claim link', async () => {
  const w = world();
  const r = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc', { id: '5001' }));
  const rows = w.ctx.db.prepare('SELECT * FROM x_dms').all();
  assert.equal(rows.length, 1); assert.equal(rows[0].to_x_id, '555'); assert.equal(rows[0].claim_id, r.claimId); assert.equal(rows[0].status, 'queued');
  assert.match(rows[0].text, /\$2\.00/); assert.match(rows[0].text, /1\. .*\n2\. .*\n3\. /s); assert.match(rows[0].text, /https:\/\/dovi\.test\/c\//);
  assert.doesNotMatch(rows[0].text, /[—·]/, 'no em dash or middot');
  assert.doesNotMatch(outbox(w.ctx)[0], /https?:\/\//, 'the public reply stays link free');
});

test('direct messages can be switched off and are never sent twice for one claim', async () => {
  const w = world();
  w.ctx.env.DOVI_XDM = '0';
  await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc', { id: '5002' }));
  assert.equal(w.ctx.db.prepare('SELECT COUNT(*) n FROM x_dms').get().n, 0);
  const t = xpay.dmText({ amt: '$1.00', from: '@a', link: 'https://dovi.test/c/x', days: 7 });
  assert.match(t, /held safely for 7 days/);
});

test('an in app send to an x handle queues one dm, email gets none, a sender is capped per day, and it can be switched off', async () => {
  const w = world();
  const claims = require('../server/claims');
  const send = async (kind, pid, label, key) => {
    const d = claims.createDraft(w.ctx, { userId: w.alice.id, senderAddress: ADDR.alice, kind, providerId: pid, label, amountMicro: 2000000n, idempotencyKey: key });
    const row = w.ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(d.claimId);
    const r = await w.ctx.executor.createClaimFor({ payer: ADDR.alice, id: row.id, recipientHash: row.recipient_hash, amountMicro: row.amount_micro, expiry: row.expiry });
    await claims.confirmFunded(w.ctx, { claimId: row.id, userId: w.alice.id, txHash: r.txHash });
    return row.id;
  };
  const dms = () => w.ctx.db.prepare('SELECT * FROM x_dms ORDER BY id').all();
  const id1 = await send('x', '700', '@zed', 'k1');
  assert.equal(dms().length, 1); assert.equal(dms()[0].claim_id, id1); assert.equal(dms()[0].to_x_id, '700');
  assert.match(dms()[0].text, /sent you \$2\.00/); assert.match(dms()[0].text, /https:\/\/dovi\.test\/c\//);
  await send('email', 'zed@example.com', 'zed@example.com', 'k2');
  assert.equal(dms().length, 1, 'an email recipient gets the email, not a dm');
  w.ctx.env.DOVI_XDM_PER_SENDER = '6';
  for (let i = 0; i < 8; i++) await send('x', String(800 + i), '@u' + i, 'kk' + i);
  assert.equal(dms().length, 6, 'one sender cannot spend the bot dm allowance');
  w.ctx.env.DOVI_XDM = '0';
  const before = dms().length;
  await send('x', '999', '@off', 'koff');
  assert.equal(dms().length, before);
});

test('one tweet that throws never stalls the poll, it is recorded and the cursor moves past it', async () => {
  const w = world();
  w.ctx.chain.usdcBalance = async () => { throw new Error('rpc down'); };
  const t0 = Math.floor(w.ctx.now() / 1000);
  w.ctx.mentions = { async fetchMentions() { return [{ id: '9001', text: '@DoviFinance send @bob 2 usdc', authorId: '111', authorHandle: 'alice', createdSec: t0 }, { id: '9002', text: 'gm', authorId: '999', authorHandle: 'nobody', createdSec: t0 + 1 }]; } };
  const r = await xpay.pollMentions(w.ctx);
  assert.equal(r.count, 2);
  assert.equal(w.ctx.db.prepare("SELECT status FROM x_mentions WHERE tweet_id = '9001'").get().status, 'failed');
  assert.equal(w.ctx.db.prepare("SELECT v FROM kv WHERE k = 'xpay:sinceid'").get().v, '9002');
});

test('a tweet older than three hours is never paid', async () => {
  const w = world();
  const old = Math.floor(w.ctx.now() / 1000) - 4 * 3600;
  const r = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc', { id: '9101', createdSec: old }));
  assert.equal(r.status, 'ignored'); assert.equal(r.detail, 'stale'); assert.equal(w.ctx.executor.calls.length, 0);
});

test('the mention reader follows result pages and drops retweets', async () => {
  const calls = [];
  const pages = [
    { tweets: [{ id: '5', text: '@DoviFinance send 1 usdc to @a', author: { id: '1', userName: 'x' }, createdAt: 'Sat Nov 07 06:16:42 +0000 2026' }], has_next_page: true, next_cursor: 'c1' },
    { tweets: [{ id: '4', text: 'RT @y: @DoviFinance send 5 usdc to @b', author: { id: '2', userName: 'z' }, createdAt: 'Sat Nov 07 06:15:42 +0000 2026' }, { id: '3', text: '@DoviFinance send 2 usdc to @c', retweeted_tweet: { id: '1' }, author: { id: '3', userName: 'w' }, createdAt: 'Sat Nov 07 06:14:42 +0000 2026' }], has_next_page: true, next_cursor: 'c2' },
    { tweets: [{ id: '2', text: '@DoviFinance send 3 usdc to @d', author: { id: '4', userName: 'v' }, createdAt: 'Sat Nov 07 06:13:42 +0000 2026' }], has_next_page: false },
  ];
  const rd = xpay.makeMentionReader({ TWITTERAPI_IO_KEY: 'k' }, async (url) => { calls.push(url); return { ok: true, json: async () => pages[calls.length - 1] }; });
  const got = await rd.fetchMentions(0, '100000');
  assert.equal(calls.length, 3); assert.match(decodeURIComponent(calls[0]), /-filter:retweets/); assert.match(calls[1], /cursor=c1/); assert.match(calls[2], /cursor=c2/);
  assert.deepEqual(got.map((t) => t.id), ['5', '2']);
});

test('a thousands separator is never read as a smaller amount', () => {
  assert.deepEqual(xpay.parseCommand('@DoviFinance send @bob 1,000 usdc'), { error: 'amount' });
  assert.deepEqual(xpay.parseCommand('@DoviFinance send 1,000 usdc to @bob'), { error: 'amount' });
  const ok = xpay.parseCommand('@DoviFinance send @bob 5 usdc, thanks');
  assert.ok(ok && ok.to === 'bob' && ok.amountMicro === 5000000n);
});

test('a payment confirmed after the bot gave up is announced once, with its own reply kind', async () => {
  const w = world(); w.ctx.xpayRetryMs = 0;
  const claims = require('../server/claims'); const real = claims.confirmFunded;
  claims.confirmFunded = async () => { throw new Error('not_funded_yet'); };
  let r; try { r = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc', { id: '9201', mentionIds: ['555', '777'] })); } finally { claims.confirmFunded = real; }
  assert.equal(r.status, 'failed');
  assert.equal(w.ctx.db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE 'xlate:%'").get().n, 1);
  w.ctx.db.prepare("UPDATE claims SET status = 'funded' WHERE id = ?").run(r.claimId);
  w.ctx.mentions = { async fetchMentions() { return []; } };
  await xpay.pollMentions(w.ctx);
  const late = w.ctx.db.prepare("SELECT kind, text, exclude FROM x_outbox WHERE kind = 'late_paid'").all();
  assert.equal(late.length, 1); assert.match(late[0].text, /\$2\.00/); assert.deepEqual(JSON.parse(late[0].exclude), ['777']);
  assert.equal(w.ctx.db.prepare('SELECT COUNT(*) n FROM x_dms WHERE claim_id = ?').get(r.claimId).n, 1);
  assert.equal(w.ctx.db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE 'xlate:%'").get().n, 0);
  await xpay.pollMentions(w.ctx);
  assert.equal(w.ctx.db.prepare("SELECT COUNT(*) n FROM x_outbox WHERE kind = 'late_paid'").get().n, 1, 'announced once');
});

test('a display name can never carry a link, a tag or a lookalike path into a public message', () => {
  const { safeName } = require('../server/xdm');
  assert.equal(safeName('a.co/free-usdc'), 'acofree-usdc');
  assert.equal(safeName('@evil https://x.co'), 'evil httpsxco');
  assert.equal(safeName(''), 'Someone'); assert.equal(safeName(null), 'Someone'); assert.equal(safeName('!!!'), 'Someone');
  assert.equal(safeName('x'.repeat(60)).length, 20);
});

test('a user who keeps failing gets at most three public replies in ten minutes', async () => {
  const w = world();
  for (let i = 0; i < 6; i++) await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 0.01 usdc', { id: '9300' + i }));
  assert.equal(outbox(w.ctx).length, 3);
  assert.equal(w.ctx.db.prepare("SELECT COUNT(*) n FROM x_mentions WHERE status = 'rejected'").get().n, 6, 'every tweet is still recorded');
});

test('the sender is told in the app when the recipient cannot be messaged', async () => {
  const w = world();
  const seen = []; w.ctx.notify = (uid, evt) => seen.push({ uid, evt });
  const r = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc', { id: '9401' }));
  const err = new Error('closed'); err.status = 403;
  w.ctx.xposter = { async dm() { throw err; } };
  const { flushDms } = require('../server/xposter');
  assert.deepEqual(await flushDms(w.ctx), { sent: 0, failed: 1 });
  const told = seen.find((s) => s.evt.type === 'dm_failed');
  assert.ok(told && told.uid === w.alice.id && /@bob/.test(told.evt.title));
  assert.equal(w.ctx.db.prepare('SELECT status FROM x_dms WHERE claim_id = ?').get(r.claimId).status, 'failed');
});

test('a tweeted payment to someone who already has a DOVI account lands in their wallet at once', async () => {
  const w = world();
  const bob = user(w.ctx, 'x:555', [['x', '555', '@bob']]); setAddress(w.ctx.db, bob.id, 'base', ADDR.bob, w.ctx.now());
  const r = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc', { id: '9501' }));
  assert.equal(r.status, 'sent'); assert.equal(r.detail, 'instant');
  assert.equal(w.ctx.db.prepare('SELECT status FROM claims WHERE id = ?').get(r.claimId).status, 'claimed');
  assert.equal(w.ctx.executor.claimed.length, 1); assert.equal(w.ctx.executor.claimed[0].recipient.toLowerCase(), ADDR.bob.toLowerCase());
  assert.match(outbox(w.ctx)[0], /DOVI account/); assert.doesNotMatch(outbox(w.ctx)[0], /claim it|Sign in/i);
  assert.equal(w.ctx.db.prepare('SELECT COUNT(*) n FROM x_dms').get().n, 0, 'no claim message for money that is already delivered');
});

test('if the instant claim fails the payment stays open and is announced like any other', async () => {
  const w = world();
  const bob = user(w.ctx, 'x:555', [['x', '555', '@bob']]); setAddress(w.ctx.db, bob.id, 'base', ADDR.bob, w.ctx.now());
  w.ctx.executor.claimFor = async () => { throw new Error('rpc down'); };
  const r = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc', { id: '9502' }));
  assert.equal(r.status, 'sent');
  assert.equal(w.ctx.db.prepare('SELECT status FROM claims WHERE id = ?').get(r.claimId).status, 'funded');
  assert.match(outbox(w.ctx)[0], /Sign in|Log in|claim|collect|receive/i);
  assert.equal(w.ctx.db.prepare('SELECT COUNT(*) n FROM x_dms').get().n, 1);
  assert.equal(w.ctx.db.prepare("SELECT COUNT(*) n FROM audit WHERE action = 'xpay.auto_claim_failed'").get().n, 1);
});

test('instant delivery can be switched off', async () => {
  const w = world(); w.ctx.env.DOVI_XAUTOCLAIM = '0';
  const bob = user(w.ctx, 'x:555', [['x', '555', '@bob']]); setAddress(w.ctx.db, bob.id, 'base', ADDR.bob, w.ctx.now());
  const r = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc', { id: '9503' }));
  assert.equal(w.ctx.db.prepare('SELECT status FROM claims WHERE id = ?').get(r.claimId).status, 'funded'); assert.equal(w.ctx.executor.claimed.length, 0);
});

test('a payment asked for later is refused with one reply and nothing is paid', async () => {
  const w = world();
  w.ctx.intentLLM = { classify: async () => ({ intent: 'pay', to: 'bob', amountUsd: '5' }) };
  for (const t of ['@DoviFinance in 1hr send @bob 5 usdc', '@DoviFinance send @bob 5 usdc tomorrow', '@DoviFinance send @bob 2 usdc in 2 days', '@DoviFinance send @bob 2 usdc at 5pm']) {
    const r = await xpay.processMention(w.ctx, mention(t));
    assert.equal(r.status, 'rejected', t); assert.equal(r.detail, 'scheduled', t);
  }
  assert.equal(w.ctx.executor.calls.length, 0, 'no payment was made');
  assert.match(outbox(w.ctx)[0], /cannot schedule/);
  const stranger = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 5 usdc tomorrow', { authorId: '909', authorHandle: 'nobody' }));
  assert.equal(stranger.status, 'ignored');
  const now = await xpay.processMention(w.ctx, mention('@DoviFinance send @bob 2 usdc'));
  assert.equal(now.status, 'sent'); assert.equal(w.ctx.executor.calls.length, 1);
});

test('a payment tweet that names another token is refused instead of being paid in USDC', () => {
  const { parseCommand } = require('../server/xpay');
  for (const t of ['@DoviFinance send @bob 5 vibes', '@DoviFinance send @bob 5 $VIBES', '@DoviFinance pay @bob 5 eth', '@DoviFinance send @bob 1 sol']) assert.equal(parseCommand(t, {}).error, 'token', t);
  for (const t of ['@DoviFinance send @bob 5', '@DoviFinance send @bob $5', '@DoviFinance send @bob 5 usdc', '@DoviFinance send 5 to @bob', '@DoviFinance pay @bob 2.5 dollars']) assert.equal(parseCommand(t, {}).amountMicro, BigInt(t.includes('2.5') ? '2500000' : '5000000'), t);
});
