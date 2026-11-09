import { api } from './api.js?v=dev';
import { esc, usd, timeAgo, validAmount } from './format.js?v=dev';
import { busy, copy, errorText, toast } from './ui.js?v=dev';

const IC = {
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.9 2H22l-7.6 8.7L23 22h-6.9l-5.4-7-6.2 7H1.4l8.1-9.3L1 2h7.1l4.9 6.4L18.9 2Zm-1.2 18h1.9L6.4 3.9H4.4L17.7 20Z" fill="currentColor" stroke="none"/></svg>',
};

function loadQr() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  return new Promise((res, rej) => { const el = document.createElement('script'); el.src = '/js/qrcode.min.js'; el.onload = () => res(window.qrcode); el.onerror = rej; document.head.appendChild(el); });
}

function qrSvg(qrcode, text) { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }

function payMeHtml(d) {
  const tweet = 'You can pay me in dollars with just my X handle. No wallet needed: ' + d.payMeUrl;
  return '<div class="lk-hero"><div class="lk-h-top"><span class="lk-ic">' + IC.link + '</span><div><b>Your pay-me link</b><p>Put it in your bio. Anyone can pay your ' + esc(d.handle) + ' with a sign in and one tap.</p></div></div><div class="lk-url"><span id="pm">' + esc(d.payMeUrl) + '</span><button class="btn sm" id="cpm" type="button">Copy</button></div><div class="lk-qr" id="qr" aria-label="QR code for your pay-me link"></div><div class="lk-acts"><a class="btn sm ghost" target="_blank" rel="noopener" href="' + esc(d.payMeUrl) + '">Preview</a><a class="btn sm ghost" target="_blank" rel="noopener" href="https://x.com/intent/post?text=' + encodeURIComponent(tweet) + '">' + IC.x + ' Share on X</a></div></div>';
}

function rowHtml(l) {
  const meta = (l.payments ? l.payments + (l.payments === 1 ? ' payment' : ' payments') + ', ' + usd(l.totalMicro) : 'No payments yet') + ', made ' + timeAgo(l.createdAt);
  return '<div class="lk-row' + (l.active ? '' : ' off') + '" data-code="' + esc(l.code) + '"><div class="lk-mid"><b>' + esc(l.title) + '</b><small>' + (l.amountMicro ? esc(usd(l.amountMicro)) : 'Any amount') + ', ' + esc(meta) + '</small><span class="lk-u">' + esc(l.url) + '</span></div><div class="lk-btns"><button class="btn sm ghost" data-cp type="button">Copy</button><button class="btn sm ghost" data-tg type="button">' + (l.active ? 'Turn off' : 'Turn on') + '</button></div></div>';
}

export async function renderLinks(root, session) {
  root.innerHTML = '<div class="skeleton" style="height:160px"></div><div class="skeleton" style="height:220px;margin-top:14px"></div>';
  let d;
  try { d = await api('/api/paylinks'); } catch (e) { root.innerHTML = '<p class="err">' + esc(errorText(e)) + '</p>'; return; }
  if (!d.handle) {
    root.innerHTML = '<h2 class="sec">Payment links</h2><div class="lk-hero"><div class="lk-h-top"><span class="lk-ic">' + IC.link + '</span><div><b>Get paid with a link</b><p>Link your X account to get a pay-me link and reusable payment links for your work. They use your @handle.</p></div></div><div class="lk-acts"><a class="btn mint" href="/app#account">Link X in Account</a></div></div>';
    return;
  }
  const draw = () => {
    root.innerHTML = '<h2 class="sec">Payment links</h2>' + payMeHtml(d) + '<h3 class="mini">Reusable links</h3><form class="card lk-form" id="lf" novalidate><label class="field" for="lt" style="margin-top:0">Name</label><input class="input" id="lt" maxlength="60" placeholder="Logo design, Tip jar, Workshop ticket"><label class="field" for="la">Amount in USD (optional)</label><div class="amount-wrap"><span class="cur" aria-hidden="true">$</span><input class="input" id="la" inputmode="decimal" autocomplete="off" placeholder="Optional"></div><div id="lm" class="err" role="alert" hidden></div><button class="btn block mint" type="submit" style="margin-top:14px">Create link</button></form><div class="lk-list" id="ll">' + (d.links.length ? d.links.map(rowHtml).join('') : '<div class="empty"><h3>No links yet</h3><p>Create one above and share it. Each link counts the payments it brings in.</p></div>') + '</div>';
    loadQr().then((q) => { const box = root.querySelector('#qr'); if (box) box.innerHTML = qrSvg(q, d.payMeUrl) + '<small>Scan to pay ' + esc(d.handle) + '</small>'; }).catch(() => {});
    root.querySelector('#cpm').addEventListener('click', async () => { if (await copy(d.payMeUrl)) toast({ title: 'Link copied', ms: 2000 }); });
    const lm = root.querySelector('#lm');
    root.querySelector('#lf').addEventListener('submit', async (ev) => {
      ev.preventDefault(); lm.hidden = true;
      const title = root.querySelector('#lt').value.trim(); const amount = root.querySelector('#la').value.trim();
      if (title.length < 2) { lm.hidden = false; lm.textContent = 'Give the link a name.'; return; }
      if (amount && !validAmount(amount)) { lm.hidden = false; lm.textContent = 'Enter an amount like 5 or 5.50, or leave it empty.'; return; }
      try {
        const r = await busy(root.querySelector('#lf button'), () => api('/api/paylinks', { method: 'POST', body: { title, amount: amount || undefined } }));
        d.links.unshift(r.link); draw(); toast({ title: 'Link created', body: r.link.title, ms: 3000 });
      } catch (e) { lm.hidden = false; lm.textContent = errorText(e); }
    });
    root.querySelectorAll('.lk-row').forEach((row) => {
      const code = row.dataset.code;
      row.querySelector('[data-cp]').addEventListener('click', async () => { const l = d.links.find((x) => x.code === code); if (await copy(l.url)) toast({ title: 'Link copied', ms: 2000 }); });
      row.querySelector('[data-tg]').addEventListener('click', async (e) => {
        const l = d.links.find((x) => x.code === code);
        try { const r = await busy(e.currentTarget, () => api('/api/paylinks/' + code + '/active', { method: 'POST', body: { active: !l.active } })); Object.assign(l, r.link); draw(); } catch (er) { toast({ title: 'Could not change that link', body: errorText(er), tone: 'bad', icon: '!' }); }
      });
    });
  };
  draw();
}
