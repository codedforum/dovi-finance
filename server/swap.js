'use strict';
/* Swap between USDC and the test token in the DOVI test pool. The pool prices from its own reserves with a 0.3 percent fee.
   The server only quotes and builds the transactions; the person's own wallet makes the swap, with a minimum output so a price move cancels it. */
const { encodeFunctionData, parseUnits, formatUnits } = require('viem');
const { ERC20_ABI, POOL_ABI } = require('./chain-client');
const { parseAddress } = require('./ids');
const { audit } = require('./audit');
const { recordActivity } = require('./activity');
const { show } = require('./tokens');

class SwapError extends Error { constructor(code, message, status = 400) { super(message || code); this.name = 'SwapError'; this.code = code; this.status = status; } }

function legs(ctx) {
  const t = (ctx.cfg.tokens || [])[0];
  if (!ctx.cfg.pool || !t) return null;
  return { pool: ctx.cfg.pool.address, usdc: { symbol: 'USDC', address: ctx.cfg.base.usdc, decimals: 6 }, token: { symbol: t.symbol, address: t.address, decimals: t.decimals } };
}
function pick(l, sym) {
  const s = String(sym || '').toUpperCase();
  if (s === 'USDC') return l.usdc;
  if (s === l.token.symbol) return l.token;
  throw new SwapError('bad_token', 'Pick USDC or ' + l.token.symbol + '.');
}

async function options(ctx) {
  const l = legs(ctx);
  if (!l) return { enabled: false };
  try {
    const r = await ctx.chain.poolReserves(l.pool);
    const usdcRes = Number(formatUnits(r.a, 6)); const tokRes = Number(formatUnits(r.b, l.token.decimals));
    return { enabled: r.a > 0n && r.b > 0n, pool: l.pool, symbols: ['USDC', l.token.symbol], feeBps: 30, reserves: { USDC: show(r.a, 6), [l.token.symbol]: show(r.b, l.token.decimals) }, price: tokRes > 0 ? (usdcRes / tokRes) : null, priceText: tokRes > 0 ? '1 ' + l.token.symbol + ' = $' + (usdcRes / tokRes).toFixed(4) : null, test: true };
  } catch { return { enabled: false }; }
}

function parseIn(text, leg) {
  const s = String(text == null ? '' : text).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new SwapError('bad_amount', 'Enter a valid amount.');
  const u = parseUnits(s, leg.decimals);
  if (u === 0n) throw new SwapError('bad_amount', 'Enter a valid amount.');
  return u;
}

async function quote(ctx, { from, to, amount, slippageBps = 100 }) {
  const l = legs(ctx); if (!l) throw new SwapError('off', 'Swaps are not switched on yet.', 503);
  const a = pick(l, from); const b = pick(l, to);
  if (a.symbol === b.symbol) throw new SwapError('same_token', 'Pick two different tokens.');
  const amountIn = parseIn(amount, a);
  const reserves = await ctx.chain.poolReserves(l.pool);
  const rIn = a.symbol === 'USDC' ? reserves.a : reserves.b;
  if (amountIn * 10n > rIn) throw new SwapError('too_big', 'That is more than the pool can take in one swap. Try a smaller amount.');
  let out;
  try { out = await ctx.chain.poolQuote(l.pool, a.address, amountIn); } catch { throw new SwapError('no_liquidity', 'The pool is not ready yet.', 503); }
  if (out === 0n) throw new SwapError('too_small', 'That amount is too small to swap.');
  const bps = Math.min(500, Math.max(10, Number(slippageBps) || 100));
  const minOut = out * BigInt(10000 - bps) / 10000n;
  const impactBps = Number((amountIn * 10000n) / (rIn + amountIn));
  return { from: a.symbol, to: b.symbol, amountIn, out, minOut, slippageBps: bps, impactBps, view: { from: a.symbol, to: b.symbol, amountIn: show(amountIn, a.decimals) + ' ' + a.symbol, out: show(out, b.decimals) + ' ' + b.symbol, minOut: show(minOut, b.decimals) + ' ' + b.symbol, feeBps: 30, impactPct: (impactBps / 100).toFixed(2), slippagePct: (bps / 100).toFixed(2) }, a, b, pool: l.pool };
}

async function prepare(ctx, { userId, from, to, amount, address, slippageBps }) {
  const addr = parseAddress(address);
  const q = await quote(ctx, { from, to, amount, slippageBps });
  let have;
  try { have = await ctx.chain.tokenBalance(q.a.address, addr); } catch { have = null; }
  if (have !== null && have < q.amountIn) throw new SwapError('insufficient', 'You have ' + show(have, q.a.decimals) + ' ' + q.a.symbol + ' and this is ' + show(q.amountIn, q.a.decimals) + '. Lower the amount.', 409);
  audit(ctx.db, { actor: 'user:' + userId, action: 'swap.prepare', data: { from: q.from, to: q.to, amountIn: q.amountIn.toString(), minOut: q.minOut.toString() } });
  return {
    ...q.view, fromSymbol: q.from, toSymbol: q.to, amountText: String(amount).trim(), amountInUnits: q.amountIn.toString(), minOutUnits: q.minOut.toString(),
    txs: [
      { to: q.a.address, value: '0', data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [q.pool, q.amountIn] }), label: 'Approve' },
      { to: q.pool, value: '0', data: encodeFunctionData({ abi: POOL_ABI, functionName: 'swap', args: [q.a.address, q.amountIn, q.minOut, addr] }), label: 'Swap' },
    ],
  };
}

/* the swap itself is made by the person's own wallet; this finds it on chain, then records it once in Activity and Notifications */
async function confirm(ctx, { userId, from, to, amount, address }) {
  const l = legs(ctx); if (!l) throw new SwapError('off', 'Swaps are not switched on yet.', 503);
  const a = pick(l, from); const b = pick(l, to);
  if (a.symbol === b.symbol) throw new SwapError('same_token', 'Pick two different tokens.');
  const amountIn = parseIn(amount, a);
  const found = await ctx.chain.poolFindSwap({ pool: l.pool, trader: parseAddress(address), tokenIn: a.address, amountIn });
  if (!found) throw new SwapError('not_found_yet', 'The swap is not confirmed on Base yet.', 409);
  const dup = ctx.db.prepare("SELECT 1 FROM activity WHERE user_id = ? AND kind = 'swap' AND ref = ?").get(userId, found.txHash);
  const text = show(amountIn, a.decimals) + ' ' + a.symbol + ' for ' + show(found.amountOut, b.decimals) + ' ' + b.symbol;
  if (!dup) {
    recordActivity(ctx.db, { userId, kind: 'swap', ref: found.txHash, counterparty: a.symbol + ' to ' + b.symbol, amountText: text, now: ctx.now ? ctx.now() : Date.now() });
    audit(ctx.db, { actor: 'user:' + userId, action: 'swap.done', subject: found.txHash, data: { from: a.symbol, to: b.symbol } });
    if (ctx.notify) ctx.notify(userId, { ref: found.txHash, type: 'swap_completed', title: 'Swapped ' + text, privateTitle: 'Swap completed', body: 'Done in the DOVI test pool.', action: { label: 'Open Activity', href: '/app#activity' } });
  }
  return { done: true, txHash: found.txHash, text, from: a.symbol, to: b.symbol };
}

module.exports = { SwapError, options, quote, prepare, confirm };
