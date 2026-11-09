'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const n = require('../server/notifications');
const { listActivity, recordActivity } = require('../server/activity');
const { makeCtx, user, ADDR } = require('./helpers');
const claims = require('../server/claims');

function fakeRes() {
  const r = { chunks: [], head: null, closed: false, handlers: {} };
  r.writeHead = (s, h) => { r.head = { s, h }; };
  r.write = (c) => { if (r.closed) throw new Error('closed'); r.chunks.push(c); return true; };
  r.on = (e, f) => { r.handlers[e] = f; };
  r.close = () => { r.closed = true; if (r.handlers.close) r.handlers.close(); };
  return r;
}
function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (cdp_sub, created_at) VALUES ('a', 1), ('b', 1)").run();
  const hub = n.makeHub({ heartbeatMs: 1e9 });
  const notify = n.makeNotifier(db, hub, () => 1000);
  return { db, hub, notify };
}
const evt = (type = 'payment_received', over = {}) => ({ type, title: 'Amara sent you $5.00', privateTitle: 'You received a payment', body: 'Open it', amountMicro: '5000000', action: { label: 'Open', href: '/app' }, ...over });

test('SSE frames are well formed and arrive live', () => {
  const { db, hub, notify } = setup();
  const res = fakeRes();
  hub.subscribe(db, 1, res, undefined);
  assert.equal(res.head.s, 200);
  assert.match(res.head.h['content-type'], /text\/event-stream/);
  assert.equal(res.chunks[0], 'retry: 3000\n\n');
  const v = notify(1, evt());
  const f = res.chunks.at(-1);
  assert.match(f, new RegExp('^id: ' + v.id + '\\nevent: notification\\ndata: \\{.*\\}\\n\\n$'));
  assert.equal(JSON.parse(f.split('data: ')[1]).title, 'Amara sent you $5.00');
  assert.equal(hub.count(1), 1);
  res.close();
  assert.equal(hub.count(1), 0);
});

test('reconnect with Last-Event-ID replays only the missed ones in order', () => {
  const { db, hub, notify } = setup();
  const a = notify(1, evt('claim_created')); const b = notify(1, evt('claim_opened')); const c = notify(1, evt('claim_completed'));
  const res = fakeRes();
  hub.subscribe(db, 1, res, String(a.id));
  const ids = res.chunks.filter((x) => x.startsWith('id:')).map((x) => Number(x.split('\n')[0].slice(4)));
  assert.deepEqual(ids, [b.id, c.id]);
  const res2 = fakeRes();
  hub.subscribe(db, 1, res2, 'garbage');
  assert.equal(res2.chunks.filter((x) => x.startsWith('id:')).length, 0);
});

test('a user never receives or reads another user rows', () => {
  const { db, hub, notify } = setup();
  const mine = notify(1, evt()); const theirs = notify(2, evt());
  assert.deepEqual(n.listNotifications(db, 1).map((x) => x.id), [mine.id]);
  assert.equal(n.markRead(db, 1, [theirs.id]), 0);
  assert.equal(n.unreadCount(db, 2), 1);
  const res = fakeRes(); hub.subscribe(db, 1, res, '0');
  assert.ok(res.chunks.every((c) => !c.includes('"id":' + theirs.id)));
});

test('markRead all zeroes the count and groups filter the list', () => {
  const { db, notify } = setup();
  notify(1, evt('payment_received')); notify(1, evt('claim_created')); notify(1, evt('security_login'));
  assert.equal(n.unreadCount(db, 1), 3);
  assert.equal(n.listNotifications(db, 1, { group: 'claims' }).length, 1);
  assert.equal(n.listNotifications(db, 1, { group: 'money' }).length, 1);
  assert.equal(n.markRead(db, 1, 'all'), 3);
  assert.equal(n.unreadCount(db, 1), 0);
  assert.equal(n.markRead(db, 1, 'all'), 0);
});

test('unknown types are rejected and paging works', () => {
  const { db, notify } = setup();
  assert.throws(() => notify(1, evt('nope')), /bad_notification_type/);
  for (let i = 0; i < 5; i++) notify(1, evt());
  const p1 = n.listNotifications(db, 1, { limit: 2 });
  const p2 = n.listNotifications(db, 1, { limit: 2, before: p1.at(-1).id });
  assert.equal(p1.length, 2); assert.equal(p2.length, 2);
  assert.ok(p2[0].id < p1.at(-1).id);
});

test('privacy: every private title produced by the claim flow has no amount and no name', async () => {
  const ctx = makeCtx();
  const alice = user(ctx, 'email:alice@mail.com', [['email', 'alice@mail.com', 'alice@mail.com']]);
  const bob = user(ctx, 'x:555', [['x', '555', '@bob']]);
  const d = claims.createDraft(ctx, { userId: alice.id, senderAddress: ADDR.alice, kind: 'x', providerId: '555', label: '@bob', amountMicro: 5000000n });
  const row = ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(d.claimId);
  ctx.chain.onchainCreate(d.claimId, { sender: ADDR.alice, amount: row.amount_micro, fee: row.fee_micro, expiry: row.expiry, recipientHash: row.recipient_hash });
  await claims.confirmFunded(ctx, { claimId: d.claimId, userId: alice.id, txHash: '0x1' });
  await claims.prepareClaim(ctx, { claimId: d.claimId, userId: bob.id, recipientAddress: ADDR.bob });
  ctx.chain.onchainClaim(d.claimId);
  await claims.confirmClaimed(ctx, { claimId: d.claimId, userId: bob.id, txHash: '0x2' });
  assert.ok(ctx.events.length >= 4);
  for (const e of ctx.events) assert.doesNotMatch(e.privateTitle, /[$0-9@]|bob|alice/i, e.privateTitle);
});

test('activity lists newest first and pages', () => {
  const { db } = setup();
  for (let i = 0; i < 4; i++) recordActivity(db, { userId: 1, kind: 'claim_sent', amountMicro: 1000000 * (i + 1), now: i });
  const a = listActivity(db, 1, { limit: 2 });
  assert.deepEqual(a.map((x) => x.amountMicro), ['4000000', '3000000']);
  assert.equal(listActivity(db, 1, { limit: 2, before: a.at(-1).id }).length, 2);
  assert.equal(listActivity(db, 2).length, 0);
});
