import { api } from './api.js?v=dev';
import { esc } from './format.js?v=dev';
import { logo } from './ui.js?v=dev';

let cache = null;
export async function loadChains() { if (!cache) cache = await api('/api/chains'); return cache; }

export async function chipsHtml() {
  const c = await loadChains();
  return c.chains.map((x) => '<span class="chip ' + (x.status === 'live' ? 'live' : 'soon') + '">' + logo(x.id) + '' + esc(x.name) + (x.status === 'live' ? '' : ', coming soon') + '</span>').join('');
}

export async function statusLine() { return (await loadChains()).statusLine; }
