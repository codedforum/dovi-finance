import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => { const p = path.join(d, e.name); return e.isDirectory() ? (['node_modules', 'legacy', 'lib', 'out', 'cache'].includes(e.name) && d === root ? [] : walk(p)) : [p]; });
let bad = 0;
const fail = (m) => { console.error('FAIL ' + m); bad++; };

for (const f of walk(path.join(root, 'public')).filter((x) => x.endsWith('.js') && !x.endsWith('.min.js'))) {
  try { execFileSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(f), stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { fail('module parse ' + path.relative(root, f) + ': ' + String(e.stderr).split('\n')[0]); }
}
for (const f of [...walk(path.join(root, 'server')).filter((x) => x.endsWith('.js')), ...fs.readdirSync(path.join(root, 'lib')).filter((x) => x.endsWith('.js')).map((x) => path.join(root, 'lib', x))]) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { fail('syntax ' + path.relative(root, f)); }
}
const scan = [...walk(path.join(root, 'public')), ...walk(path.join(root, 'server')), ...fs.readdirSync(path.join(root, 'lib')).filter((x) => x.endsWith('.js')).map((x) => path.join(root, 'lib', x)), path.join(root, 'contracts/src/DoviClaim.sol')].filter((f) => /\.(js|html|css|sol|json)$/.test(f) && !f.endsWith('.min.js'));
for (const f of scan) {
  const t = fs.readFileSync(f, 'utf8');
  if (/[—–·]/.test(t)) fail('forbidden punctuation in ' + path.relative(root, f));
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|0x[0-9a-fA-F]{64}\b.*private|sk_live_[A-Za-z0-9]{10,}/.test(t) && !f.includes('test')) fail('possible secret in ' + path.relative(root, f));
}
const sol = fs.readFileSync(path.join(root, 'contracts/src/DoviClaim.sol'), 'utf8').split('\n').filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l) && !/SPDX/.test(l));
if (sol.length) fail('the contract must have no comments, found ' + sol.length);
if (bad) { console.error(bad + ' problem(s)'); process.exit(1); }
console.log('check ok');

{
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [new URL('./build-assets.mjs', import.meta.url).pathname, '--check'], { encoding: 'utf8' });
  if (r.status !== 0) { console.error('generated assets are stale, run node tools/build-assets.mjs\n' + (r.stderr || '')); process.exit(1); }
}

{
  const { spawnSync } = await import('node:child_process');
  const bad = [];
  for (const dir of ['tools']) {
    for (const f of fs.readdirSync(path.join(root, dir)).filter((x) => /\.(js|cjs)$/.test(x))) {
      const r = spawnSync(process.execPath, ['--check', path.join(root, dir, f)], { encoding: 'utf8' });
      if (r.status !== 0) bad.push(dir + '/' + f);
    }
  }
  if (bad.length) { console.error('node --check failed for: ' + bad.join(', ')); process.exit(1); }
}
