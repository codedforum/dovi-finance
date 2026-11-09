'use strict';
/* Test network only: asks Circle's faucet API to send test USDC to a wallet. Inactive unless CIRCLE_API_KEY is set. */
const crypto = require('crypto');
const URL_DRIPS = 'https://api.circle.com/v1/faucet/drips';

function makeCircleFaucet(env = process.env, fetchFn = globalThis.fetch) {
  const key = env.CIRCLE_API_KEY || '';
  const chain = env.CIRCLE_FAUCET_CHAIN || 'BASE-SEPOLIA';
  return {
    enabled: !!key,
    async requestUsdc(address) {
      if (!key) return { ok: false, reason: 'no_key' };
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 10000);
      try {
        const res = await fetchFn(URL_DRIPS, {
          method: 'POST', redirect: 'manual', signal: ac.signal,
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
          body: JSON.stringify({ address, blockchain: chain, usdc: true }),
        });
        if (res.status === 204 || res.status === 200) return { ok: true };
        let msg = ''; try { msg = String(await res.text()).slice(0, 300); } catch { /* body is optional */ }
        return { ok: false, reason: 'http_' + res.status, detail: msg.replace(/Bearer\s+\S+/g, 'Bearer ***').slice(0, 200) };
      } catch (e) { return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network' }; }
      finally { clearTimeout(t); }
    },
  };
}

module.exports = { makeCircleFaucet };
