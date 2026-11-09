'use strict';
const http = require('node:http');
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { makeRegistry, applyNetwork } = require('./chains');
const rows = require('./chains.json');
const { defaultSessions } = require('./auth/session');
const { makeAttester } = require('./attester');
const { makeChainClient, makeReader } = require('./chain-client');
const { makeHub, makeNotifier } = require('./notifications');
const { createApp } = require('./app');
const claims = require('./claims');
const { syncEvents } = require('./indexer');
const { audit } = require('./audit');

function buildCtx(env = process.env) {
  const cfg = loadConfig(env);
  const db = openDb(cfg.dbPath);
  const registry = makeRegistry(applyNetwork(rows, cfg), { allowTestnet: cfg.network === 'sepolia', onChange: (e) => audit(db, { actor: e.actor, action: 'chain.status', subject: e.id, data: e }) });
  for (const r of db.prepare('SELECT id, status FROM chain_status').all()) { try { registry.setStatus(r.id, r.status, 'boot'); } catch (e) { console.error('[dovi] ignored stored chain status', r.id, r.status, e.message); } }
  const hub = makeHub();
  const ctx = {
    env, cfg, db, registry, hub, now: () => Date.now(),
    sessions: defaultSessions(), cdpAuth: require('../lib/cdp-auth'), cdpProxy: require('../lib/cdp-proxy').cdpProxy,
    emailOtp: require('../lib/email-otp'), googleAuth: require('../lib/google-auth'), onramp: require('../lib/onramp'),
    chain: cfg.claim.contract ? makeChainClient(cfg) : null,
    reader: makeReader(cfg),
    attester: null,
    near: require('./nearintents').makeNearIntents(env),
    circleFaucet: require('../lib/circle-faucet').makeCircleFaucet(env),
    kora: require('../lib/kora').makeKora(env),
    agentLLM: require('./agent/llm').makeAgentLLM(env),
    executor: null, mentions: null, xposter: null, postChecker: require('./autorelease').makePostChecker(env), reqlog: require('./reqlog').makeReqLog(env),
  };
  ctx.notify = makeNotifier(db, hub, ctx.now);
  ctx.mailer = require('../lib/mailer').makeMailer(env);
  if (cfg.giveaway) { try { ctx.engagement = require('./giveaway').makeEngagementReader(env); } catch (e) { console.error('[dovi] giveaways not ready:', e.message); } }
  if ((env.DOVI_XPAY === '1' || env.DOVI_MCP === '1') && cfg.claim.contract) {
    try {
      ctx.executor = require('./executor').makeCdpExecutor(cfg, env);
      if (env.DOVI_XPAY === '1') { ctx.mentions = require('./xpay').makeMentionReader(env); ctx.intentLLM = require('./xintent').makeIntentLLM(env); if (env.DOVI_XPOST === '1') ctx.xposter = require('./xposter').makeXPoster(env); }
    } catch (e) { console.error('[dovi] executor not ready:', e.message); }
  }
  try { ctx.attester = makeAttester(cfg, env); } catch (e) { console.error('[dovi] attester not ready:', e.message); }
  return ctx;
}

const env0 = (ctx) => ctx.env && ctx.env.DOVI_NAIRA;
const once = (fn) => { let busy = false; return () => { if (busy) return; busy = true; Promise.resolve().then(fn).catch(() => {}).finally(() => { busy = false; }); }; };

function start() {
  process.on('unhandledRejection', (e) => console.error('[dovi] unhandled rejection', e && e.stack || e));
  const ctx = buildCtx();
  ctx.registry.assertRegistryHonest();
  const { handler } = createApp(ctx);
  const server = http.createServer(handler);
  server.listen(ctx.cfg.port, ctx.cfg.host, () => console.log('DOVI listening on http://' + ctx.cfg.host + ':' + ctx.cfg.port + ' | ' + ctx.registry.statusLine()));
  const timers = [];
  timers.push(setInterval(() => { try { claims.sweep(ctx); } catch (e) { console.error('[dovi] sweep', e.message); } }, 10 * 60 * 1000));
  if (ctx.chain) { const drift = () => require('./drift').check(ctx).then((d) => { if (d.length) console.error('[dovi] config drift: ' + d.join('; ')); }).catch((e) => console.error('[dovi] drift check', e.message)); drift(); timers.push(setInterval(drift, 10 * 60 * 1000)); }
  if (ctx.chain) timers.push(setInterval(once(() => syncEvents(ctx, { startBlock: Number(ctx.env.DOVI_CLAIM_DEPLOY_BLOCK || 0) }).catch((e) => console.error('[dovi] index', e.message))), 60 * 1000));
  if (ctx.env.DOVI_AUTORELEASE !== '0') timers.push(setInterval(once(() => require('./autorelease').releaseDue(ctx).catch((e) => console.error('[dovi] auto release', e.message))), 60 * 1000));
  if (ctx.engagement && ctx.cfg.giveaway) timers.push(setInterval(once(() => require('./giveaway').drawDue(ctx).catch((e) => console.error('[dovi] giveaway draw', e.message))), 60 * 1000));
  if (ctx.executor) timers.push(require('./gaswatch').start(ctx));
  if (ctx.executor && env0(ctx) === '1') timers.push(setInterval(once(() => require('./naira').tick(ctx).catch((e) => console.error('[dovi] naira', e.message))), 20 * 1000));
  if (ctx.mentions && ctx.executor) timers.push(setInterval(once(() => require('./xpay').pollMentions(ctx).catch((e) => console.error('[dovi] x mentions', e.message))), Math.max(1, Number(ctx.env.DOVI_XPAY_POLL_MIN || 5)) * 60 * 1000));
  if (ctx.xposter) timers.push(setInterval(once(() => require('./xposter').flushOutbox(ctx).then(() => require('./xposter').flushDms(ctx)).catch((e) => console.error('[dovi] x outbox', e.message))), 20 * 1000));
  timers.forEach((t) => t.unref && t.unref());
  const stop = (sig) => { console.log(sig + ' received, closing DOVI'); ctx.hub.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  return { server, ctx };
}

if (require.main === module) start();
module.exports = { buildCtx, start };
