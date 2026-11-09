import { api } from './api.js?v=dev';
import { esc, timeAgo } from './format.js?v=dev';
import * as wallet from './wallet.js?v=dev';
import { sheet, busy, errorText, toast } from './ui.js?v=dev';

const when = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/* account screen: start a recovery from a new login, finish one, or cancel one aimed at your account */
export async function mountRecovery(slot) {
  let r; try { r = await api('/api/recovery/mine'); } catch { return; }
  if (!r || !r.enabled) return;
  const box = document.createElement('div'); slot.appendChild(box);
  const open = r.mine.find((x) => x.status === 'pending' || x.status === 'waiting');
  let html = '<h3 class="mini">Account recovery</h3><div class="card">';
  if (r.incoming.length) html += r.incoming.map((x) => '<p class="err" role="alert"><b>Someone asked to move your account to a new login.</b> If this was not you, cancel it now.</p><button class="btn block danger" data-rc="' + esc(x.id) + '" type="button">Cancel this request</button>').join('');
  else if (open) html += '<b>' + (open.status === 'pending' ? 'Waiting for the DOVI team to check you' : open.ready ? 'Ready to finish' : 'Approved, waiting time running') + '</b><p class="note">' + (open.status === 'waiting' ? 'The move can be finished from ' + esc(when(open.readyAt)) + '. The owner of the account has been told and can still cancel.' : 'We check who you are before anything moves. Nothing has changed on the old account.') + '</p>' + (open.ready ? '<button class="btn block mint" id="rcdone" data-id="' + esc(open.id) + '" type="button">Finish recovery</button>' : '');
  else html += '<b>Lost access to your X account or email?</b><p class="note">Sign in here with a new login, then ask us to move your old account to it. The DOVI team checks it is you, there is a waiting time, and the old account owner is told.</p><button class="btn block" id="rcgo" type="button">Recover my account</button>';
  html += '</div>';
  box.innerHTML = html;
  box.querySelectorAll('[data-rc]').forEach((b) => b.addEventListener('click', async () => {
    try { await busy(b, () => api('/api/recovery/' + b.dataset.rc + '/cancel', { method: 'POST', body: {} })); toast({ title: 'Cancelled', body: 'The request was stopped.', icon: '✓' }); box.innerHTML = ''; } catch (e) { toast({ title: 'Could not cancel', body: errorText(e), tone: 'bad', icon: '!' }); }
  }));
  const go = box.querySelector('#rcgo'); if (go) go.addEventListener('click', () => ask(() => { box.remove(); mountRecovery(slot); }));
  const done = box.querySelector('#rcdone');
  if (done) done.addEventListener('click', async () => {
    try { await busy(done, () => api('/api/recovery/' + done.dataset.id + '/complete', { method: 'POST', body: {} })); try { await wallet.signOut(); } catch { /* best effort */ } toast({ title: 'Account moved', body: 'Sign in again with this login.', icon: '✓' }); setTimeout(() => { location.href = '/app'; }, 1200); }
    catch (e) { toast({ title: 'Could not finish', body: errorText(e), tone: 'bad', icon: '!' }); }
  });
}

function ask(onDone) {
  const s = sheet('', { label: 'Recover my account' });
  const form = (err = '') => {
    s.set('<div class="rv"><h2>Recover my account</h2><p class="hint">Tell us which account you lost. We will check it is you before anything moves.</p>' +
      '<label class="field" for="rcl">Your old X handle or email</label><input class="input" id="rcl" autocomplete="off" placeholder="@handle or you@mail.com">' +
      '<label class="field" for="rcn">How can we tell it is you?</label><textarea class="input" id="rcn" rows="3" maxlength="600" placeholder="Payments you sent or received, roughly when you joined, anything only you would know."></textarea>' +
      (err ? '<p class="err" role="alert">' + esc(err) + '</p>' : '') + '<button class="btn block mint" id="rcs" type="button">Send request</button></div>');
    s.el.querySelector('#rcs').addEventListener('click', async (e) => {
      try { await busy(e.currentTarget, () => api('/api/recovery/request', { method: 'POST', body: { lost: s.el.querySelector('#rcl').value, note: s.el.querySelector('#rcn').value } })); s.set('<div class="rv"><h2>Request sent</h2><p>We will check it and you will see the next step in Account. The owner of the old account is told.</p></div>'); onDone(); }
      catch (er) { form(errorText(er)); }
    });
  };
  form();
}

/* a link from the owner's email: stops a request without needing to sign in */
export async function cancelFromLink(token) {
  try { await api('/api/recovery/cancel', { method: 'POST', body: { token } }); toast({ title: 'Request cancelled', body: 'Nothing was changed on your account.', icon: '✓' }); }
  catch (e) { toast({ title: 'Could not cancel', body: errorText(e), tone: 'bad', icon: '!' }); }
}
void timeAgo;
