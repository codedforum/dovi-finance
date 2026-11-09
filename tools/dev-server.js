'use strict';
// Local development and browser testing only. Uses an in-memory database, a fake chain and a mock wallet.
// It is never imported by server/index.js and refuses to run unless DOVI_ENV=dev.
if (process.env.DOVI_ENV !== 'dev') { console.error('Set DOVI_ENV=dev to run the dev server.'); process.exit(1); }
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { decodeFunctionData } = require('viem');
const { makeCtx, fakeChain } = require('../test/helpers');
const { createApp } = require('../server/app');
const { makeHub, makeNotifier } = require('../server/notifications');
const { userFromSession } = require('../server/auth/login');
const { cookieFor } = require('../server/auth/session');
const abi = require('../server/abi/DoviClaim.json');
const { feeFor } = require('../server/money');

const PORT = Number(process.env.PORT || 3399);
const ctx = makeCtx({ env: { DOVI_ENV: 'dev', DOVI_URL: 'http://localhost:' + PORT, X_CLIENT_ID: 'dev', X_REDIRECT_URI: 'http://localhost:' + PORT + '/api/auth/x/callback' } });
ctx.devMock = true; ctx.cfg.claim.lockEnabled = true;
ctx.cfg.giveaway = true; ctx.cfg.payBaseUrl = 'http://localhost:' + PORT;
ctx.engagement = { async tweet(id) { return { id, authorId: '555', authorHandle: 'bob', isReply: false }; }, async retweeters() { return ['amara', 'kofi', 'lena', 'tunde', 'zed', 'ola', 'ife'].map((h, i) => ({ id: String(100 + i), handle: h })); }, async replies() { return ['amara', 'kofi', 'lena', 'tunde', 'zed', 'ola', 'bob'].map((h, i) => ({ id: h === 'bob' ? '555' : String(100 + i), handle: h })); }, async quotes() { return []; } }; ctx.env = {};
ctx.cfg.publicDir = path.join(__dirname, '..', 'public');
ctx.now = () => Date.now(); ctx.clock = null;
ctx.hub = makeHub(); ctx.notify = makeNotifier(ctx.db, ctx.hub, ctx.now);
const secret = crypto.randomBytes(16).toString('hex');
ctx.sessions = { mint: (id, jti) => { const p = Buffer.from(JSON.stringify({ id, jti: jti || null, iat: Date.now() })).toString('base64url'); return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('hex'); }, read: (t) => { const i = String(t).lastIndexOf('.'); const p = t.slice(0, i); if (t.slice(i + 1) !== crypto.createHmac('sha256', secret).update(p).digest('hex')) return null; try { const j = JSON.parse(Buffer.from(p, 'base64url').toString()); return { identity: j.id, jti: j.jti, iatMs: j.iat }; } catch { return null; } }, verify: (t) => { const r = ctx.sessions.read(t); return r ? r.identity : null; } };
ctx.cdpAuth = { mintFor: (id) => 'dev-jwt-' + id, jwks: () => ({ keys: [] }) };
ctx.cdpProxy = (req, res) => { res.writeHead(404); res.end(); };
ctx.emailOtp = { start: async () => ({ sent: true, devCode: '123456' }), verify: (email, code) => { if (code !== '123456') throw new Error('That code did not work.'); return { email: String(email).toLowerCase(), identity: 'email:' + String(email).toLowerCase() }; } };
ctx.googleAuth = { verifyGoogleIdToken: async () => { throw new Error('no google in dev'); } };
ctx.onramp = { onrampUrl: async ({ address }) => ({ url: 'about:blank#' + address }), providers: () => [{ id: 'coinbase' }] };
const XUSERS = { amara: '42', bob: '555', kofi: '43', carol: '777' };
ctx.fetch = async (url) => { const h = String(url).split('/').pop().toLowerCase(); return XUSERS[h] ? { status: 200, json: async () => ({ user: { id: XUSERS[h], screen_name: h, protected: false, name: h[0].toUpperCase() + h.slice(1) + ' Obi', followers: 12400, verification: { verified: h === 'amara' }, description: 'Builder, runner, coffee person. Lagos.' } }) } : { status: 302, json: async () => ({}) }; };
ctx.chain.usdcBalance = async () => 7000000n;
ctx.executor = { async createClaimFor({ payer, id, recipientHash, amountMicro, expiry }) { ctx.chain.onchainCreate(id, { sender: payer, amount: BigInt(amountMicro), fee: feeFor(BigInt(amountMicro), ctx.cfg.claim), expiry, recipientHash }); return { txHash: '0x' + crypto.randomBytes(32).toString('hex') }; } };
ctx.chain.readAutoPay = async (payer) => ctx.chain.autoPays.get(String(payer).toLowerCase()) || { perPayment: 0n, perDay: 0n };
if (process.env.DOVI_DEV_TOKENS === '1') ctx.cfg.tokens = [{ symbol: 'VIBES', name: 'Vibes', address: '0x2222222222222222222222222222222222222222', decimals: 18, minUnits: 10n ** 18n, perClaimUnits: 1000n * 10n ** 18n, test: true }];
if (process.env.DOVI_DEV_TOKENS === '1') { ctx.cfg.pool = { address: '0x3333333333333333333333333333333333333333' }; ctx.chain.usdcAddr = ctx.cfg.base.usdc; ctx.cfg.tokens[0].faucet = true; }
if (process.env.DOVI_DEV_NAIRA === '1') {
  ctx.env = { ...(ctx.env || {}), DOVI_NAIRA: '1' }; ctx.cfg.base.testnet = true;
  ctx.executor.address = async () => '0x00000000000000000000000000000000000e0ec1';
  ctx.executor.sendUsdc = async () => ({ txHash: '0x' + crypto.randomBytes(32).toString('hex') });
  const plainFetch = ctx.fetch;
  ctx.fetch = async (url, o) => (String(url).includes('er-api') ? { ok: true, status: 200, json: async () => ({ rates: { NGN: 1500 }, time_last_update_unix: Math.floor(Date.now() / 1000) }) } : plainFetch(url, o));
  if (process.env.DOVI_DEV_KORA === '1') {
    const { KoraError } = require('../lib/kora');
    ctx.kora = { test: true,
      async resolve({ account }) { if (String(account).startsWith('000')) return { accountName: 'ADA OBI' }; throw new KoraError('rejected', 'no account'); },
      async initCharge({ amountKobo }) { return { amountExpectedKobo: String(BigInt(amountKobo) + 5000n), account: { bankName: 'Wema Bank', accountNumber: '8012345678', accountName: 'DOVI', expiresAt: Date.now() + 1800000 } }; },
      async getCharge() { return { status: 'success', amountPaidKobo: '99999999999' }; },
      async disburse() { return { status: 'pending' }; }, async getPayout() { return { status: 'success' }; } };
  }
  if (process.env.DOVI_DEV_AGENT === '1') ctx.agentLLM = { async ask({ handle }) { return { action: 'chat', reply: 'Yes, you are signed in as @' + (handle || 'you') + '. I only know your DOVI account, nothing else about you. I can check your balance, send or request money, or help you cash out to naira.' }; } };
  setInterval(() => require('../server/naira').tick(ctx).catch(() => {}), 5000).unref();
}
const { handler } = createApp(ctx);

