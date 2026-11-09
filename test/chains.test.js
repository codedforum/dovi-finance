'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRegistry, ChainNotLive } = require('../server/chains');
const rows = require('../server/chains.json');
const reg = makeRegistry(rows);

test('only Base is live and the others are soon', () => {
  assert.equal(reg.isLive('base'), true);
  for (const id of ['solana', 'sui', 'arc', 'robinhood']) assert.equal(reg.isLive(id), false, id);
});

test('assertLive throws ChainNotLive for a soon chain and for an unknown chain', () => {
  assert.throws(() => reg.assertLive('solana'), (e) => e instanceof ChainNotLive && e.code === 'chain_not_live');
  assert.throws(() => reg.assertLive('nope'), ChainNotLive);
  assert.doesNotThrow(() => reg.assertLive('base'));
});

test('a testnet chain marked live makes the registry refuse to start', () => {
  const bad = rows.map((r) => (r.id === 'arc' ? { ...r, status: 'live' } : r));
  assert.throws(() => makeRegistry(bad), /registry_dishonest:arc/);
});

test('an unverified chain marked live makes the registry refuse to start', () => {
  const bad = rows.map((r) => (r.id === 'solana' ? { ...r, status: 'live' } : r));
  assert.throws(() => makeRegistry(bad), /registry_dishonest:solana/);
});

test('setStatus refuses to switch a testnet or unverified chain live', () => {
  const r = makeRegistry(rows);
  assert.throws(() => r.setStatus('arc', 'live', 'admin'), /refused:arc/);
  assert.throws(() => r.setStatus('solana', 'live', 'admin'), /refused:solana/);
  assert.equal(r.isLive('arc'), false);
});

test('setStatus can pause Base and bring it back, and reports each change to the hook', () => {
  const seen = [];
  const r = makeRegistry(rows, { onChange: (e) => seen.push(e) });
  r.setStatus('base', 'off', 'admin:1');
  assert.equal(r.isLive('base'), false);
  r.setStatus('base', 'live', 'admin:1');
  assert.equal(r.isLive('base'), true);
  assert.deepEqual(seen.map((e) => [e.before, e.after, e.actor]), [['live', 'off', 'admin:1'], ['off', 'live', 'admin:1']]);
});

test('setStatus rejects bad input', () => {
  assert.throws(() => reg.setStatus('base', 'maybe', 'x'), /bad_status/);
  assert.throws(() => reg.setStatus('mars', 'live', 'x'), /unknown_chain/);
});

test('the public view hides internals and the status line is generated from the registry', () => {
  const v = reg.publicView();
  assert.ok(v.every((c) => !('chainId' in c) && !('network' in c) && !('verified' in c)));
  assert.equal(reg.statusLine(), 'Live on Base. Solana, Sui, Arc, Robinhood Chain coming soon.');
});

test('a test network can be live only when testnet mode is switched on, and only for Base', () => {
  const { makeRegistry, applyNetwork } = require('../server/chains');
  const rows = require('../server/chains.json');
  const cfg = { network: 'sepolia', base: { usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' } };
  const test = applyNetwork(rows, cfg);
  assert.throws(() => makeRegistry(test), /registry_dishonest/);
  const reg = makeRegistry(test, { allowTestnet: true });
  assert.equal(reg.getChain('base').chainId, 84532);
  assert.ok(!('chainId' in reg.publicView().find((x) => x.id === 'base')));
  assert.throws(() => reg.setStatus('arc', 'live', 't'), /refused/);
  assert.equal(applyNetwork(rows, { network: 'mainnet' }), rows);
});
