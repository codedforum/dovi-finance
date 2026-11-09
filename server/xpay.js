'use strict';
const { encodeFunctionData } = require('viem');
const abi = require('./abi/DoviClaim.json');
const { ERC20_ABI } = require('./chain-client');
const { parseUsd, formatUsd, feeFor } = require('./money');
const { resolveRecipient } = require('./auth/resolve');
const { findUserByIdentity, getAddress: userAddress, userHasIdentity } = require('./identity');
const { utcDay } = require('./limits');
const { audit } = require('./audit');
const claims = require('./claims');
const { dmText, queueClaimDm } = require('./xdm');

class XPayError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.name = 'XPayError'; this.code = code; this.status = status; }
}

const nowMs = (ctx) => (ctx.now ? ctx.now() : Date.now());
const BOT = 'dovifinance';
/* wording that asks for a later payment: DOVI only pays now, so these are refused instead of paid early */
const TIMED = /\b(?:in|after|within)\s+(?:an?|one|two|three|four|five|ten|\d+)\s*(?:hrs?|hours?|mins?|minutes?|days?|weeks?)\b|\b(?:tomorrow|tonight|later today|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b|\bat\s+\d{1,2}(?::\d\d\s*(?:am|pm|utc)?|\s*(?:am|pm|utc))\b/i;
const TAGS = new Set(['base', 'vibestarterxyz']);
const ALLOWANCE_DAYS = 7n;

function parseCommand(text, opts = {}) {
  const bot = (opts.bot || BOT).toLowerCase();
  const raw = String(text || '').replace(/https?:\/\/\S+/g, ' ');
  const re = /@dovifinance\b/gi; let last = -1; let hit;
  while ((hit = re.exec(raw))) last = hit.index + hit[0].length;
  if (last < 0) return null;
  const tail = raw.slice(last).replace(/^[\s,:;-]+/, '').replace(/^please\s+/i, '');
  const V = '(?:send|pay|give|tip)'; const H = '@([A-Za-z0-9_]{1,15})'; const N = '(?:\\$\\s*)?(\\d+(?:\\.\\d{1,6})?)(?!,\\d)'; const U = '(?:\\s*(?:usdc|usd|dollars?|bucks|\\$))';
  if (new RegExp('^' + V + '\\s+@[A-Za-z0-9_]{1,15}\\s+@[A-Za-z0-9_]{1,15}', 'i').test(tail)) return { error: 'multiple' };
  if (/^(?:send|pay|give|tip)\b[^\n]*\d,\d{3}/i.test(tail)) return { error: 'amount' };
  if (/\d(?:\.\d+)?\s*(?:\$\s*(?!usdc?\b|usd\b)[a-z]{2,12}|(?:vibes|eth|weth|btc|wbtc|sol|usdt|dai|bnb|matic|avax|doge|pepe|degen|virtual|near|sui)\b)/i.test(tail)) return { error: 'token' };
  let to = null; let amountText = null; let m;
  if ((m = tail.match(new RegExp('^' + V + '\\s+' + H + '\\s+' + N + U + '?(?![\\w.])', 'i')))) { to = m[1]; amountText = m[2]; }
  else if ((m = tail.match(new RegExp('^' + V + '\\s+' + N + U + '?\\s+(?:to\\s+)?' + H, 'i')))) { amountText = m[1]; to = m[2]; }
  else if ((m = tail.match(new RegExp('^' + H + '\\s+' + N + U, 'i')))) { to = m[1]; amountText = m[2]; }
  else if (opts.replyTo && (m = tail.match(new RegExp('^' + V + '\\s+' + N + U + '?(?![\\w.@])', 'i')))) { amountText = m[1]; to = String(opts.replyTo); }
  else if ((m = tail.match(new RegExp('^((?:@[A-Za-z0-9_]{1,15}\\s+)+)' + V + '\\s+' + N + U + '?(?![\\w.@])', 'i')))) {
    const names = [...m[1].matchAll(/@([A-Za-z0-9_]{1,15})/g)].map((x) => x[1]).filter((h) => h.toLowerCase() !== bot && !TAGS.has(h.toLowerCase()));
    if (names.length > 1) return { error: 'ambiguous' };
    if (names.length === 1) { to = names[0]; amountText = m[2]; }
  }
  if (!to || !amountText || to.toLowerCase() === bot) return null;
  let amountMicro; try { amountMicro = parseUsd(amountText); } catch { return { error: 'amount' }; }
  return { to, amountMicro };
}

function queueReply(ctx, replyTo, text, kind = null, exclude = null) {
  ctx.db.prepare('INSERT INTO x_outbox (reply_to, text, status, created_at, kind, exclude) VALUES (?, ?, ?, ?, ?, ?)').run(String(replyTo), String(text).slice(0, 270), 'queued', nowMs(ctx), kind, exclude && exclude.length ? JSON.stringify(exclude.map(String)) : null);
}

/* payment notice wording: a different phrasing from the one used last, so replies never repeat */
const PAID_TEXT = [
  '{amt} from {from} is waiting for you on DOVI. Sign in with this X account at {site} to claim it.',
  '{from} sent you {amt} on DOVI. Log in at {site} with this X account and it is yours.',
  'Good news, {amt} from {from} is held for you. Claim it at {site} with one login.',
  'You have {amt} waiting from {from}. Open {site}, sign in with X and claim it.',
  '{from} just paid you {amt} on DOVI. One login at {site} and it is in your wallet.',
  '{amt} is held for you, sent by {from}. Sign in at {site} with your X account to collect it.',
  'Heads up, {from} sent you {amt}. Collect it by signing in at {site} with X.',
  '{amt} from {from} is ready to claim. Head to {site} and log in with this X account.',
  '{from} has {amt} for you on DOVI. Sign in at {site} with X to receive it.',
  'A payment of {amt} from {from} is waiting. Sign in at {site} with your X account, no wallet needed.',
  'Your {amt} from {from} is ready. Log in with X at {site} to claim it.',
  '{from} sent {amt} your way on DOVI. Claim it in one login at {site}.',
];
const INSTANT_TEXT = [
  '{amt} from {from} just landed in your DOVI account.',
  '{from} sent you {amt} and it is already in your DOVI account.',
  'Done. {amt} from {from} is in your DOVI account now.',
  '{amt} from {from} arrived in your DOVI account, no claim needed.',
  'Your DOVI account just received {amt} from {from}.',
  '{from} paid you {amt}. It is already in your DOVI account.',
];
function instantText(ctx, tweetId, vars) {
  let h = 0; for (const ch of String(tweetId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const row = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get('xpay:tpl2');
  let i = h % INSTANT_TEXT.length; if (row && Number(row.v) === i) i = (i + 1) % INSTANT_TEXT.length;
  ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').run('xpay:tpl2', String(i), nowMs(ctx));
  return INSTANT_TEXT[i].replace('{amt}', vars.amt).replace('{from}', vars.from);
}

function paidText(ctx, tweetId, vars) {
  let h = 0; for (const ch of String(tweetId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const row = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get('xpay:tpl');
  const last = row ? Number(row.v) : -1;
  let i = h % PAID_TEXT.length; if (i === last) i = (i + 1) % PAID_TEXT.length;
  ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').run('xpay:tpl', String(i), nowMs(ctx));
  return PAID_TEXT[i].replace('{amt}', vars.amt).replace('{from}', vars.from).replace('{site}', vars.site);
}

const appLink = (ctx, hash) => ctx.cfg.publicUrl + '/app#' + hash;

const RECENT_MS = 6 * 3600 * 1000;
const PAYISH = /\b(send|pay|give|tip|transfer|usdc|usd|dollars?|bucks)\b|\$\s*\d/i;
const recentSame = (ctx, authorId, status) => !!ctx.db.prepare('SELECT 1 FROM x_mentions WHERE author_id = ? AND status = ? AND created_at > ? LIMIT 1').get(String(authorId), status, nowMs(ctx) - RECENT_MS);
const rejectBurst = (ctx, authorId) => ctx.db.prepare("SELECT COUNT(*) AS n FROM x_mentions WHERE author_id = ? AND status = 'rejected' AND created_at > ?").get(String(authorId), nowMs(ctx) - 600000).n >= 3;
const STALE_SEC = 3 * 3600;
const onboardingBurst = (ctx) => ctx.db.prepare("SELECT COUNT(*) AS n FROM x_mentions WHERE status = 'needs_account' AND created_at > ?").get(nowMs(ctx) - 3600000).n >= 6;

async function processMention(ctx, m) {
  const id = String(m.id);
  const seen = ctx.db.prepare('SELECT status FROM x_mentions WHERE tweet_id = ?').get(id);
  if (seen) return { status: seen.status, duplicate: true };
  const staleSec = m.createdSec ? Math.floor(nowMs(ctx) / 1000) - m.createdSec : 0;
  const done = (status, detail, claimId) => {
    ctx.db.prepare('INSERT INTO x_mentions (tweet_id, author_id, author_handle, text, status, detail, claim_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, String(m.authorId), m.authorHandle || null, String(m.text || '').slice(0, 400), status, detail || null, claimId || null, nowMs(ctx));
    return { status, detail: detail || null, claimId: claimId || null };
  };
  if (staleSec > STALE_SEC) return done('ignored', 'stale');
  const gv = ctx.cfg.giveaway ? require('./giveaway').parseGiveaway(m.text) : null;
  if (gv) return require('./giveaway').fromMention(ctx, m, gv, { queueReply, done });
  let cmd = parseCommand(m.text, { replyTo: m.isReplyTo });
  const who = '@' + (m.authorHandle || 'there');
  const exclude = (m.mentionIds || []).map(String).filter((x) => x !== String(m.authorId));
  const say = (text) => { if (!rejectBurst(ctx, m.authorId)) queueReply(ctx, id, text, null, exclude); };
  let viaLLM = false;
  if (!cmd && ctx.intentLLM && /@dovifinance/i.test(String(m.text || '')) && PAYISH.test(String(m.text || ''))) {
    const u0 = findUserByIdentity(ctx.db, 'x', String(m.authorId));
    const on0 = u0 && !u0.frozen_at && !u0.admin_frozen_at && ctx.db.prepare('SELECT 1 FROM autopay WHERE user_id = ? AND enabled = 1').get(u0.id);
    if (on0 && !(ctx.env && ctx.env.DOVI_XPAY_DRY === '1')) {
      try {
        const r = await ctx.intentLLM.classify({ text: m.text, authorId: m.authorId, replyTo: m.isReplyTo, now: nowMs(ctx) });
        if (r.intent === 'pay') { try { cmd = { to: r.to, amountMicro: parseUsd(r.amountUsd) }; viaLLM = true; } catch { cmd = null; } }
        else if (r.intent === 'unclear' && !ctx.db.prepare("SELECT 1 FROM x_mentions WHERE author_id = ? AND detail = 'unclear_llm' AND created_at > ? LIMIT 1").get(String(m.authorId), nowMs(ctx) - RECENT_MS)) {
          say(who + ' I could not tell who to pay or how much. Write it like: send 1 usdc to @name');
          return done('rejected', 'unclear_llm');
        }
      } catch { /* the model is optional: no answer means no payment and no reply */ }
    }
  }
  if (cmd && !cmd.error && TIMED.test(String(m.text || ''))) {
    if (!findUserByIdentity(ctx.db, 'x', String(m.authorId))) return done('ignored', 'not_a_user');
    say(who + ' I pay right away and cannot schedule a payment. Send it again when you want it paid.');
    return done('rejected', 'scheduled');
  }
  if (ctx.env && ctx.env.DOVI_XPAY_DRY === '1') return done('dry_run', !cmd ? 'ignore' : cmd.error ? 'error:' + cmd.error : 'pay:' + cmd.to + ':' + cmd.amountMicro);
  if (!cmd) return done('ignored');
  if (cmd.error && !findUserByIdentity(ctx.db, 'x', String(m.authorId))) return done('ignored', 'not_a_user');
  if (cmd.error === 'ambiguous') { say(who + ' which one should I pay? Write it like: send 1 usdc to @name'); return done('rejected', 'ambiguous_recipient'); }
  if (cmd.error === 'multiple') { say(who + ' one person at a time please. Try: send @name 5 usdc'); return done('rejected', 'multiple_recipients'); }
  if (cmd.error === 'token') { say(who + ' I only pay USDC from X for now. For other tokens use the DOVI app: ' + appLink(ctx, 'home')); return done('rejected', 'unsupported_token'); }
  if (cmd.error) { say(who + ' I could not read that amount. Try: send @name 5 usdc'); return done('rejected', 'bad_amount'); }

  const user = findUserByIdentity(ctx.db, 'x', String(m.authorId));
  if (!user) { if (!(ctx.env && ctx.env.DOVI_XPAY_ONBOARD === '1')) return done('ignored', 'not_a_user'); if (recentSame(ctx, m.authorId, 'needs_account') || onboardingBurst(ctx)) return done('ignored', 'cooldown'); say(who + ' set up DOVI first, then turn on pay from X: ' + appLink(ctx, 'autopay')); return done('needs_account'); }
  if (user.admin_frozen_at) { say(who + ' your DOVI account is on hold, so I did not send that. Contact support from the Help page.'); return done('rejected', 'account_on_hold'); }
  if (user.frozen_at) { say(who + ' your DOVI account is frozen, so I did not send that. Unfreeze it in the app: ' + appLink(ctx, 'account')); return done('rejected', 'account_frozen'); }
  const ap = ctx.db.prepare('SELECT * FROM autopay WHERE user_id = ? AND enabled = 1').get(user.id);
  const payer = userAddress(ctx.db, user.id, 'base');
  if (!ap || !payer) { if (recentSame(ctx, m.authorId, 'needs_autopay')) return done('ignored', 'cooldown'); say(who + ' turn on pay from X in DOVI first, you set the limits: ' + appLink(ctx, 'autopay')); return done('needs_autopay'); }

  const c = ctx.cfg.claim; const amount = cmd.amountMicro;
  const fail = (code, text, status = 'rejected') => { if ((status === 'needs_autopay' || status === 'insufficient') && recentSame(ctx, m.authorId, status)) return done('ignored', 'cooldown'); say(who + ' ' + text); return done(status, code); };
  if (amount < c.minAmountMicro) return fail('below_minimum', 'the minimum is ' + formatUsd(c.minAmountMicro) + '.');
  if (amount > c.perClaimCapMicro) return fail('above_cap', 'the beta limit per payment is ' + formatUsd(c.perClaimCapMicro) + '.');
  if (amount > BigInt(ap.per_payment_micro)) return fail('above_autopay', 'that is above your pay from X limit of ' + formatUsd(BigInt(ap.per_payment_micro)) + ' per payment. Change it here: ' + appLink(ctx, 'autopay'));
  const day = ctx.db.prepare('SELECT spent_micro FROM limits_usage WHERE user_id = ? AND day = ?').get(user.id, utcDay(nowMs(ctx)));
  const spent = day ? BigInt(day.spent_micro) : 0n;
  if (spent + amount > BigInt(ap.per_day_micro)) return fail('above_autopay_day', 'that would pass your daily pay from X limit of ' + formatUsd(BigInt(ap.per_day_micro)) + '.');
  if (spent + amount > c.perUserDayCapMicro) return fail('day_cap', 'the beta limit per day is ' + formatUsd(c.perUserDayCapMicro) + '.');

  let target;
  try { target = await resolveRecipient(ctx, '@' + cmd.to); } catch (e) { return fail('recipient', e.message || 'I could not find that account.'); }
  if (userHasIdentity(ctx.db, user.id, target.kind, target.providerId)) return fail('self_send', 'you cannot pay yourself.');
  const fee = feeFor(amount, c); const total = amount + fee;
  const [bal, allow, onchain] = await Promise.all([ctx.chain.usdcBalance(payer), ctx.chain.readAllowance(payer), ctx.chain.readAutoPay(payer)]);
  if (onchain.perPayment < amount || onchain.perDay === 0n) return fail('autopay_off_chain', 'pay from X needs to be turned on again: ' + appLink(ctx, 'autopay'), 'needs_autopay');
  if (BigInt(bal) < total) return fail('insufficient', 'you do not have enough USDC in DOVI. Add money here: ' + appLink(ctx, 'home'), 'insufficient');
  if (BigInt(allow) < total) return fail('allowance', 'your pay from X allowance is used up. Renew it here: ' + appLink(ctx, 'autopay'), 'needs_autopay');
  if (!ctx.executor) return fail('executor_off', 'pay from X is not switched on yet.', 'unavailable');

  let d;
  try { d = claims.createDraft(ctx, { userId: user.id, senderAddress: payer, kind: target.kind, providerId: target.providerId, label: target.label, amountMicro: amount, idempotencyKey: 'x:' + id }); }
  catch (e) { return fail(e.code || 'draft_failed', e.message || 'I could not start that payment.'); }
  ctx.db.prepare("UPDATE claims SET source = 'x', x_tweet_id = ? WHERE id = ?").run(id, d.claimId);
  const row = ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(d.claimId);
  const keep = new Set([String(m.authorId), String(target.providerId)]);
  const skip = (m.mentionIds || []).map(String).filter((x) => !keep.has(x));
  let v;
  try {
    const r = await ctx.executor.createClaimFor({ payer, id: row.id, recipientHash: row.recipient_hash, amountMicro: row.amount_micro, expiry: row.expiry });
    v = await confirmWithRetry(ctx, { claimId: row.id, userId: user.id, txHash: r.txHash });
  } catch (e) {
    audit(ctx.db, { actor: 'x:' + m.authorId, action: 'xpay.failed', subject: row.id, data: { tweet: id, error: String(e && e.message || e).slice(0, 160) } });
    ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').run('xlate:' + row.id, JSON.stringify({ claimId: row.id, tweet: id, who, amt: formatUsd(amount), skip, at: nowMs(ctx) }), nowMs(ctx));
    say(who + ' I could not confirm that one. Check Activity in DOVI before you try again, it may still arrive: ' + appLink(ctx, 'send'));
    return done('failed', String(e && e.message || e).slice(0, 160), row.id);
  }
  audit(ctx.db, { actor: 'x:' + m.authorId, action: 'xpay.sent', subject: row.id, data: { tweet: id, amount: amount.toString() } });
  const rcpt = findUserByIdentity(ctx.db, target.kind, target.providerId);
  const rcptAddr = rcpt ? userAddress(ctx.db, rcpt.id, 'base') : null;
  if (rcptAddr && typeof ctx.executor.claimFor === 'function' && !(ctx.env && ctx.env.DOVI_XAUTOCLAIM === '0')) {
    try {
      const prep = await claims.prepareClaim(ctx, { claimId: row.id, userId: rcpt.id, recipientAddress: rcptAddr });
      const t = await ctx.executor.claimFor({ id: row.id, recipient: rcptAddr, deadline: prep.deadline, attestation: prep.attestation });
      await claims.confirmClaimed(ctx, { claimId: row.id, userId: rcpt.id, txHash: t.txHash });
      audit(ctx.db, { actor: 'x:' + m.authorId, action: 'xpay.auto_claimed', subject: row.id, data: { tweet: id } });
      queueReply(ctx, id, instantText(ctx, id, { amt: formatUsd(amount), from: who }), null, skip);
      return done('sent', viaLLM ? 'llm' : 'instant', row.id);
    } catch (e) {
      audit(ctx.db, { actor: 'x:' + m.authorId, action: 'xpay.auto_claim_failed', subject: row.id, data: { tweet: id, error: String(e && e.message || e).slice(0, 160) } });
    }
  }
  const site = ctx.env && ctx.env.DOVI_XREPLY_LINK === '1' ? v.link : 'DOVI';
  queueReply(ctx, id, paidText(ctx, id, { amt: formatUsd(amount), from: who, site }), null, skip);
  queueClaimDm(ctx, row, { from: who, link: v.link, amt: formatUsd(amount) });
  return done('sent', viaLLM ? 'llm' : null, row.id);
}

/* a payment that landed on chain after the bot gave up waiting is announced once it is confirmed */
async function confirmWithRetry(ctx, args) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await claims.confirmFunded(ctx, args); } catch (e) { last = e; if (i < 2) await new Promise((r) => setTimeout(r, ctx.xpayRetryMs != null ? ctx.xpayRetryMs : 2000)); }
  }
  throw last;
}

function announceLate(ctx) {
  for (const r of ctx.db.prepare("SELECT k, v FROM kv WHERE k LIKE 'xlate:%'").all()) {
    const drop = () => ctx.db.prepare('DELETE FROM kv WHERE k = ?').run(r.k);
    let info; try { info = JSON.parse(r.v); } catch { drop(); continue; }
    const row = ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(info.claimId);
    if (!row) { drop(); continue; }
    if (row.status === 'funded') {
      queueReply(ctx, info.tweet, paidText(ctx, info.tweet, { amt: info.amt, from: info.who, site: 'DOVI' }), 'late_paid', info.skip);
      queueClaimDm(ctx, row, { from: info.who, link: ctx.cfg.publicUrl + (row.short ? '/c/' + row.short : '/claim/' + row.id), amt: info.amt });
      audit(ctx.db, { actor: 'system', action: 'xpay.late_announced', subject: row.id });
      drop();
    } else if (row.status !== 'draft' || nowMs(ctx) - info.at > 30 * 60 * 1000) { audit(ctx.db, { actor: 'system', action: 'xpay.late_dropped', subject: row.id, data: { status: row.status } }); drop(); }
  }
}

/* settings: the on chain opt in plus an allowance, confirmed by reading the chain */
function allowanceFor(perDayMicro) { return BigInt(perDayMicro) * ALLOWANCE_DAYS * 102n / 100n; }

function getSettings(ctx, userId) {
  const ap = ctx.db.prepare('SELECT * FROM autopay WHERE user_id = ?').get(userId);
  const xLinked = !!ctx.db.prepare("SELECT 1 FROM identities WHERE user_id = ? AND kind = 'x'").get(userId);
  return {
    enabled: !!(ap && ap.enabled), perPaymentMicro: ap ? ap.per_payment_micro : null, perDayMicro: ap ? ap.per_day_micro : null, xLinked,
    available: !!ctx.executor, allowanceDays: Number(ALLOWANCE_DAYS),
    examples: ['@DoviFinance send @name 5 usdc', '@DoviFinance pay @name $5'],
    maxPerPaymentMicro: ctx.cfg.claim.perClaimCapMicro.toString(), maxPerDayMicro: ctx.cfg.claim.perUserDayCapMicro.toString(),
  };
}

function prepareEnable(ctx, { userId, perPaymentMicro, perDayMicro }) {
  const c = ctx.cfg.claim;
  if (!ctx.db.prepare("SELECT 1 FROM identities WHERE user_id = ? AND kind = 'x'").get(userId)) throw new XPayError('x_required', 'Link your X account first. Pay from X works from the X account you link.', 409);
  if (!userAddress(ctx.db, userId, 'base')) throw new XPayError('no_wallet', 'Your wallet is still being created. Try again in a moment.', 409);
  const pp = BigInt(perPaymentMicro); const pd = BigInt(perDayMicro);
  if (pp < c.minAmountMicro) throw new XPayError('below_minimum', 'The per payment limit must be at least ' + formatUsd(c.minAmountMicro) + '.');
  if (pp > c.perClaimCapMicro) throw new XPayError('above_cap', 'The beta limit per payment is ' + formatUsd(c.perClaimCapMicro) + '.');
  if (pd < pp) throw new XPayError('bad_limits', 'The daily limit cannot be lower than the per payment limit.');
  if (pd > c.perUserDayCapMicro) throw new XPayError('above_cap', 'The beta limit per day is ' + formatUsd(c.perUserDayCapMicro) + '.');
  const allowance = allowanceFor(pd);
  return {
    perPaymentMicro: pp.toString(), perDayMicro: pd.toString(), allowanceMicro: allowance.toString(),
    txs: [
      { to: ctx.cfg.base.usdc, value: '0', data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [c.contract, allowance] }), label: 'Allow' },
      { to: c.contract, value: '0', data: encodeFunctionData({ abi, functionName: 'setAutoPay', args: [pp, pd] }), label: 'Turn on' },
    ],
    preview: { lines: [{ label: 'Per payment', value: 'up to ' + formatUsd(pp) }, { label: 'Per day', value: 'up to ' + formatUsd(pd) }, { label: 'Allowance', value: formatUsd(allowance) + ' (' + ALLOWANCE_DAYS + ' days at your daily limit)' }], note: 'DOVI can only create payments from you that you tweet, inside these limits. You can cancel any payment in the app until it is claimed, and turn this off at any time.' },
  };
}

async function confirmEnable(ctx, { userId, perPaymentMicro, perDayMicro }) {
  const payer = userAddress(ctx.db, userId, 'base');
  const on = await ctx.chain.readAutoPay(payer);
  if (on.perPayment !== BigInt(perPaymentMicro) || on.perDay !== BigInt(perDayMicro)) throw new XPayError('not_confirmed', 'Pay from X is not confirmed on Base yet.', 409);
  const t = nowMs(ctx);
  ctx.db.prepare('INSERT INTO autopay (user_id, per_payment_micro, per_day_micro, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(user_id) DO UPDATE SET per_payment_micro = excluded.per_payment_micro, per_day_micro = excluded.per_day_micro, enabled = 1, updated_at = excluded.updated_at').run(userId, String(perPaymentMicro), String(perDayMicro), t, t);
  audit(ctx.db, { actor: 'user:' + userId, action: 'autopay.on', data: { perPaymentMicro: String(perPaymentMicro), perDayMicro: String(perDayMicro) } });
  return getSettings(ctx, userId);
}

function prepareDisable(ctx, { userId }) {
  const c = ctx.cfg.claim;
  return { txs: [
    { to: c.contract, value: '0', data: encodeFunctionData({ abi, functionName: 'setAutoPay', args: [0n, 0n] }), label: 'Turn off' },
    { to: ctx.cfg.base.usdc, value: '0', data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [c.contract, 0n] }), label: 'Remove allowance' },
  ] };
}

