'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUsd, formatUsd, feeFor, MoneyError } = require('../server/money');

const reject = (v, code) => assert.throws(() => parseUsd(v), (e) => e instanceof MoneyError && e.code === code, String(v));

test('parses plain amounts exactly', () => {
  assert.equal(parseUsd('5'), 5000000n);
  assert.equal(parseUsd('5.50'), 5500000n);
  assert.equal(parseUsd('$0.000001'), 1n);
  assert.equal(parseUsd(' 12.345678 '), 12345678n);
  assert.equal(parseUsd(7), 7000000n);
});

test('rejects zero-ish junk, negatives, too many decimals, scientific notation and huge values', () => {
  reject('', 'bad_amount'); reject('abc', 'bad_amount'); reject('1,000', 'bad_amount'); reject('.5', 'bad_amount'); reject('5.', 'bad_amount');
  reject('-5', 'negative_amount');
  reject('1.1234567', 'too_many_decimals');
  reject('1e6', 'bad_amount'); reject('1E6', 'bad_amount');
  reject('9'.repeat(40), 'amount_too_large');
  reject(NaN, 'bad_amount'); reject(Infinity, 'bad_amount'); reject({}, 'bad_amount'); reject(null, 'bad_amount');
});

test('formats with grouping and at least two decimals', () => {
  assert.equal(formatUsd(5000000n), '$5.00');
  assert.equal(formatUsd(5500000n), '$5.50');
  assert.equal(formatUsd(1234567890000n), '$1,234,567.89');
  assert.equal(formatUsd(1n), '$0.000001');
});

test('fee is 1 percent with a 0.10 minimum and never above the hard maximum', () => {
  const c = { feeBps: 100n, feeMinMicro: 100000n, maxFeeBps: 150n };
  assert.equal(feeFor(1000000n, c), 100000n);
  assert.equal(feeFor(5000000n, c), 100000n);
  assert.equal(feeFor(10000000n, c), 100000n);
  assert.equal(feeFor(50000000n, c), 500000n);
  assert.throws(() => feeFor(1000000n, { ...c, feeBps: 151n }), (e) => e.code === 'fee_above_max');
});
