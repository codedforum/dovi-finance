import { api } from './api.js?v=dev';

let sdk = null; let cfg = null; let ready = null; let mock = false;

async function config() { if (!cfg) cfg = await api('/api/public/cdp-config'); return cfg; }

async function getJwt() {
  const j = await api('/api/auth/cdp-jwt', { method: 'POST', body: {} });
  if (!j.jwt) throw new Error('Could not start your wallet. Please sign in again.');
  return j.jwt;
}

async function init() {
  if (ready) return ready;
  ready = (async () => {
    const c = await config();
    if (c.mock) { mock = true; return; }
    if (!c.enabled) throw new Error('The wallet is not switched on yet.');
    await import('./cdp-shim.js?v=dev');
    sdk = await import(/* @vite-ignore */ c.sdkUrl);
    await sdk.initialize({
      projectId: c.projectId,
      customAuth: { getJwt },
      ethereum: { createOnLogin: 'smart' },
      disableAnalytics: true,
      secureIframeBasePath: location.origin + '/cdpwallet',
    });
  })();
  try { await ready; } catch (e) { ready = null; throw e; }
  return ready;
}

const BOUND = 'dovi.wallet.user';

export async function start() {
  await init();
  if (mock) return;
  let uid = null;
  try { const me = await api('/api/me'); uid = me && me.user ? String(me.user.id) : null; } catch { /* the caller handles a missing session */ }
  let signed = false;
  try { signed = !!(sdk.isSignedIn && (await sdk.isSignedIn())); } catch { /* continue */ }
  let bound = null;
  try { bound = localStorage.getItem(BOUND); } catch { /* storage blocked */ }
  if (signed && uid && bound === uid) return;
  if (signed) { try { await sdk.signOut(); } catch { /* start over below */ } }
  await sdk.authenticateWithJWT();
  try { if (uid) localStorage.setItem(BOUND, uid); } catch { /* storage blocked */ }
}

async function account() {
  await init();
  if (mock) { const me = await api('/api/me'); return { mock: true, address: me.user.address || mockAddress(me.user.id) }; }
  const u = await sdk.getCurrentUser();
  if (!u) throw new Error('Please sign in again.');
  const smart = (u.evmSmartAccounts || [])[0];
  const eoa = (u.evmAccounts || [])[0];
  if (smart) return { smart, address: typeof smart === 'string' ? smart : smart.address };
  if (eoa) return { eoa, address: typeof eoa === 'string' ? eoa : eoa.address };
  throw new Error('Your wallet is still being created. Please try again in a moment.');
}

function mockAddress(id) { return '0x' + String(id).padStart(40, '0'); }

export async function address() { return (await account()).address; }

export async function sendCalls(calls) {
  const a = await account();
  const pc = await api('/api/public/cdp-config');
  const network = pc.network || 'base'; const chainId = pc.chainId || 8453;
  if (a.mock) {
    const r = await api('/api/dev/execute', { method: 'POST', body: { from: a.address, calls: calls.map((c) => ({ to: c.to, data: c.data })) } });
    return { hash: r.hash };
  }
  if (a.smart) {
    const r = await sdk.sendUserOperation({ evmSmartAccount: a.smart, network, calls: calls.map((c) => ({ to: c.to, value: 0n, data: c.data })), useCdpPaymaster: true });
    return { hash: r.userOperationHash || null };
  }
  let last = null;
  for (const c of calls) {
    const r = await sdk.sendEvmTransaction({ evmAccount: a.eoa, network, transaction: { to: c.to, value: 0n, data: c.data, chainId, type: 'eip1559' } });
    last = r && (r.transactionHash || r.hash);
  }
  return { hash: last };
}

export async function signOut() {
  try { await init(); if (!mock && sdk.signOut) await sdk.signOut(); } catch { /* ignore */ }
  try { localStorage.removeItem(BOUND); } catch { /* storage blocked */ }
  try { Object.keys(sessionStorage).filter((k) => k.startsWith('dovi.')).forEach((k) => sessionStorage.removeItem(k)); } catch { /* storage blocked */ }
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
}

let gis = null;
export async function googleButton(container, onDone) {
  const c = await config();
  if (!c.googleClientId || !container) return false;
  if (!gis) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = res; s.onerror = () => rej(new Error('Could not load Google sign in')); document.head.appendChild(s); });
  gis = true;
  window.google.accounts.id.initialize({ client_id: c.googleClientId, ux_mode: 'popup', callback: async (r) => { try { await api('/api/auth/google', { method: 'POST', body: { credential: r.credential, invite: (function () { try { return sessionStorage.getItem('dovi.invite') || undefined; } catch { return undefined; } })() } }); await start(); onDone(null); } catch (e) { onDone(e); } } });
  container.innerHTML = '';
  window.google.accounts.id.renderButton(container, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: Math.min(320, container.offsetWidth || 300) });
  return true;
}

export async function authOptions() { const c = await config(); return { google: !!c.googleClientId, x: !!c.xAuth, mock: !!c.mock, inviteOnly: !!c.inviteOnly }; }
