'use strict';
// Browser walkthrough of batch payouts, withdraw and pay from X against the dev server. Run with a FRESH dev server: DOVI_ENV=dev node tools/dev-server.js
const puppeteer = require(process.env.PUPPETEER || 'puppeteer-core');
const fs = require('node:fs');
const BASE = process.env.BASE || 'http://localhost:3399';
const SHOTS = process.env.SHOTS || '/tmp/dovi-shots-new';
fs.mkdirSync(SHOTS, { recursive: true });
const results = []; const errors = [];
let lastText = '';
const ok = (name, cond, extra = '') => { if (!cond && lastText) console.log('   text: ' + lastText.slice(0, 900).replace(/\n/g, ' | ')); results.push(cond); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const M = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const text = async (p) => { lastText = await p.evaluate(() => document.body.innerText); return lastText; };
async function login(page, identity, label) {
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(async (identity, label) => { await fetch('/api/dev/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity, label }) }); }, identity, label);
}
async function mk(browser) {
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage(); await page.setViewport(M); await page.evaluateOnNewDocument(() => { try { localStorage.setItem('dovi.cookie-notice', '1'); } catch { /* storage blocked */ } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));
  return page;
}
const clk = async (p, sel) => { await p.evaluate((q) => { document.querySelectorAll('.toast').forEach((t) => t.remove()); document.querySelector(q).scrollIntoView({ block: 'center' }); }, sel); await sleep(150); await p.click(sel); };
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: 'new', args: ['--no-sandbox'] });
  const a = await mk(browser);
  await login(a, 'email:alice@mail.com', 'alice@mail.com');
  await a.goto(BASE + '/app', { waitUntil: 'networkidle2' }); await sleep(900);
  let t = await text(a);
  ok('home has the new tiles', /Pay many people/.test(t) && /Pay from X/.test(t) && /Withdraw/.test(t));
  await a.screenshot({ path: SHOTS + '/01-home.png' });

  await a.goto(BASE + '/app#batch', { waitUntil: 'networkidle2' }); await sleep(800);
  t = await text(a);
  ok('batch page renders', /Pay many people/.test(t) && /Who gets paid/.test(t));
  await a.type('#bl', '@bob 3\nzed@mail.com 2\nnot a thing\n'); await sleep(300);
  t = await text(a);
  ok('live parse shows ready lines and a line to fix', /2 of 3 lines ready/.test(t) && /\$5\.00 before the fee/.test(t), t.match(/\d of \d lines ready[^\n]*/) + '');
  await a.screenshot({ path: SHOTS + '/02-batch-form.png' });
  await clk(a, '#br'); await sleep(500);
  t = await text(a);
  ok('submit blocks while a line has an error', /Fix the lines marked/.test(t));
  await a.evaluate(() => { const ta = document.querySelector('#bl'); ta.value = '@bob 3\nzed@mail.com 2\nzed@mail.com 4'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
  await clk(a, '#br'); await sleep(1500);
  t = await text(a);
  ok('duplicate recipient is reported by the server per line', /Fix these lines/.test(t) && /Line 3/.test(t) && /Listed twice/.test(t));
  await a.screenshot({ path: SHOTS + '/03-batch-fix.png' });
  await clk(a, '#cl'); await sleep(300);
  await a.evaluate(() => { const ta = document.querySelector('#bl'); ta.value = '@bob 3\nzed@mail.com 2'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
  await a.type('#bt', 'Giveaway'); await clk(a, '#br'); await sleep(1500);
  t = await text(a);
  ok('review shows payments, fee and total', /Review batch/.test(t) && /You pay/.test(t) && /\$5\.20/.test(t));
  await a.screenshot({ path: SHOTS + '/04-batch-review.png' });
  await clk(a, '#go'); await sleep(7000);
  t = await text(a);
  ok('batch sends and lists every claim link with copy and post on X', /2 payments sent/.test(t) && /Copy all messages/.test(t) && (await a.$$('[data-cp]')).length >= 2 && /Post on X/.test(t));
  const links = await a.$$eval('[data-cp]', (els) => els.map((e) => e.dataset.cp));
  ok('links are short claim links', links.length === 2 && links.every((l) => /\/c\/[2-9a-hj-km-np-zA-HJ-NP-Z]{8}$/.test(l)), links.join(' '));
  ok('no horizontal overflow on the result sheet', await noOverflow(a));
  await a.screenshot({ path: SHOTS + '/05-batch-done.png' });
  await clk(a, '#dn'); await sleep(900);
  t = await text(a);
  ok('past batches lists it', /Giveaway/.test(t) && /2 payments/.test(t));
  await a.click('[data-b]'); await sleep(900);
  t = await text(a);
  ok('opening a past batch shows its links', /Copy as CSV/.test(t) && /funded/.test(t));
  await a.screenshot({ path: SHOTS + '/06-batch-detail.png' });
  await a.keyboard.press('Escape');

  // bob claims one of the batch links
  const bob = await mk(browser); await login(bob, 'x:555', '@bob');
  await bob.goto(links[0], { waitUntil: 'networkidle2' }); await sleep(600);
  t = await text(bob);
  ok('a batch claim link opens the claim page', /\$3\.00/.test(t) && /Claim/.test(t));
  await clk(bob, '#cl'); await sleep(5000);
  ok('recipient claims a batch payment', /You got\s+\$3\.00/.test(await text(bob)));

  // withdraw
  await a.goto(BASE + '/app#withdraw', { waitUntil: 'networkidle2' }); await sleep(900);
  t = await text(a);
  ok('withdraw page shows routes with private and fiat marked as not available', /Withdraw/.test(t) && /Public/.test(t) && /Private/.test(t) && /naira/.test(t) && /not switched on|switched on at launch|mainnet/.test(t));
  await a.type('#wa', 'not an address'); await a.type('#wm', '2'); await clk(a, '#wgo'); await sleep(300);
  ok('bad address is refused in the form', /valid Base wallet address/.test(await text(a)));
  await a.evaluate(() => { document.querySelector('#wa').value = '0x4444444444444444444444444444444444444444'; });
  await clk(a, '#wgo'); await sleep(1200);
  t = await text(a);
  ok('withdraw review shows route, amount and zero fee', /Review withdrawal/.test(t) && /Network fee/.test(t) && /Public/.test(t));
  await a.screenshot({ path: SHOTS + '/07-withdraw-review.png' });
  await clk(a, '#go'); await sleep(6000);
  t = await text(a);
  ok('withdrawal completes', /Withdrawal sent/.test(t), t.slice(0, 120).replace(/\n/g, ' '));
  await a.screenshot({ path: SHOTS + '/08-withdraw-done.png' });
  await clk(a, '#dn'); await sleep(900);
  { const th = await text(a); ok('withdraw history lists it', /Recent withdrawals/i.test(th) && /Public/.test(th)); }
  ok('no overflow on withdraw page', await noOverflow(a));

  // pay from X (bob has X linked)
  await bob.goto(BASE + '/app#autopay', { waitUntil: 'networkidle2' }); await sleep(1000);
  t = await text(bob);
  ok('autopay page offers limits when X is linked', /Pay from X/.test(t) && /Most per payment/.test(t) && /how it works/i.test(t));
  await bob.screenshot({ path: SHOTS + '/09-autopay.png' });
  await clk(bob, '#ago'); await sleep(1200);
  t = await text(bob);
  ok('turn on shows limits and allowance', /Turn on pay from X/.test(t) && /Allowance/.test(t));
  await clk(bob, '#go'); await sleep(6500);
  ok('autopay turns on', /Pay from X is on/.test(await text(bob)));
  await clk(bob, '#dn'); await sleep(1500);

  // agent keys and the MCP endpoint (bob has Pay from X on)
  await bob.goto(BASE + '/app#keys', { waitUntil: 'networkidle2' }); await sleep(900);
  t = await text(bob);
  ok('agent keys page offers a form and the MCP address', /Agent keys/.test(t) && /Most per payment/.test(t) && /\/mcp/.test(t));
  await bob.type('#kn', 'e2e agent'); await bob.$eval('#kp', (e) => { e.value = '2'; }); await bob.$eval('#kd', (e) => { e.value = '3'; });
  await clk(bob, '#kgo'); await sleep(1200);
  const keyText = await bob.$eval('#kb', (e) => e.textContent).catch(() => '');
  ok('the key is shown once in a sheet', /^dvk_/.test(keyText));
  await bob.screenshot({ path: SHOTS + '/11-agent-key.png' });
  const rpc = async (method, params, key = keyText) => { const r = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return { status: r.status, j: await r.json().catch(() => null) }; };
  const tool = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return r.j && r.j.result ? JSON.parse(r.j.result.content[0].text) : r; };
  ok('MCP initialize and tools list work with the key', (await rpc('initialize', { protocolVersion: '2025-06-18' })).j.result.serverInfo.name === 'dovi-send' && (await rpc('tools/list')).j.result.tools.length === 5);
  const lim = await tool('dovi_get_limits'); ok('MCP limits show the key caps', lim.per_payment_usd === '$2.00' && lim.per_day_usd === '$3.00', JSON.stringify(lim));
  const over = await tool('dovi_send_payment', { to: '@alice', amount_usd: '2.50', idempotency_key: 'e2e-over-0001' }); ok('MCP refuses a payment above the key cap', over.error === 'above_key_limit', JSON.stringify(over));
  ok('MCP without a key is refused', (await rpc('ping', {}, 'dvk_' + 'q'.repeat(30))).status === 401);
  await clk(bob, '#dn'); await sleep(1200);
  t = await text(bob);
  ok('the key is listed with its limits and never shows the secret again', /e2e agent/.test(t) && /\$2\.00 per payment/.test(t) && !t.includes(keyText.slice(10)));
  await bob.screenshot({ path: SHOTS + '/12-agent-keys-list.png' });
  await clk(bob, '[data-revoke]'); await sleep(600); await clk(bob, '#yes'); await sleep(1500);
  ok('a revoked key stops working at once', (await rpc('ping', {})).status === 401);
  ok('no overflow on agent keys page', await noOverflow(bob));
  await bob.goto(BASE + '/app#autopay', { waitUntil: 'networkidle2' }); await sleep(900);
  t = await text(bob);
  ok('page now shows On with limits and a turn off button', /\bOn\b/.test(t) && /Turn off pay from X/.test(t));
  await bob.screenshot({ path: SHOTS + '/10-autopay-on.png' });
  await bob.goto(BASE + '/app#home', { waitUntil: 'networkidle2' }); await sleep(800);
  await bob.evaluate(() => { window.__n = { a: 0, b: 0, c: 0 }; const f = window.fetch; window.fetch = (...x) => { const u = String(x[0]); if (u.includes('/api/activity')) window.__n.a++; if (u.includes('/api/wallet/balance')) window.__n.b++; if (u.includes('/api/claims/incoming')) window.__n.c++; return f(...x); }; });
  await sleep(16500);
  const live = await bob.evaluate(() => window.__n);
  ok('home refreshes balance, recent activity and waiting claims by itself', live.a >= 1 && live.b >= 1 && live.c >= 1, JSON.stringify(live));
  const homeText = await text(bob);
  ok('home naira line shows no source, date or swap note', !/ExchangeRate|Not a swap|Indicative/.test(homeText), '');
  ok('home does not call live features coming soon', !/Reply on X|Send from AI chat|Pay links/.test(homeText) && !/Pay from X\s*Coming soon/.test(homeText), '');
  ok('no waitlist wording on home', !/waitlist/i.test(homeText), '');
  const mr = await bob.evaluate(async () => (await fetch('/api/dev/mention', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 't1', authorId: '555', authorHandle: 'bob', text: '@DoviFinance send @kofi 2 usdc' }) })).json());
  ok('a tweeted command sends the payment and queues a reply naming the amount and sender, with no claim url', mr.result.status === 'sent' && /\$2\.00/.test(mr.reply || '') && /@bob/.test(mr.reply || '') && !/https?:\/\//.test(mr.reply || ''), JSON.stringify(mr));
  const mr2 = await bob.evaluate(async () => (await fetch('/api/dev/mention', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 't2', authorId: '555', authorHandle: 'bob', text: '@DoviFinance send @kofi 9 usdc' }) })).json());
  ok('over the limit is refused with a reply', mr2.result.status === 'rejected' && /limit/.test(mr2.reply || ''), JSON.stringify(mr2));
  await bob.goto(BASE + '/app#activity', { waitUntil: 'networkidle2' }); await sleep(900);
  ok('the tweeted payment can be taken back from Activity', /Take it back/.test(await text(bob)));
  await bob.goto(BASE + '/app#autopay', { waitUntil: 'networkidle2' }); await sleep(900);
  await sleep(600); if (!(await bob.$('#aoff'))) console.log('   no #aoff, page: ' + (await text(bob)).slice(0, 500).replace(/\n/g, ' | '));
  await clk(bob, '#aoff'); await sleep(700); await clk(bob, '#go'); await sleep(6000);
  ok('autopay turns off', /Pay from X is off/.test(await text(bob)));

  // desktop
  const d = await browser.createBrowserContext(); const dp = await d.newPage(); await dp.setViewport({ width: 1280, height: 900 }); await dp.evaluateOnNewDocument(() => { try { localStorage.setItem('dovi.cookie-notice', '1'); } catch { /* storage blocked */ } });
  await login(dp, 'email:alice@mail.com', 'alice@mail.com'); await dp.goto(BASE + '/app#batch', { waitUntil: 'networkidle2' }); await sleep(900);
  await dp.screenshot({ path: SHOTS + '/11-batch-desktop.png' });
  ok('desktop batch page has no overflow', await noOverflow(dp));
  const realErrors = errors.filter((e) => !/status of 400/.test(e));
  // cookie notice and legal pages (a fresh browser that has not dismissed the notice)
  { const fc = await browser.createBrowserContext(); const fp = await fc.newPage(); await fp.setViewport(M);
    await fp.goto(BASE + '/', { waitUntil: 'networkidle2' }); await sleep(600);
    ok('first visit shows the cookie notice with a policy link', !!(await fp.$('#cookie-notice')) && !!(await fp.$('#cookie-notice a[href="/cookies"]')));
    await fp.focus('#cookie-notice button'); await fp.keyboard.press('Enter'); await sleep(300);
    ok('the notice closes from the keyboard', !(await fp.$('#cookie-notice')));
    await fp.reload({ waitUntil: 'networkidle2' }); await sleep(500);
    ok('the notice stays closed on the next visit', !(await fp.$('#cookie-notice')));
    for (const [path, re] of [['/privacy', /What we collect/], ['/terms', /What DOVI is/], ['/refunds', /Taking a payment back/], ['/cookies', /dovi_sess/], ['/data-request', /Request deletion/]]) {
      await fp.goto(BASE + path, { waitUntil: 'networkidle2' }); const tx = await fp.evaluate(() => document.body.innerText);
      ok('legal page ' + path + ' renders with a skip link and the footer links', re.test(tx) && /Skip to content/.test(tx) && /Delete my data/.test(tx));
    }
    await fc.close(); }
  ok('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' || '));
  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed. Screenshots in ' + SHOTS);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
