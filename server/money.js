'use strict';

class MoneyError extends Error {
  constructor(code, message) { super(message || code); this.name = 'MoneyError'; this.code = code; }
}

function parseUsd(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError('bad_amount', 'Enter a valid amount.');
    input = String(input);
  }
  if (typeof input !== 'string') throw new MoneyError('bad_amount', 'Enter a valid amount.');
  const s = input.trim().replace(/^\$/, '');
  if (!s) throw new MoneyError('bad_amount', 'Enter an amount.');
  if (/e/i.test(s)) throw new MoneyError('bad_amount', 'Use plain numbers like 5 or 5.50.');
  if (s.startsWith('-')) throw new MoneyError('negative_amount', 'Amounts cannot be negative.');
  if (!/^\d+(\.\d+)?$/.test(s)) throw new MoneyError('bad_amount', 'Use plain numbers like 5 or 5.50.');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 6) throw new MoneyError('too_many_decimals', 'Amounts can have at most 6 decimal places.');
  if (whole.length > 12) throw new MoneyError('amount_too_large', 'That amount is too large.');
  const micro = BigInt(whole) * 1000000n + BigInt((frac + '000000').slice(0, 6));
  return micro;
}

function formatUsd(micro) {
  const m = BigInt(micro);
  const neg = m < 0n;
  const a = neg ? -m : m;
  const whole = a / 1000000n;
  let frac = String(a % 1000000n).padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = (frac + '00').slice(0, 2);
  return (neg ? '-' : '') + '$' + whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + frac;
}

function feeFor(amountMicro, { feeBps, feeMinMicro, maxFeeBps }) {
  const a = BigInt(amountMicro);
  if (BigInt(feeBps) > BigInt(maxFeeBps)) throw new MoneyError('fee_above_max');
  const pct = (a * BigInt(feeBps)) / 10000n;
  return pct > BigInt(feeMinMicro) ? pct : BigInt(feeMinMicro);
}

module.exports = { MoneyError, parseUsd, formatUsd, feeFor };
