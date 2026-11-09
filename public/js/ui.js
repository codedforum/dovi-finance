import { esc } from './format.js?v=dev';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const stack = [];
export function sheet(html, { onClose, label = 'Dialog', cls = '' } = {}) {
  const lastFocus = document.activeElement;
  const token = {};
  stack.push(token);
  let locked = false;
  const back = document.createElement('div');
  back.className = 'sheet-back' + (cls ? ' ' + cls : '');
  back.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(label) + '" tabindex="-1"><button class="x" type="button" aria-label="Close">&times;</button><div class="sb"></div></div>';
  const body = $('.sb', back);
  body.innerHTML = html;
  const tryClose = () => { if (!locked) close(); };
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); const i = stack.indexOf(token); if (i >= 0) stack.splice(i, 1); if (lastFocus && lastFocus.isConnected && lastFocus.focus) lastFocus.focus(); if (onClose) onClose(); };
  const onKey = (e) => {
    if (stack[stack.length - 1] !== token) return;
    if (e.key === 'Escape') tryClose();
    if (e.key === 'Tab') {
      const f = $$('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])', back).filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (!back.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', (e) => { if (e.target === back || (e.target.closest && e.target.closest('.x'))) tryClose(); });
  document.body.appendChild(back);
  const first = $('input,button:not(.x)', body);
  setTimeout(() => (first || $('.sheet', back)).focus(), 30);
  return { el: body, close, set: (h) => { body.innerHTML = h; if (!back.contains(document.activeElement)) { const n = $('input,button:not(.x)', body) || $('.sheet', back); if (n && n.focus) n.focus(); } }, lock: (v) => { locked = !!v; back.classList.toggle('locked', locked); } };
}

let toastRoot = null;
export function toast(opts) {
  const { title, body = '', icon = '✓', tone = '', action = null, ms = 6000 } = typeof opts === 'string' ? { title: opts } : (opts || {});
  if (!toastRoot) { toastRoot = document.createElement('div'); toastRoot.className = 'toasts'; toastRoot.setAttribute('role', 'status'); toastRoot.setAttribute('aria-live', 'polite'); document.body.appendChild(toastRoot); }
  const t = document.createElement('div');
  t.className = 'toast ' + tone;
  t.innerHTML = '<div class="ic" aria-hidden="true">' + esc(icon) + '</div><div class="tb"><div class="tt">' + esc(title) + '</div>' + (body ? '<div class="td">' + esc(body) + '</div>' : '') + (action ? '<div class="ta"><a' + (action.claim ? ' data-claim="' + esc(action.claim) + '"' : '') + ' href="' + esc(action.href) + '">' + esc(action.label) + '</a></div>' : '') + '</div><button class="tx" type="button" aria-label="Dismiss">&times;</button>';
  let timer;
  const kill = () => { clearTimeout(timer); t.classList.add('out'); setTimeout(() => t.remove(), 230); };
  $('.tx', t).addEventListener('click', kill);
  t.addEventListener('mouseenter', () => clearTimeout(timer));
  t.addEventListener('mouseleave', () => { timer = setTimeout(kill, 2500); });
  let x0 = null;
  t.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  t.addEventListener('touchend', (e) => { if (x0 != null && Math.abs(e.changedTouches[0].clientX - x0) > 60) kill(); x0 = null; });
  toastRoot.appendChild(t);
  while (toastRoot.children.length > 3) toastRoot.firstChild.remove();
  timer = setTimeout(kill, ms);
  return kill;
}

export async function busy(btn, fn) {
  if (!btn) return fn();
  if (btn.classList.contains('busy')) return new Promise(() => {});
  const html = btn.innerHTML;
  btn.classList.add('busy');
  btn.setAttribute('aria-busy', 'true');
  btn.innerHTML = '<span class="spin" aria-hidden="true"></span> Working';
  try { return await fn(); } finally { btn.classList.remove('busy'); btn.removeAttribute('aria-busy'); btn.innerHTML = html; }
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; } ta.remove(); return ok;
  }
}

export function errorText(e) { return e && e.message ? e.message : 'Something went wrong. Please try again.'; }

export function logo(name, cls = 'lg') { return '<svg class="' + cls + '" width="16" height="16" aria-hidden="true"><use href="/brand/logos.svg#lg-' + name + '"/></svg>'; }

// In-app links (toast actions, notification rows) while already on the app page: close open sheets and move to
// the target screen, or refresh the current one when the address would not change.
document.addEventListener('click', (e) => {
  const c = e.target.closest && e.target.closest('a[data-claim]');
  if (c && !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0 && /^\/app\/?$/.test(location.pathname)) {
    e.preventDefault();
    document.querySelectorAll('.sheet-back .x').forEach((b) => b.click());
    document.querySelectorAll('.toast .tx').forEach((b) => b.click());
    document.dispatchEvent(new CustomEvent('dovi:open-claim', { detail: c.getAttribute('data-claim') }));
    return;
  }
  const a = e.target.closest && e.target.closest('a[href^="/app"]');
  if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  if (!/^\/app\/?$/.test(location.pathname)) return;
  let u; try { u = new URL(a.getAttribute('href'), location.origin); } catch { return; }
  if (u.origin !== location.origin || !/^\/app\/?$/.test(u.pathname)) return;
  e.preventDefault();
  document.querySelectorAll('.sheet-back .x').forEach((b) => b.click());
  document.querySelectorAll('.toast .tx').forEach((b) => b.click());
  if (u.hash && u.hash !== location.hash) location.hash = u.hash;
  else { if (!u.hash && location.hash) history.pushState(null, '', u.pathname); window.dispatchEvent(new HashChangeEvent('hashchange')); }
}, true);
