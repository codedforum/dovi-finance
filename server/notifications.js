'use strict';

const TYPES = ['payment_received', 'claim_created', 'claim_opened', 'claim_completed', 'claim_expiring', 'claim_returned', 'request_received', 'send_confirmed', 'send_failed', 'swap_completed', 'cap_reached', 'security_login', 'system'];
const GROUPS = {
  money: ['payment_received', 'send_confirmed', 'send_failed', 'request_received', 'swap_completed'],
  claims: ['claim_created', 'claim_opened', 'claim_completed', 'claim_expiring', 'claim_returned'],
  security: ['security_login', 'cap_reached', 'system'],
};

function toView(r) {
  return {
    id: r.id, type: r.type, title: r.title, privateTitle: r.private_title, body: r.body,
    amountMicro: r.amount_micro, ref: r.ref || null, action: r.action_label ? { label: r.action_label, href: r.action_href } : null,
    read: r.read_at != null, createdAt: r.created_at,
  };
}

function frame(view) {
  return 'id: ' + view.id + '\nevent: notification\ndata: ' + JSON.stringify(view) + '\n\n';
}

function makeHub({ heartbeatMs = 25000 } = {}) {
  const subs = new Map();
  const timers = new Set();
  return {
    subscribe(db, userId, res, lastEventId) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 3000\n\n');
      const last = Number(lastEventId);
      if (Number.isInteger(last) && last >= 0) {
        const missed = db.prepare('SELECT * FROM notifications WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT 200').all(userId, last);
        for (const m of missed) res.write(frame(toView(m)));
      }
      if (!subs.has(userId)) subs.set(userId, new Set());
      const mine = subs.get(userId);
      if (mine.size >= 5) { const oldest = mine.values().next().value; try { oldest.end(); } catch { /* closed */ } mine.delete(oldest); }
      mine.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, heartbeatMs);
      if (hb.unref) hb.unref();
      timers.add(hb);
      const done = () => { clearInterval(hb); timers.delete(hb); const s = subs.get(userId); if (s) { s.delete(res); if (!s.size) subs.delete(userId); } };
      if (res.on) { res.on('close', done); res.on('error', done); }
      return done;
    },
    emit(userId, view) {
      const s = subs.get(userId);
      if (!s) return 0;
      const f = frame(view);
      let n = 0;
      for (const res of s) { try { res.write(f); n++; } catch { /* closed */ } }
      return n;
    },
    count(userId) { const s = subs.get(userId); return s ? s.size : 0; },
    close() { for (const t of timers) clearInterval(t); timers.clear(); subs.clear(); },
  };
}

function makeNotifier(db, hub, now = Date.now) {
  return function notify(userId, evt) {
    if (!TYPES.includes(evt.type)) throw new Error('bad_notification_type:' + evt.type);
    const t = now();
    const pref = db.prepare('SELECT * FROM notification_prefs WHERE user_id = ?').get(userId);
    if (pref) {
      if (GROUPS.money.includes(evt.type) && !pref.money) return null;
      if (GROUPS.claims.includes(evt.type) && !pref.claims) return null;
    }
    const mins = Math.floor(t / 60000); const local = (((mins + (pref ? pref.tz_offset : 0)) % 1440) + 1440) % 1440;
    const quiet = !!(pref && pref.quiet_on && (pref.quiet_start <= pref.quiet_end ? local >= pref.quiet_start && local < pref.quiet_end : local >= pref.quiet_start || local < pref.quiet_end));
    const r = db.prepare('INSERT INTO notifications (user_id, type, title, body, private_title, amount_micro, action_label, action_href, created_at, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, evt.type, String(evt.title).slice(0, 140), String(evt.body || '').slice(0, 400), String(evt.privateTitle || 'You have a notification').slice(0, 140), evt.amountMicro == null ? null : String(evt.amountMicro), evt.action ? evt.action.label : null, evt.action ? evt.action.href : null, t, evt.ref ? String(evt.ref).slice(0, 80) : null);
    const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(Number(r.lastInsertRowid));
    const view = toView(row);
    if (hub && !quiet) hub.emit(userId, view);
    return view;
  };
}

function listNotifications(db, userId, { limit = 30, before = null, group = null } = {}) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 30));
  const types = group && GROUPS[group] ? GROUPS[group] : null;
  let sql = 'SELECT * FROM notifications WHERE user_id = ?';
  const args = [userId];
  if (before != null) { sql += ' AND id < ?'; args.push(Number(before)); }
  if (types) { sql += ' AND type IN (' + types.map(() => '?').join(',') + ')'; args.push(...types); }
  sql += ' ORDER BY id DESC LIMIT ?';
  args.push(lim);
  return db.prepare(sql).all(...args).map(toView);
}

function markRead(db, userId, ids, now = Date.now()) {
  if (ids === 'all') return Number(db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, userId).changes);
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
  if (!list.length) return 0;
  return Number(db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (' + list.map(() => '?').join(',') + ')').run(now, userId, ...list).changes);
}

function unreadCount(db, userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;
}

module.exports = { TYPES, GROUPS, makeHub, makeNotifier, listNotifications, markRead, unreadCount, toView, frame };
