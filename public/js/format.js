export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function usd(micro) {
  const m = BigInt(micro || 0);
  const neg = m < 0n; const a = neg ? -m : m;
  const whole = (a / 1000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let frac = String(a % 1000000n).padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = (frac + '00').slice(0, 2);
  return (neg ? '-' : '') + '$' + whole + '.' + frac;
}

export function validAmount(text) {
  const s = String(text || '').trim().replace(/^\$/, '');
  return /^\d{1,9}(\.\d{1,6})?$/.test(s) && Number(s) > 0;
}

export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : d + ' days ago';
}

export function inTime(sec, now = Date.now()) {
  const left = sec * 1000 - now;
  if (left <= 0) return 'expired';
  const h = Math.floor(left / 3600000);
  if (h < 1) return 'less than an hour left';
  if (h < 48) return h + ' hours left';
  return Math.floor(h / 24) + ' days left';
}

export function safeHref(h) { return typeof h === 'string' && /^\/(?![\/\\])[^\\\s]*$/.test(h) ? h : '/app'; }

export function fmtDateTime(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms)); const now = new Date();
  const o = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (d.getFullYear() !== now.getFullYear()) o.year = 'numeric';
  try { return d.toLocaleString(undefined, o); } catch { return d.toISOString().replace('T', ' ').slice(0, 16); }
}
