'use strict';
const { encodeFunctionData } = require('viem');
const abi = require('./abi/DoviClaim.json');
const { ERC20_ABI } = require('./chain-client');
const { newClaimId, recipientHash, normalizeProviderId, parseAddress, IdError } = require('./ids');
const { feeFor, formatUsd } = require('./money');
const { checkLimits, recordSpend } = require('./limits');
const { audit } = require('./audit');
const { findUserByIdentity, userHasIdentity } = require('./identity');
const emails = require('./emails/templates');

const ON = { NONE: 0, OPEN: 1, CLAIMED: 2, RECLAIMED: 3 };

class ClaimError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.name = 'ClaimError'; this.code = code; this.status = status; }
}

const nowSec = (ctx) => Math.floor((ctx.now ? ctx.now() : Date.now()) / 1000);
const nowMs = (ctx) => (ctx.now ? ctx.now() : Date.now());

function effectiveStatus(row, ctx) {
  if (row.status === 'funded' && nowSec(ctx) > row.expiry) return 'expired';
  return row.status;
}

function load(ctx, claimId) {
  if (/^[2-9a-hj-km-np-zA-HJ-NP-Z]{8}$/.test(String(claimId))) { const bs = ctx.db.prepare('SELECT * FROM claims WHERE short = ?').get(String(claimId)); if (bs) return bs; }
  if (!/^0x[0-9a-f]{64}$/.test(String(claimId))) throw new ClaimError('claim_not_found', 'That payment link is not valid.', 404);
  const row = ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!row) throw new ClaimError('claim_not_found', 'That payment link is not valid.', 404);
  return row;
}

function notify(ctx, userId, evt) { if (ctx.notify && userId) ctx.notify(userId, evt); }

const SHORT_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
function newShort(db) {
  const { randomInt } = require('node:crypto');
  for (let n = 0; n < 8; n++) {
    let s = ''; for (let i = 0; i < 8; i++) s += SHORT_ALPHABET[randomInt(SHORT_ALPHABET.length)];
    if (!db.prepare('SELECT 1 FROM claims WHERE short = ?').get(s)) return s;
  }
  throw new Error('short_code_exhausted');
}
function claimLink(ctx, row) { return ctx.cfg.publicUrl + (row.short ? '/c/' + row.short : '/claim/' + row.id); }

function mail(ctx, to, kind, data, ref) {
  if (!ctx.mailer) return;
  const unsubscribe = require('./unsubscribe');
  const optional = emails.OPTIONAL_KINDS.has(kind);
  if (optional && unsubscribe.isOptedOut(ctx.db, to)) { audit(ctx.db, { actor: 'system', action: 'email.skipped_optout', subject: ref, data: { kind } }); return; }
  const m = emails.render(kind, data, { unsubUrl: optional ? unsubscribe.link(ctx, to) : null, business: ctx.cfg.business });
  Promise.resolve(ctx.mailer.send({ to, ...m })).then(
    () => audit(ctx.db, { actor: 'system', action: 'email.sent', subject: ref, data: { kind } }),
    (e) => audit(ctx.db, { actor: 'system', action: 'email.failed', subject: ref, data: { kind, error: String(e && e.message || e).slice(0, 120) } }),
  );
}

function lockFor(ctx, lockSeconds) {
  if (lockSeconds == null || lockSeconds === '' || Number(lockSeconds) === 0) return null;
  if (!ctx.cfg.claim.lockEnabled) throw new ClaimError('lock_off', 'Locked payouts are not switched on yet.', 503);
  const secs = Number(lockSeconds);
  if (!Number.isInteger(secs) || secs < 3600 || secs > ctx.cfg.claim.expirySeconds) throw new ClaimError('bad_lock', 'A lock can last from 1 hour to ' + Math.floor(ctx.cfg.claim.expirySeconds / 86400) + ' days.');
  return nowSec(ctx) + secs;
}

