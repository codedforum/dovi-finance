'use strict';
/* naira rail: pay naira, receive USDC in DOVI (buy), and send USDC to a Nigerian bank account as naira (sell).
   The fiat leg runs through Kora, or through a built-in simulator on the test network when no Kora key is set.
   The USDC leg is the executor treasury wallet. On a test key nothing real moves. */
const { encodeFunctionData, getAddress } = require('viem');
const { randomBytes } = require('node:crypto');
const { getAddress: userAddress } = require('./identity');
const { formatUsd } = require('./money');
const { audit } = require('./audit');
const { ngnQuote } = require('./fx');

class NairaError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.name = 'NairaError'; this.code = code; this.status = status; }
}

const TRANSFER_ABI = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }];
const FEE_BPS = 100;
const MIN_KOBO = 100000n;
const MAX_KOBO = 200000000n;
const MIN_USDC_MICRO = 1000000n;
const MAX_BUY_USDC_MICRO = 500000000n;
const MAX_OPEN = 3;
const MAX_PER_DAY = 10;
const BUY_WINDOW_MS = 30 * 60 * 1000;
const SIM_PAYOUT_MS = 15 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const nowMs = (ctx) => (ctx.now ? ctx.now() : Date.now());
const newId = () => 'n_' + randomBytes(7).toString('hex');
const kobo = (n) => BigInt(n);
const ngnText = (k) => { const v = BigInt(k); return '₦' + (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + String(v % 100n).padStart(2, '0'); };

const { BANKS, bankName } = require('./banks');

function rail(ctx) {
  const env = ctx.env || {};
  if (env.DOVI_NAIRA !== '1' || !ctx.executor) return null;
  if (ctx.kora) {
    if (!ctx.kora.test && env.DOVI_NAIRA_LIVE !== '1') return null;
    return { id: 'kora', simulated: ctx.kora.test };
  }
  if (ctx.cfg.base.testnet) return { id: 'sim', simulated: true };
  return null;
}

function parseNgn(text) {
  const t = String(text == null ? '' : text).trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) throw new NairaError('bad_amount', 'Enter an amount in naira like 5000 or 5000.50.');
  const [w, f = ''] = t.split('.');
  return BigInt(w) * 100n + BigInt((f + '00').slice(0, 2));
}

async function quoteFor(ctx, side, amount) {
  const fx = await ngnQuote(ctx);
  if (!fx.available) throw new NairaError('rate_unavailable', 'The naira rate is not available right now. Try again in a moment.', 503);
  const rateMilli = BigInt(Math.round(fx.rate * 1000));
  const fee = BigInt(FEE_BPS);
  if (side === 'buy') { const raw = (amount * 10000000n / rateMilli) * (10000n - fee) / 10000n; return { rateMilli, usdcMicro: raw / 10000n * 10000n, ngnKobo: amount }; }
  return { rateMilli, ngnKobo: (amount * rateMilli / 10000000n) * (10000n - fee) / 10000n, usdcMicro: amount };
}

async function options(ctx) {
  const r = rail(ctx);
  const out = { available: !!r, simulated: r ? r.simulated : false, rail: r ? r.id : null, feeBps: FEE_BPS, minNgnKobo: MIN_KOBO.toString(), maxNgnKobo: MAX_KOBO.toString(), minUsdcMicro: MIN_USDC_MICRO.toString(), banks: BANKS.map((b) => ({ code: b.code, name: b.name, words: b.words })) };
  if (r) { const fx = await ngnQuote(ctx); out.rate = fx.available ? fx.rate : null; }
  return out;
}

/* looks up the account holder name. Test mode only knows a few sandbox accounts, so a miss there is not an error. */
async function lookupName(ctx, code, acct) {
  if (!ctx.kora) return { found: false, simulated: true };
  try {
    const r = await ctx.kora.resolve({ bank: code, account: acct });
    return r && r.accountName ? { found: true, accountName: r.accountName, simulated: ctx.kora.test } : { found: false, simulated: ctx.kora.test };
  } catch (e) {
    if (e && e.unknown) return { found: false, down: true, simulated: ctx.kora.test };
    return { found: false, simulated: ctx.kora.test };
  }
}

