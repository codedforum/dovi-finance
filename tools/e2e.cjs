'use strict';
// Browser walkthrough against the dev server (tools/dev-server.js). Run: DOVI_ENV=dev node tools/dev-server.js, then node tools/e2e.cjs
const puppeteer = require(process.env.PUPPETEER || 'puppeteer-core');
const fs = require('node:fs');
const BASE = process.env.BASE || 'http://localhost:3399';
const SHOTS = process.env.SHOTS || '/tmp/dovi-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const results = []; const errors = [];
const ok = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name, extra]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(page, identity, label) {
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(async (identity, label) => { await fetch('/api/dev/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity, label }) }); }, identity, label);
}
async function newPage(browser, vp) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(vp);
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('dovi.cookie-notice', '1'); } catch { /* storage blocked */ } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));
  page.on('requestfailed', (r) => { if (!/fonts\.g|fxtwitter/.test(r.url())) errors.push('REQFAIL ' + r.url()); });
  return page;
}
const text = (page) => page.evaluate(() => document.body.innerText);

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: 'new', args: ['--no-sandbox'] });
  const D = { width: 1280, height: 900, deviceScaleFactor: 1 }; const M = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

  // 1 landing
  let page = await newPage(browser, D);
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  let t = await text(page);
  ok('landing says Live on Base', /Live on Base/.test(t));
  ok('landing has no Raise or five chains', !/Raise|five chains|Five chains/i.test(t));
  await page.screenshot({ path: SHOTS + '/01-landing.png', fullPage: false });

  // 2 app gate on mobile, sign in with email through the real UI
  const alicePage = await newPage(browser, M);
  await alicePage.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  t = await text(alicePage);
  ok('app shows the sign in gate when signed out', /payment address/.test(t));
  await alicePage.click('#si'); await sleep(400);
  await alicePage.type('#em', 'alice@mail.com');
  await alicePage.click('#ef button'); await sleep(500);
  await alicePage.type('#cd', '123456');
  await alicePage.click('#cf button[type=submit]'); await sleep(1500);
  t = await text(alicePage);
  ok('email sign in lands on Home with a balance', /Your dollars/.test(t) && /\$7\.00/.test(t), t.slice(0, 80).replace(/\n/g, ' '));
  ok('chain chips: Base live and others coming soon', /Base/.test(t) && /Solana, coming soon/.test(t));
  await alicePage.screenshot({ path: SHOTS + '/02-home-mobile.png' });
  const overflow = await alicePage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  ok('no horizontal overflow on Home at 390px', !overflow);

  // 3 send flow
  await alicePage.click('.tab[data-t="send"]'); await sleep(300);
  await alicePage.type('#to', '@bob'); await alicePage.type('#am', '5');
  await alicePage.click('#sf button[type=submit]'); await sleep(1200);
  t = await text(alicePage);
  ok('review shows what they receive, the DOVI fee and what you pay', /They receive/.test(t) && /DOVI fee/.test(t) && /\$5\.10/.test(t), '');
  await alicePage.screenshot({ path: SHOTS + '/03-review-mobile.png' });
  await alicePage.click('#go'); await sleep(4500);
  t = await text(alicePage);
  ok('send ends on a claim link screen', /Ready to claim/.test(t) && /\/c\/[2-9a-hj-km-np-zA-HJ-NP-Z]{8}/.test(t));
  const link = await alicePage.evaluate(() => (document.querySelector('#lk') || {}).textContent);
  await alicePage.screenshot({ path: SHOTS + '/04-success-mobile.png' });
  await alicePage.click('#done'); await sleep(400);

  // 4 recipient claims on a separate browser context
  const bobPage = await newPage(browser, M);
  await login(bobPage, 'x:555', '@bob');
  await bobPage.goto(link, { waitUntil: 'networkidle2' });
  t = await text(bobPage);
  ok('claim page shows amount, sender and the claim button', /\$5\.00/.test(t) && /Claim \$5\.00/.test(t));
  await bobPage.screenshot({ path: SHOTS + '/05-claim-page.png' });
  await bobPage.click('#cl'); await sleep(5000);
  t = await text(bobPage);
  ok('recipient claims and sees the success state', /You got\s+\$5\.00/.test(t));
  await bobPage.screenshot({ path: SHOTS + '/06-claimed.png' });

  // 5 sender is notified live and the bell badge shows
  await sleep(800);
  const badge = await alicePage.evaluate(() => (document.querySelector('#bell .badge') || {}).textContent || '');
  ok('sender bell badge increments from the live stream', Number(badge.replace('+', '')) >= 1, 'badge=' + badge);
  const toastText = await alicePage.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => x.innerText).join(' | '));
  ok('a toast announced the claim', /claimed/i.test(toastText), toastText.slice(0, 80));
  await alicePage.screenshot({ path: SHOTS + '/07-toast-mobile.png' });

  // 6 notifications page and panel
  await alicePage.click('#bell'); await sleep(900);
  t = await text(alicePage);
  ok('bell panel lists notifications', /Notifications/.test(t) && /claimed/i.test(t));
  await alicePage.screenshot({ path: SHOTS + '/08-panel-mobile.png' });
  await alicePage.keyboard.press('Escape');
  await alicePage.goto(BASE + '/notifications', { waitUntil: 'networkidle2' }); await sleep(600);
  t = await text(alicePage);
  ok('notifications page renders with filters', /All/.test(t) && /Claims/.test(t) && /claimed/i.test(t));
  await alicePage.screenshot({ path: SHOTS + '/09-notifications-mobile.png' });

  // 7 activity and take it back
  await alicePage.goto(BASE + '/app#activity', { waitUntil: 'networkidle2' }); await sleep(800);
  t = await text(alicePage);
  ok('activity lists the completed send', /Sent/.test(t) && /\$5\.00/.test(t));
  await alicePage.screenshot({ path: SHOTS + '/10-activity-mobile.png' });

  // 8 second send then reclaim
  await alicePage.goto(BASE + '/app#send', { waitUntil: 'networkidle2' }); await sleep(500);
  await alicePage.type('#to', 'zed@mail.com'); await alicePage.type('#am', '2');
  await alicePage.click('#sf button[type=submit]'); await sleep(1200);
  await alicePage.click('#go'); await sleep(4500);
  await alicePage.goto(BASE + '/app#activity', { waitUntil: 'networkidle2' }); await sleep(800);
  t = await text(alicePage);
  ok('a waiting payment shows with Take it back', /Waiting to be claimed/.test(t) && /Take it back/.test(t));
  await alicePage.evaluate(() => document.querySelector('[data-reclaim]').click()); await sleep(900);
  t = await text(alicePage);
  ok('take back asks in a styled modal, not a browser dialog', /Take it back\?/.test(t) && /DOVI fee/.test(t) && /Keep waiting/.test(t));
  await alicePage.screenshot({ path: SHOTS + '/11-takeback-modal.png' });
  await alicePage.click('#yes'); await sleep(4500);
  t = await text(alicePage);
  ok('taking it back shows who, when, how much and no fee', /Taken back/.test(t) && /Taken back by\s+You/.test(t) && /No fee was charged/.test(t) && /\$2\.00/.test(t));
  await alicePage.screenshot({ path: SHOTS + '/12-takeback-done.png' });
  await alicePage.click('#done'); await sleep(900);
  t = await text(alicePage);
  ok('history records the send and the take back with dates', /Sent to\s+zed@mail\.com/.test(t) && /Taken back from\s+zed@mail\.com/.test(t) && /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}/.test(t));
  await alicePage.evaluate(() => { const r = [...document.querySelectorAll('[data-kind="claim_returned"]')][0]; r.click(); }); await sleep(900);
  t = await text(alicePage);
  ok('detail shows a timeline with both times and the refund', /Sent/.test(t) && /Taken back/.test(t) && /You got back/.test(t) && /returned in full, no fee/.test(t));
  const off = await alicePage.evaluate(() => [innerWidth, document.documentElement.scrollWidth, ...[...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !e.closest('.toasts')).slice(0, 8).map((e) => e.tagName + '.' + String(e.className).slice(0, 24) + ':' + Math.round(e.getBoundingClientRect().right))]);
  console.log('sheet overflow', JSON.stringify(off));
  await alicePage.screenshot({ path: SHOTS + '/13-detail.png' });
  await alicePage.click('#c'); await sleep(300);

  // 8b account sheet and dashboard
  await alicePage.goto(BASE + '/app', { waitUntil: 'networkidle2' }); await sleep(900);
  await alicePage.click('#me'); await sleep(1200);
  t = await text(alicePage);
  ok('account sheet shows profile, stats, linked accounts, limits and sign out', /Linked accounts/i.test(t) && /Sent today/i.test(t) && /Sign out/i.test(t) && /Link X/i.test(t));
  await alicePage.screenshot({ path: SHOTS + '/14-account-sheet.png' });
  await alicePage.click('#dash'); await sleep(1200);
  t = await text(alicePage);
  ok('dashboard page shows stats, limits and wallet', /Linked accounts/i.test(t) && /Limits/i.test(t) && /Wallet/i.test(t) && /DOVI fees paid/i.test(t) && /#account$/.test(alicePage.url()));
  await alicePage.screenshot({ path: SHOTS + '/15-dashboard.png', fullPage: true });

  // 9 agent
  await alicePage.goto(BASE + '/app#agent', { waitUntil: 'networkidle2' }); await sleep(400);
  await alicePage.type('#ci', 'send 3 to @kofi'); await alicePage.keyboard.press('Enter'); await sleep(1500);
  t = await text(alicePage);
  ok('agent shows a preview with Approve', /Approve/.test(t) && /\$3\.10/.test(t));
  await alicePage.type('#ci', 'swap 5 usdc for eth'); await alicePage.keyboard.press('Enter'); await sleep(1000);
  t = await text(alicePage);
  ok('agent honestly refuses things it cannot do', /cannot do that yet/i.test(t));
  await alicePage.screenshot({ path: SHOTS + '/11-agent-mobile.png' });

  // 10 desktop views and a11y basics
  const desk = await newPage(browser, D);
  await login(desk, 'email:alice@mail.com', 'alice@mail.com');
  await desk.goto(BASE + '/app', { waitUntil: 'networkidle2' }); await sleep(800);
  await desk.screenshot({ path: SHOTS + '/12-home-desktop.png' });
  const unlabeled = await desk.evaluate(() => [...document.querySelectorAll('button,a,input')].filter((e) => !(e.innerText || e.getAttribute('aria-label') || e.placeholder || e.value || e.title)).length);
  ok('every control has a visible name or aria label', unlabeled === 0, 'unlabeled=' + unlabeled);

  // 11 pages
  for (const p of ['/help', '/terms', '/privacy']) { const pg = await newPage(browser, M); const r = await pg.goto(BASE + p, { waitUntil: 'networkidle2' }); ok(p + ' loads', r.status() === 200); await pg.close(); }

  ok('no console errors or failed requests', errors.length === 0, errors.slice(0, 3).join(' || '));
  await browser.close();
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed. Screenshots in ' + SHOTS);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