async function confirmDisable(ctx, { userId }) {
  const payer = userAddress(ctx.db, userId, 'base');
  const on = await ctx.chain.readAutoPay(payer);
  if (on.perPayment !== 0n || on.perDay !== 0n) throw new XPayError('not_confirmed', 'Turning off is not confirmed on Base yet.', 409);
  ctx.db.prepare('UPDATE autopay SET enabled = 0, updated_at = ? WHERE user_id = ?').run(nowMs(ctx), userId);
  audit(ctx.db, { actor: 'user:' + userId, action: 'autopay.off' });
  return getSettings(ctx, userId);
}

/* mention intake: twitterapi.io search of mentions, newest first, remembered by tweet id */
function makeMentionReader(env = process.env, f = fetch) {
  const key = env.TWITTERAPI_IO_KEY; const handle = env.DOVI_X_HANDLE || 'DoviFinance';
  if (!key) return null;
  return {
    async fetchMentions(sinceSec, sinceId = null) {
      const after = sinceId && /^\d{5,25}$/.test(String(sinceId)) ? ' since_id:' + String(sinceId) : (sinceSec ? ' since_time:' + Number(sinceSec) : '');
      const query = '@' + handle + ' (send OR pay OR give OR tip OR usdc OR usd OR dollars OR bucks OR giveaway OR winner OR winners OR raffle) -from:' + handle + ' -filter:retweets' + after;
      const all = []; let cursor = '';
      for (let page = 0; page < 5; page++) {
        const r = await f('https://api.twitterapi.io/twitter/tweet/advanced_search?queryType=Latest&query=' + encodeURIComponent(query) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { headers: { 'X-API-Key': key, 'user-agent': 'dovi/1.0' } });
        if (!r.ok) throw new Error('mentions ' + r.status);
        const j = await r.json();
        all.push(...(j.tweets || (j.data && j.data.tweets) || []));
        const next = j.next_cursor || (j.data && j.data.next_cursor);
        if (!(j.has_next_page || (j.data && j.data.has_next_page)) || !next) break;
        cursor = next;
      }
      return all.filter((t) => !t.retweeted_tweet && !/^RT @/.test(String(t.text || ''))).map((t) => ({ id: String(t.id), text: t.text, authorId: String(t.author && t.author.id), authorHandle: t.author && (t.author.userName || t.author.username), createdAt: t.createdAt, createdSec: Math.floor(new Date(t.createdAt).getTime() / 1000) || 0, isReplyTo: t.inReplyToUsername || null, replyToId: t.inReplyToId ? String(t.inReplyToId) : null, mentionIds: ((t.entities && t.entities.user_mentions) || []).map((u) => String(u.id_str || u.id || '')).filter((x) => /^\d+$/.test(x)) }))
        .filter((t) => t.id && t.authorId && t.authorId !== 'undefined' && String(t.authorHandle || '').toLowerCase() !== String(handle).toLowerCase());
    },
  };
}

