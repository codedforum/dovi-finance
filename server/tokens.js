'use strict';
/* Payments in extra tokens (VIBES on the test network). They use the same claim contract, the same recipient lookup and the
   same attestation as USDC payments, but live in their own table so USDC totals, limits and statements are never mixed with them. */
const { encodeFunctionData, parseUnits, formatUnits } = require('viem');
const abi4 = require('./abi/DoviClaimV4.json');
const { ERC20_ABI } = require('./chain-client');
const { newClaimId, recipientHash, normalizeProviderId, parseAddress, IdError } = require('./ids');
const { audit } = require('./audit');
const { recordActivity } = require('./activity');
const { findUserByIdentity, userHasIdentity } = require('./identity');
const emails = require('./emails/templates');

const ON = { OPEN: 1, CLAIMED: 2, RECLAIMED: 3 };
class TokenError extends Error { constructor(code, message, status = 400) { super(message || code); this.name = 'TokenError'; this.code = code; this.status = status; } }

const nowMs = (ctx) => (ctx.now ? ctx.now() : Date.now());
const nowSec = (ctx) => Math.floor(nowMs(ctx) / 1000);

function tokenBySymbol(ctx, symbol) {
  const t = (ctx.cfg.tokens || []).find((x) => x.symbol === String(symbol || '').toUpperCase());
  if (!t) throw new TokenError('token_off', 'That token is not available yet.', 404);
  return t;
}
function show(units, decimals) {
  const s = formatUnits(BigInt(units), decimals);
  const [i, f = ''] = s.split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f.slice(0, 4).replace(/0+$/, '') : '').replace(/\.$/, '');
}
function parseAmount(text, t) {
  const s = String(text == null ? '' : text).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new TokenError('bad_amount', 'Enter a valid amount.');
  const u = parseUnits(s, t.decimals);
  if (u < t.minUnits) throw new TokenError('below_minimum', 'The minimum is ' + show(t.minUnits, t.decimals) + ' ' + t.symbol + '.');
  if (u > t.perClaimUnits) throw new TokenError('above_cap', 'The limit per payment is ' + show(t.perClaimUnits, t.decimals) + ' ' + t.symbol + '.');
  return u;
}
function load(ctx, id) {
  const row = ctx.db.prepare('SELECT * FROM token_claims WHERE id = ?').get(String(id));
  if (!row) throw new TokenError('not_found', 'That payment was not found.', 404);
  return row;
}
function notify(ctx, userId, evt) { if (ctx.notify && userId) ctx.notify(userId, evt); }
function view(ctx, row, { includeTxs = false } = {}) {
  const t = tokenBySymbol(ctx, row.symbol);
  const expired = row.status === 'funded' && row.expiry <= nowSec(ctx);
  const v = { claimId: row.id, symbol: row.symbol, decimals: t.decimals, amountUnits: row.amount_units, amountText: show(row.amount_units, t.decimals) + ' ' + row.symbol, status: expired ? 'expired' : row.status, to: row.recipient_label, kind: row.recipient_kind, expiry: row.expiry, note: row.note || null, createdAt: row.created_at, link: ctx.cfg.publicUrl + '/app?tclaim=' + row.id };
  if (includeTxs) v.txs = txsFor(ctx, row);
  return v;
}
function txsFor(ctx, row) {
  return [
    { to: row.token, value: '0', data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ctx.cfg.claim.contract, BigInt(row.amount_units)] }), label: 'Approve' },
    { to: ctx.cfg.claim.contract, value: '0', data: encodeFunctionData({ abi: abi4, functionName: 'createTokenClaim', args: [row.token, row.id, row.recipient_hash, BigInt(row.amount_units), BigInt(row.expiry)] }), label: 'Send' },
  ];
}

function options(ctx) {
  const list = (ctx.cfg.tokens || []).map((t) => ({ symbol: t.symbol, name: t.name, decimals: t.decimals, address: t.address, min: formatUnits(t.minUnits, t.decimals), max: formatUnits(t.perClaimUnits, t.decimals), test: !!t.test, faucet: !!t.faucet }));
  return { enabled: list.length > 0 && !!ctx.cfg.claim.contract, tokens: list };
}
async function balances(ctx, address) {
  const out = {};
  for (const t of ctx.cfg.tokens || []) {
    try { const b = await ctx.chain.tokenBalance(t.address, address); out[t.symbol] = { units: b.toString(), text: show(b, t.decimals) }; } catch { out[t.symbol] = null; }
  }
  return out;
}

