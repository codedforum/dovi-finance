'use strict';
const { encodeFunctionData } = require('viem');
const { ERC20_ABI } = require('./chain-client');
const { parseAddress } = require('./ids');
const { checkLimits, recordSpend } = require('./limits');
const { getAddress } = require('./identity');
const { resolveRecipient } = require('./auth/resolve');
const { formatUsd } = require('./money');
const { audit } = require('./audit');

class SendError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.name = 'SendError'; this.code = code; this.status = status; }
}

const TRANSFER_ABI = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }];

async function prepareDirect(ctx, { userId, senderAddress, text, amountMicro }) {
  ctx.registry.assertLive('base');
  const sender = parseAddress(senderAddress);
  const target = await resolveRecipient(ctx, text);
  if (!target.existingUserId) return { mode: 'claim', target: { kind: target.kind, label: target.label } };
  if (target.existingUserId === userId) throw new SendError('self_send', 'You cannot send a payment to yourself.');
  const to = getAddress(ctx.db, target.existingUserId, 'base');
  if (!to) return { mode: 'claim', target: { kind: target.kind, label: target.label } };
  const amount = BigInt(amountMicro);
  const lim = checkLimits(ctx.db, ctx.cfg, { userId, amountMicro: amount, now: ctx.now ? ctx.now() : Date.now() });
  if (!lim.ok) throw new SendError(lim.reason, lim.message || 'That amount is not allowed.');
  return {
    mode: 'direct',
    target: { kind: target.kind, label: target.label },
    to, amountMicro: amount.toString(), sender,
    tx: { to: ctx.cfg.base.usdc, value: '0', data: encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [to, amount] }) },
    preview: { lines: [{ label: 'To', value: target.label }, { label: 'They receive', value: formatUsd(amount) }, { label: 'DOVI fee', value: '$0.00' }, { label: 'You pay', value: formatUsd(amount) }], note: 'Sending to someone who already uses DOVI has no DOVI fee.' },
  };
}

async function confirmDirect(ctx, { userId, txHash = null, from = null, to, amountMicro, label }) {
  const amount = BigInt(amountMicro);
  let hash = txHash;
  if (hash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) throw new SendError('bad_tx', 'That transaction id is not valid.');
    const t = await ctx.chain.getTransfer(hash);
    if (!t || t.status !== 'success') throw new SendError('not_confirmed', 'The transfer is not confirmed on Base yet.', 409);
    const mine = getAddress(ctx.db, userId, 'base');
    if (!mine) throw new SendError('no_wallet', 'Your wallet address is not set up yet.', 409);
    const match = (t.transfers || []).find((x) => x.token.toLowerCase() === ctx.cfg.base.usdc.toLowerCase() && x.from.toLowerCase() === mine.toLowerCase() && x.to.toLowerCase() === to.toLowerCase() && BigInt(x.value) === amount);
    if (!match) throw new SendError('mismatch', 'That transaction does not match this payment.', 409);
  } else {
    if (!from) throw new SendError('bad_request', 'Missing sender address.');
    const mine = getAddress(ctx.db, userId, 'base');
    if (!mine || mine.toLowerCase() !== String(from).toLowerCase()) throw new SendError('not_yours', 'That transfer did not come from your wallet.', 403);
    const found = await ctx.chain.findTransfer({ from: parseAddress(from), to, value: amount });
    if (!found) throw new SendError('not_confirmed', 'The transfer is not confirmed on Base yet.', 409);
    hash = found.txHash;
  }
  const dup = ctx.db.prepare("SELECT 1 FROM activity WHERE kind = 'send' AND ref = ? AND user_id = ?").get(hash, userId);
  if (dup) return { ok: true, duplicate: true, txHash: hash };
  const now = ctx.now ? ctx.now() : Date.now();
  recordSpend(ctx.db, userId, amount, now);
  ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, 'send', hash, label || null, amount.toString(), 'done', now);
  const rcpt = ctx.db.prepare('SELECT user_id FROM addresses WHERE chain = ? AND lower(address) = lower(?)').get('base', to);
  if (rcpt) {
    require('./requests').settlePaid(ctx, { payerUserId: userId, requesterUserId: rcpt.user_id, amountMicro: amount });
    ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(rcpt.user_id, 'receive', hash, null, amount.toString(), 'done', now);
    if (ctx.notify) ctx.notify(rcpt.user_id, { type: 'payment_received', title: 'You received ' + formatUsd(amount), privateTitle: 'You received a payment', body: 'It is in your DOVI account.', amountMicro: amount.toString(), action: { label: 'Open', href: '/app' } });
  }
  if (ctx.notify) ctx.notify(userId, { type: 'send_confirmed', title: 'Sent ' + formatUsd(amount) + (label ? ' to ' + label : ''), privateTitle: 'Your payment was sent', body: 'It settled on Base.', amountMicro: amount.toString(), action: { label: 'View', href: '/app#activity' } });
  audit(ctx.db, { actor: 'user:' + userId, action: 'send.direct', subject: hash, data: { amount, to } });
  return { ok: true, txHash: hash };
}

module.exports = { SendError, prepareDirect, confirmDirect };
