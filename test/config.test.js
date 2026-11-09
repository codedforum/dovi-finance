'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, BASE_USDC } = require('../server/config');

test('defaults match the spec values', () => {
  const c = loadConfig({});
  assert.equal(c.base.chainId, 8453);
  assert.equal(c.base.usdc, BASE_USDC);
  assert.equal(c.claim.feeBps, 100n);
  assert.equal(c.claim.feeMinMicro, 100000n);
  assert.equal(c.claim.maxFeeBps, 150n);
  assert.equal(c.claim.minAmountMicro, 1000000n);
  assert.equal(c.claim.perClaimCapMicro, 10000000n);
  assert.equal(c.claim.perUserDayCapMicro, 50000000n);
  assert.equal(c.claim.globalCapMicro, 500000000n);
  assert.equal(c.claim.expirySeconds, 604800);
});

test('env overrides apply and bad numbers are rejected', () => {
  assert.equal(loadConfig({ DOVI_FEE_BPS: '50' }).claim.feeBps, 50n);
  assert.throws(() => loadConfig({ DOVI_CAP_PER_CLAIM_MICRO: '1e7' }), /config_bad_int/);
  assert.throws(() => loadConfig({ DOVI_FEE_BPS: '151' }), /config_fee_above_max/);
  assert.throws(() => loadConfig({ DOVI_CAP_PER_CLAIM_MICRO: '500000' }), /config_cap_below_min/);
});
