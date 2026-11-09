'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { buildCtx } = require('../server/index');
const { createApp } = require('../server/app');

test('the real server boots with a temp database and reports Base live, claims off until a contract is set', async () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'dovi-smoke-'));
  const ctx = buildCtx({ DOVI_DB_PATH: dir + '/d.db', DOVI_ENV: 'production', CDP_PROJECT_ID: 'p', DOVI_URL: 'https://dovi.test', DOVI_CDP_JWT_KEY_PATH: dir + '/k.pem' });
  ctx.registry.assertRegistryHonest();
  const { handler } = createApp(ctx);
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.equal((await fetch(base + '/healthz')).status, 200);
    const st = await (await fetch(base + '/api/status')).json();
    assert.deepEqual(st.live, ['base']);
    assert.equal(st.claims.enabled, false);
    assert.equal(st.environment, 'production');
    const cfg = await (await fetch(base + '/api/public/cdp-config')).json();
    assert.equal(cfg.mock, false);
    for (const p of ['/', '/app', '/help', '/terms', '/privacy', '/notifications']) assert.equal((await fetch(base + p)).status, 200, p);
    const hdr = (await fetch(base + '/')).headers;
    assert.equal(hdr.get('x-content-type-options'), 'nosniff');
    assert.ok(hdr.get('content-security-policy-report-only'));
  } finally { ctx.hub.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