async function resolveAccount(ctx, { bankCode, accountNumber }) {
  if (!rail(ctx)) throw new NairaError('unavailable', 'Naira is not switched on yet.', 409);
  const code = String(bankCode || ''); const acct = String(accountNumber || '').replace(/\s/g, '');
  if (!bankName(code)) throw new NairaError('bad_bank', 'Choose your bank.');
  if (!/^\d{10}$/.test(acct)) throw new NairaError('bad_account', 'Enter your 10 digit account number.');
  const r = await lookupName(ctx, code, acct);
  return { found: r.found, accountName: r.found ? r.accountName : null, lookupDown: !!r.down, simulated: !!r.simulated };
}

function guardLimits(ctx, userId) {
  const t = nowMs(ctx);
  const open = ctx.db.prepare("SELECT COUNT(*) n FROM naira_orders WHERE user_id = ? AND status IN ('awaiting_payment','prepared','processing','crediting')").get(userId).n;
  if (open >= MAX_OPEN) throw new NairaError('too_many_open', 'You have ' + MAX_OPEN + ' naira orders in progress. Finish or wait for them first.', 409);
  const day = ctx.db.prepare("SELECT COUNT(*) n FROM naira_orders WHERE user_id = ? AND created_at > ? AND status <> 'expired'").get(userId, t - DAY_MS).n;
  if (day >= MAX_PER_DAY) throw new NairaError('daily_limit', 'You reached today\'s limit of ' + MAX_PER_DAY + ' naira orders. Try again tomorrow.', 429);
}

function view(o) {
  const pay = o.pay_json ? JSON.parse(o.pay_json) : null;
  const bank = o.bank_json ? JSON.parse(o.bank_json) : null;
  return {
    id: o.id, side: o.side, status: o.status, detail: o.detail || null, simulated: o.rail === 'sim' || !!(pay && pay.simulated) || !!(bank && bank.simulated),
    ngnKobo: o.ngn_kobo, usdcMicro: o.usdc_micro, rateMilli: o.rate_milli, feeBps: o.fee_bps,
    pay: pay ? { bankName: pay.bankName, accountNumber: pay.accountNumber, accountName: pay.accountName, amountExpectedKobo: pay.amountExpectedKobo, expiresAt: pay.expiresAt, simulated: !!pay.simulated } : null,
    bank: bank ? { bankName: bank.bankName, last4: bank.accountNumber.slice(-4), accountName: bank.accountName } : null,
    txHash: o.tx_hash || null, refundTx: o.refund_tx || null, expiresAt: o.expires_at || null, createdAt: o.created_at, updatedAt: o.updated_at,
  };
}

const load = (ctx, id) => ctx.db.prepare('SELECT * FROM naira_orders WHERE id = ?').get(id);
const setStatus = (ctx, id, status, detail = null, extra = {}) => {
  const cols = ['status = ?', 'detail = ?', 'updated_at = ?']; const args = [status, detail, nowMs(ctx)];
  for (const [k, v] of Object.entries(extra)) { cols.push(k + ' = ?'); args.push(v); }
  ctx.db.prepare('UPDATE naira_orders SET ' + cols.join(', ') + ' WHERE id = ?').run(...args, id);
};
const needsAttention = (ctx, o, detail) => { setStatus(ctx, o.id, 'needs_attention', detail); audit(ctx.db, { actor: 'system', action: 'naira.needs_attention', subject: o.id, data: { detail } }); };

