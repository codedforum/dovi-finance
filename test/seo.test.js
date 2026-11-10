'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { makeCtx } = require('./helpers');
const { createApp } = require('../server/app');

function boot(env = {}) {
  const ctx = makeCtx({ env: { DOVI_ENV: 'test', DOVI_INDEXABLE: '1', ...env } });
  ctx.env = {};
  ctx.cfg.base.testnet = env.TESTNET === '1';
  ctx.cfg.indexable = env.DOVI_INDEXABLE === '1';
  const secret = 'test-secret';
  ctx.sessions = {
    mint: (id, jti) => {
      const p = Buffer.from(JSON.stringify({ id, jti: jti || null, iat: Date.now() })).toString('base64url');
      return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('hex');
    },
    read: () => null,
    verify: () => null
  };
  ctx.cdpAuth = { mintFor: () => 'jwt', jwks: () => ({ keys: [] }) };
  const { handler } = createApp(ctx);
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = 'http://127.0.0.1:' + server.address().port;
    const call = (method, p, headers = {}) => fetch(base + p, { method, headers });
    const close = () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); };
    resolve({ ctx, base, call, close });
  }));
}

test('seo: robots.txt and sitemap.xml are served with correct headers and coverage', async () => {
  const s = await boot({ DOVI_INDEXABLE: '1', TESTNET: '0' });
  try {
    const rRobots = await s.call('GET', '/robots.txt');
    assert.equal(rRobots.status, 200);
    assert.match(rRobots.headers.get('content-type'), /text\/plain/);
    const txtRobots = await rRobots.text();
    assert.match(txtRobots, /Allow: \/\n/);
    assert.match(txtRobots, /Allow: \/app\n/);
    assert.match(txtRobots, /Allow: \/live\n/);
    assert.match(txtRobots, /Allow: \/judges\n/);
    assert.match(txtRobots, /Allow: \/proof\n/);
    assert.match(txtRobots, /Disallow: \/claim\/\n/);
    assert.match(txtRobots, /Disallow: \/notifications\n/);
    assert.match(txtRobots, /Sitemap: https:\/\/dovi\.finance\/sitemap\.xml/);

    const rMap = await s.call('GET', '/sitemap.xml');
    assert.equal(rMap.status, 200);
    assert.match(rMap.headers.get('content-type'), /application\/xml/);
    const txtMap = await rMap.text();
    for (const p of ['https://dovi.finance/', 'https://dovi.finance/app', 'https://dovi.finance/live', 'https://dovi.finance/judges', 'https://dovi.finance/help', 'https://dovi.finance/terms', 'https://dovi.finance/privacy', 'https://dovi.finance/proof', 'https://dovi.finance/announcement', 'https://dovi.finance/refunds', 'https://dovi.finance/cookies', 'https://dovi.finance/data-request']) {
      assert.ok(txtMap.includes('<loc>' + p + '</loc>'), 'sitemap includes ' + p);
    }
  } finally {
    await s.close();
  }
});

