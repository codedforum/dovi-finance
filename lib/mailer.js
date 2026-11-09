'use strict';
const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SENDMAIL_BIN = ['/usr/sbin/sendmail', '/usr/lib/sendmail'].find((p) => { try { return fs.existsSync(p); } catch { return false; } });

function makeMailer(env = process.env) {
  const FROM = env.EMAIL_FROM || 'DOVI <noreply@dovi.finance>';
  const envelope = (FROM.match(/<([^>]+)>/) || [null, FROM])[1];
  async function viaResend({ to, subject, html, text, headers }) {
    const payload = JSON.stringify({ from: FROM, to: [to], subject, html, text, ...(headers ? { headers } : {}) });
    return new Promise((resolve, reject) => {
      const req = https.request('https://api.resend.com/emails', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-length': Buffer.byteLength(payload) } }, (r) => { r.resume(); r.on('end', () => (r.statusCode < 300 ? resolve(true) : reject(new Error('resend ' + r.statusCode)))); });
      req.on('error', reject); req.write(payload); req.end();
    });
  }
  async function viaSendmail({ to, subject, html, text, headers }) {
    if (!SENDMAIL_BIN) throw new Error('no local MTA');
    const b = 'dovi' + crypto.randomBytes(8).toString('hex');
    const msg = ['From: ' + FROM, 'To: ' + to, 'Subject: ' + subject, ...Object.entries(headers || {}).map(([k, v]) => k + ': ' + String(v).replace(/[\r\n]/g, ' ')), 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="' + b + '"', '', '--' + b, 'Content-Type: text/plain; charset=utf-8', '', text, '--' + b, 'Content-Type: text/html; charset=utf-8', '', html, '--' + b + '--', ''].join('\r\n');
    return new Promise((resolve, reject) => {
      const sm = spawn(SENDMAIL_BIN, ['-t', '-i', '-f', envelope], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      sm.stderr.on('data', (c) => { err += c; });
      sm.on('error', reject);
      sm.on('close', (c) => (c === 0 ? resolve(true) : reject(new Error('sendmail exit ' + c + ' ' + err))));
      sm.stdin.write(msg); sm.stdin.end();
    });
  }
  return { send: async (m) => (env.RESEND_API_KEY ? viaResend(m) : viaSendmail(m)) };
}

module.exports = { makeMailer };
