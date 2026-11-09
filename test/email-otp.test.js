'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const otp = require('../lib/email-otp');

function setup() { otp.__test.reset(); const sent = []; otp.__test.setSender(async (email, code) => { sent.push({ email, code }); }); return sent; }

test('a code is emailed, never returned in the response, and verifies once', async () => {
  const sent = setup();
  const r = await otp.start('Amara@Mail.com');
  assert.deepEqual(Object.keys(r), ['sent']);
  assert.equal(sent.length, 1);
  assert.equal(otp.verify('amara@mail.com', sent[0].code).identity, 'email:amara@mail.com');
  assert.throws(() => otp.verify('amara@mail.com', sent[0].code), /request a code first/);
});

test('when delivery fails there is an error and no code is revealed', async () => {
  otp.__test.reset();
  otp.__test.setSender(async () => { throw new Error('smtp down'); });
  await assert.rejects(otp.start('a@b.co'), /delivery failed/);
  assert.throws(() => otp.verify('a@b.co', '000000'), /request a code first/);
});

test('sending is rate limited per email: cooldown and an hourly maximum', async () => {
  const sent = setup();
  await otp.start('a@b.co');
  await assert.rejects(otp.start('a@b.co'), /wait a moment/);
  assert.equal(sent.length, 1);
});

test('guessing is limited: five tries per code and a one hour lock after repeated failures', async () => {
  const sent = setup();
  await otp.start('v@b.co');
  const real = sent[0].code; const wrong = real === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.throws(() => otp.verify('v@b.co', wrong), /incorrect code/);
  assert.throws(() => otp.verify('v@b.co', real), /too many attempts|request a code first/);
});

test('ten failures lock the email even if the attacker keeps requesting new codes', async () => {
  const sent = setup();
  const realNow = Date.now; let t = realNow();
  Date.now = () => t;
  try {
    for (let round = 0; round < 2; round++) {
      await otp.start('lock@b.co'); t += 31000;
      const wrong = sent.at(-1).code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) assert.throws(() => otp.verify('lock@b.co', wrong));
    }
    await assert.rejects(otp.start('lock@b.co'), /too many attempts/);
    assert.throws(() => otp.verify('lock@b.co', sent.at(-1).code), /too many attempts/);
    t += 61 * 60 * 1000;
    await otp.start('lock@b.co');
  } finally { Date.now = realNow; }
});

test('bad emails are rejected', async () => {
  setup();
  await assert.rejects(otp.start('nope'), /valid email/);
});

test('the login code email is a styled html and text pair with the code, an Open DOVI button and no forbidden punctuation', () => {
  const emails = require('../server/emails/templates');
  const m = emails.render('loginCode', { code: '127663' });
  assert.equal(m.subject, 'Your DOVI code: 127663');
  assert.match(m.html, /127663/); assert.match(m.html, /Open DOVI/); assert.match(m.html, /user-select:all/);
  assert.match(m.text, /127663/);
  assert.ok(!/[—–·]/.test(m.html.replace(/<[^>]+>/g, ' ') + m.text));
  assert.equal(emails.render('loginCode', { code: '12<b>3456' }).html.includes('<b>'), false);
});
