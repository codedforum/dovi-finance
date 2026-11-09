'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, user } = require('./helpers');
const llm = require('../server/agent/llm');
const agent = require('../server/agent/engine');
const { parse } = require('../server/agent/parse');

const reply = (obj) => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] }) });
const ENV = { DOVI_AGENT_LLM: '1', RELAYSTATION_API_KEY: 'k', RELAYSTATION_BASE_URL: 'https://relay.test/v1', RELAYSTATION_MODEL: 'm1' };

test('the model is off unless switched on and configured', () => {
  assert.equal(llm.makeAgentLLM({}), null);
  assert.equal(llm.makeAgentLLM({ ...ENV, DOVI_AGENT_LLM: '0' }), null);
  assert.equal(llm.makeAgentLLM({ ...ENV, RELAYSTATION_API_KEY: '' }), null);
  assert.ok(llm.makeAgentLLM(ENV));
});

test('a send or request is accepted only when the person and the amount are in the original words', () => {
  const ok = llm.validate('pls pay amara 5 dollars @amara', JSON.stringify({ action: 'send', command: 'send 5 to @amara', reply: 'Here you go' }));
  assert.deepEqual(ok, { action: 'send', command: 'send 5 to @amara', reply: 'Here you go' });
  assert.equal(llm.validate('ask kofi@mail.com for 12 usdc', JSON.stringify({ action: 'request', command: 'request 12 from kofi@mail.com', reply: '' })).action, 'request');
  for (const bad of [
    { action: 'send', command: 'send 500 to @eve', reply: '' },
    { action: 'send', command: 'send 5 to @amara', reply: '' },
    { action: 'send', command: 'send 5 to 0x1234567890123456789012345678901234567890', reply: '' },
    { action: 'request', command: 'send 5 to @amara', reply: '' },
    { action: 'send', command: null, reply: '' },
  ]) assert.equal(llm.validate('pls pay bob 5 dollars @bob', JSON.stringify(bad)).action, 'chat', JSON.stringify(bad));
  assert.equal(llm.validate('hello', 'not json').action, 'chat');
  assert.equal(llm.validate('hello', JSON.stringify({ action: 'drain_wallet', reply: 'x' })).action, 'chat');
});

test('replies are cleaned: no links, markdown, dashes or long text', () => {
  const r = llm.cleanReply('See **this** https://evil.test/x — now · ok www.bad.com ' + 'word '.repeat(100));
  assert.doesNotMatch(r, /https?:|www\.|\*|—|·/); assert.ok(r.length <= 320);
});

test('the agent chats, navigates and previews through the same approval as before', async () => {
  const ctx = makeCtx(); const u = user(ctx, 'x:1', [['x', '1', '@ada']]);
  const asked = [];
  const ask = (out) => ({ async ask(a) { asked.push(a); return out; } });
  ctx.agentLLM = ask({ action: 'chat', reply: 'Hi, good to see you.' });
  let r = await agent.handle(ctx, u.id, 'did you know me');
  assert.deepEqual([r.ok, r.intent, r.message], [true, 'chat', 'Hi, good to see you.']); assert.equal(asked[0].handle, 'ada');
  ctx.agentLLM = ask({ action: 'cash_out', reply: 'Opening cash out.' });
  r = await agent.handle(ctx, u.id, 'i want my money in my bank please');
  assert.deepEqual([r.intent, r.target, r.message], ['navigate', 'cashout', 'Opening cash out.']);
  ctx.agentLLM = ask({ action: 'balance', reply: '' });
  r = await agent.handle(ctx, u.id, 'what do i have left in here');
  assert.equal(r.intent, 'balance');
  ctx.agentLLM = ask({ action: 'send', command: 'send 5 to @amara', reply: '' });
  r = await agent.handle(ctx, u.id, 'could you maybe pay amara for me five dollars @amara 5');
  assert.ok(r.ok === false || r.intentId || r.code, 'a send goes through the strict flow, never straight to money');
  assert.ok(!r.action, 'the model never returns an executable action');
});

test('plain commands never reach the model, and a model failure falls back to the normal reply', async () => {
  const ctx = makeCtx(); const u = user(ctx, 'x:2', [['x', '2', '@bo']]);
  let calls = 0; ctx.agentLLM = { async ask() { calls++; throw new Error('relay down'); } };
  assert.equal((await agent.handle(ctx, u.id, 'how much do i have')).intent, 'balance');
  assert.equal((await agent.handle(ctx, u.id, 'show my history')).intent, 'history');
  assert.equal(calls, 0, 'rule matches do not call the model');
  const r = await agent.handle(ctx, u.id, 'tell me a joke please');
  assert.equal(r.ok, false); assert.match(r.message, /did not understand/); assert.equal(calls, 1);
});

test('the rule parser opens naira, add money and withdraw instead of refusing, but never hijacks a payment', () => {
  assert.deepEqual([parse('swap to naira').kind, parse('swap to naira').target], ['navigate', 'cashout']);
  assert.equal(parse('i need more test usdc').target, 'add');
  assert.equal(parse('withdraw please').target, 'withdraw');
  assert.equal(parse('start a giveaway').target, 'giveaways');
  assert.equal(parse('send 5 to @opay').kind, 'send');
  assert.equal(parse('swap my eth to sol').error, 'refused');
});