function autoFor(ctx, auto) {
  if (!auto) return null;
  const nowS = nowSec(ctx); const latest = nowS + ctx.cfg.claim.expirySeconds - 3600;
  if (auto.mode === 'time') {
    const at = Number(auto.at);
    if (!Number.isInteger(at) || at < nowS + 600 || at > latest) throw new ClaimError('bad_release_time', 'Pick a release time from 10 minutes from now to ' + Math.floor(ctx.cfg.claim.expirySeconds / 86400 - 1) + ' days from now.');
    return { rule: 'time', at, hours: null };
  }
  if (auto.mode === 'post') {
    const hours = Number(auto.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours * 3600 > latest - nowS) throw new ClaimError('bad_release_hours', 'Choose 1 hour up to ' + Math.floor((latest - nowS) / 3600) + ' hours.');
    return { rule: 'post', at: null, hours };
  }
  throw new ClaimError('bad_release_mode', 'That release option is not available.');
}

function createDraft(ctx, { userId, senderAddress, kind, providerId, label, amountMicro, idempotencyKey = null, note = null, lockSeconds = null, needsRelease = false, autoRelease = null, postId = null }) {
  ctx.registry.assertLive('base');
  if (!ctx.cfg.claim.contract) throw new ClaimError('not_configured', 'Payments are not switched on yet.', 503);
  const sender = parseAddress(senderAddress);
  const pid = normalizeProviderId(kind, providerId);
  let amount;
  try { amount = BigInt(amountMicro); } catch { throw new ClaimError('bad_amount', 'Enter a valid amount.'); }

  if (idempotencyKey) {
    const dup = ctx.db.prepare('SELECT * FROM claims WHERE sender_user_id = ? AND idempotency_key = ?').get(userId, idempotencyKey);
    if (dup) return view(ctx, dup, { includeTxs: true });
  }

  if (ctx.configDrift && ctx.configDrift.length) throw new ClaimError('config_drift', 'DOVI is being checked for a moment. Please try again soon.', 503);

  const self = userHasIdentity(ctx.db, userId, kind, pid);
  if (self) throw new ClaimError('self_send', 'You cannot send a payment to yourself.');

  const lim = checkLimits(ctx.db, ctx.cfg, { userId, amountMicro: amount, now: nowMs(ctx) });
  if (!lim.ok) throw new ClaimError(lim.reason, lim.message || 'That amount is not allowed.');

  const lockUntil = lockFor(ctx, lockSeconds);
  const auto = autoFor(ctx, autoRelease);
  if (auto && auto.rule === 'post' && !postId) throw new ClaimError('post_required', 'Add the link to their post.');
  if (auto) needsRelease = true;
  const feeMicro = feeFor(amount, ctx.cfg.claim);
  const id = newClaimId();
  const expiry = nowSec(ctx) + ctx.cfg.claim.expirySeconds;
  const hash = recipientHash(kind, pid);
  const t = nowMs(ctx);
  ctx.db.prepare('INSERT INTO claims (id, sender_user_id, sender_address, recipient_kind, recipient_hash, recipient_provider_id, recipient_label, amount_micro, fee_micro, chain, status, expiry, idempotency_key, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, sender, kind, hash, pid, String(label || pid).slice(0, 80), amount.toString(), feeMicro.toString(), 'base', 'draft', expiry, idempotencyKey, note ? String(note).slice(0, 140) : null, t, t);
  ctx.db.prepare('UPDATE claims SET short = ?, lock_until = ?, needs_release = ? WHERE id = ?').run(newShort(ctx.db), lockUntil, needsRelease ? 1 : 0, id);
  if (auto) ctx.db.prepare('UPDATE claims SET release_rule = ?, release_at = ?, post_hours = ?, post_id = ? WHERE id = ?').run(auto.rule, auto.at, auto.hours, postId ? String(postId) : null, id);
  audit(ctx.db, { actor: 'user:' + userId, action: 'claim.draft', subject: id, data: { amount, feeMicro, kind } });
  return view(ctx, ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(id), { includeTxs: true });
}

function txsFor(ctx, row) {
  const total = BigInt(row.amount_micro) + BigInt(row.fee_micro);
  return [
    { to: ctx.cfg.base.usdc, value: '0', data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ctx.cfg.claim.contract, total] }), label: 'Approve' },
    { to: ctx.cfg.claim.contract, value: '0', data: row.lock_until ? encodeFunctionData({ abi, functionName: 'createClaimLocked', args: [row.id, row.recipient_hash, BigInt(row.amount_micro), BigInt(row.expiry), BigInt(row.lock_until)] }) : encodeFunctionData({ abi, functionName: 'createClaim', args: [row.id, row.recipient_hash, BigInt(row.amount_micro), BigInt(row.expiry)] }), label: 'Send' },
  ];
}

