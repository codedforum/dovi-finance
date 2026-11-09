'use strict';

const TTL_MS = 30 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const URL_USD = 'https://open.er-api.com/v6/latest/USD';

async function fetchRate(ctx) {
  const f = ctx.fetch || fetch;
  const r = await f(URL_USD, { signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined });
  if (!r.ok) throw new Error('fx_http_' + r.status);
  const j = await r.json();
  const rate = j && j.rates && Number(j.rates.NGN);
  if (!(rate > 0) || !isFinite(rate) || rate < 50 || rate > 20000) throw new Error('fx_bad_rate');
  return { rate, updatedAt: j.time_last_update_unix ? Number(j.time_last_update_unix) * 1000 : Date.now() };
}

async function ngnQuote(ctx) {
  const now = ctx.now ? ctx.now() : Date.now();
  const c = ctx.fxCache;
  if (c && now - c.at < TTL_MS) return c.v;
  try {
    const { rate, updatedAt } = await fetchRate(ctx);
    const v = { available: true, pair: 'USD/NGN', rate, updatedAt, source: 'ExchangeRate-API', indicative: true };
    ctx.fxCache = { at: now, v };
    return v;
  } catch {
    if (c && now - c.at < STALE_MS) return { ...c.v, stale: true };
    return { available: false, pair: 'USD/NGN', source: 'ExchangeRate-API' };
  }
}

module.exports = { ngnQuote };
