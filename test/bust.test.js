'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function load() { return import('../tools/bust.mjs'); }

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bust-'));
  for (const [n, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true }); fs.writeFileSync(path.join(dir, n), c); }
  return dir;
}

test('every pin in the graph gets the same stamp and a content change changes it', async () => {
  const { bust } = await load();
  const dir = fixture({ 'index.html': '<script type="module" src="/js/app.js?v=old"></script>', 'js/app.js': "import { a } from './a.js?v=old';\nexport const b = a;", 'js/a.js': 'export const a = 1;' });
  const r1 = bust({ dir });
  assert.match(fs.readFileSync(path.join(dir, 'js/app.js'), 'utf8'), new RegExp('a\\.js\\?v=' + r1.hash));
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), new RegExp('app\\.js\\?v=' + r1.hash));
  fs.writeFileSync(path.join(dir, 'js/a.js'), 'export const a = 2;');
  const r2 = bust({ dir });
  assert.notEqual(r1.hash, r2.hash);
});

test('a pin-only edit does not change the hash, so tooling must not rely on it', async () => {
  const { bust } = await load();
  const dir = fixture({ 'js/a.js': "export const a = 1; // ?v=x", 'index.html': '<script src="/js/a.js?v=1"></script>' });
  const r1 = bust({ dir });
  fs.writeFileSync(path.join(dir, 'index.html'), '<script src="/js/a.js?v=zzz"></script>');
  const r2 = bust({ dir });
  assert.equal(r1.hash, r2.hash);
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), new RegExp('v=' + r2.hash));
});

test('refuses to stamp when a module does not parse', async () => {
  const { bust } = await load();
  const dir = fixture({ 'js/bad.js': "import x from './y.js';\nconst = ;" });
  assert.throws(() => bust({ dir }), /bust_refused_parse_failure/);
});
