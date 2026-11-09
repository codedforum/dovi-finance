'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx } = require('./helpers');
const gas = require('../server/gaswatch');

test('a low executor balance raises one warning, clears when topped up, and no executor means no check', async () => {
  const ctx = makeCtx();
  assert.deepEqual(await gas.check(ctx, {}), { skipped: true });
  ctx.executor = { async address() { return '0x00000000000000000000000000000000000e0ec1'; } };
  let wei = 100000000000000n; const client = { async getBalance() { return wei; } };
  const errs = []; const orig = console.error; console.error = (m) => errs.push(m);
  try {
    assert.equal((await gas.check(ctx, client)).low, true);
    assert.equal((await gas.check(ctx, client)).low, true);
    assert.equal(errs.length, 1, 'one warning, not one per check');
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM audit WHERE action = 'gas.low'").get().n, 1);
    wei = 5000000000000000n;
    assert.equal((await gas.check(ctx, client)).low, false);
    wei = 1n; await gas.check(ctx, client);
    assert.equal(errs.length, 2, 'it warns again after a recovery');
  } finally { console.error = orig; }
});
