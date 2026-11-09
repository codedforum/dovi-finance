'use strict';
/* Test network only: when the shared faucet is at its limit, send a one time starter amount of test USDC from the DOVI executor wallet. */
const kvGet = (ctx, k) => ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
const kvSet = (ctx, k, v) => ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').run(k, String(v), ctx.now());

const kvAdd = (ctx, k, d) => ctx.db.prepare("INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + CAST(? AS INTEGER) AS TEXT), updated_at = excluded.updated_at").run(k, String(Math.max(0, d)), ctx.now(), d);

async function starterDrip(ctx, userId, address) {
  const env = ctx.env || {};
  if (env.DOVI_DRIP === '0' || !ctx.executor || typeof ctx.executor.sendUsdc !== 'function') return null;
  const amount = BigInt(env.DOVI_DRIP_MICRO || 5000000);
  const perDay = Number(env.DOVI_DRIP_PER_DAY || 40);
  const ukey = 'drip:user:' + userId; const akey = 'drip:addr:' + String(address).toLowerCase();
  if (kvGet(ctx, ukey) || kvGet(ctx, akey)) return { already: true };
  const day = 'drip:day:' + new Date(ctx.now()).toISOString().slice(0, 10);
  if (Number((kvGet(ctx, day) || {}).v || 0) >= perDay) return null;
  /* reserve before any await so concurrent requests cannot pass the same checks */
  kvSet(ctx, ukey, ctx.now()); kvSet(ctx, akey, ctx.now()); kvAdd(ctx, day, 1);
  const release = () => { ctx.db.prepare('DELETE FROM kv WHERE k IN (?, ?)').run(ukey, akey); kvAdd(ctx, day, -1); };
  try {
    const bal = BigInt(await (ctx.chain || ctx.reader).usdcBalance(await ctx.executor.address()));
    if (bal < amount) { release(); return null; }
  } catch { release(); return null; }
  try { await ctx.executor.sendUsdc({ to: address, amountMicro: amount }); }
  catch (e) {
    /* a transfer that was broadcast may still land, so only a send that never left is given back */
    if (!(e && e.broadcast)) release();
    return null;
  }
  return { micro: amount };
}

/* One Circle faucet request per account and per wallet, and a daily cap, so the developer account allowance is not burned by repeats. */
async function circleDrip(ctx, userId, address) {
  const env = ctx.env || {};
  const cf = ctx.circleFaucet;
  if (env.DOVI_CIRCLE_DRIP === '0' || !cf || !cf.enabled) return null;
  const perDay = Number(env.CIRCLE_DRIP_PER_DAY || 8);
  const ukey = 'cdrip:user:' + userId; const akey = 'cdrip:addr:' + String(address).toLowerCase();
  const seen = kvGet(ctx, ukey) || kvGet(ctx, akey);
  if (seen && ctx.now() - Number(seen.v) < 24 * 3600 * 1000) return { already: true };
  const day = 'cdrip:day:' + new Date(ctx.now()).toISOString().slice(0, 10);
  const used = Number((kvGet(ctx, day) || {}).v || 0);
  if (used >= perDay) return null;
  kvSet(ctx, ukey, ctx.now()); kvSet(ctx, akey, ctx.now()); kvSet(ctx, day, used + 1);
  const r = await cf.requestUsdc(address);
  if (!r.ok) {
    ctx.db.prepare('DELETE FROM kv WHERE k IN (?, ?)').run(ukey, akey); kvSet(ctx, day, used);
    console.error('[dovi] circle faucet refused: ' + r.reason + (r.detail ? ' ' + r.detail : ''));
    return null;
  }
  return { usdc: Number(env.CIRCLE_DRIP_USDC || 20) };
}

module.exports = { starterDrip, circleDrip };