test('seo: public pages serve unique titles under 60 chars, descriptions under 160 chars, canonicals and og tags', async () => {
  const s = await boot({ DOVI_INDEXABLE: '1', TESTNET: '0' });
  const pages = [
    { path: '/', titleExpected: 'DOVI finance: Send USDC to an X handle or email' },
    { path: '/app', titleExpected: 'DOVI app: send and claim USDC on Base' },
    { path: '/live', titleExpected: 'Live network numbers: DOVI on Base' },
    { path: '/help', titleExpected: 'Help and safety guide: how DOVI works' },
    { path: '/proof', titleExpected: 'Payment proof and verification: DOVI' },
    { path: '/judges', titleExpected: 'DOVI for judges: overview and live demo' },
    { path: '/terms', titleExpected: 'DOVI terms of service' },
    { path: '/privacy', titleExpected: 'DOVI privacy policy' },
    { path: '/refunds', titleExpected: 'DOVI refund policy' },
    { path: '/cookies', titleExpected: 'DOVI cookie policy' },
    { path: '/data-request', titleExpected: 'Delete or export your data: DOVI' },
    { path: '/announcement', titleExpected: 'DOVI is live on the Base test network' },
  ];

  const titles = new Set();
  const descs = new Set();

  try {
    for (const item of pages) {
      const res = await s.call('GET', item.path);
      assert.equal(res.status, 200, 'Page ' + item.path + ' returned 200');
      const html = await res.text();


      const mTitle = /<title>([^<]+)<\/title>/.exec(html);
      assert.ok(mTitle, 'Title exists on ' + item.path);
      const title = mTitle[1].trim();
      assert.ok(title.length <= 60, 'Title under 60 chars on ' + item.path + ' (' + title.length + ' chars): ' + title);
      assert.equal(title, item.titleExpected, 'Title matches expected on ' + item.path);
      assert.ok(!titles.has(title), 'Title is unique: ' + title);
      titles.add(title);

      const mDesc = /<meta name="description" content="([^"]+)"/.exec(html);
      assert.ok(mDesc, 'Meta description exists on ' + item.path);
      const desc = mDesc[1].trim();
      assert.ok(desc.length <= 160, 'Meta description under 160 chars on ' + item.path + ' (' + desc.length + ' chars): ' + desc);
      assert.ok(!descs.has(desc), 'Meta description is unique on ' + item.path);
      descs.add(desc);

      const mCan = /<link rel="canonical" href="([^"]+)"/.exec(html);
      assert.ok(mCan, 'Canonical tag exists on ' + item.path);
      assert.match(mCan[1], /^https:\/\/dovi\.finance/, 'Canonical on dovi.finance on ' + item.path);

      assert.match(html, /<meta property="og:url"/, 'OG url on ' + item.path);
      assert.match(html, /<meta property="og:title"/, 'OG title on ' + item.path);
      assert.match(html, /<meta property="og:description"/, 'OG description on ' + item.path);
      assert.match(html, /<meta property="og:image"/, 'OG image on ' + item.path);
      assert.match(html, /<meta property="og:image:width" content="1200"/, 'OG image width 1200 on ' + item.path);
      assert.match(html, /<meta property="og:image:height" content="630"/, 'OG image height 630 on ' + item.path);
      assert.match(html, /<link rel="manifest" href="\/manifest\.json"/, 'Manifest link on ' + item.path);
      assert.match(html, /<meta name="twitter:card"/, 'Twitter card on ' + item.path);

      assert.doesNotMatch(html, /[—–·]/, 'No forbidden punctuation on ' + item.path);
    }
  } finally {
    await s.close();
  }
});

test('seo: unknown routes return HTTP status 404 without soft-404 redirects', async () => {
  const s = await boot({ DOVI_INDEXABLE: '1', TESTNET: '0' });
  try {
    const r1 = await s.call('GET', '/not-a-real-page');
    assert.equal(r1.status, 404);
    const r2 = await s.call('GET', '/missing-doc.html');
    assert.equal(r2.status, 404);
    const r3 = await s.call('GET', '/api/not-an-endpoint');
    assert.equal(r3.status, 404);
  } finally {
    await s.close();
  }
});

test('seo: public pages provide descriptive internal linking and trust signals', async () => {
  const s = await boot({ DOVI_INDEXABLE: '1', TESTNET: '0' });
  try {
    const pages = ['/', '/help', '/live', '/proof', '/terms', '/privacy', '/judges', '/announcement'];
    for (const p of pages) {
      const res = await s.call('GET', p);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /href="(\/|https:\/\/[^/]+\/)app"/, 'Links to /app on ' + p);
      assert.match(html, /href="(\/|https:\/\/[^/]+\/)live"/, 'Links to /live on ' + p);
      assert.match(html, /href="(\/|https:\/\/[^/]+\/)help"/, 'Links to /help on ' + p);
      assert.match(html, /href="(\/|https:\/\/[^/]+\/)terms"/, 'Links to /terms on ' + p);
      assert.match(html, /href="(\/|https:\/\/[^/]+\/)privacy"/, 'Links to /privacy on ' + p);
      assert.match(html, /https:\/\/x\.com\/DoviFinance/, 'Trust signal: links to DOVI X profile on ' + p);
      assert.match(html, /https:\/\/github\.com\/codedforum\/dovi-finance/, 'Trust signal: links to open source repo on ' + p);
    }
  } finally {
    await s.close();
  }
});

