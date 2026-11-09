'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');

/* boots the real entry file with a feature flag on, so a typo in a flag-only branch of start() fails here and not in production */
const boot = (extra) => new Promise((resolve) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dovi-boot-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { PATH: process.env.PATH, PORT: String(port), DOVI_DB_PATH: path.join(dir, 't.db'), TWITTERAPI_IO_KEY: 'dummy', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let exited = null;
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  child.on('exit', (c) => { exited = c; });
  setTimeout(() => { const alive = exited === null; child.kill('SIGTERM'); setTimeout(() => { fs.rmSync(dir, { recursive: true, force: true }); resolve({ alive, out }); }, 300); }, 2500);
});

test('the server starts and stays up with giveaways switched on', async () => {
  const r = await boot({ DOVI_GIVEAWAY: '1' });
  assert.ok(r.alive, 'process exited early: ' + r.out.slice(0, 300));
  assert.match(r.out, /DOVI listening/); assert.doesNotMatch(r.out, /ReferenceError/);
});

test('the server starts and stays up with every optional feature flag at its default', async () => {
  const r = await boot({});
  assert.ok(r.alive, 'process exited early: ' + r.out.slice(0, 300)); assert.match(r.out, /DOVI listening/);
});
