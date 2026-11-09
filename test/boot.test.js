'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

test('the real entry point boots, serves /healthz and stays up past its first timers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dovi-boot-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { PATH: process.env.PATH, DOVI_ENV: 'dev', DOVI_DB_PATH: path.join(dir, 'boot.db'), PORT: String(port), DOVI_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  let exited = null;
  child.on('exit', (c) => { exited = c; });
  try {
    let ok = false;
    for (let i = 0; i < 40 && exited === null; i++) {
      await new Promise((r) => setTimeout(r, 250));
      ok = await fetch('http://127.0.0.1:' + port + '/healthz').then((r) => r.ok).catch(() => false);
      if (ok) break;
    }
    assert.equal(exited, null, 'process exited: ' + err.slice(0, 400));
    assert.ok(ok, 'healthz never answered: ' + err.slice(0, 400));
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!/ReferenceError|TypeError/.test(err), err.slice(0, 400));
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
