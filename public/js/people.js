import { esc } from './format.js?v=dev';

export function fmtCount(n) {
  if (n == null) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function initials(text) {
  const t = String(text || '?').replace(/^@/, '').trim();
  const parts = t.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0] || '?')[0] + ((parts[1] || '')[0] || '')).toUpperCase();
}

const CHECK = '<svg class="vbadge" viewBox="0 0 24 24" width="16" height="16" role="img" aria-label="Verified"><circle cx="12" cy="12" r="11" fill="#1d9bf0"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function avatarHtml(profile, label, size = 'md') {
  const url = profile && profile.avatarUrl;
  const mail = /@.+\./.test(String(label || '')) && !String(label).startsWith('@');
  const ph = mail ? '<svg viewBox="0 0 24 24" width="55%" height="55%" aria-hidden="true"><path d="M3 6.5h18v11H3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3.5 7l8.5 6.5L20.5 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>' : esc(initials((profile && profile.name) || label));
  return '<span class="pfp ' + size + '"><span class="ph">' + ph + '</span>' + (url ? '<img data-pfp src="' + esc(url) + '" alt="" width="96" height="96" referrerpolicy="no-referrer" decoding="async">' : '') + '</span>';
}

export function wireAvatars(root) {
  root.querySelectorAll('img[data-pfp]').forEach((img) => {
    const done = () => img.classList.add('ok');
    img.addEventListener('load', done); img.addEventListener('error', () => img.remove());
    if (img.complete && img.naturalWidth) done();
  });
}

export function recipientCard({ profile, label, hasAccount }, { compact = false } = {}) {
  const p = profile || null;
  const name = p && p.name ? p.name : label;
  const handle = String(label || '').startsWith('@') ? label : '';
  const meta = [];
  if (p && p.followers != null) meta.push('<span><b>' + esc(fmtCount(p.followers)) + '</b> followers</span>');
  const chip = '<span class="chip ' + (hasAccount ? 'live' : '') + '">' + (hasAccount ? 'On DOVI' : 'New to DOVI') + '</span>';
  return '<div class="rcard' + (compact ? ' compact' : '') + '">' + avatarHtml(p, label, compact ? 'sm' : 'lg') + '<div class="rc-b"><div class="rc-n">' + esc(name) + (p && p.verified ? CHECK : '') + '</div>' + (handle && handle !== name ? '<div class="rc-h">' + esc(handle) + '</div>' : '') + (meta.length && !compact ? '<div class="rc-m">' + meta.join('') + '</div>' : '') + '</div>' + (compact ? '' : chip) + '</div>' + (p && p.bio && !compact ? '<p class="rc-bio">' + esc(p.bio) + '</p>' : '');
}