async function pollMentions(ctx) {
  if (!ctx.mentions || !ctx.executor) return { skipped: true };
  const k = 'xpay:since';
  const row = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
  const since = row ? Number(row.v) : Math.floor((ctx.now ? ctx.now() : Date.now()) / 1000) - 3600;
  const idRow = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get('xpay:sinceid');
  const sinceId = idRow ? idRow.v : null;
  const nRow = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get('xpay:polls');
  const polls = (nRow ? Number(nRow.v) : 0) + 1;
  ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').run('xpay:polls', String(polls), ctx.now ? ctx.now() : Date.now());
  try { announceLate(ctx); } catch (e) { console.error('[dovi] xpay late', e.message); }
  const list = await ctx.mentions.fetchMentions(since, sinceId);
  const out = [];
  let newest = since;
  let newestId = sinceId ? BigInt(sinceId) : 0n;
  for (const m of list.slice().sort((a, b) => a.createdSec - b.createdSec)) {
    try { out.push(await processMention(ctx, m)); }
    catch (e) {
      console.error('[dovi] xpay mention', m.id, e.message);
      try { ctx.db.prepare('INSERT OR IGNORE INTO x_mentions (tweet_id, author_id, author_handle, text, status, detail, claim_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(String(m.id), String(m.authorId), m.authorHandle || null, String(m.text || '').slice(0, 400), 'failed', 'error:' + String(e && e.message || e).slice(0, 120), null, nowMs(ctx)); } catch { /* already recorded */ }
      out.push({ status: 'failed' });
    }
    if (m.createdSec > newest) newest = m.createdSec;
    if (/^\d+$/.test(m.id) && BigInt(m.id) > newestId) newestId = BigInt(m.id);
  }
  if (newestId > 0n) ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').run('xpay:sinceid', newestId.toString(), ctx.now ? ctx.now() : Date.now());
  ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').run(k, String(newest), ctx.now ? ctx.now() : Date.now());
  return { count: out.length, sent: out.filter((x) => x.status === 'sent').length };
}

module.exports = { dmText, XPayError, parseCommand, processMention, getSettings, prepareEnable, confirmEnable, prepareDisable, confirmDisable, makeMentionReader, pollMentions, allowanceFor, queueReply };
