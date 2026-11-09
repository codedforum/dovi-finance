'use strict';
const BASE = 'https://1click.chaindefuser.com';

function assetFor(usdc) { return 'nep141:base-' + String(usdc).toLowerCase() + '.omft.near'; }

function makeNearIntents(env = process.env, f = fetch) {
  const key = env.NEAR_INTENTS_API_KEY || '';
  if (!key) return null;
  async function call(method, path, body) {
    const r = await f(BASE + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'user-agent': 'dovi/1.0' }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { j = null; }
    if (!r.ok) { const e = new Error((j && (j.message || j.error)) || 'The private route is not available right now.'); e.status = r.status; throw e; }
    return j;
  }
  return {
    assetFor,
    quote: (body) => call('POST', '/v0/quote', body),
    submitDeposit: (txHash, depositAddress) => call('POST', '/v0/deposit/submit', { txHash, depositAddress }),
    status: (depositAddress) => call('GET', '/v0/status?depositAddress=' + encodeURIComponent(depositAddress)),
  };
}

module.exports = { makeNearIntents, assetFor };