async function checkBalance(ctx, { symbol, amount, address }) {
  const t = tokenBySymbol(ctx, symbol);
  const units = parseAmount(amount, t);
  let have;
  try { have = await ctx.chain.tokenBalance(t.address, parseAddress(address)); } catch { return; }
  if (have < units) throw new TokenError('insufficient', 'You have ' + show(have, t.decimals) + ' ' + t.symbol + ' and this is ' + show(units, t.decimals) + '. Lower the amount' + (t.faucet ? ' or tap Get 100 test ' + t.symbol + '.' : '.'), 409);
}

function createDraft(ctx, { userId, senderAddress, symbol, amount, kind, providerId, label, idempotencyKey = null, note = null }) {
  ctx.registry.assertLive('base');
  if (!ctx.cfg.claim.contract) throw new TokenError('not_configured', 'Payments are not switched on yet.', 503);
  const t = tokenBySymbol(ctx, symbol);
  let sender; let pid;
  try { sender = parseAddress(senderAddress); pid = normalizeProviderId(kind, providerId); } catch (e) { if (e instanceof IdError) throw new TokenError(e.code || 'bad_recipient', e.message); throw e; }
  const units = parseAmount(amount, t);
  if (idempotencyKey) { const dup = ctx.db.prepare('SELECT * FROM token_claims WHERE sender_user_id = ? AND idempotency_key = ?').get(userId, idempotencyKey); if (dup) return view(ctx, dup, { includeTxs: true }); }
  if (ctx.configDrift && ctx.configDrift.length) throw new TokenError('config_drift', 'DOVI is being checked for a moment. Please try again soon.', 503);
  if (userHasIdentity(ctx.db, userId, kind, pid)) throw new TokenError('self_send', 'You cannot send a payment to yourself.');
  const draftWindow = nowMs(ctx) - 30 * 60 * 1000;
  const open = ctx.db.prepare("SELECT COUNT(*) n FROM token_claims WHERE sender_user_id = ? AND status = 'draft' AND created_at > ?").get(userId, draftWindow).n;
  if (open >= 5) throw new TokenError('too_many_drafts', 'You have several payments waiting to be confirmed. Finish or wait a few minutes.', 429);
  const id = newClaimId(); const t0 = nowMs(ctx); const expiry = nowSec(ctx) + ctx.cfg.claim.expirySeconds;
  ctx.db.prepare('INSERT INTO token_claims (id, sender_user_id, sender_address, recipient_kind, recipient_hash, recipient_provider_id, recipient_label, symbol, token, amount_units, status, expiry, idempotency_key, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, sender, kind, recipientHash(kind, pid), pid, String(label || pid).slice(0, 80), t.symbol, t.address, units.toString(), 'draft', expiry, idempotencyKey, note ? String(note).slice(0, 140) : null, t0, t0);
  audit(ctx.db, { actor: 'user:' + userId, action: 'token.draft', subject: id, data: { symbol: t.symbol, units: units.toString(), kind } });
  return view(ctx, load(ctx, id), { includeTxs: true });
}

async function confirmFunded(ctx, { claimId, userId, txHash }) {
  const row = load(ctx, claimId);
  if (row.sender_user_id !== userId) throw new TokenError('not_yours', 'That payment is not yours.', 403);
  if (row.status === 'funded') return view(ctx, row);
  if (row.status !== 'draft') throw new TokenError('bad_state', 'That payment cannot be funded now.');
  const on = await ctx.chain.readTokenClaim(claimId);
  if (on.status !== ON.OPEN) throw new TokenError('not_funded_yet', 'The payment is not confirmed on Base yet.', 409);
  const same = on.sender.toLowerCase() === row.sender_address.toLowerCase() && on.token.toLowerCase() === row.token.toLowerCase() && BigInt(on.amount) === BigInt(row.amount_units) && Number(on.expiry) === row.expiry && String(on.recipientHash).toLowerCase() === row.recipient_hash.toLowerCase();
  if (!same) { audit(ctx.db, { actor: 'system', action: 'token.fund_mismatch', subject: claimId }); throw new TokenError('mismatch', 'The confirmed payment does not match what was prepared.', 409); }
  const won = ctx.db.prepare("UPDATE token_claims SET status = 'funded', fund_tx = ?, updated_at = ? WHERE id = ? AND status = 'draft'").run(txHash || null, nowMs(ctx), claimId);
  if (!Number(won.changes)) return view(ctx, load(ctx, claimId));
  audit(ctx.db, { actor: 'user:' + userId, action: 'token.funded', subject: claimId, data: { txHash } });
  const fresh = load(ctx, claimId); const v = view(ctx, fresh);
  recordActivity(ctx.db, { userId, kind: 'token_sent', ref: claimId, counterparty: row.recipient_label, amountText: v.amountText, now: nowMs(ctx) });
  const sender = ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
  notify(ctx, userId, { ref: claimId, type: 'claim_created', title: v.amountText + ' ready to claim', privateTitle: 'Payment ready to claim', body: 'Waiting for ' + row.recipient_label + '. Share the link if they have not seen it.' });
  if (row.recipient_kind === 'email' && ctx.mailer) {
    const unsub = require('./unsubscribe');
    if (!unsub.isOptedOut(ctx.db, row.recipient_provider_id)) {
      const m = emails.render('tokenInvite', { fromName: require('./xdm').safeName(sender && sender.display_name), amountText: v.amountText, link: v.link, expiry: row.expiry, now: nowMs(ctx) }, { unsubUrl: unsub.link(ctx, row.recipient_provider_id), business: ctx.cfg.business });
      Promise.resolve(ctx.mailer.send({ to: row.recipient_provider_id, ...m })).catch(() => {});
    }
  }
  const rcpt = findUserByIdentity(ctx.db, row.recipient_kind, row.recipient_provider_id);
  if (rcpt) notify(ctx, rcpt.id, { type: 'payment_received', title: ((sender && sender.display_name) || 'Someone') + ' sent you ' + v.amountText, privateTitle: 'You have a payment waiting', body: 'Open it to claim it.', action: { label: 'Claim', href: '/app?tclaim=' + claimId } });
  return v;
}

function publicView(ctx, claimId) {
  const row = load(ctx, claimId);
  const sender = ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(row.sender_user_id);
  const v = view(ctx, row);
  return { claimId: v.claimId, symbol: v.symbol, amountText: v.amountText, status: row.status === 'draft' ? 'pending' : v.status, to: v.to, kind: v.kind, expiry: v.expiry, from: (sender && sender.display_name) || 'Someone', note: v.note };
}

function isRecipient(ctx, row, userId) {
  return ctx.db.prepare('SELECT provider_id FROM identities WHERE user_id = ? AND kind = ?').all(userId, row.recipient_kind)
    .some((i) => recipientHash(row.recipient_kind, i.provider_id).toLowerCase() === row.recipient_hash.toLowerCase());
}

async function prepareClaim(ctx, { claimId, userId, recipientAddress }) {
  ctx.registry.assertLive('base');
  const row = load(ctx, claimId);
  const recipient = parseAddress(recipientAddress);
  const st = view(ctx, row).status;
  if (st === 'expired') throw new TokenError('expired', 'This payment has expired. The sender can take it back.', 410);
  if (st !== 'funded') throw new TokenError('not_claimable', st === 'claimed' ? 'This payment was already claimed.' : 'This payment is not ready to claim.', st === 'claimed' ? 410 : 409);
  if (!isRecipient(ctx, row, userId)) { audit(ctx.db, { actor: 'user:' + userId, action: 'token.refused_wrong_identity', subject: claimId }); throw new TokenError('not_recipient', 'This payment is for ' + row.recipient_label + '. Sign in as that account to claim it.', 403); }
  const on = await ctx.chain.readTokenClaim(claimId);
  if (on.status !== ON.OPEN) throw new TokenError('not_claimable', 'This payment is no longer available.', 409);
  const deadline = nowSec(ctx) + 600;
  const attestation = await ctx.attester.sign({ claimId, recipient, deadline });
  audit(ctx.db, { actor: 'user:' + userId, action: 'token.attested', subject: claimId, data: { recipient, deadline } });
  return { claimId, recipient, deadline, attestation, tx: { to: ctx.cfg.claim.contract, value: '0', data: encodeFunctionData({ abi: abi4, functionName: 'claimToken', args: [claimId, recipient, BigInt(deadline), attestation] }) } };
}

async function confirmClaimed(ctx, { claimId, userId, txHash }) {
  const row = load(ctx, claimId);
  if (row.status === 'claimed') return view(ctx, row);
  if (row.status !== 'funded') throw new TokenError('bad_state', 'That payment cannot be completed now.');
  if (!isRecipient(ctx, row, userId)) throw new TokenError('not_recipient', 'This payment is for ' + row.recipient_label + '. Sign in as that account.', 403);
  const on = await ctx.chain.readTokenClaim(claimId);
  if (on.status !== ON.CLAIMED) throw new TokenError('not_claimed_yet', 'The claim is not confirmed on Base yet.', 409);
  const won = ctx.db.prepare("UPDATE token_claims SET status = 'claimed', claim_tx = ?, claimed_by_user_id = ?, updated_at = ? WHERE id = ? AND status = 'funded'").run(txHash || null, userId, nowMs(ctx), claimId);
  if (!Number(won.changes)) return view(ctx, load(ctx, claimId));
  audit(ctx.db, { actor: 'user:' + userId, action: 'token.claimed', subject: claimId, data: { txHash } });
  const v = view(ctx, load(ctx, claimId));
  recordActivity(ctx.db, { userId, kind: 'token_received', ref: claimId, counterparty: null, amountText: v.amountText, now: nowMs(ctx) });
  notify(ctx, row.sender_user_id, { ref: claimId, type: 'claim_completed', title: row.recipient_label + ' claimed ' + v.amountText, privateTitle: 'Your payment was claimed', body: 'It arrived. Thanks for using DOVI.' });
  notify(ctx, userId, { ref: claimId, type: 'payment_received', title: 'You received ' + v.amountText, privateTitle: 'You received a payment', body: 'It is in your DOVI account.' });
  return v;
}

async function prepareReclaim(ctx, { claimId, userId }) {
  const row = load(ctx, claimId);
  if (row.sender_user_id !== userId) throw new TokenError('not_yours', 'That payment is not yours.', 403);
  if (row.status !== 'funded') throw new TokenError('bad_state', row.status === 'claimed' ? 'It was already claimed.' : 'That payment cannot be taken back.');
  const on = await ctx.chain.readTokenClaim(claimId);
  if (on.status !== ON.OPEN) throw new TokenError('not_open', 'This payment is no longer open on Base. Refresh to see its latest status.', 409);
  return { claimId, tx: { to: ctx.cfg.claim.contract, value: '0', data: encodeFunctionData({ abi: abi4, functionName: 'reclaimToken', args: [claimId] }) } };
}

async function confirmReclaimed(ctx, { claimId, userId, txHash }) {
  const row = load(ctx, claimId);
  if (row.sender_user_id !== userId) throw new TokenError('not_yours', 'That payment is not yours.', 403);
  if (row.status === 'returned') return view(ctx, row);
  const on = await ctx.chain.readTokenClaim(claimId);
  if (on.status !== ON.RECLAIMED) throw new TokenError('not_returned_yet', 'The refund is not confirmed on Base yet.', 409);
  const won = ctx.db.prepare("UPDATE token_claims SET status = 'returned', reclaim_tx = ?, updated_at = ? WHERE id = ? AND status <> 'returned'").run(txHash || null, nowMs(ctx), claimId);
  if (!Number(won.changes)) return view(ctx, load(ctx, claimId));
  audit(ctx.db, { actor: 'user:' + userId, action: 'token.reclaimed', subject: claimId, data: { txHash } });
  const v = view(ctx, load(ctx, claimId));
  recordActivity(ctx.db, { userId, kind: 'token_returned', ref: claimId, counterparty: row.recipient_label, amountText: v.amountText, now: nowMs(ctx) });
  notify(ctx, userId, { ref: claimId, type: 'claim_returned', title: v.amountText + ' returned to you', privateTitle: 'A payment was returned to you', body: 'You got back the full amount.' });
  return v;
}

function listFor(ctx, userId) {
  const sent = ctx.db.prepare("SELECT * FROM token_claims WHERE sender_user_id = ? AND status <> 'draft' ORDER BY created_at DESC LIMIT 50").all(userId).map((r) => view(ctx, r));
  const idents = ctx.db.prepare('SELECT kind, provider_id FROM identities WHERE user_id = ?').all(userId);
  const hashes = idents.map((i) => recipientHash(i.kind, i.provider_id).toLowerCase());
  const incoming = hashes.length ? ctx.db.prepare("SELECT * FROM token_claims WHERE status = 'funded' AND LOWER(recipient_hash) IN (" + hashes.map(() => '?').join(',') + ') ORDER BY created_at DESC LIMIT 50').all(...hashes).map((r) => publicView(ctx, r.id)) : [];
  return { sent, incoming };
}

module.exports = { TokenError, checkBalance, options, balances, createDraft, confirmFunded, publicView, prepareClaim, confirmClaimed, prepareReclaim, confirmReclaimed, listFor, parseAmount, show };
