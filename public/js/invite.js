import { api } from './api.js?v=dev';
import { esc } from './format.js?v=dev';
import { busy, copy, errorText, toast } from './ui.js?v=dev';

const IC = {
  gift: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="9" width="17" height="11" rx="2"/><path d="M12 9v11M3.5 13h17M12 9c-2.5 0-4-1-4-2.5S9.5 4 12 9zM12 9c2.5 0 4-1 4-2.5S14.5 4 12 9z"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.9 2H22l-7.6 8.7L23 22h-6.9l-5.4-7-6.2 7H1.4l8.1-9.3L1 2h7.1l4.9 6.4L18.9 2Zm-1.2 18h1.9L6.4 3.9H4.4L17.7 20Z" fill="currentColor" stroke="none"/></svg>',
};

export async function renderInvite(root) {
  root.innerHTML = '<div class="skeleton" style="height:200px"></div><div class="skeleton" style="height:120px;margin-top:14px"></div>';
  let d;
  try { d = await api('/api/referral'); } catch (e) { root.innerHTML = '<p class="err">' + esc(errorText(e)) + '</p>'; return; }
  if (!d.linked) {
    root.innerHTML = '<h2 class="sec">Invite friends</h2><div class="lk-hero"><div class="lk-h-top"><span class="lk-ic">' + IC.gift + '</span><div><b>Get your invite code</b><p>Your code is tied to your X account and stays yours for good, including at the mainnet launch. Link X to get it.</p></div></div><div class="lk-acts"><a class="btn mint" href="/app#account">Link X in Account</a></div></div>';
    return;
  }
  const tweet = 'I am on DOVI. Pay anyone in dollars with just their X handle or email, and they claim with one login. Join with my code ' + d.code + ': ' + d.link;
  root.innerHTML = '<h2 class="sec">Invite friends</h2><div class="inv-hero"><small>Your invite code</small><b id="ic">' + esc(d.code) + '</b><p>Tied to ' + esc(d.handle || 'your X account') + '. It never changes, including at the mainnet launch.</p></div><div class="inv-btns"><button class="btn mint" id="cc" type="button">Copy code</button><button class="btn ghost" id="cl" type="button">Copy link</button></div><a class="btn block ghost" id="sh" target="_blank" rel="noopener" href="https://x.com/intent/post?text=' + encodeURIComponent(tweet) + '" style="margin-top:10px">' + IC.x + ' Share on X</a><div class="inv-stats"><div class="stat t-mint"><small>Friends joined</small><b>' + d.referrals + '</b><span>' + (d.referrals === 1 ? 'person' : 'people') + ' with your code</span></div>' + '' + '</div><div class="card inv-how"><b>How it works</b><p>Friends who sign up with your link or code are counted for you. Your code stays yours at the mainnet launch.</p>' + '' + '</div>';
  root.querySelector('#cc').addEventListener('click', async () => { if (await copy(d.code)) toast({ title: 'Code copied', ms: 2000 }); });
  root.querySelector('#cl').addEventListener('click', async () => { if (await copy(d.link)) toast({ title: 'Link copied', ms: 2000 }); });
}
