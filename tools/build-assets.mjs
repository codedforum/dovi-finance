// Builds public/dovi.css (fonts, ui, app, depth, minified) and the modulepreload lists in the page heads.
// node tools/build-assets.mjs writes. node tools/build-assets.mjs --check exits 1 when the committed output is stale.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pub = path.join(root, 'public');
const CHECK = process.argv.includes('--check');

function minify(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*\n\s*/g, '').replace(/\s*([{};,>])\s*/g, '$1').replace(/:\s+/g, ':').replace(/;}/g, '}').trim();
}

const parts = ['fonts.css', 'ui.css', 'app.css', 'depth.css'];
const css = parts.map((f) => minify(fs.readFileSync(path.join(pub, f), 'utf8'))).join('\n') + '\n';

function graph(entry) {
  const seen = new Set(); const order = [];
  const visit = (file) => {
    if (seen.has(file)) return; seen.add(file);
    const src = fs.readFileSync(path.join(pub, file), 'utf8');
    for (const m of src.matchAll(/(?:from\s+|import\()\s*['"]\.\/([A-Za-z0-9_.-]+\.js)/g)) visit('js/' + m[1]);
    order.push(file);
  };
  visit(entry);
  return order;
}

const PAGES = { 'app.html': 'js/app.js', 'claim.html': 'js/claim.js', 'notifications.html': 'js/notifications-page.js' };
const outputs = new Map([[path.join(pub, 'dovi.css'), css]]);
for (const [page, entry] of Object.entries(PAGES)) {
  const f = path.join(pub, page); let html = fs.readFileSync(f, 'utf8');
  const tags = graph(entry).filter((x) => !x.endsWith('.min.js')).map((x) => '<link rel="modulepreload" href="/' + x + '?v=dev">').join('\n');
  const block = '<!--preload-->\n' + tags + '\n<!--/preload-->';
  html = /<!--preload-->[\s\S]*?<!--\/preload-->/.test(html) ? html.replace(/<!--preload-->[\s\S]*?<!--\/preload-->/, block) : html.replace('</head>', block + '\n</head>');
  outputs.set(f, html);
}

{
  const f = path.join(pub, 'index.html'); const html = fs.readFileSync(f, 'utf8');
  outputs.set(f, html.replace(/\/\*fonts\*\/[\s\S]*?\/\*\/fonts\*\//, () => '/*fonts*/' + minify(fs.readFileSync(path.join(pub, 'fonts.css'), 'utf8')) + '/*/fonts*/'));
}

let stale = 0;
for (const [f, content] of outputs) {
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (cur === content) continue;
  if (CHECK) { stale++; console.error('stale: ' + path.relative(root, f)); } else fs.writeFileSync(f, content);
}
if (CHECK && stale) process.exit(1);
if (!CHECK) console.log('built dovi.css ' + css.length + ' bytes, preload lists updated');
