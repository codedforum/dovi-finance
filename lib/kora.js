'use strict';
/* Kora (korapay.com) client for the naira leg: a single-use bank transfer account for pay-ins, bank payouts, and account name lookup.
   A test secret key (sk_test_) talks to Kora's sandbox, where nothing real moves. */

const BASE = 'https://api.korapay.com';

class KoraError extends Error {
  constructor(code, message, { http = 0, unknown = false } = {}) { super(message || code); this.name = 'KoraError'; this.code = code; this.http = http; this.unknown = unknown; }
}

const naira = (kobo) => (Number(BigInt(kobo)) / 100).toFixed(2);
const chargeStatus = (s) => { const v = String(s || '').toLowerCase(); return v === 'success' ? 'success' : (['processing', 'pending', 'initiated'].includes(v) ? 'pending' : 'failed'); };
const payoutStatus = (s) => { const v = String(s || '').toLowerCase(); return v === 'success' ? 'success' : (['processing', 'pending', 'initiated', 'queued'].includes(v) ? 'pending' : 'failed'); };

function makeKora(env = process.env, f = fetch) {
  const key = env.KORA_SECRET_KEY;
  if (!key) return null;
  const test = /^sk_test_/.test(String(key));

  async function call(method, path, body) {
    let r;
    try {
      r = await f(BASE + path, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
    } catch (e) { throw new KoraError('network', 'Kora could not be reached.', { unknown: true }); }
    let j = {}; try { j = await r.json(); } catch { /* an empty body is handled below */ }
    if (r.status >= 500) throw new KoraError('server', 'Kora had a problem.', { http: r.status, unknown: true });
    if (!r.ok || j.status !== true) throw new KoraError('rejected', String(j.message || 'Kora rejected the request.').slice(0, 160), { http: r.status });
    return j.data || {};
  }

  return {
    test,
    async initCharge({ reference, amountKobo, name, email, autoComplete = true }) {
      const d = await call('POST', '/merchant/api/v1/charges/bank-transfer', { reference, amount: Number(naira(amountKobo)), currency: 'NGN', customer: { name, email }, merchant_bears_cost: false, narration: 'DOVI naira', account_name: 'DOVI', ...(test ? { auto_complete: autoComplete } : {}) });
      const b = d.bank_account || {};
      if (!b.account_number) throw new KoraError('no_account', 'Kora did not return a payment account.');
      return { amountExpectedKobo: BigInt(Math.round(Number(d.amount_expected || d.amount) * 100)).toString(), account: { bankName: b.bank_name, accountNumber: b.account_number, accountName: b.account_name, expiresAt: b.expiry_date_in_utc ? Date.parse(b.expiry_date_in_utc) : null } };
    },
    async getCharge(reference) {
      const d = await call('GET', '/merchant/api/v1/charges/' + encodeURIComponent(reference));
      return { status: chargeStatus(d.status), amountPaidKobo: BigInt(Math.round(Number(d.amount_paid || 0) * 100)).toString() };
    },
    async resolve({ bank, account }) {
      const d = await call('POST', '/merchant/api/v1/misc/banks/resolve', { bank, account, currency: 'NGN' });
      return { accountName: d.account_name || null };
    },
    async disburse({ reference, amountKobo, bank, account, name, email }) {
      const d = await call('POST', '/merchant/api/v1/transactions/disburse', { reference, destination: { type: 'bank_account', amount: Number(naira(amountKobo)), currency: 'NGN', narration: 'DOVI cash out', bank_account: { bank, account }, customer: { name, email } } });
      return { status: payoutStatus(d.status) };
    },
    async getPayout(reference) {
      const d = await call('GET', '/merchant/api/v1/transactions/' + encodeURIComponent(reference));
      return { status: payoutStatus(d.status) };
    },
  };
}

module.exports = { makeKora, KoraError, chargeStatus, payoutStatus };