function view(ctx, row, { includeTxs = false } = {}) {
  const amount = BigInt(row.amount_micro);
  const fee = BigInt(row.fee_micro);
  const out = {
    claimId: row.id,
    status: effectiveStatus(row, ctx),
    amountMicro: amount.toString(),
    feeMicro: fee.toString(),
    totalMicro: (amount + fee).toString(),
    expiry: row.expiry,
    to: row.recipient_label,
    createdAt: row.created_at,
    fundedAt: row.funded_at || null,
    claimedAt: row.claimed_at || null,
    returnedAt: row.returned_at || null,
    expiredAt: row.expired_at || null,
    lockUntil: row.lock_until || null, needsRelease: !!row.needs_release, releasedAt: row.released_at || null, releaseRule: row.release_rule || null, releaseAt: row.release_at || null, postHours: row.post_hours || null, postId: row.post_id || null, releaseNote: row.release_note || null,
    link: claimLink(ctx, row),
    preview: {
      lines: [
        { label: 'They receive', value: formatUsd(amount) },
        { label: 'DOVI fee', value: formatUsd(fee) },
        { label: 'You pay', value: formatUsd(amount + fee) },
      ],
      note: 'The fee is only charged if they claim it. If nobody claims it, you get everything back.',
    },
  };
  if (includeTxs && row.status === 'draft') out.txs = txsFor(ctx, row);
  return out;
}

function announce(ctx, row, sender) {
  if (row.recipient_kind === 'email') mail(ctx, row.recipient_provider_id, 'claimInvite', { fromName: require('./xdm').safeName(sender && sender.display_name), amountMicro: row.amount_micro, link: claimLink(ctx, row), expiry: row.expiry, now: nowMs(ctx) }, row.id);
  if (row.recipient_kind === 'x' && row.source !== 'x') {
    const queued = require('./xdm').queueClaimDm(ctx, row, { from: require('./xdm').safeName(sender && sender.display_name), link: claimLink(ctx, row), amt: formatUsd(BigInt(row.amount_micro)) });
    if (!queued) notify(ctx, row.sender_user_id, { ref: row.id, type: 'dm_skipped', title: 'Share your claim link with ' + row.recipient_label, privateTitle: 'Share your claim link', body: 'We could not message them on X. Send them the link from Activity.', action: { label: 'Open Activity', href: '/app#activity' } });
  }
  const rcpt = findUserByIdentity(ctx.db, row.recipient_kind, row.recipient_provider_id);
  if (rcpt) notify(ctx, rcpt.id, { type: 'payment_received', title: (sender && sender.display_name || 'Someone') + ' sent you ' + formatUsd(BigInt(row.amount_micro)), privateTitle: 'You have a payment waiting', body: 'Open it to claim it.', amountMicro: row.amount_micro, action: { label: 'Claim', href: '/claim/' + row.id } });
}

function release(ctx, { claimId, userId }) {
  const row = load(ctx, claimId);
  if (row.sender_user_id !== userId) throw new ClaimError('not_yours', 'That payment is not yours.', 403);
  if (!row.needs_release) throw new ClaimError('no_release', 'This payment does not need your approval.', 409);
  if (effectiveStatus(row, ctx) !== 'funded') throw new ClaimError('bad_state', 'This payment cannot be approved now.', 409);
  if (row.released_at) return view(ctx, row);
  ctx.db.prepare('UPDATE claims SET released_at = ?, updated_at = ? WHERE id = ?').run(nowMs(ctx), nowMs(ctx), claimId);
  audit(ctx.db, { actor: 'user:' + userId, action: 'claim.released', subject: claimId });
  const fresh = load(ctx, claimId);
  const sender = ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
  announce(ctx, fresh, sender);
  return view(ctx, fresh);
}

