'use strict';
const crypto = require('node:crypto');
const { parse } = require('./parse');
const { evaluate } = require('./policy');
const { resolveRecipient } = require('../auth/resolve');
const { audit } = require('../audit');
const { listActivity } = require('../activity');

const CAPABILITIES = 'I can check your balance, show your history, send money to an X handle or email, request money, and open Add money, Withdraw or cash out to naira for you. I never move money without your approval.';
const NAV_MESSAGE = { cashout: 'I can open cash out for you. You pick your bank and enter your account number.', add: 'I can open Add money for you.', withdraw: 'I can open Withdraw for you, to move USDC to a Base wallet you control.', giveaways: 'I can open Giveaways for you, to pick winners from your X post.' };
const LLM_NAV = { cash_out: 'cashout', add_money: 'add', withdraw: 'withdraw', giveaway: 'giveaways' };

function newIntentId() { return crypto.randomBytes(12).toString('hex'); }
const replacer = (_, v) => (typeof v === 'bigint' ? v.toString() : v);

async function handle(ctx, userId, text, { source = 'web' } = {}) {
  let typed = parse(text);
  const now = ctx.now ? ctx.now() : Date.now();
  if (typed.error === 'unknown' && ctx.agentLLM) {
    try {
      const idn = ctx.db.prepare("SELECT label FROM identities WHERE user_id = ? AND kind = 'x'").get(userId);
      const r = await ctx.agentLLM.ask({ text, userId, handle: idn && idn.label ? String(idn.label).replace(/^@/, '') : null, now });
      if (r.action === 'send' || r.action === 'request') { const p = parse(r.command); typed = p.error ? { error: 'unknown', message: r.reply || typed.message } : p; }
      else if (['balance', 'history', 'help'].includes(r.action)) typed = { kind: r.action };
      else if (LLM_NAV[r.action]) typed = { kind: 'navigate', target: LLM_NAV[r.action], message: r.reply || NAV_MESSAGE[LLM_NAV[r.action]] };
      else if (r.reply) return { ok: true, intent: 'chat', message: r.reply };
    } catch { /* the model is optional: without an answer the plain reply below is used */ }
  }
  if (typed.error) {
    audit(ctx.db, { actor: 'user:' + userId, action: 'agent.rejected', data: { code: typed.error, source } });
    return { ok: false, code: typed.error, message: typed.message, capabilities: CAPABILITIES };
  }
  if (typed.kind === 'navigate') return { ok: true, intent: 'navigate', target: typed.target, message: typed.message || NAV_MESSAGE[typed.target] };
  if (typed.kind === 'help') return { ok: true, intent: 'help', message: CAPABILITIES };
  if (typed.kind === 'balance') return { ok: true, intent: 'balance', needs: 'client_balance', message: 'Checking your balance on Base.' };
  if (typed.kind === 'history') return { ok: true, intent: 'history', activity: listActivity(ctx.db, userId, { limit: 10 }) };
  if (typed.kind === 'claim') return { ok: true, intent: 'claim', message: 'Open the payment link you were sent to claim it. I cannot claim for you.' };

  let target;
  try { target = await resolveRecipient(ctx, typed.to.kind === 'x' ? '@' + typed.to.handle : typed.to.handle); }
  catch (e) { return { ok: false, code: e.code || 'resolve_failed', message: e.message }; }
  const intent = { ...typed, to: { kind: target.kind, providerId: target.providerId, label: target.label, existingUserId: target.existingUserId } };
  const verdict = evaluate(ctx, userId, intent);
  const id = newIntentId();
  const status = verdict.ok ? 'previewed' : 'rejected';
  ctx.db.prepare('INSERT INTO intents (id, user_id, source, raw, typed, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, source, String(text).slice(0, 280), JSON.stringify(intent, replacer), status, now);
  audit(ctx.db, { actor: 'user:' + userId, action: 'agent.' + status, subject: id, data: { kind: intent.kind, reasons: verdict.reasons } });
  if (!verdict.ok) return { ok: false, code: verdict.reasons[0], message: verdict.message };
  return { ok: true, intentId: id, intent: intent.kind, preview: verdict.preview };
}

function approve(ctx, userId, intentId) {
  const row = ctx.db.prepare('SELECT * FROM intents WHERE id = ?').get(String(intentId));
  if (!row || row.user_id !== userId) return { ok: false, code: 'not_found', message: 'That request was not found.' };
  if (row.status !== 'previewed') return { ok: false, code: 'bad_state', message: row.status === 'approved' || row.status === 'done' ? 'That was already approved.' : 'That request cannot be approved.' };
  const intent = JSON.parse(row.typed);
  const verdict = evaluate(ctx, userId, { ...intent, amountMicro: BigInt(intent.amountMicro) });
  if (!verdict.ok) return { ok: false, code: verdict.reasons[0], message: verdict.message };
  ctx.db.prepare("UPDATE intents SET status = 'approved' WHERE id = ?").run(row.id);
  audit(ctx.db, { actor: 'user:' + userId, action: 'agent.approved', subject: row.id });
  if (intent.kind === 'send') return { ok: true, action: { type: 'create_claim', kind: intent.to.kind, providerId: intent.to.providerId, label: intent.to.label, amountMicro: String(intent.amountMicro), note: intent.note || null, idempotencyKey: 'agent:' + row.id } };
  if (intent.kind === 'request') return { ok: true, action: { type: 'create_request', kind: intent.to.kind, providerId: intent.to.providerId, label: intent.to.label, amountMicro: String(intent.amountMicro), note: intent.note || null } };
  return { ok: false, code: 'unsupported', message: 'Nothing to approve.' };
}

module.exports = { handle, approve, CAPABILITIES };