async function readBody(req) { const c = []; for await (const x of req) c.push(x); return c.length ? JSON.parse(Buffer.concat(c).toString()) : {}; }
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v))); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/dev/login' && req.method === 'POST') {
    const { identity, label } = await readBody(req);
    const user = userFromSession(ctx, identity, { label });
    if (label) ctx.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(label, user.id);
    if (label && /^x:/.test(identity)) ctx.db.prepare("UPDATE identities SET label = ? WHERE user_id = ? AND kind = 'x'").run(label, user.id);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookieFor(ctx.sessions.mint(identity), { secure: false }) });
    return res.end(JSON.stringify({ ok: true, userId: user.id }));
  }
  if (u.pathname === '/api/dev/draw' && req.method === 'POST') {
    ctx.cfg.giveaway = true;
    ctx.db.prepare("UPDATE giveaways SET ends_at = 1 WHERE status = 'open'").run();
    const r = await require('../server/giveaway').drawDue(ctx);
    return json(res, 200, r);
  }
  if (u.pathname === '/api/dev/mention' && req.method === 'POST') {
    const m = await readBody(req);
    const r = await require('../server/xpay').processMention(ctx, m);
    const out = ctx.db.prepare('SELECT text FROM x_outbox ORDER BY id DESC LIMIT 1').get();
    return json(res, 200, { result: r, reply: out && out.text });
  }
  if (u.pathname === '/api/dev/execute' && req.method === 'POST') {
    const { from, calls } = await readBody(req);
    for (const c of calls) {
      if (ctx.cfg.pool && c.to.toLowerCase() === ctx.cfg.pool.address.toLowerCase()) {
        const d = decodeFunctionData({ abi: require('../server/chain-client').POOL_ABI, data: c.data });
        const usdcIn = String(d.args[0]).toLowerCase() === ctx.cfg.base.usdc.toLowerCase();
        const out = await ctx.chain.poolQuote(c.to, d.args[0], d.args[1]);
        ctx.chain.swaps.push({ trader: from, tokenIn: d.args[0], amountIn: d.args[1], amountOut: out, txHash: '0x' + crypto.randomBytes(32).toString('hex') });
        if (usdcIn) { ctx.chain.pool.a += d.args[1]; ctx.chain.pool.b -= out; } else { ctx.chain.pool.b += d.args[1]; ctx.chain.pool.a -= out; }
      } else if (c.to.toLowerCase() === ctx.cfg.claim.contract.toLowerCase()) {
        let d; try { d = decodeFunctionData({ abi, data: c.data }); } catch { d = decodeFunctionData({ abi: require('../server/abi/DoviClaimV4.json'), data: c.data }); }
        if (d.functionName === 'createTokenClaim') { const [token, id, hash, amount, expiry] = d.args; ctx.chain.onchainTokenCreate(id, { sender: from, token, amount, expiry, recipientHash: hash }); }
        if (d.functionName === 'claimToken') ctx.chain.onchainTokenClaim(d.args[0]);
        if (d.functionName === 'reclaimToken') ctx.chain.onchainTokenReclaim(d.args[0]);
        if (d.functionName === 'createClaim') { const [id, hash, amount, expiry] = d.args; ctx.chain.onchainCreate(id, { sender: from, amount, fee: feeFor(amount, ctx.cfg.claim), expiry, recipientHash: hash }); }
        if (d.functionName === 'createBatch') { const [ids, hashes, amounts, expiry] = d.args; ids.forEach((id, i) => ctx.chain.onchainCreate(id, { sender: from, amount: amounts[i], fee: feeFor(amounts[i], ctx.cfg.claim), expiry, recipientHash: hashes[i] })); }
        if (d.functionName === 'createClaimLocked') { const [id, hash, amount, expiry, lock] = d.args; ctx.chain.onchainCreate(id, { sender: from, amount, fee: feeFor(amount, ctx.cfg.claim), expiry, recipientHash: hash, lock }); }
        if (d.functionName === 'createBatchLocked') { const [ids, hashes, amounts, expiry, lock] = d.args; ids.forEach((id, i) => ctx.chain.onchainCreate(id, { sender: from, amount: amounts[i], fee: feeFor(amounts[i], ctx.cfg.claim), expiry, recipientHash: hashes[i], lock })); }
        if (d.functionName === 'setAutoPay') ctx.chain.onchainSetAutoPay(from, d.args[0], d.args[1]);
        if (d.functionName === 'claim') ctx.chain.onchainClaim(d.args[0]);
        if (d.functionName === 'reclaim') ctx.chain.onchainReclaim(d.args[0]);
      } else if (c.data.startsWith('0xa9059cbb')) {
        const to = '0x' + c.data.slice(34, 74); const value = BigInt('0x' + c.data.slice(74, 138));
        const h = '0x' + crypto.randomBytes(32).toString('hex');
        ctx.chain.found = { txHash: h };
        ctx.chain.transfers.set(h, { status: 'success', transfers: [{ token: ctx.cfg.base.usdc, from, to, value: value.toString() }] });
      } else if (c.data.startsWith('0x095ea7b3')) { ctx.chain.onchainApprove(from, BigInt('0x' + c.data.slice(74, 138))); }
    }
    return json(res, 200, { hash: '0x' + crypto.randomBytes(32).toString('hex') });
  }
  return handler(req, res);
}).listen(PORT, '127.0.0.1', () => console.log('DOVI dev server on http://localhost:' + PORT));
