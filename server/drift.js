'use strict';

async function check(ctx) {
  if (!ctx.chain || !ctx.chain.readConfig || !ctx.cfg.claim.contract) { ctx.configDrift = []; return []; }
  const on = await ctx.chain.readConfig();
  const k = ctx.cfg.claim;
  const out = [];
  if (BigInt(k.feeBps) !== BigInt(on.feeBps)) out.push('fee rate differs from the contract');
  if (BigInt(k.feeMinMicro) !== BigInt(on.minFee)) out.push('minimum fee differs from the contract');
  if (BigInt(k.minAmountMicro) < BigInt(on.minAmount)) out.push('minimum amount is below the contract minimum');
  if (BigInt(k.perClaimCapMicro) > BigInt(on.perClaimCap)) out.push('per payment cap is above the contract cap');
  ctx.configDrift = out;
  return out;
}

module.exports = { check };
