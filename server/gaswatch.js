'use strict';
/* warns when the executor wallet is low on the network gas token, because every payout, claim and starter drip is sent from it */
const { createPublicClient, http } = require('viem');
const { audit } = require('./audit');

const LOW_WEI = 300000000000000n;

async function check(ctx, client) {
  if (!ctx.executor) return { skipped: true };
  const addr = await ctx.executor.address();
  const bal = await client.getBalance({ address: addr });
  const low = bal < BigInt(ctx.env && ctx.env.DOVI_GAS_LOW_WEI || LOW_WEI);
  if (low && !ctx.gasWarned) { ctx.gasWarned = true; console.error('[dovi] LOW GAS: the executor wallet has ' + bal + ' wei'); audit(ctx.db, { actor: 'system', action: 'gas.low', subject: addr, data: { wei: bal.toString() } }); }
  if (!low) ctx.gasWarned = false;
  return { low, wei: bal.toString() };
}

function start(ctx) {
  const client = createPublicClient({ transport: http(ctx.cfg.base.rpc) });
  const run = () => check(ctx, client).catch((e) => console.error('[dovi] gas check', e.message));
  run();
  return setInterval(run, 10 * 60 * 1000);
}

module.exports = { check, start, LOW_WEI };