async function confirmFunded(ctx, { claimId, userId, txHash }) {
  const row = load(ctx, claimId);
  if (row.sender_user_id !== userId) throw new ClaimError('not_yours', 'That payment is not yours.', 403);
  if (row.status === 'funded') return view(ctx, row);
  if (row.status !== 'draft') throw new ClaimError('bad_state', 'That payment cannot be funded now.');
  const on = await ctx.chain.readClaim(claimId);
  if (on.status !== ON.OPEN) throw new ClaimError('not_funded_yet', 'The payment is not confirmed on Base yet.', 409);
  const same = on.sender.toLowerCase() === row.sender_address.toLowerCase()
    && BigInt(on.amount) === BigInt(row.amount_micro)
    && BigInt(on.fee) === BigInt(row.fee_micro)
    && Number(on.expiry) === row.expiry
    && String(on.recipientHash).toLowerCase() === row.recipient_hash.toLowerCase()
    && (!row.lock_until || Number(ctx.chain.readLock ? await ctx.chain.readLock(claimId) : 0) === row.lock_until);
  if (!same) {
    audit(ctx.db, { actor: 'system', action: 'claim.fund_mismatch', subject: claimId, data: { on } });
    throw new ClaimError('mismatch', 'The confirmed payment does not match what was prepared.', 409);
  }
  const won = ctx.db.prepare("UPDATE claims SET status = 'funded', fund_tx = ?, funded_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'").run(txHash || null, nowMs(ctx), nowMs(ctx), claimId);
  if (!Number(won.changes)) return view(ctx, load(ctx, claimId));
  ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, 'claim_funded', claimId, row.recipient_label, row.amount_micro, 'pending', nowMs(ctx));
  recordSpend(ctx.db, userId, BigInt(row.amount_micro), nowMs(ctx));
  { const rq = findUserByIdentity(ctx.db, row.recipient_kind, row.recipient_provider_id); if (rq) require('./requests').settlePaid(ctx, { payerUserId: userId, requesterUserId: rq.id, amountMicro: row.amount_micro }); }
  audit(ctx.db, { actor: 'user:' + userId, action: 'claim.funded', subject: claimId, data: { txHash } });
  const sender = ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
  notify(ctx, userId, { ref: claimId, type: 'claim_created', title: 'Payment ready to claim', privateTitle: 'Payment ready to claim', body: formatUsd(BigInt(row.amount_micro)) + ' is waiting for ' + row.recipient_label + (row.needs_release ? '. It is held for you. Approve it when you are ready for them to claim.' : '. Share the link so they can claim it.'), amountMicro: row.amount_micro, action: { label: 'View', href: '/app?claim=' + claimId + '#activity' } });
  if (!row.needs_release) announce(ctx, row, sender);
  return view(ctx, ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId));
}

function publicView(ctx, claimId) {
  const row = load(ctx, claimId);
  const sender = ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(row.sender_user_id);
  const v = view(ctx, row);
  return {
    claimId: v.claimId,
    status: row.status === 'draft' ? 'pending' : v.status,
    amountMicro: v.amountMicro,
    expiry: v.expiry,
    to: v.to,
    kind: row.recipient_kind,
    sentAt: v.fundedAt,
    claimedAt: v.claimedAt,
    returnedAt: v.returnedAt,
    from: (sender && sender.display_name) || 'Someone',
    note: row.note || null,
    lockUntil: row.lock_until || null,
    awaitingRelease: !!(row.needs_release && !row.released_at),
    autoReleaseAt: row.release_rule === 'time' && !row.released_at ? row.release_at : null,
    autoReleaseRule: row.release_rule && !row.released_at ? row.release_rule : null,
  };
}

