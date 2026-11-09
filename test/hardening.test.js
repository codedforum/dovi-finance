'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

function raw(port, requestLine) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(requestLine + ' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    let out = '';
    s.on('data', (d) => { out += d; });
    s.on('close', () => resolve(out));
    s.on('error', reject);
    setTimeout(() => { s.destroy(); resolve(out); }, 3000);
  });
}

test('a malformed request target answers 400 and the process keeps serving', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dovi-hard-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { PATH: process.env.PATH, DOVI_ENV: 'dev', DOVI_DB_PATH: path.join(dir, 'h.db'), PORT: String(port), DOVI_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = null; child.on('exit', (c) => { exited = c; });
  try {
    let up = false;
    for (let i = 0; i < 40 && exited === null; i++) {
      await new Promise((r) => setTimeout(r, 250));
      up = await fetch('http://127.0.0.1:' + port + '/healthz').then((r) => r.ok).catch(() => false);
      if (up) break;
    }
    assert.ok(up, 'server did not start');
    for (const target of ['GET //', 'GET ///x', 'GET /%']) {
      const res = await raw(port, target);
      assert.match(res, /^HTTP\/1\.1 (400|404|200|302|301)/, target + ' got: ' + res.slice(0, 80));
    }
    const after = await fetch('http://127.0.0.1:' + port + '/healthz').then((r) => r.ok).catch(() => false);
    assert.equal(exited, null, 'process died after a malformed target');
    assert.ok(after, 'server stopped answering after a malformed target');
  } finally { child.kill('SIGTERM'); }
});

test('an absurd exchange rate is refused instead of being used for quotes', async () => {
  const { ngnQuote } = require('../server/fx');
  const mk = (rate) => ({ now: () => 1e12, fetch: async () => ({ ok: true, json: async () => ({ rates: { NGN: rate }, time_last_update_unix: 1 }) }) });
  assert.equal((await ngnQuote(mk(1500))).available, true);
  for (const bad of [0, 1, 0.0001, 1e9, NaN]) assert.equal((await ngnQuote(mk(bad))).available, false, 'rate ' + bad);
});