/* buy: pay naira into a single-use account, get USDC */
async function buyStart(ctx, { userId, amountNgn }) {
  const r = rail(ctx); if (!r) throw new NairaError('unavailable', 'Naira is not switched on yet.', 409);
  const amount = parseNgn(amountNgn);
  if (amount < MIN_KOBO || amount > MAX_KOBO) throw new NairaError('amount_range', 'Pay between ' + ngnText(MIN_KOBO).replace('.00', '') + ' and ' + ngnText(MAX_KOBO).replace('.00', '') + ' per order.');
  if (!userAddress(ctx.db, userId, 'base')) throw new NairaError('no_wallet', 'Your wallet is still being created. Try again in a moment.', 409);
  guardLimits(ctx, userId);
  const q = await quoteFor(ctx, 'buy', amount);
  if (q.usdcMicro > MAX_BUY_USDC_MICRO) throw new NairaError('amount_range', 'That is more than ' + formatUsd(MAX_BUY_USDC_MICRO) + ' of USDC for one order. Try a smaller amount.');
  const dayCap = BigInt(ctx.env && ctx.env.DOVI_NAIRA_DAY_MICRO || '2000000000');
  const used = BigInt(ctx.db.prepare("SELECT COALESCE(SUM(CAST(usdc_micro AS INTEGER)), 0) n FROM naira_orders WHERE side = 'buy' AND status IN ('awaiting_payment','crediting','completed') AND created_at > ?").get(nowMs(ctx) - DAY_MS).n);
  if (used + q.usdcMicro > dayCap) throw new NairaError('capacity', 'Naira orders are at their daily limit across DOVI. Try again tomorrow.', 429);
  const id = newId(); const t = nowMs(ctx);
  let pay;
  if (r.id === 'kora') {
    const email = (ctx.env && ctx.env.DOVI_NAIRA_EMAIL) || 'naira@dovi.finance';
    let c;
    try { c = await ctx.kora.initCharge({ reference: id, amountKobo: amount, name: 'DOVI user', email, autoComplete: true }); }
    catch (e) { throw new NairaError('provider_down', 'The naira partner could not set up a payment account. Try again in a moment.', 502); }
    pay = { ...c.account, amountExpectedKobo: c.amountExpectedKobo, simulated: ctx.kora.test };
  } else {
    const num = '9' + String(BigInt('0x' + id.slice(2)) % 1000000000n).padStart(9, '0');
    pay = { bankName: 'DOVI Test Bank', accountNumber: num, accountName: 'DOVI TEST NAIRA', amountExpectedKobo: amount.toString(), expiresAt: t + BUY_WINDOW_MS, simulated: true };
  }
  const expires = pay.expiresAt || t + BUY_WINDOW_MS;
  ctx.db.prepare('INSERT INTO naira_orders (id, user_id, side, rail, status, ngn_kobo, usdc_micro, rate_milli, fee_bps, pay_json, provider_ref, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, 'buy', r.id, 'awaiting_payment', amount.toString(), q.usdcMicro.toString(), q.rateMilli.toString(), FEE_BPS, JSON.stringify(pay), id, expires, t, t);
  audit(ctx.db, { actor: 'user:' + userId, action: 'naira.buy_start', subject: id, data: { rail: r.id, ngnKobo: amount.toString() } });
  return view(load(ctx, id));
}

async function creditBuy(ctx, o) {
  const to = userAddress(ctx.db, o.user_id, 'base');
  const won = ctx.db.prepare("UPDATE naira_orders SET status = 'crediting', updated_at = ? WHERE id = ? AND status = 'awaiting_payment'").run(nowMs(ctx), o.id);
  if (!Number(won.changes)) return;
  try {
    const t = await ctx.executor.sendUsdc({ to, amountMicro: o.usdc_micro });
    setStatus(ctx, o.id, 'completed', null, { tx_hash: t.txHash });
    ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(o.user_id, 'topup', t.txHash, 'Naira', o.usdc_micro, 'done', nowMs(ctx));
    if (ctx.notify) ctx.notify(o.user_id, { type: 'send_confirmed', title: 'Added ' + formatUsd(BigInt(o.usdc_micro)), privateTitle: 'Your naira payment arrived', body: 'Your naira payment arrived as USDC in your DOVI account.', amountMicro: o.usdc_micro, action: { label: 'View', href: '/app#activity' } });
    audit(ctx.db, { actor: 'system', action: 'naira.buy_completed', subject: o.id, data: { txHash: t.txHash } });
  } catch (e) { needsAttention(ctx, o, e && e.broadcast ? 'credit_unconfirmed' : 'credit_failed'); }
}

async function refreshBuy(ctx, o) {
  if (o.status === 'crediting') { if (nowMs(ctx) - o.updated_at > 5 * 60 * 1000) needsAttention(ctx, o, 'credit_stuck'); return; }
  if (o.status !== 'awaiting_payment') return;
  if (o.rail === 'kora') {
    let c; try { c = await ctx.kora.getCharge(o.provider_ref); } catch { return; }
    if (c.status === 'success') {
      if (BigInt(c.amountPaidKobo) < BigInt(o.ngn_kobo)) return needsAttention(ctx, o, 'underpaid');
      return creditBuy(ctx, o);
    }
    if (c.status === 'failed') return setStatus(ctx, o.id, 'failed', 'payment_failed');
  }
  if (nowMs(ctx) > o.expires_at) setStatus(ctx, o.id, 'expired');
}

/* simulator only: marks the test payment as received */
async function buyTestPaid(ctx, { userId, id }) {
  const o = load(ctx, id);
  if (!o || o.user_id !== userId) throw new NairaError('not_found', 'That order was not found.', 404);
  if (o.rail !== 'sim' || !ctx.cfg.base.testnet) throw new NairaError('not_simulated', 'This order is paid by bank transfer.', 409);
  if (o.status === 'awaiting_payment' && nowMs(ctx) > o.expires_at) { setStatus(ctx, o.id, 'expired'); return view(load(ctx, id)); }
  if (o.status === 'awaiting_payment') await creditBuy(ctx, o);
  return view(load(ctx, id));
}

/* sell: send USDC to DOVI, receive naira in a bank account */
async function sellPrepare(ctx, { userId, amountMicro, bank }) {
  const r = rail(ctx); if (!r) throw new NairaError('unavailable', 'Naira is not switched on yet.', 409);
  let amount; try { amount = BigInt(amountMicro); } catch { throw new NairaError('bad_amount', 'Enter a valid amount.'); }
  if (amount < MIN_USDC_MICRO) throw new NairaError('below_minimum', 'The minimum is ' + formatUsd(MIN_USDC_MICRO) + '.');
  const code = String(bank && bank.bankCode || ''); const name = bankName(code);
  const acct = String(bank && bank.accountNumber || '').replace(/\s/g, '');
  const holder = String(bank && bank.accountName || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new NairaError('bad_bank', 'Choose your bank.');
  if (!/^\d{10}$/.test(acct)) throw new NairaError('bad_account', 'Enter your 10 digit account number.');
  const from = userAddress(ctx.db, userId, 'base');
  if (!from) throw new NairaError('no_wallet', 'Your wallet is still being created. Try again in a moment.', 409);
  guardLimits(ctx, userId);
  const q = await quoteFor(ctx, 'sell', amount);
  if (q.ngnKobo < MIN_KOBO || q.ngnKobo > MAX_KOBO) throw new NairaError('amount_range', 'That converts to ' + ngnText(q.ngnKobo) + '. Cash out between ' + ngnText(MIN_KOBO).replace('.00', '') + ' and ' + ngnText(MAX_KOBO).replace('.00', '') + ' per order.');
  const bal = await (ctx.chain || ctx.reader).usdcBalance(from);
  if (BigInt(bal) < amount) throw new NairaError('insufficient', 'You have ' + formatUsd(bal) + ' available.', 409);
  const live = r.id === 'kora' && !ctx.kora.test;
  const looked = await lookupName(ctx, code, acct);
  let resolvedName = holder;
  if (looked.found) resolvedName = looked.accountName;
  else if (!live && !/^[\p{L} .'-]{2,80}$/u.test(holder)) throw new NairaError('bad_name', 'Enter the account name exactly as the bank shows it.');
  else if (live) throw new NairaError('account_not_found', looked.down ? 'We could not check that bank account right now. Try again in a moment.' : 'We could not verify that bank account. Check the bank and number.', looked.down ? 502 : 400);
  const deposit = getAddress(await ctx.executor.address());
  const id = newId(); const t = nowMs(ctx);
  const bankJson = JSON.stringify({ bankCode: code, bankName: name, accountNumber: acct, accountName: resolvedName, simulated: r.simulated });
  ctx.db.prepare('INSERT INTO naira_orders (id, user_id, side, rail, status, ngn_kobo, usdc_micro, rate_milli, fee_bps, bank_json, deposit_address, provider_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, 'sell', r.id, 'prepared', q.ngnKobo.toString(), amount.toString(), q.rateMilli.toString(), FEE_BPS, bankJson, deposit, id, t, t);
  audit(ctx.db, { actor: 'user:' + userId, action: 'naira.sell_prepare', subject: id, data: { rail: r.id, usdcMicro: amount.toString() } });
  return {
    orderId: id, simulated: r.simulated, ngnKobo: q.ngnKobo.toString(), usdcMicro: amount.toString(),
    tx: { to: ctx.cfg.base.usdc, value: '0', data: encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [deposit, amount] }) },
    preview: { lines: [{ label: 'You send', value: formatUsd(amount) }, { label: 'Rate', value: '₦' + (Number(q.rateMilli) / 1000).toFixed(2) + ' per $1' }, { label: 'Fee', value: (FEE_BPS / 100).toFixed(1) + '%' }, { label: 'Bank', value: name + ' ending ' + acct.slice(-4) }, { label: 'Account name', value: resolvedName }, { label: 'You receive', value: ngnText(q.ngnKobo) }],
      note: r.simulated ? 'Test mode: no real naira moves. Your test USDC is sent and a simulated payout follows.' : 'The naira goes to this bank account. Make sure the details are right, because a wrong account cannot be reversed by DOVI.' },
  };
}

async function sellConfirm(ctx, { userId, id, txHash }) {
  const o = load(ctx, id);
  if (!o || o.user_id !== userId || o.side !== 'sell') throw new NairaError('not_found', 'That order was not found.', 404);
  if (o.status !== 'prepared') return view(o);
  const from = userAddress(ctx.db, userId, 'base');
  const target = o.deposit_address.toLowerCase();
  if (txHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash))) throw new NairaError('bad_tx', 'That transaction id is not valid.');
    const t = await ctx.chain.getTransfer(txHash).catch(() => null);
    if (!t || t.status !== 'success') throw new NairaError('not_confirmed', 'The transfer is not confirmed on Base yet.', 409);
    const hit = (t.transfers || []).find((x) => x.token.toLowerCase() === ctx.cfg.base.usdc.toLowerCase() && x.to.toLowerCase() === target && BigInt(x.value) === BigInt(o.usdc_micro) && x.from.toLowerCase() === String(from).toLowerCase());
    if (!hit) throw new NairaError('mismatch', 'That transaction does not match this order.', 409);
  } else {
    const found = await ctx.chain.findTransfer({ from, to: o.deposit_address, value: BigInt(o.usdc_micro) }).catch(() => null);
    if (!found) throw new NairaError('not_confirmed', 'The transfer is not confirmed on Base yet.', 409);
    txHash = found.txHash;
  }
  if (ctx.db.prepare('SELECT 1 FROM naira_orders WHERE tx_hash = ? AND id <> ?').get(txHash, id)) throw new NairaError('mismatch', 'That transaction already settled another order.', 409);
  const won = ctx.db.prepare("UPDATE naira_orders SET status = 'processing', tx_hash = ?, payout_at = ?, updated_at = ? WHERE id = ? AND status = 'prepared'").run(txHash, nowMs(ctx) + SIM_PAYOUT_MS, nowMs(ctx), id);
  if (!Number(won.changes)) return view(load(ctx, id));
  audit(ctx.db, { actor: 'user:' + userId, action: 'naira.sell_confirm', subject: id, data: { txHash } });
  const cur = load(ctx, id);
  if (cur.rail === 'kora') {
    const b = JSON.parse(cur.bank_json);
    try { await ctx.kora.disburse({ reference: cur.provider_ref, amountKobo: BigInt(cur.ngn_kobo), bank: b.bankCode, account: b.accountNumber, name: b.accountName, email: (ctx.env && ctx.env.DOVI_NAIRA_EMAIL) || 'naira@dovi.finance' }); }
    catch (e) { if (e && e.unknown) setStatus(ctx, id, 'processing', 'payout_unconfirmed'); else await refundSell(ctx, cur, 'payout_rejected'); }
  }
  return view(load(ctx, id));
}

