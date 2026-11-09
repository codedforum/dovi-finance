'use strict';
const { openDb } = require('../server/db');
const { loadConfig } = require('../server/config');
const { makeRegistry } = require('../server/chains');
const rows = require('../server/chains.json');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const { makeLocalAttester } = require('../server/attester');
const { upsertUser, linkIdentity } = require('../server/identity');

const CONTRACT = '0x1111111111111111111111111111111111111111';

function fakeChain() {
  const claims = new Map();
  return {
    claims,
    async readClaim(id) {
      return claims.get(id) || { sender: '0x0000000000000000000000000000000000000000', amount: 0n, fee: 0n, expiry: 0, status: 0, recipientHash: '0x' + '00'.repeat(32) };
    },
    transfers: new Map(),
    async getTransfer(h) { return this.transfers.get(h) || null; },
    found: null,
    async findTransfer() { return this.found; },
    async blockNumber() { return 100; },
    events: [],
    async getEvents() { const e = this.events; this.events = []; return e; },
    async usdcBalance() { return 7000000n; },
    pool: { a: 5000000000n, b: 50000n * 10n ** 18n },
    async poolReserves() { return this.pool; },
    swaps: [],
    async poolFindSwap({ trader, tokenIn, amountIn }) { return this.swaps.find((x) => x.trader.toLowerCase() === String(trader).toLowerCase() && x.tokenIn.toLowerCase() === String(tokenIn).toLowerCase() && x.amountIn === amountIn) || null; },
    async poolQuote(_p, tokenIn, amountIn) { const usdcIn = String(tokenIn).toLowerCase() === String(this.usdcAddr || '').toLowerCase(); const [rIn, rOut] = usdcIn ? [this.pool.a, this.pool.b] : [this.pool.b, this.pool.a]; const f = amountIn * 9970n; return (f * rOut) / (rIn * 10000n + f); },
    tokenClaims: new Map(),
    async readTokenClaim(id) { return this.tokenClaims.get(id) || { sender: '0x0000000000000000000000000000000000000000', token: '0x0000000000000000000000000000000000000000', amount: 0n, expiry: 0, status: 0, recipientHash: '0x' + '00'.repeat(32) }; },
    async tokenBalance() { return 12500000000000000000n; },
    onchainTokenCreate(id, c) { this.tokenClaims.set(id, { sender: c.sender, token: c.token, amount: BigInt(c.amount), expiry: Number(c.expiry), status: 1, recipientHash: c.recipientHash }); },
    onchainTokenClaim(id) { this.tokenClaims.set(id, { ...this.tokenClaims.get(id), status: 2 }); },
    onchainTokenReclaim(id) { this.tokenClaims.set(id, { ...this.tokenClaims.get(id), status: 3 }); },
    locks: new Map(),
    async readLock(id) { return this.locks.get(id) || 0; },
    onchainCreate(id, { sender, amount, fee, expiry, recipientHash, lock }) { claims.set(id, { sender, amount: BigInt(amount), fee: BigInt(fee), expiry: Number(expiry), status: 1, recipientHash }); if (lock) this.locks.set(id, Number(lock)); },
    autoPays: new Map(),
    allowances: new Map(),
    async readAutoPay(payer) { return this.autoPays.get(String(payer).toLowerCase()) || { perPayment: 0n, perDay: 0n }; },
    async readAllowance(owner) { return this.allowances.get(String(owner).toLowerCase()) || 0n; },
    onchainSetAutoPay(payer, perPayment, perDay) { this.autoPays.set(String(payer).toLowerCase(), { perPayment: BigInt(perPayment), perDay: BigInt(perDay) }); },
    onchainApprove(owner, amount) { this.allowances.set(String(owner).toLowerCase(), BigInt(amount)); },
    onchainClaim(id) { const c = claims.get(id); claims.set(id, { ...c, status: 2 }); },
    onchainReclaim(id) { const c = claims.get(id); claims.set(id, { ...c, status: 3 }); },
  };
}

function makeCtx(over = {}) {
  const db = openDb(':memory:');
  const cfg = loadConfig({ DOVI_CLAIM_CONTRACT: CONTRACT, DOVI_URL: 'https://dovi.test', ...(over.env || {}) });
  const key = generatePrivateKey();
  const attester = makeLocalAttester(cfg, { [cfg.attester.keyEnv]: key });
  const events = [];
  const clock = { t: Date.UTC(2026, 9, 20, 12) };
  const ctx = {
    db, cfg, registry: makeRegistry(rows), chain: fakeChain(), attester, attesterKey: key,
    events, clock, now: () => clock.t,
    notify: (userId, evt) => events.push({ userId, ...evt }),
    ...over.ctx,
  };
  return ctx;
}

function user(ctx, sub, identities = []) {
  const u = upsertUser(ctx.db, { cdpSub: sub, displayName: sub.split(':')[1] || sub });
  for (const [kind, providerId, label] of identities) linkIdentity(ctx.db, { userId: u.id, kind, providerId, label });
  return u;
}

const ADDR = { alice: '0x00000000000000000000000000000000000a11ce', bob: '0x0000000000000000000000000000000000000b0b', carol: '0x000000000000000000000000000000000000ca01' };

module.exports = { makeCtx, user, ADDR, CONTRACT, fakeChain, privateKeyToAccount };
