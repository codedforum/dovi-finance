import { api } from './api.js?v=dev';
import { esc, usd, fmtDateTime, validAmount } from './format.js?v=dev';
import { busy, copy, errorText, toast } from './ui.js?v=dev';

function left(ms) { if (ms <= 0) return 'ending now'; const m = Math.round(ms / 60000); if (m < 60) return m + ' min left'; const h = Math.round(m / 6) / 10; return h < 48 ? h + ' h left' : Math.round(h / 24) + ' days left'; }

function row(g) {
  const reqs = [g.reqs.rt && 'RT', g.reqs.comment && 'Reply', g.reqs.quote && 'Quote'].filter(Boolean).join(' + ').replace(/ \+ /g, ', ');
  const st = g.status === 'open' ? left(g.endsAt - Date.now()) : g.status === 'drawn' ? (g.result.winners.length + ' of ' + g.result.eligible + ' eligible won') : g.status;
  const names = g.status === 'drawn' ? g.result.winners.map((w) => '@' + (w.handle || w.id)).join(' ') : '';
  return '<div class="lk-row" data-id="' + g.id + '"><div class="lk-mid"><b>' + g.winners + (g.winners === 1 ? ' winner' : ' winners') + ', ' + esc(reqs) + '</b><small>' + esc(st) + (g.prizeMicro ? ', ' + esc(usd(g.prizeMicro)) + ' each' : '') + '</small>' + (names ? '<small>' + esc(names) + '</small>' : '') + '<span class="lk-u">' + esc(g.url) + '</span></div><div class="lk-btns"><button class="btn sm ghost" data-cp type="button">Copy record</button>' + (g.status === 'drawn' && g.prizeMicro ? '<button class="btn sm mint" data-pay type="button">Pay winners</button>' : '') + (g.status === 'open' ? '<button class="btn sm ghost" data-cx type="button">Cancel</button>' : '') + '</div></div>';
}

export async function renderGiveaways(root, session, { go }) {
  root.innerHTML = '<div class="skeleton" style="height:200px"></div>';
  let d;
  try { d = await api('/api/giveaways'); } catch (e) { root.innerHTML = '<p class="err">' + esc(errorText(e)) + '</p>'; return; }
  const draw = () => {
    root.innerHTML = '<h2 class="sec">Giveaways</h2><div class="lk-hero"><div class="lk-h-top"><span class="lk-ic">&#127873;</span><div><b>Pick winners from your post</b><p>Tag @DoviFinance under your post, like "in 24 hrs select 5 winners that rt and comment on this post", or start one here. DOVI picks at random from people who retweeted and replied, then posts the winners with a draw anyone can check.</p></div></div><p class="note" style="color:#9db0a6;margin:0">Likes cannot be checked on X, so a giveaway needs a retweet, a reply or a quote.</p></div>'
      + (d.enabled ? '' : '<div class="warn">Giveaways are being switched on. You can see this screen, but starting one is not open yet.</div>')
      + '<h3 class="mini">Start a giveaway</h3><form class="card lk-form" id="gf" novalidate><label class="field" for="gt" style="margin-top:0">Link to your post</label><input class="input" id="gt" inputmode="url" autocomplete="off" placeholder="https://x.com/you/status/123..."><div class="two"><div><label class="field" for="gw">Winners</label><select class="input" id="gw">' + Array.from({ length: d.maxWinners }, (_, i) => '<option value="' + (i + 1) + '"' + (i === 4 ? ' selected' : '') + '>' + (i + 1) + '</option>').join('') + '</select></div><div><label class="field" for="gh">Picks winners in</label><select class="input" id="gh">' + [[1, '1 hour'], [6, '6 hours'], [12, '12 hours'], [24, '24 hours'], [48, '2 days'], [72, '3 days'], [168, '7 days']].map((h) => '<option value="' + h[0] + '"' + (h[0] === 24 ? ' selected' : '') + '>' + h[1] + '</option>').join('') + '</select></div></div><label class="field">People must</label><div class="gchecks"><label class="swrow"><span>Retweet</span><input type="checkbox" role="switch" id="grt" checked></label><label class="swrow"><span>Reply</span><input type="checkbox" role="switch" id="gc" checked></label><label class="swrow"><span>Quote</span><input type="checkbox" role="switch" id="gq"></label><label class="swrow"><span>Like (cannot be checked)</span><input type="checkbox" role="switch" id="gl"></label></div><label class="field" for="gp">Prize per winner in USD (optional)</label><div class="amount-wrap"><span class="cur" aria-hidden="true">$</span><input class="input" id="gp" inputmode="decimal" autocomplete="off" placeholder="Optional"></div><div id="gm" class="err" role="alert" hidden></div><button class="btn block mint" type="submit" style="margin-top:14px"' + (d.enabled ? '' : ' disabled') + '>Start giveaway</button></form><h3 class="mini">Your giveaways</h3><div class="lk-list">' + (d.giveaways.length ? d.giveaways.map(row).join('') : '<div class="empty"><h3>No giveaways yet</h3><p>Start one above or tag @DoviFinance under your post.</p></div>') + '</div>';
    const gm = root.querySelector('#gm');
    root.querySelector('#gf').addEventListener('submit', async (ev) => {
      ev.preventDefault(); gm.hidden = true;
      const prize = root.querySelector('#gp').value.trim();
      if (prize && !validAmount(prize)) { gm.hidden = false; gm.textContent = 'Enter a prize like 5 or 5.50, or leave it empty.'; return; }
      try {
        const r = await busy(root.querySelector('#gf button[type=submit]'), () => api('/api/giveaways', { method: 'POST', body: { tweet: root.querySelector('#gt').value.trim(), winners: Number(root.querySelector('#gw').value), hours: Number(root.querySelector('#gh').value), rt: root.querySelector('#grt').checked, comment: root.querySelector('#gc').checked, quote: root.querySelector('#gq').checked, like: root.querySelector('#gl').checked, prize: prize || undefined } }));
        d.giveaways.unshift(r.giveaway); draw(); toast({ title: 'Giveaway started', body: 'Winners are picked automatically.', ms: 4000 });
      } catch (e) { gm.hidden = false; gm.textContent = errorText(e); }
    });
    root.querySelectorAll('.lk-row').forEach((el) => {
      const gid = el.dataset.id; const g = d.giveaways.find((x) => String(x.id) === gid);
      el.querySelector('[data-cp]').addEventListener('click', async () => { if (await copy(g.url)) toast({ title: 'Link copied', ms: 2000 }); });
      const cx = el.querySelector('[data-cx]'); if (cx) cx.addEventListener('click', async () => { try { const r = await busy(cx, () => api('/api/giveaways/' + gid + '/cancel', { method: 'POST', body: {} })); Object.assign(g, r.giveaway); draw(); } catch (e) { toast({ title: 'Could not cancel', body: errorText(e), tone: 'bad', icon: '!' }); } });
      const pay = el.querySelector('[data-pay]'); if (pay) pay.addEventListener('click', async () => { try { const r = await busy(pay, () => api('/api/giveaways/' + gid + '/pay')); sessionStorage.setItem('dovi.batchlines', r.lines.join('\n')); go('batch'); } catch (e) { toast({ title: 'Could not prepare the payout', body: errorText(e), tone: 'bad', icon: '!' }); } });
    });
  };
  draw();
}
