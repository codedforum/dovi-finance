'use strict';
const { formatUsd } = require('./money');

const W = 595; const H = 842; const M = 48;
const ascii = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, (c) => '\\' + c);
const GLYPH = { ' ': 278, '.': 278, ',': 278, '-': 333, '+': 584, '$': 556, ':': 278 };
const width = (s, size) => [...String(s)].reduce((a, c) => a + (GLYPH[c] || (/[0-9]/.test(c) ? 556 : /[A-Z]/.test(c) ? 667 : 500)), 0) * size / 1000;

function makePdf(pages) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(''); const pagesRef = add(''); const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const ops of pages) {
    const stream = ops.join('\n');
    const content = add('<< /Length ' + Buffer.byteLength(stream, 'latin1') + ' >>\nstream\n' + stream + '\nendstream');
    kids.push(add('<< /Type /Page /Parent ' + pagesRef + ' 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /Font << /F1 ' + f1 + ' 0 R /F2 ' + f2 + ' 0 R >> >> /Contents ' + content + ' 0 R >>'));
  }
  objs[catalog - 1] = '<< /Type /Catalog /Pages ' + pagesRef + ' 0 R >>';
  objs[pagesRef - 1] = '<< /Type /Pages /Count ' + kids.length + ' /Kids [' + kids.map((k) => k + ' 0 R').join(' ') + '] >>';
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((b, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += (i + 1) + ' 0 obj\n' + b + '\nendobj\n'; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalog + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

const date = (t) => new Date(Number(t)).toISOString().slice(0, 16).replace('T', ' ');
const signed = (r) => (r.direction === 'in' ? '+' : '-') + formatUsd(BigInt(r.amountMicro || 0));

function statementPdf(st) {
  const pages = []; let ops = []; let y = H - M;
  const text = (x, str, { size = 10, bold = false, right = false, gray = false } = {}) => {
    const s = ascii(str); const px = right ? x - width(String(str), size) : x;
    ops.push((gray ? '0.35 0.38 0.37 rg' : '0.03 0.07 0.06 rg') + ' BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' + px.toFixed(1) + ' ' + y.toFixed(1) + ' Td (' + s + ') Tj ET');
  };
  const rule = () => ops.push('0.8 0.8 0.78 RG 0.5 w ' + M + ' ' + (y - 4).toFixed(1) + ' m ' + (W - M) + ' ' + (y - 4).toFixed(1) + ' l S');
  const newPage = () => { if (ops.length) pages.push(ops); ops = []; y = H - M; };
  const need = (h) => { if (y - h < M + 30) { newPage(); header(); } };
  const header = () => { text(M, 'Date (UTC)', { bold: true, size: 9 }); text(M + 110, 'What', { bold: true, size: 9 }); text(M + 235, 'With', { bold: true, size: 9 }); text(W - M - 70, 'Status', { bold: true, size: 9, right: true }); text(W - M, 'Amount', { bold: true, size: 9, right: true }); y -= 4; rule(); y -= 14; };

  text(M, 'DOVI statement', { size: 20, bold: true }); y -= 22;
  text(M, st.label + (st.holder ? ', ' + st.holder : ''), { size: 12 }); y -= 16;
  text(M, 'Network: ' + st.network + (st.testnet ? ' (test network, test USDC, no real money)' : ''), { size: 9, gray: true }); y -= 14;
  text(M, 'Generated ' + date(st.generatedAt) + ' UTC. Balances are not shown because they live on chain.', { size: 9, gray: true }); y -= 24;

  text(M, 'Summary', { size: 12, bold: true }); y -= 16;
  const t = st.totals;
  for (const [k, label] of [['sent', 'Sent'], ['received', 'Received'], ['returned', 'Taken back'], ['added', 'Added'], ['withdrawn', 'Withdrawn']]) {
    text(M, label + ' (' + t[k + 'Count'] + ')'); text(M + 230, formatUsd(BigInt(t[k + 'Micro'])), { right: true }); y -= 14;
  }
  text(M, 'DOVI fees on claimed payments'); text(M + 230, formatUsd(BigInt(st.feesMicro)), { right: true }); y -= 26;

  text(M, 'Activity', { size: 12, bold: true }); y -= 16; header();
  if (!st.rows.length) text(M, 'No activity this month.', { gray: true });
  for (const r of st.rows) {
    need(16);
    text(M, date(r.createdAt || r.at || r.time || 0), { size: 9 });
    text(M + 110, r.type, { size: 9 }); text(M + 235, String(r.counterparty || '').slice(0, 26), { size: 9 });
    text(W - M - 70, String(r.status || ''), { size: 9, right: true }); text(W - M, signed(r), { size: 9, right: true }); y -= 14;
  }
  if (st.truncated) { y -= 6; text(M, 'Only the first 2000 items are shown.', { size: 9, gray: true }); }
  newPage();
  return makePdf(pages.map((p, i) => p.concat(['BT /F1 8 Tf 0.4 0.4 0.4 rg ' + (W / 2 - 20) + ' 24 Td (Page ' + (i + 1) + ' of ' + pages.length + ') Tj ET'])));
}

module.exports = { statementPdf, makePdf };