test('seo: og image asset exists and is 1200 by 630', () => {
  const ogPath = path.join(__dirname, '..', 'public', 'brand', 'og.jpg');
  assert.ok(fs.existsSync(ogPath), 'public/brand/og.jpg exists');
  const buf = fs.readFileSync(ogPath);
  assert.ok(buf.length > 20000, 'og.jpg has non-trivial size: ' + buf.length);
  // Check JPEG dimensions from frame header
  let i = 0;
  let width = 0;
  let height = 0;
  while (i < buf.length - 8) {
    if (buf[i] === 0xff && (buf[i + 1] === 0xc0 || buf[i + 1] === 0xc2)) {
      height = buf.readUInt16BE(i + 5);
      width = buf.readUInt16BE(i + 7);
      break;
    }
    i++;
  }
  assert.equal(width, 1200, 'OG image width is 1200');
  assert.equal(height, 630, 'OG image height is 630');
});

test('seo: live-index.html in dovi-seo-work is valid, has JSON-LD and adheres to copy rules', () => {
  const p = path.join('/Users/smartcoded2011/dovi-seo-work/live-index.html');
  assert.ok(fs.existsSync(p), 'live-index.html exists');
  const html = fs.readFileSync(p, 'utf8');

  assert.doesNotMatch(html, /[—–·]/, 'No forbidden punctuation');
  assert.doesNotMatch(html, /[→←↑↓↔↕]/, 'No arrow characters');
  assert.doesNotMatch(html, /zsh\./, 'No zsh template leak');

  const mTitle = /<title>([^<]+)<\/title>/.exec(html);
  assert.ok(mTitle, 'Title exists');
  const title = mTitle[1].trim();
  assert.ok(title.length <= 60, 'Title under 60 chars');
  assert.equal(title, 'DOVI finance: Send USDC to an X handle or email');

  const mJson = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(mJson, 'JSON-LD found in live-index.html');
  const parsed = JSON.parse(mJson[1]);
  assert.equal(parsed['@context'], 'https://schema.org');
  const faq = parsed['@graph'].find((x) => x['@type'] === 'FAQPage');
  assert.ok(faq && faq.mainEntity.length >= 5, 'FAQPage has at least 5 questions');
});

test('seo: homepage includes valid JSON-LD graph with Organization, WebSite, SoftwareApplication, FinancialProduct, and FAQPage', async () => {
  const s = await boot({ DOVI_INDEXABLE: '1', TESTNET: '0' });
  try {
    const res = await s.call('GET', '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    const mJson = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(mJson, 'JSON-LD tag found');
    const parsed = JSON.parse(mJson[1]);
    assert.equal(parsed['@context'], 'https://schema.org');
    assert.ok(Array.isArray(parsed['@graph']));
    const types = parsed['@graph'].map((x) => x['@type']);
    assert.ok(types.includes('Organization'), 'Includes Organization');
    assert.ok(types.includes('WebSite'), 'Includes WebSite');
    assert.ok(types.includes('SoftwareApplication'), 'Includes SoftwareApplication');
    assert.ok(types.includes('FinancialProduct'), 'Includes FinancialProduct');
    assert.ok(types.includes('FAQPage'), 'Includes FAQPage');

    const faq = parsed['@graph'].find((x) => x['@type'] === 'FAQPage');
    assert.ok(faq.mainEntity.length >= 5, 'FAQ has at least 5 questions');
  } finally {
    await s.close();
  }
});

test('seo: private pages have noindex', async () => {
  const s = await boot({ DOVI_INDEXABLE: '1', TESTNET: '0' });
  try {
    const rNotif = await s.call('GET', '/notifications');
    assert.equal(rNotif.status, 200);
    const htmlNotif = await rNotif.text();
    assert.match(htmlNotif, /<meta name="robots" content="noindex">/);
  } finally {
    await s.close();
  }
});