function isRecipient(ctx, row, userId) {
  return ctx.db.prepare('SELECT provider_id FROM identities WHERE user_id = ? AND kind = ?').all(userId, row.recipient_kind)
    .some((i) => recipientHash(row.recipient_kind, i.provider_id).toLowerCase() === row.recipient_hash.toLowerCase());
}

async function prepareClaim(ctx, { claimId, userId, recipientAddress }) {
  ctx.registry.assertLive('base');
  const row = load(ctx, claimId);
  const recipient = parseAddress(recipientAddress);
  const st = effectiveStatus(row, ctx);
  if (st === 'expired') throw new ClaimError('expired', 'This payment has expired. The sender can take it back.', 410);
  if (st !== 'funded') throw new ClaimError('not_claimable', st === 'claimed' ? 'This payment was already claimed.' : 'This payment is not ready to claim.', st === 'claimed' ? 410 : 409);
  if (row.needs_release && !row.released_at) throw new ClaimError('awaiting_release', 'The sender approves this payment before it can be claimed. You will be told when it is ready.', 409);
  if (!isRecipient(ctx, row, userId)) {
    audit(ctx.db, { actor: 'user:' + userId, action: 'claim.refused_wrong_identity', subject: claimId });
    throw new ClaimError('not_recipient', 'This payment is for ' + row.recipient_label + '. Sign in as that account to claim it.', 403);
  }
  const on = await ctx.chain.readClaim(claimId);
  if (on.status !== ON.OPEN) throw new ClaimError('not_claimable', 'This payment is no longer available.', 409);
  const deadline = nowSec(ctx) + 600;
  const attestation = await ctx.attester.sign({ claimId, recipient, deadline });
  audit(ctx.db, { actor: 'user:' + userId, action: 'claim.attested', subject: claimId, data: { recipient, deadline } });
  notify(ctx, row.sender_user_id, { ref: claimId, type: 'claim_opened', title: row.recipient_label + ' opened your payment', privateTitle: 'Your payment was opened', body: 'They are claiming it now.', amountMicro: row.amount_micro, action: { label: 'View', href: '/app?claim=' + claimId + '#activity' } });
  return {
    claimId, recipient, deadline, attestation,
    tx: { to: ctx.cfg.claim.contract, value: '0', data: encodeFunctionData({ abi, functionName: 'claim', args: [claimId, recipient, BigInt(deadline), attestation] }) },
  };
}

async function confirmClaimed(ctx, { claimId, userId, txHash }) {
  const row = load(ctx, claimId);
  if (row.status === 'claimed') return view(ctx, row);
  if (row.status !== 'funded' && row.status !== 'expired') throw new ClaimError('bad_state', 'That payment cannot be completed now.');
  if (!isRecipient(ctx, row, userId)) throw new ClaimError('not_recipient', 'This payment is for ' + row.recipient_label + '. Sign in as that account.', 403);
  const on = await ctx.chain.readClaim(claimId);
  if (on.status !== ON.CLAIMED) throw new ClaimError('not_claimed_yet', 'The claim is not confirmed on Base yet.', 409);
  const won = ctx.db.prepare("UPDATE claims SET status = 'claimed', claim_tx = ?, claimed_by_user_id = ?, claimed_at = ?, updated_at = ? WHERE id = ? AND status IN ('funded', 'expired')").run(txHash || null, userId, nowMs(ctx), nowMs(ctx), claimId);
  if (!Number(won.changes)) return view(ctx, load(ctx, claimId));
  ctx.db.prepare("UPDATE activity SET status = 'done' WHERE kind = 'claim_funded' AND ref = ?").run(claimId);
  audit(ctx.db, { actor: 'user:' + userId, action: 'claim.claimed', subject: claimId, data: { txHash } });
  const amt = BigInt(row.amount_micro);
  ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, 'claim_received', claimId, null, amt.toString(), 'done', nowMs(ctx));
  ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.sender_user_id, 'claim_sent', claimId, row.recipient_label, amt.toString(), 'done', nowMs(ctx));
  notify(ctx, row.sender_user_id, { ref: claimId, type: 'claim_completed', title: row.recipient_label + ' claimed ' + formatUsd(amt), privateTitle: 'Your payment was claimed', body: 'It arrived. Thanks for using DOVI.', amountMicro: row.amount_micro, action: { label: 'View', href: '/app?claim=' + claimId + '#activity' } });
  notify(ctx, userId, { ref: claimId, type: 'payment_received', title: 'You received ' + formatUsd(amt), privateTitle: 'You received a payment', body: 'It is in your DOVI account.', amountMicro: row.amount_micro, action: { label: 'Open', href: '/app?claim=' + claimId + '#activity' } });
  return view(ctx, ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId));
}

