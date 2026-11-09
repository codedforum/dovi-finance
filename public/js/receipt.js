import { usd } from './format.js?v=dev';

function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

function fit(ctx, text, max) { let t = String(text); while (ctx.measureText(t).width > max && t.length > 4) t = t.slice(0, -2); return t === String(text) ? t : t + '...'; }

export async function receiptPng({ amountMicro, label, kind = 'sent', note = '', when = Date.now(), feeMicro = null, ref = '', testnet = true }) {
  try { await document.fonts.load('600 120px Fraunces'); await document.fonts.load('700 30px Inter'); } catch { /* fonts optional */ }
  const W = 1200; const H = 675; const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#07130f'); g.addColorStop(1, '#0f2a1d'); x.fillStyle = g; x.fillRect(0, 0, W, H);
  const glow = x.createRadialGradient(W - 140, 80, 10, W - 140, 80, 420); glow.addColorStop(0, 'rgba(36,228,125,.35)'); glow.addColorStop(1, 'rgba(36,228,125,0)'); x.fillStyle = glow; x.fillRect(0, 0, W, H);
  x.fillStyle = '#24e47d'; rr(x, 64, 56, 56, 56, 16); x.fill();
  x.fillStyle = '#07130f'; x.font = '900 36px Inter, system-ui, sans-serif'; x.textAlign = 'center'; x.fillText('D', 92, 96);
  x.textAlign = 'left'; x.fillStyle = '#f3f1e9'; x.font = '900 26px Inter, system-ui, sans-serif'; x.fillText('DOVI', 134, 94);
  x.textAlign = 'right'; x.fillStyle = '#5cf0a0'; x.font = '700 22px Inter, system-ui, sans-serif'; x.fillText(testnet ? 'RECEIPT  TEST NETWORK' : 'RECEIPT', W - 64, 92);
  x.textAlign = 'left';
  x.fillStyle = '#9fb0a8'; x.font = '700 22px Inter, system-ui, sans-serif'; x.fillText(kind === 'received' ? 'YOU RECEIVED' : kind === 'returned' ? 'TAKEN BACK' : 'YOU SENT', 64, 200);
  const t = usd(amountMicro); x.fillStyle = '#f3f1e9'; x.font = '600 150px Fraunces, Georgia, serif'; x.fillText(t, 64, 336);
  x.fillStyle = '#24e47d'; x.font = '700 28px Inter, system-ui, sans-serif'; x.fillText('USDC on Base' + (testnet ? ' Sepolia' : ''), 64, 384);
  x.strokeStyle = 'rgba(255,255,255,.14)'; x.lineWidth = 2; x.beginPath(); x.moveTo(64, 428); x.lineTo(W - 64, 428); x.stroke();
  const row = (k, v, y, xx) => { x.fillStyle = '#9fb0a8'; x.font = '600 20px Inter, system-ui, sans-serif'; x.fillText(k, xx, y); x.fillStyle = '#f3f1e9'; x.font = '700 28px Inter, system-ui, sans-serif'; x.fillText(fit(x, v, 480), xx, y + 40); };
  row(kind === 'received' ? 'FROM' : 'TO', label || 'Account', 466, 64);
  row('DATE', new Date(when).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), 466, 640);
  if (feeMicro != null) row('DOVI FEE', usd(feeMicro), 566, 64);
  if (note) row('NOTE', note, 566, feeMicro != null ? 640 : 64);
  if (ref) { x.fillStyle = '#9fb0a8'; x.font = '600 18px ui-monospace, Menlo, monospace'; x.textAlign = 'right'; x.fillText('Ref ' + ref, W - 64, H - 36); x.textAlign = 'left'; }
  x.fillStyle = '#9fb0a8'; x.font = '600 18px Inter, system-ui, sans-serif'; x.fillText('Pay anyone by X handle or email', 64, H - 36);
  return new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
}

export async function downloadReceipt(opts) {
  const blob = await receiptPng(opts);
  if (!blob) throw new Error('Could not make the receipt.');
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'dovi-receipt-' + new Date(opts.when || Date.now()).toISOString().slice(0, 10) + '.png';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
