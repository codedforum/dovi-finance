import { api } from './api.js?v=dev';
import * as wallet from './wallet.js?v=dev';
import { sheet, busy, errorText, logo } from './ui.js?v=dev';
import { esc } from './format.js?v=dev';

export async function signInSheet({ title = 'Sign in to DOVI', lead = 'No wallet to install and no seed phrase. We will make a dollar account for you.', next = '/app' } = {}) {
  const opts = await wallet.authOptions();
  return new Promise((resolve) => {
    let done = false;
    const s = sheet('<h2>' + esc(title) + '</h2><p class="hint">' + esc(lead) + '</p><div class="signin-opts" id="so"></div><div id="msg" class="err" role="alert" hidden></div><p class="hint consent">By continuing you agree to the <a href="/terms" target="_blank" rel="noopener">Terms</a> and <a href="/privacy" target="_blank" rel="noopener">Privacy</a>. Coinbase creates and protects your wallet. DOVI only uses the cookies it needs.</p>', { label: title, onClose: () => { if (!done) resolve(false); } });
    const so = s.el.querySelector('#so'); const msg = s.el.querySelector('#msg');
    const fail = (e) => { msg.hidden = false; msg.textContent = errorText(e); };
    const ok = () => { done = true; s.close(); resolve(true); };
    const inviteBox = '<div class="invbox"><label class="field" for="inv" style="margin-top:0">' + (opts.inviteOnly ? 'Invite code' : 'Invite code (optional)') + '</label><input class="input" id="inv" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="8" placeholder="K7M2QX9P" style="text-transform:uppercase;letter-spacing:.12em"></div>';
    if (opts.inviteOnly) so.insertAdjacentHTML('beforeend', inviteBox + '<p class="hint" style="margin:-4px 0 12px">DOVI is invite only right now. A friend can share a code from the Invite friends screen.</p>');
    const invite = () => { const el = so.querySelector('#inv'); const v = el ? el.value.trim().toUpperCase() : ''; try { if (v) sessionStorage.setItem('dovi.invite', v); else sessionStorage.removeItem('dovi.invite'); } catch { /* storage blocked */ } return v; };
    if (opts.x) so.insertAdjacentHTML('beforeend', '<a class="btn block" id="xbtn" href="/api/auth/x/start?return=' + encodeURIComponent(next) + '">' + logo('xmark') + ' Continue with X</a>');
    const xb = so.querySelector('#xbtn'); if (xb) xb.addEventListener('click', () => { const v = invite(); xb.href = '/api/auth/x/start?return=' + encodeURIComponent(next) + (v ? '&invite=' + encodeURIComponent(v) : ''); });
    so.insertAdjacentHTML('beforeend', '<div id="g"></div>');
    if (opts.google) wallet.googleButton(so.querySelector('#g'), (e) => (e ? fail(e) : ok())).catch(fail);
    so.insertAdjacentHTML('beforeend', '<div class="divider">or use your email</div><form id="ef" novalidate><label class="field" for="em">Email</label><input class="input" id="em" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required><button class="btn block mint" type="submit" style="margin-top:12px">Send me a code</button></form>');
    const ef = so.querySelector('#ef');
    ef.addEventListener('submit', async (ev) => {
      ev.preventDefault(); msg.hidden = true;
      const email = so.querySelector('#em').value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(new Error('Enter a valid email address.'));
      const btn = ef.querySelector('button');
      try {
        await busy(btn, () => api('/api/auth/email/start', { method: 'POST', body: { email } }));
        ef.outerHTML = '<form id="cf" novalidate><p class="hint">We sent a 6 digit code to <b>' + esc(email) + '</b>.</p><label class="field" for="cd">Code</label><input class="input" id="cd" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456"><button class="linkbtn" id="pc" type="button">Paste code</button><button class="btn block mint" type="submit" style="margin-top:12px">Sign in</button></form>';
        const cf = so.querySelector('#cf');
        cf.querySelector('#cd').focus();
        cf.querySelector('#pc').addEventListener('click', async () => { try { const t = await navigator.clipboard.readText(); const m = /\d{6}/.exec(t || ''); if (m) { cf.querySelector('#cd').value = m[0]; cf.querySelector('#cd').focus(); msg.hidden = true; } else { msg.textContent = 'Copy the 6 digit code from the email first, then tap Paste code.'; msg.hidden = false; } } catch { msg.textContent = 'Your browser blocked pasting. Press and hold in the code box and choose Paste.'; msg.hidden = false; } });
        cf.addEventListener('submit', async (e2) => {
          e2.preventDefault(); msg.hidden = true;
          const code = cf.querySelector('#cd').value.trim();
          try {
            await busy(cf.querySelector('button[type=submit]'), async () => { await api('/api/auth/email/verify', { method: 'POST', body: { email, code, invite: invite() || undefined } }); await wallet.start(); });
            ok();
          } catch (e3) { fail(e3); }
        });
      } catch (e) { fail(e); }
    });
  });
}
