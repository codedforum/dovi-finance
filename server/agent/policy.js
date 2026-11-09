'use strict';
const { checkLimits } = require('../limits');
const { feeFor, formatUsd } = require('../money');
const { userHasIdentity, findUserByIdentity } = require('../identity');

function hasPaidBefore(db, userId, label) {
  return !!db.prepare("SELECT 1 FROM claims WHERE sender_user_id = ? AND recipient_label = ? AND status IN ('funded','claimed','expired') LIMIT 1").get(userId, label);
}

function evaluate(ctx, userId, intent) {
  const reasons = [];
  if (!ctx.registry.isLive('base')) return { ok: false, reasons: ['chain_not_live'], message: 'DOVI is paused right now. Please try again soon.' };
  if (['balance', 'history', 'claim'].includes(intent.kind)) return { ok: true, reasons, preview: { kind: intent.kind } };
  if (intent.kind === 'request') {
    if (userHasIdentity(ctx.db, userId, intent.to.kind, intent.to.kind === 'x' ? '0' : intent.to.handle) && intent.to.kind === 'email') return { ok: false, reasons: ['self_send'], message: 'You cannot request money from yourself.' };
    return { ok: true, reasons, preview: { kind: 'request', lines: [{ label: 'You ask', value: intent.to.label }, { label: 'Amount', value: formatUsd(intent.amountMicro) }] } };
  }
  if (intent.kind === 'send') {
    const lim = checkLimits(ctx.db, ctx.cfg, { userId, amountMicro: intent.amountMicro, now: ctx.now ? ctx.now() : Date.now() });
    if (!lim.ok) return { ok: false, reasons: [lim.reason], message: lim.message || 'That amount is not allowed.' };
    const fee = feeFor(intent.amountMicro, ctx.cfg.claim);
    const first = !hasPaidBefore(ctx.db, userId, intent.to.label);
    const lines = [
      { label: 'To', value: intent.to.label },
      { label: 'They receive', value: formatUsd(intent.amountMicro) },
      { label: 'DOVI fee', value: formatUsd(fee) },
      { label: 'You pay', value: formatUsd(intent.amountMicro + fee) },
    ];
    return { ok: true, reasons, firstTimeRecipient: first, preview: { kind: 'send', lines, warning: first ? 'You have not paid ' + intent.to.label + ' before. Check the name is right.' : null, note: 'The fee is only charged if they claim it.' } };
  }
  return { ok: false, reasons: ['unsupported'], message: 'I cannot do that yet.' };
}

module.exports = { evaluate, hasPaidBefore };