function finishSell(ctx, o) {
  setStatus(ctx, o.id, 'completed');
  const b = JSON.parse(o.bank_json);
  ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(o.user_id, 'withdraw', o.tx_hash || o.id, 'naira at ' + b.bankName + ' ' + b.accountNumber.slice(-4), o.usdc_micro, 'done', nowMs(ctx));
  if (ctx.notify) ctx.notify(o.user_id, { type: 'send_confirmed', title: 'Cashed out ' + ngnText(o.ngn_kobo), privateTitle: 'Your naira payout was sent', body: 'Naira is on its way to ' + b.bankName + ' ending ' + b.accountNumber.slice(-4) + '.', amountMicro: o.usdc_micro, action: { label: 'View', href: '/app#activity' } });
  audit(ctx.db, { actor: 'system', action: 'naira.sell_completed', subject: o.id, data: {} });
}

/* a payout the partner could not make sends the USDC back to the user, once */
async function refundSell(ctx, o, reason) {
  const to = userAddress(ctx.db, o.user_id, 'base');
  const won = ctx.db.prepare("UPDATE naira_orders SET status = 'refunding', detail = ?, updated_at = ? WHERE id = ? AND status IN ('processing','needs_attention')").run(reason, nowMs(ctx), o.id);
  if (!Number(won.changes)) return;
  try {
    const t = await ctx.executor.sendUsdc({ to, amountMicro: o.usdc_micro });
    setStatus(ctx, o.id, 'refunded', reason, { refund_tx: t.txHash });
    ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(o.user_id, 'topup', t.txHash, 'a returned cash out', o.usdc_micro, 'done', nowMs(ctx));
    if (ctx.notify) ctx.notify(o.user_id, { type: 'send_confirmed', title: 'Cash out returned ' + formatUsd(BigInt(o.usdc_micro)), privateTitle: 'Your cash out was returned', body: 'The naira payout could not be made, so your USDC is back in your DOVI account.', amountMicro: o.usdc_micro, action: { label: 'View', href: '/app#activity' } });
    audit(ctx.db, { actor: 'system', action: 'naira.sell_refunded', subject: o.id, data: { reason, txHash: t.txHash } });
  } catch (e) { needsAttention(ctx, o, e && e.broadcast ? 'refund_unconfirmed' : 'refund_failed'); }
}

