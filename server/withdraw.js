'use strict';
const { encodeFunctionData, getAddress } = require('viem');
const { randomBytes } = require('node:crypto');
const { parseAddress } = require('./ids');
const { getAddress: userAddress } = require('./identity');
const { formatUsd } = require('./money');
const { audit } = require('./audit');
const { assetFor } = require('./nearintents');

class WithdrawError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.name = 'WithdrawError'; this.code = code; this.status = status; }
}

const TRANSFER_ABI = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }];
const MIN_MICRO = 1000000n;
const ZERO = '0x0000000000000000000000000000000000000000';
const nowMs = (ctx) => (ctx.now ? ctx.now() : Date.now());
const newId = () => 'w_' + randomBytes(6).toString('hex');

function options(ctx) {
  const priv = !!ctx.near && !ctx.cfg.base.testnet;
  return {
    public: { available: true },
    private: { available: priv, reason: priv ? null : (ctx.cfg.base.testnet ? 'The private route runs on Base mainnet. It is switched on at launch.' : 'The private route is not switched on yet.') },
    fiat: { available: false, reason: require('./naira').rail(ctx) ? 'Use Cash out to naira above.' : 'Cash out to naira and other currencies through an exchange partner is coming soon.' },
    minMicro: MIN_MICRO.toString(),
  };
}

function checkDestination(ctx, userId, raw) {
  let to;
  try { to = getAddress(parseAddress(raw)); } catch { throw new WithdrawError('bad_address', 'Enter a valid Base wallet address, starting with 0x.'); }
  const lower = to.toLowerCase();
  const blocked = [ZERO, ctx.cfg.claim.contract, ctx.cfg.base.usdc].filter(Boolean).map((a) => a.toLowerCase());
  if (blocked.includes(lower)) throw new WithdrawError('bad_destination', 'That address cannot receive a withdrawal. Use your own wallet address.');
  const mine = userAddress(ctx.db, userId, 'base');
  if (mine && mine.toLowerCase() === lower) throw new WithdrawError('own_account', 'That is your DOVI account address. Enter the address of the wallet you want to withdraw to.');
  return to;
}

async function prepare(ctx, { userId, route = 'public', to, amountMicro }) {
  ctx.registry.assertLive('base');
  const opt = options(ctx);
  if (route !== 'public' && route !== 'private') throw new WithdrawError('bad_route', 'Choose public or private.');
  if (route === 'private' && !opt.private.available) throw new WithdrawError('private_unavailable', opt.private.reason, 409);
  const from = userAddress(ctx.db, userId, 'base');
  if (!from) throw new WithdrawError('no_wallet', 'Your wallet is still being created. Try again in a moment.', 409);
  const dest = checkDestination(ctx, userId, to);
  let amount; try { amount = BigInt(amountMicro); } catch { throw new WithdrawError('bad_amount', 'Enter a valid amount.'); }
  if (amount < MIN_MICRO) throw new WithdrawError('below_minimum', 'The minimum withdrawal is ' + formatUsd(MIN_MICRO) + '.');
  const bal = await (ctx.chain || ctx.reader).usdcBalance(from);
  if (BigInt(bal) < amount) throw new WithdrawError('insufficient', 'You have ' + formatUsd(bal) + ' available.', 409);
  const id = newId(); const t = nowMs(ctx);
  let target = dest; let depositAddress = null; let receive = amount; let quoteJson = null; let note = 'It goes straight from your DOVI account to this wallet on Base. DOVI covers the network fee.';
  if (route === 'private') {
    const deadline = new Date(t + 30 * 60 * 1000).toISOString();
    const asset = assetFor(ctx.cfg.base.usdc);
    let q;
    try { q = await ctx.near.quote({ dry: false, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: asset, depositType: 'ORIGIN_CHAIN', destinationAsset: asset, amount: amount.toString(), refundTo: from, refundType: 'ORIGIN_CHAIN', recipient: dest, recipientType: 'DESTINATION_CHAIN', deadline, confidentiality: 'basic' }); }
    catch (e) { throw new WithdrawError('private_failed', 'The private route could not quote that right now. ' + (e.status === 401 ? '' : 'Try again in a moment, or withdraw publicly.'), 502); }
    const qq = q && q.quote; if (!qq || !qq.depositAddress) throw new WithdrawError('private_failed', 'The private route did not return a deposit address. Try again.', 502);
    target = getAddress(qq.depositAddress); depositAddress = target; receive = BigInt(qq.amountOut || amount); quoteJson = JSON.stringify({ amountIn: qq.amountIn, amountOut: qq.amountOut, timeEstimate: qq.timeEstimate, deadline });
    note = 'Private route: your DOVI account is not linked to this wallet on chain. The amount and timing stay visible, and DOVI can still see the withdrawal. If it fails you are refunded to your DOVI account.';
  }
  ctx.db.prepare('INSERT INTO withdrawals (id, user_id, route, to_address, amount_micro, status, deposit_address, quote_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, userId, route, dest, amount.toString(), 'prepared', depositAddress, quoteJson, t, t);
  audit(ctx.db, { actor: 'user:' + userId, action: 'withdraw.prepare', subject: id, data: { route, amount } });
  return {
    withdrawalId: id, route, to: dest, amountMicro: amount.toString(), receiveMicro: receive.toString(),
    tx: { to: ctx.cfg.base.usdc, value: '0', data: encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [target, amount] }) },
    preview: { lines: [{ label: 'To', value: dest }, { label: 'Route', value: route === 'private' ? 'Private' : 'Public' }, { label: 'You send', value: formatUsd(amount) }, { label: 'Network fee', value: '$0.00' }, { label: 'They receive', value: formatUsd(receive) }], note },
  };
}