function prepareReclaim(ctx, { claimId, userId }) {
  const row = load(ctx, claimId);
  if (row.sender_user_id !== userId) throw new ClaimError('not_yours', 'That payment is not yours.', 403);
  const st = effectiveStatus(row, ctx);
  if (!['funded', 'expired'].includes(st)) throw new ClaimError('bad_state', st === 'claimed' ? 'It was already claimed.' : 'That payment cannot be taken back.');
  if (row.lock_until && nowSec(ctx) < row.lock_until) throw new ClaimError('locked', 'This payment is locked for the person you sent it to. You can take it back after ' + new Date(row.lock_until * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC.', 409);
  return { claimId, tx: { to: ctx.cfg.claim.contract, value: '0', data: encodeFunctionData({ abi, functionName: 'reclaim', args: [claimId] }) } };
}

async function prepareReclaimChecked(ctx, args) {
  const out = prepareReclaim(ctx, args);
  if (ctx.chain && ctx.chain.readClaim) {
    const on = await ctx.chain.readClaim(args.claimId);
    if (!on || /^0x0+$/i.test(String(on.sender || '0x0'))) throw new ClaimError('legacy_claim', 'This payment was made on an earlier test version of DOVI that is no longer connected, so it cannot be taken back here. It holds test money only.', 409);
    if (on.status !== ON.OPEN) throw new ClaimError('not_open', 'This payment is no longer open on Base. Refresh to see its latest status.', 409);
  }
  return out;
}

async function confirmReclaimed(ctx, { claimId, userId, txHash }) {
  const row = load(ctx, claimId);
  if (row.sender_user_id !== userId) throw new ClaimError('not_yours', 'That payment is not yours.', 403);
  if (row.status === 'returned') return view(ctx, row);
  const on = await ctx.chain.readClaim(claimId);
  if (on.status !== ON.RECLAIMED) throw new ClaimError('not_returned_yet', 'The refund is not confirmed on Base yet.', 409);
  const won = ctx.db.prepare("UPDATE claims SET status = 'returned', reclaim_tx = ?, returned_at = ?, updated_at = ? WHERE id = ? AND status <> 'returned'").run(txHash || null, nowMs(ctx), nowMs(ctx), claimId);
  if (!Number(won.changes)) return view(ctx, load(ctx, claimId));
  ctx.db.prepare("UPDATE activity SET status = 'done' WHERE kind = 'claim_funded' AND ref = ?").run(claimId);
  audit(ctx.db, { actor: 'user:' + userId, action: 'claim.reclaimed', subject: claimId, data: { txHash } });
  ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, 'claim_returned', claimId, row.recipient_label, row.amount_micro, 'done', nowMs(ctx));
  notify(ctx, userId, { ref: claimId, type: 'claim_returned', title: 'Payment returned to you', privateTitle: 'A payment was returned to you', body: 'You got back the full amount. No fee was charged.', amountMicro: row.amount_micro, action: { label: 'View', href: '/app?claim=' + claimId + '#activity' } });
  return view(ctx, ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId));
}

