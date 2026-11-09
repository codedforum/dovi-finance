import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pub = path.join(root, 'public');
const PIN = /(\?v=)[A-Za-z0-9._-]+/g;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

export function listAssets(dir = pub) {
  return walk(dir).filter((f) => /\.(js|mjs|css|html)$/.test(f) && !f.endsWith('.min.js') && !f.includes('backup')).sort();
}

export function contentHash(files) {
  const h = crypto.createHash('sha1');
  for (const f of files) {
    h.update(path.relative(pub, f));
    h.update(fs.readFileSync(f, 'utf8').replace(PIN, '$1'));
  }
  return h.digest('hex').slice(0, 10);
}

function parsesAsModule(file) {
  const src = fs.readFileSync(file, 'utf8');
  try {
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: src, stdio: ['pipe', 'pipe', 'pipe'] });
    return null;
  } catch (e) { return String(e.stderr || e.message).split('\n').slice(0, 3).join(' | '); }
}

export function bust({ write = true, dir = pub } = {}) {
  const files = listAssets(dir);
  const bad = [];
  for (const f of files.filter((x) => x.endsWith('.js') && fs.readFileSync(x, 'utf8').includes('import '))) {
    const err = parsesAsModule(f);
    if (err) bad.push(path.relative(dir, f) + ': ' + err);
  }
  if (bad.length) throw new Error('bust_refused_parse_failure\n' + bad.join('\n'));
  const hash = contentHash(files);
  let changed = 0;
  for (const f of files) {
    const before = fs.readFileSync(f, 'utf8');
    const after = before.replace(PIN, '$1' + hash);
    if (after !== before) { changed++; if (write) fs.writeFileSync(f, after); }
  }
  return { hash, files: files.length, changed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const r = bust();
  console.log('stamped', r.hash, 'files', r.files, 'rewrote', r.changed);
}