/* returns the USDC of an order whose payout failed or was rejected and was left for a person */
async function refundFailedPayout(ctx, { id }) {
  const o = load(ctx, id);
  if (!o || o.side !== 'sell') throw new NairaError('not_found', 'That order was not found.', 404);
  if (o.status !== 'needs_attention' || !['payout_failed', 'payout_rejected'].includes(o.detail)) throw new NairaError('not_refundable', 'That order cannot be refunded this way.', 409);
  await refundSell(ctx, o, o.detail);
  return view(load(ctx, id));
}

async function refreshSell(ctx, o) {
  if (o.status !== 'processing') return;
  if (o.rail === 'sim') { if (nowMs(ctx) >= o.payout_at) finishSell(ctx, o); return; }
  let p;
  try { p = await ctx.kora.getPayout(o.provider_ref); }
  catch (e) { if (!e.unknown && o.detail === 'payout_unconfirmed' && nowMs(ctx) - o.updated_at > 10 * 60 * 1000) needsAttention(ctx, o, 'payout_unknown'); return; }
  if (p.status === 'success') return finishSell(ctx, o);
  if (p.status === 'failed') await refundSell(ctx, o, 'payout_failed');
}

async function refresh(ctx, o) {
  if (o.side === 'buy') await refreshBuy(ctx, o); else await refreshSell(ctx, o);
  return load(ctx, o.id);
}

async function get(ctx, { userId, id }) {
  let o = load(ctx, id);
  if (!o || o.user_id !== userId) throw new NairaError('not_found', 'That order was not found.', 404);
  o = await refresh(ctx, o);
  return view(o);
}

function list(ctx, userId) {
  return ctx.db.prepare("SELECT * FROM naira_orders WHERE user_id = ? AND status <> 'prepared' ORDER BY created_at DESC LIMIT 30").all(userId).map(view);
}

/* background settle for orders nobody is watching */
async function tick(ctx) {
  if (!rail(ctx)) return;
  const rows = ctx.db.prepare("SELECT * FROM naira_orders WHERE status IN ('awaiting_payment','processing','crediting') AND created_at > ? ORDER BY updated_at LIMIT 20").all(nowMs(ctx) - 2 * DAY_MS);
  for (const o of rows) { try { await refresh(ctx, o); } catch (e) { console.error('[dovi] naira tick', o.id, e.message); } }
}

module.exports = { refundFailedPayout, NairaError, FEE_BPS, BANKS, options, resolveAccount, buyStart, buyTestPaid, sellPrepare, sellConfirm, get, list, tick, quoteFor, parseNgn, ngnText, rail };