function detailFor(ctx, claimId, userId) {
  const row = load(ctx, claimId);
  if (row.sender_user_id !== userId && row.claimed_by_user_id !== userId) throw new ClaimError('claim_not_found', 'That payment link is not valid.', 404);
  const v = view(ctx, row);
  const mine = row.sender_user_id === userId;
  return {
    ...v,
    role: mine ? 'sender' : 'recipient',
    kind: row.recipient_kind,
    note: row.note || null,
    chargedFeeMicro: row.status === 'claimed' ? row.fee_micro : '0',
    txs: { send: row.fund_tx || null, claim: row.claim_tx || null, reclaim: row.reclaim_tx || null },
    explorerTx: ctx.registry.publicView().find((x) => x.id === 'base').explorerTx || '',
    link: mine && ['funded', 'expired'].includes(v.status) ? v.link : null,
  };
}

function listForSender(ctx, userId) {
  return ctx.db.prepare('SELECT * FROM claims WHERE sender_user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId).map((r) => view(ctx, r));
}

/* funded claims addressed to any identity the signed in user has verified */
function incomingFor(ctx, userId) {
  const hashes = ctx.db.prepare('SELECT kind, provider_id FROM identities WHERE user_id = ?').all(userId).map((i) => recipientHash(i.kind, i.provider_id).toLowerCase());
  if (!hashes.length) return [];
  const rows = ctx.db.prepare("SELECT * FROM claims WHERE status = 'funded' AND expiry > ? AND NOT (needs_release = 1 AND released_at IS NULL) AND lower(recipient_hash) IN (" + hashes.map(() => '?').join(',') + ') ORDER BY created_at DESC LIMIT 20').all(nowSec(ctx), ...hashes);
  return rows.map((r) => { const s = ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(r.sender_user_id); return { id: r.id, short: r.short || null, amountMicro: r.amount_micro, from: require('./xdm').safeName(s && s.display_name), expiry: r.expiry, path: r.short ? '/c/' + r.short : '/claim/' + r.id }; });
}

function sweep(ctx) {
  const t = nowSec(ctx);
  ctx.db.prepare("DELETE FROM kv WHERE k LIKE 'xstate:%' AND updated_at < ?").run(nowMs(ctx) - 15 * 60 * 1000);
  const soon = ctx.db.prepare("SELECT * FROM claims WHERE status = 'funded' AND expiry > ? AND expiry <= ?").all(t, t + 86400);
  let expiring = 0;
  for (const r of soon) {
    const k = 'expiring:' + r.id;
    if (ctx.db.prepare('SELECT 1 FROM kv WHERE k = ?').get(k)) continue;
    ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)').run(k, '1', nowMs(ctx));
    if (r.recipient_kind === 'email') { const snd = ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(r.sender_user_id); mail(ctx, r.recipient_provider_id, 'claimReminder', { fromName: (snd && snd.display_name) || 'Someone', amountMicro: r.amount_micro, link: claimLink(ctx, r), expiry: r.expiry, now: nowMs(ctx) }, r.id); }
    notify(ctx, r.sender_user_id, { ref: r.id, type: 'claim_expiring', title: 'A payment expires soon', privateTitle: 'A payment expires soon', body: r.recipient_label + ' has not claimed ' + formatUsd(BigInt(r.amount_micro)) + ' yet. You can remind them or take it back.', amountMicro: r.amount_micro, action: { label: 'Review', href: '/app?claim=' + r.id + '#activity' } });
    expiring++;
  }
  for (const r of ctx.db.prepare("SELECT * FROM claims WHERE status = 'funded' AND expiry < ?").all(t)) ctx.db.prepare('INSERT INTO activity (user_id, kind, ref, counterparty, amount_micro, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.sender_user_id, 'claim_expired', r.id, r.recipient_label, r.amount_micro, 'pending', nowMs(ctx));
  const done = ctx.db.prepare("UPDATE claims SET status = 'expired', expired_at = ?, updated_at = ? WHERE status = 'funded' AND expiry < ?").run(nowMs(ctx), nowMs(ctx), t);
  return { expiring, expired: Number(done.changes) };
}

module.exports = { mail, lockFor, autoFor, release, newShort, detailFor, ClaimError, createDraft, confirmFunded, publicView, prepareClaim, confirmClaimed, prepareReclaim, prepareReclaimChecked, confirmReclaimed, listForSender, incomingFor, sweep, effectiveStatus, view, ON };
