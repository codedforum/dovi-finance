'use strict';

const MAX_STEP = 2000;
const MAX_CALLS = 60;
const DEPTH = 5;

async function syncEvents(ctx, { startBlock = 0 } = {}) {
  const get = (k) => { const r = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? r.v : null; };
  const set = (k, v) => ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').run(k, String(v), Date.now());
  const head = Math.max(0, Number(await ctx.chain.blockNumber()) - DEPTH);
  const seen = [];
  let from = get('idx:block') != null ? Number(get('idx:block')) + 1 : Number(startBlock);
  let inserted = 0;
  const ins = ctx.db.prepare('INSERT OR IGNORE INTO chain_events (tx_hash, log_index, kind, claim_id, amount_micro, fee_micro, block_time) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let step = Number(get('idx:step')) || MAX_STEP;
  let calls = 0;
  while (from <= head && calls < MAX_CALLS) {
    const to = Math.min(head, from + step - 1);
    let events;
    try { events = await ctx.chain.getEvents(BigInt(from), BigInt(to)); calls++; }
    catch (err) {
      const m = /limited to a (\d+) range|range (?:is )?(?:too large|limited)[^0-9]*(\d+)/i.exec(String(err && (err.details || err.message) || ''));
      const lim = m ? Number(m[1] || m[2]) : 0;
      if (lim >= 10 && lim < step) { step = lim; set('idx:step', step); continue; }
      throw err;
    }
    ctx.db.exec('BEGIN');
    try {
      for (const e of events) {
        const kind = e.name === 'ClaimCreated' ? 'created' : e.name === 'ClaimClaimed' ? 'claimed' : 'reclaimed';
        const amount = e.args.amount != null ? e.args.amount : e.args.returned;
        const r = ins.run(e.txHash, e.logIndex, kind, e.args.id, amount == null ? null : String(amount), e.args.fee == null ? null : String(e.args.fee), null);
        inserted += Number(r.changes);
        seen.push({ kind, claimId: String(e.args.id), txHash: e.txHash });
      }
      set('idx:block', to);
      ctx.db.exec('COMMIT');
    } catch (err) { ctx.db.exec('ROLLBACK'); throw err; }
    from = to + 1;
  }
  await reconcile(ctx, seen);
  return { head, inserted };
}

async function reconcile(ctx, list) {
  const claims = require('./claims');
  const { findUserByIdentity } = require('./identity');
  for (const e of list) {
    try {
      const row = ctx.db.prepare('SELECT * FROM claims WHERE lower(id) = lower(?)').get(e.claimId);
      if (!row) continue;
      if (e.kind === 'created' && row.status === 'draft') await claims.confirmFunded(ctx, { claimId: row.id, userId: row.sender_user_id, txHash: e.txHash });
      else if (e.kind === 'reclaimed' && (row.status === 'funded' || row.status === 'expired')) await claims.confirmReclaimed(ctx, { claimId: row.id, userId: row.sender_user_id, txHash: e.txHash });
      else if (e.kind === 'claimed' && (row.status === 'funded' || row.status === 'expired')) {
        const u = findUserByIdentity(ctx.db, row.recipient_kind, row.recipient_provider_id);
        if (u) await claims.confirmClaimed(ctx, { claimId: row.id, userId: u.id, txHash: e.txHash });
      }
    } catch (err) { console.error('[dovi] reconcile', e.kind, e.claimId, err && err.code || err && err.message); }
  }
}

function earnings(ctx) {
  const row = ctx.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CAST(fee_micro AS INTEGER)), 0) AS fees, COALESCE(SUM(CAST(amount_micro AS INTEGER)), 0) AS volume FROM chain_events WHERE kind = 'claimed'").get();
  const created = ctx.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount_micro AS INTEGER)), 0) AS volume FROM chain_events WHERE kind = 'created'").get();
  const returned = ctx.db.prepare("SELECT COUNT(*) AS n FROM chain_events WHERE kind = 'reclaimed'").get();
  return {
    claimsCompleted: row.n, feesEarnedMicro: String(row.fees), volumeClaimedMicro: String(row.volume),
    claimsCreated: created.n, volumeCreatedMicro: String(created.volume), claimsReturned: returned.n,
    source: 'on-chain events from the DoviClaim contract, indexed to block ' + ((ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get('idx:block') || {}).v || 'none'),
  };
}

module.exports = { syncEvents, earnings };
