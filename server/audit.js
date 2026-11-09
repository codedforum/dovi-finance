'use strict';

function audit(db, { actor, action, subject = null, data = null }) {
  db.prepare('INSERT INTO audit (ts, actor, action, subject, data) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), String(actor), String(action), subject == null ? null : String(subject), data == null ? null : JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

function recentAudit(db, limit = 50) {
  return db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = { audit, recentAudit };
