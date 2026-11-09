import { api } from './api.js?v=dev';
import { esc, usd, fmtDateTime } from './format.js?v=dev';
import { $ } from './ui.js?v=dev';

const view = $('#view');
const id = (location.pathname.match(/^\/g\/(\d{1,10})$/) || [])[1];

function gone() { view.innerHTML = '<div class="card paycard"><div class="pay-gone"><span aria-hidden="true">?</span><h2>Giveaway not found</h2><p>The link may be wrong, or the giveaway was cancelled.</p><a class="btn block" href="/">Go to DOVI</a></div></div>'; }

async function hmacIndex(seed, i) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('i:' + i)));
  let n = 0n; for (let k = 0; k < 8; k++) n = (n << 8n) | BigInt(sig[k]);
  return Number(n % BigInt(i + 1));
}

async function reproduce(g) {
  const ids = g.pool.map((p) => p.id).sort();
  for (let i = ids.length - 1; i > 0; i--) { const j = await hmacIndex(g.result.seed, i); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const want = ids.slice(0, g.winners).join(',');
  return want === g.result.winners.map((w) => w.id).join(',');
}

async function main() {
  if (!id) return gone();
  let g; try { g = await api('/api/giveaway/' + id); } catch { return gone(); }
  const reqs = [g.reqs.rt && 'Retweet', g.reqs.comment && 'Reply', g.reqs.quote && 'Quote'].filter(Boolean);
  const drawn = g.status === 'drawn';
  const chip = drawn ? '<span class="proof-st done">Winners picked</span>' : g.status === 'open' ? '<span class="proof-st wait">Open until ' + esc(fmtDateTime(g.endsAt)) + '</span>' : '<span class="proof-st back">' + esc(g.status) + '</span>';
  const winners = drawn ? (g.result.winners.length ? '<h3 class="mini">Winners</h3><div class="card"><div class="rows">' + g.result.winners.map((w, i) => '<div class="r"><span>' + (i + 1) + '</span>' + (w.handle ? '<a href="https://x.com/' + esc(w.handle) + '" target="_blank" rel="noopener"><b>@' + esc(w.handle) + '</b></a>' : '<b>' + esc(w.id) + '</b>') + '</div>').join('') + '</div></div>' : '<p class="note">Nobody met the requirements, so there are no winners.</p>') : '';
  const prize = g.prizeMicro ? '<div class="r"><span>Prize per winner</span><b>' + esc(usd(g.prizeMicro)) + '</b></div>' : '';
  const check = drawn ? '<h3 class="mini">Check the draw</h3><div class="card"><div class="rows"><div class="r"><span>Eligible entries</span><b>' + g.result.eligible + '</b></div><div class="r"><span>Seed</span><b class="mono">' + esc(g.result.seed.slice(0, 12)) + '...</b></div><div class="r"><span>Entry list fingerprint</span><b class="mono">' + esc(g.result.poolHash.slice(0, 12)) + '...</b></div></div><p class="note">The winners come from shuffling the sorted entry list with the seed. Press the button and your browser repeats the shuffle.</p><button class="btn block ghost" id="rep" type="button">Repeat the draw here</button><div class="msg" id="rm" role="status"></div></div>' : '';
  view.innerHTML = '<div class="card paycard proof"><div class="proof-top"><span class="chip">Giveaway</span>' + chip + '</div><small class="proof-k">' + (g.creator ? 'By ' + esc(g.creator) : 'Giveaway') + '</small><div class="proof-amt" style="font-size:40px">' + g.winners + (g.winners === 1 ? ' winner' : ' winners') + '</div><div class="card"><div class="rows"><div class="r"><span>To enter</span><b>' + esc(reqs.join(' and ') || 'Reply') + '</b></div>' + (g.reqs.like ? '<div class="r"><span>Likes</span><b>Cannot be checked on X</b></div>' : '') + prize + '<div class="r"><span>The post</span><a href="' + esc(g.tweetUrl) + '" target="_blank" rel="noopener"><b>Open on X</b></a></div></div></div>' + winners + check + '<p class="note" style="text-align:center">Winners are picked at random by DOVI from the people who did what was asked. Nobody can choose them.</p><a class="btn block mint" href="https://dovi.finance/">Pay anyone by handle with DOVI</a></div>';
  const rep = $('#rep');
  if (rep) rep.addEventListener('click', async () => { const m = $('#rm'); m.className = 'msg'; m.textContent = 'Working...'; try { const ok = await reproduce(g); m.className = ok ? 'msg' : 'msg err'; m.textContent = ok ? 'The same winners came out. The draw is genuine.' : 'The winners did not match.'; } catch { m.className = 'msg err'; m.textContent = 'Your browser could not run the check.'; } });
}
main().catch(gone);
