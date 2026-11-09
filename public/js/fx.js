export function particles(el, n = 16) {
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.className = 'pt';
    p.style.setProperty('--x', (Math.random() * 100).toFixed(1) + '%');
    p.style.setProperty('--s', (3 + Math.random() * 5).toFixed(1) + 'px');
    p.style.setProperty('--d', (7 + Math.random() * 9).toFixed(1) + 's');
    p.style.setProperty('--l', (-Math.random() * 14).toFixed(1) + 's');
    p.style.setProperty('--c', ['#24e47d', '#ffe59b', '#ded5ff', '#cde9ff'][i % 4]);
    el.appendChild(p);
  }
}

export function countUp(el, to, fmt, ms = 700) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !isFinite(to)) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / ms); el.textContent = fmt(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
