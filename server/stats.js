'use strict';

function compute(ctx) {
  const db = ctx.db;
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  /* payment counts come from the escrow contract's own events (chain_events, filled by the indexer), so they match the block explorer */
  const ev = (kind) => one('SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount_micro AS INTEGER)), 0) AS s FROM chain_events WHERE kind = ?', kind);
  const created = ev('created'), claimedEv = ev('claimed'), reclaimed = ev('reclaimed');
  const sent = { n: created.n, s: created.s, first: one("SELECT MIN(funded_at) AS first FROM claims WHERE status IN ('funded', 'claimed', 'returned', 'expired')").first };
  const claimed = one("SELECT COUNT(*) AS n, COUNT(DISTINCT recipient_label) AS handles, AVG((claimed_at - funded_at) / 1000.0) AS avgsec FROM claims WHERE status = 'claimed' AND claimed_at IS NOT NULL AND funded_at IS NOT NULL");
  claimed.n = claimedEv.n;
  const returned = { n: reclaimed.n };
  const waiting = { n: Math.max(0, Number(created.n) - Number(claimedEv.n) - Number(reclaimed.n)) };
  const idx = one("SELECT v FROM kv WHERE k = 'idx:block'");
  const users = one('SELECT COUNT(*) AS n FROM users');
  const waitlist = one("SELECT COUNT(*) AS n FROM waitlist WHERE source = 'waitlist'");
  const settled = Number(claimed.n) + Number(returned.n);
  return {
    network: ctx.cfg.base.testnet ? 'Base Sepolia' : 'Base', testnet: !!ctx.cfg.base.testnet,
    payments: { sent: Number(sent.n), totalMicro: String(sent.s), claimed: Number(claimed.n), returned: Number(returned.n), waiting: Number(waiting.n) },
    claimRatePct: settled >= 3 ? Math.round((Number(claimed.n) / settled) * 100) : null,
    handlesPaid: Number(claimed.handles),
    avgClaimSeconds: claimed.avgsec == null ? null : Math.round(Number(claimed.avgsec)),
    accounts: Number(users.n), waitlist: Number(waitlist.n),
    source: 'escrow contract events', indexedToBlock: idx ? Number(idx.v) : null,
    since: sent.first ? Number(sent.first) : null, generatedAt: ctx.now ? ctx.now() : Date.now(),
  };
}

function cached(ctx) {
  const t = ctx.now ? ctx.now() : Date.now();
  if (ctx.statsCache && t - ctx.statsCache.at < 60000) return ctx.statsCache.v;
  const v = compute(ctx); ctx.statsCache = { at: t, v }; return v;
}

module.exports = { compute, cached };