async function confirm(ctx, { userId, id, txHash }) {
  const w = ctx.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
  if (!w || w.user_id !== userId) throw new WithdrawError('not_found', 'That withdrawal was not found.', 404);
  if (['done', 'submitted'].includes(w.status)) return view(ctx, w);
  const target = (w.route === 'private' ? w.deposit_address : w.to_address).toLowerCase();
  const from = (userAddress(ctx.db, userId, 'base') || '').toLowerCase();
  if (txHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash))) throw new WithdrawError('bad_tx', 'That transaction id is not valid.');
    const t = await ctx.chain.getTransfer(txHash).catch(() => null);
    if (!t || t.status !== 'success') throw new WithdrawError('not_confirmed', 'The transfer is not confirmed on Base yet.', 409);
    const hit = (t.transfers || []).find((x) => x.token.toLowerCase() === ctx.cfg.base.usdc.toLowerCase() && x.to.toLowerCase() === target && BigInt(x.value) === BigInt(w.amount_micro) && x.from.toLowerCase() === from);
    if (!hit) throw new WithdrawError('mismatch', 'That transaction does not match this withdrawal.', 409);
  } else {
    const found = await ctx.chain.findTransfer({ from: userAddress(ctx.db, userId, 'base'), to: w.route === 'private' ? w.deposit_address : w.to_address, value: BigInt(w.amount_micro) }).catch(() => null);
    if (!found) throw new WithdrawError('not_confirmed', 'The transfer is not confirmed on Base yet.', 409);
    txHash = found.txHash;
  }
  const now = nowMs(ctx);
  if (ctx.db.prepare('SELECT 1 FROM withdrawals WHERE tx_hash = ? AND id <> ?').get(txHash, id)) throw new WithdrawError('mismatch', 'That transaction already settled another withdrawal.', 409);
  const next = w.route === 'private' ? 'submitted' : 'done';
  const won = ctx.db.prepare('UPDATE withdrawals SET status = ?, tx_hash = ?, updated_at = ? WHERE id = ? AND status = ?').run(next, txHash, now, id, 'prepared');
  if (!Number(won.changes)) return view(ctx, ctx.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id));
  if (w.route === 'private') {
    try { await ctx.near.submitDeposit(txHash, w.deposit_address); } catch { /* the status poll finds the deposit on its own */ }
  } else {
    finish(ctx, ctx.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id));
  }
  audit(ctx.db, { actor: 'user:' + userId, action: 'withdraw.confirm', subject: id, data: { txHash, route: w.route } });
  return view(ctx, ctx.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id));
}

function finish(ctx, w) {
  const now = nowMs(ctx);
  ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(w.user_id, 'withdraw', w.tx_hash || w.id, w.to_address, w.amount_micro, 'done', now);
  if (ctx.notify) ctx.notify(w.user_id, { type: 'send_confirmed', title: 'Withdrew ' + formatUsd(BigInt(w.amount_micro)), privateTitle: 'Your withdrawal arrived', body: 'It is on its way to ' + w.to_address.slice(0, 6) + '…' + w.to_address.slice(-4) + (w.route === 'private' ? ' through the private route.' : '.'), amountMicro: w.amount_micro, action: { label: 'View', href: '/app#activity' } });
}

async function refresh(ctx, w) {
  if (w.route !== 'private' || w.status !== 'submitted' || !ctx.near) return w;
  let s; try { s = await ctx.near.status(w.deposit_address); } catch { return w; }
  const st = String(s && s.status || '').toUpperCase();
  const now = nowMs(ctx);
  if (st === 'SUCCESS') { ctx.db.prepare("UPDATE withdrawals SET status = 'done', updated_at = ? WHERE id = ?").run(now, w.id); const nw = ctx.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(w.id); finish(ctx, nw); return nw; }
  if (st === 'REFUNDED' || st === 'FAILED') { ctx.db.prepare('UPDATE withdrawals SET status = ?, detail = ?, updated_at = ? WHERE id = ?').run(st === 'REFUNDED' ? 'refunded' : 'failed', st, now, w.id); return ctx.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(w.id); }
  return w;
}

function view(ctx, w) {
  const q = w.quote_json ? JSON.parse(w.quote_json) : null;
  return { withdrawalId: w.id, route: w.route, status: w.status, to: w.to_address, amountMicro: w.amount_micro, receiveMicro: q && q.amountOut ? String(q.amountOut) : w.amount_micro, txHash: w.tx_hash || null, createdAt: w.created_at, updatedAt: w.updated_at };
}

async function get(ctx, { userId, id }) {
  let w = ctx.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
  if (!w || w.user_id !== userId) throw new WithdrawError('not_found', 'That withdrawal was not found.', 404);
  w = await refresh(ctx, w);
  return view(ctx, w);
}

function list(ctx, userId) {
  return ctx.db.prepare("SELECT * FROM withdrawals WHERE user_id = ? AND status != 'prepared' ORDER BY created_at DESC LIMIT 30").all(userId).map((w) => view(ctx, w));
}

module.exports = { WithdrawError, options, prepare, confirm, get, list };
