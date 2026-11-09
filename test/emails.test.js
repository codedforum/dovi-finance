'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../server/emails/templates');
const { makeCtx, user, ADDR } = require('./helpers');
const claims = require('../server/claims');

const LINK = 'https://dovi.test/claim/0x' + 'ab'.repeat(32);
const base = { fromName: 'Amara', amountMicro: '5000000', link: LINK, expiry: Math.floor(Date.now() / 1000) + 3 * 86400, toLabel: '@bob', what: 'A new device signed in', when: 'just now' };
const KINDS = ['claimInvite', 'claimReminder', 'claimCompleted', 'claimReturned', 'paymentReceived', 'securityAlert'];

test('every template renders subject, html and text with the link and the safety line', () => {
  for (const k of KINDS) {
    const m = render(k, base);
    assert.ok(m.subject && m.html && m.text, k);
    assert.ok(m.html.includes(LINK) && m.text.includes(LINK), k + ' link');
    assert.match(m.text, /never asks for your password, a seed phrase or a private key/, k);
    assert.doesNotMatch(m.html, /<img|<script|track/i, k + ' no tracking or scripts');
    assert.doesNotMatch(m.subject + m.html + m.text, /[—–·]/, k + ' forbidden punctuation');
  }
});

test('subjects never contain an amount or a name', () => {
  for (const k of KINDS) assert.doesNotMatch(render(k, base).subject, /\$|\d|Amara|bob/i, k);
});

test('user supplied names and labels are escaped in html', () => {
  const evil = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';
  for (const k of ['claimInvite', 'claimReminder', 'paymentReceived']) { const h = render(k, { ...base, fromName: evil }).html; assert.doesNotMatch(h, /<script>alert|<img src=x/, k); assert.match(h, /&lt;script&gt;/, k); }
  assert.doesNotMatch(render('claimCompleted', { ...base, toLabel: evil }).html, /<script>alert/);
});

test('the claim invite names the amount and says when it expires, and the word free never sits next to a fee', () => {
  const m = render('claimInvite', { ...base, now: Date.now() });
  assert.match(m.html, /\$5\.00/); assert.match(m.html, /expires in about 3 days/);
  for (const k of KINDS) assert.doesNotMatch(render(k, base).html, /free[^.]{0,60}fee|fee[^.]{0,60}free/i, k);
});

test('funding a claim to an email sends the invite exactly once to that mailbox, and a failing mailer does not break the claim', async () => {
  const ctx = makeCtx();
  const sent = [];
  ctx.mailer = { send: async (m) => { sent.push(m); } };
  const alice = user(ctx, 'email:alice@mail.com', [['email', 'alice@mail.com', 'alice@mail.com']]);
  const d = claims.createDraft(ctx, { userId: alice.id, senderAddress: ADDR.alice, kind: 'email', providerId: 'Zed@Mail.com', label: 'zed@mail.com', amountMicro: 5000000n });
  const row = ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(d.claimId);
  ctx.chain.onchainCreate(d.claimId, { sender: ADDR.alice, amount: row.amount_micro, fee: row.fee_micro, expiry: row.expiry, recipientHash: row.recipient_hash });
  await claims.confirmFunded(ctx, { claimId: d.claimId, userId: alice.id, txHash: '0x1' });
  await claims.confirmFunded(ctx, { claimId: d.claimId, userId: alice.id, txHash: '0x1' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'zed@mail.com');
  assert.ok(sent[0].html.includes(d.link));

  const ctx2 = makeCtx();
  ctx2.mailer = { send: async () => { throw new Error('smtp down'); } };
  const a2 = user(ctx2, 'email:alice@mail.com', [['email', 'alice@mail.com', 'alice@mail.com']]);
  const d2 = claims.createDraft(ctx2, { userId: a2.id, senderAddress: ADDR.alice, kind: 'email', providerId: 'zed@mail.com', label: 'zed@mail.com', amountMicro: 5000000n });
  const r2 = ctx2.db.prepare('SELECT * FROM claims WHERE id = ?').get(d2.claimId);
  ctx2.chain.onchainCreate(d2.claimId, { sender: ADDR.alice, amount: r2.amount_micro, fee: r2.fee_micro, expiry: r2.expiry, recipientHash: r2.recipient_hash });
  const ok = await claims.confirmFunded(ctx2, { claimId: d2.claimId, userId: a2.id, txHash: '0x1' });
  assert.equal(ok.status, 'funded');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ctx2.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'email.failed'").get().n, 1);
});

test('an X recipient gets no email', async () => {
  const ctx = makeCtx(); const sent = []; ctx.mailer = { send: async (m) => sent.push(m) };
  const alice = user(ctx, 'email:alice@mail.com', [['email', 'alice@mail.com', 'alice@mail.com']]);
  const d = claims.createDraft(ctx, { userId: alice.id, senderAddress: ADDR.alice, kind: 'x', providerId: '555', label: '@bob', amountMicro: 5000000n });
  const row = ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(d.claimId);
  ctx.chain.onchainCreate(d.claimId, { sender: ADDR.alice, amount: row.amount_micro, fee: row.fee_micro, expiry: row.expiry, recipientHash: row.recipient_hash });
  await claims.confirmFunded(ctx, { claimId: d.claimId, userId: alice.id, txHash: '0x1' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 0);
});
