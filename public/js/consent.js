const KEY = 'dovi.cookie-notice';
const seen = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const remember = () => { try { localStorage.setItem(KEY, '1'); } catch { /* storage blocked, the notice shows again next visit */ } };

function mount() {
  if (seen() || document.getElementById('cookie-notice')) return;
  const st = document.createElement('style');
  st.textContent = '#cookie-notice{position:fixed;left:16px;bottom:16px;z-index:50;width:min(340px,calc(100vw - 32px));background:#07130f;color:#f3f1e9;border:1px solid rgba(255,255,255,.18);border-radius:16px;padding:8px 10px 8px 12px;display:flex;gap:10px;align-items:center;flex-wrap:nowrap;font-size:13px;animation:cn-in .25s ease-out;box-shadow:0 18px 50px rgba(5,25,16,.35);font:500 12.5px/1.35 Inter,system-ui,sans-serif}'
    + '#cookie-notice p{margin:0;flex:1 1 auto;min-width:0}@keyframes cn-in{from{opacity:0;transform:translateY(8px)}}@media (prefers-reduced-motion:reduce){#cookie-notice{animation:none}}#cookie-notice a{color:#5cf0a0;text-decoration:underline}'
    + '#cookie-notice button{background:#24e47d;color:#07130f;border:0;border-radius:99px;padding:6px 16px;min-height:40px;font:800 13px Inter,system-ui,sans-serif;cursor:pointer}'
    + '#cookie-notice a:focus-visible,#cookie-notice button:focus-visible{outline:3px solid #ffe59b;outline-offset:2px}'
    + 'body.has-tabs #cookie-notice{bottom:84px}@media (max-width:480px){#cookie-notice{left:12px;width:calc(100vw - 24px)}}';
  document.head.appendChild(st);
  const n = document.createElement('div');
  n.id = 'cookie-notice'; n.setAttribute('role', 'region'); n.setAttribute('aria-label', 'Cookie notice');
  n.innerHTML = '<p>DOVI only uses the cookies it needs to work, such as keeping you signed in. No ads, no analytics, no tracking. <a href="/cookies">Cookie policy</a></p><button type="button">OK</button>';
  const close = () => { clearTimeout(timer); remember(); n.remove(); document.body.classList.remove('has-notice'); };
  const timer = setTimeout(close, 30000);
  n.querySelector('button').addEventListener('click', close);
  n.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.appendChild(n); document.body.classList.add('has-notice');
  if (document.querySelector('.tabs,.tabbar,nav.tab')) document.body.classList.add('has-tabs');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
