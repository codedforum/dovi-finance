'use strict';
// Test network only: tops a wallet up with Circle test USDC through the Coinbase developer faucet.
// The faucet itself enforces 1 USDC per request and 10 USDC per rolling 24 hours per address.
let client = null;
function cdp() {
  if (!client) { const { CdpClient } = require('@coinbase/cdp-sdk'); client = new CdpClient(); }
  return client;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestTestUsdc(address, { requests = 10, pauseMs = 400 } = {}) {
  let ok = 0; let reason = '';
  for (let i = 0; i < requests; i++) {
    try { await cdp().evm.requestFaucet({ address, network: 'base-sepolia', token: 'usdc' }); ok++; }
    catch (e) { reason = String((e && e.message) || e).slice(0, 120); break; }
    if (i < requests - 1) await sleep(pauseMs);
  }
  return { granted: ok, reason };
}

module.exports = { requestTestUsdc };
