'use strict';
const fs = require('node:fs');
const path = require('node:path');
const unsub = require('./unsubscribe');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UPDATED = '1 November 2026';

function businessBlock(b) {
  const rows = [];
  if (b.name) rows.push('<li><b>Operator:</b> ' + esc(b.name) + '</li>');
  if (b.address) rows.push('<li><b>Address:</b> ' + esc(b.address) + '</li>');
  if (b.country) rows.push('<li><b>Country:</b> ' + esc(b.country) + '</li>');
  if (b.email) rows.push('<li><b>Email:</b> <a href="mailto:' + esc(b.email) + '">' + esc(b.email) + '</a></li>');
  if (!rows.length) return '<p>The company details for DOVI are being finalised and will be published here before DOVI opens to the public. Until then, write to us with <b>Report a problem</b> inside the app.</p>';
  return '<ul>' + rows.join('') + '</ul>';
}

const contactLine = (b) => (b.email ? 'Email <a href="mailto:' + esc(b.email) + '">' + esc(b.email) + '</a>, or use' : 'Use') + ' <b>Report a problem</b> in the app.';
const beta = '<p class="note">Beta version, last updated ' + UPDATED + '. A reviewed version will replace it before DOVI opens more widely.</p>';

const PAGES = {
  privacy: { title: 'Privacy.', body: (b) => '<h1>Privacy</h1>' + beta +
    '<h2>Who we are</h2>' + businessBlock(b) +
    '<h2>What we collect</h2><ul><li>Your sign in identity: your email, your Google account id, or your X account id and handle.</li><li>Your wallet address on Base.</li><li>Payment records: amounts, the recipient you typed, status, time, and notes you add.</li><li>Messages you type to Ask DOVI, so it can answer and show your history.</li><li>Your signed in devices (a label and the last time each was used) and your notification settings.</li><li>If you joined the early waitlist: your X handle and picture, your referral code, and an email if you added one.</li><li>If you report a problem: what you write.</li><li>Your IP address is used in memory for rate limits and abuse checks. Our request logs keep the page, status, timing and an account number, not your IP address.</li></ul>' +
    '<h2>What we do not collect</h2><p>We never see or store your private keys, your password or a seed phrase. Your wallet is created and protected by Coinbase through its embedded wallet service. We use no advertising trackers and no analytics tools.</p>' +
    '<h2>Why we use it</h2><ul><li>To run your account and make payments work (this is the service you asked for).</li><li>To send emails and notifications about your payments and your security.</li><li>To prevent fraud and abuse, and to meet legal duties.</li></ul><p>We do not sell your data.</p>' +
    '<h2>What is public</h2><p>Payments on Base are public on the blockchain and cannot be erased by us. A claim link page shows only the amount, the sender display name, the recipient label and the status.</p>' +
    '<h2>Who we share it with</h2><ul><li><b>Coinbase</b>: creates and protects your wallet, and handles card purchases if you add money on mainnet.</li><li><b>Google</b>: only if you choose to sign in with Google.</li><li><b>X</b>: only if you sign in with X or send to an X handle (we read public profile information).</li><li><b>esm.sh</b>: a code delivery network that serves the Coinbase wallet code to your browser, so it sees your IP address when you sign in.</li><li><b>Our email provider</b>: delivers the emails we send.</li><li><b>Hosting</b>: the servers that run DOVI.</li></ul><p>They only get what they need to do their job. See the <a href="/cookies">cookie page</a> for what each one stores in your browser.</p>' +
    '<h2>How long we keep it</h2><p>We keep account data while your account is open. Payment records are kept as long as the law or the handling of a dispute requires, then removed or anonymised. When we erase an account we remove what we can. We cannot change blockchain records.</p>' +
    '<h2>Your rights</h2><ul><li><b>See your data:</b> Account, Your data, Download my data.</li><li><b>Delete your data:</b> Account, Your data, Request deletion. See <a href="/data-request">how deletion works</a>. We aim to answer within 30 days.</li><li><b>Fix your data:</b> change your display details in the app, or tell us what is wrong.</li><li><b>Stop emails:</b> every email has an unsubscribe link, and you can switch notifications off in the app.</li><li><b>Complain:</b> you can contact your local data protection authority.</li></ul>' +
    '<h2>Children</h2><p>DOVI is not for anyone under 18.</p>' +
    '<h2>Changes</h2><p>If this page changes in a way that matters, we will say so in the app.</p>' +
    '<h2>Contact</h2><p>' + contactLine(b) + '</p>' },
  terms: { title: 'Terms.', body: (b) => '<h1>Terms</h1>' + beta +
    '<h2>Who is offering DOVI</h2>' + businessBlock(b) +
    '<h2>What DOVI is</h2><p>DOVI is a beta service that lets you hold USDC on Base in a wallet created for you, send it to an X handle or an email, and claim payments sent to you. DOVI does not hold your private keys. Payments to new recipients are held in a smart contract until they are claimed or taken back.</p>' +
    '<h2>What DOVI is not</h2><p>DOVI is not a bank and balances are not insured deposits. DOVI does not give investment, tax or legal advice.</p>' +
    '<h2>Fees</h2><p>A fee of 1 percent, with a minimum of $0.10, applies to a payment to a new recipient and is charged only when the payment is claimed. If a payment is taken back, no fee is charged. Sending to someone who already uses DOVI has no DOVI fee. Network costs may apply and are shown when they do. See <a href="/refunds">refunds</a>.</p>' +
    '<h2>Limits and expiry</h2><p>Beta limits apply per payment, per day and in total. A payment that is not claimed expires. After it expires, or at any time before it is claimed, the sender can take it back, unless the sender chose to lock it for a set time.</p>' +
    '<h2>Your responsibilities</h2><p>Check the recipient before you approve. Payments on a blockchain cannot be reversed once claimed. Keep your sign in methods safe. Use DOVI lawfully. Do not use it for fraud, harassment or to avoid sanctions. Agent keys you create can spend up to the limits you set, so keep them secret and revoke them when you are done.</p>' +
    '<h2>Freezing and ending</h2><p>You can freeze your account in the app at any time. We may pause or close an account that breaks these terms or the law. You can ask us to delete your account, see <a href="/data-request">delete my data</a>.</p>' +
    '<h2>Risks</h2><p>This is new software. Bugs, network problems and stablecoin issues can cause delays or loss. Use only amounts you can afford to lose while DOVI is in beta.</p>' +
    '<h2>Our liability</h2><p>To the extent the law allows, DOVI is provided as is, and we are not liable for indirect loss or for losses caused by blockchains, stablecoin issuers or other third parties.</p>' +
    '<h2>Changes</h2><p>We may update these terms. If a change matters, we will tell you in the app before it applies.</p>' +
    '<h2>Contact</h2><p>' + contactLine(b) + '</p>' },
  refunds: { title: 'Refunds.', body: (b) => '<h1>Refunds</h1>' + beta +
    '<h2>Taking a payment back</h2><p>You can take back a payment you sent, in full, any time before the recipient claims it. No DOVI fee is charged and nothing needs approval. Open Activity, find the payment, and choose Take it back. A payment that expires unclaimed can also be taken back.</p>' +
    '<h2>Locked payments</h2><p>If you chose to lock a payment, you cannot take it back until the lock ends. The recipient can still claim it during the lock. The lock time is shown before you send.</p>' +
    '<h2>After it is claimed</h2><p>A claimed payment is final. It moves on the blockchain and neither you nor DOVI can reverse it. Check the recipient before you approve.</p>' +
    '<h2>Fees</h2><p>The DOVI fee is charged only when a payment is claimed. If you made a payment by mistake because of an error in DOVI, tell us and we will look at it and put it right where we can.</p>' +
    '<h2>Adding money</h2><p>Card and bank purchases are made with Coinbase or Transak, not with DOVI. Their own refund rules apply to those purchases. On the test network no real money is involved.</p>' +
    '<h2>Network costs</h2><p>Blockchain network costs, where they apply, go to the network and cannot be refunded.</p>' +
    '<h2>How to ask</h2><p>' + contactLine(b) + '</p>' },
  cookies: { title: 'Cookies.', body: (b) => '<h1>Cookies</h1>' + beta +
    '<p>DOVI uses only the cookies and browser storage it needs to work. We do not use advertising, analytics or tracking cookies, so there is nothing to switch off.</p>' +
    '<h2>Cookies we set</h2><table class="legaltable"><thead><tr><th scope="col">Name</th><th scope="col">What it does</th><th scope="col">How long</th></tr></thead><tbody>' +
    '<tr><td><code>dovi_sess</code></td><td>Keeps you signed in. It is HttpOnly, so pages cannot read it.</td><td>Until you sign out or it expires</td></tr>' +
    '</tbody></table>' +
    '<h2>Browser storage we use</h2><ul><li><code>dovi.cookie-notice</code> in local storage remembers that you saw the cookie notice.</li><li>A few <code>dovi.*</code> items in session storage hold drafts, such as an unfinished batch, until you close the tab.</li></ul>' +
    '<h2>Third parties</h2><ul><li><b>Coinbase</b> wallet code (delivered by esm.sh) may keep wallet session data in your browser so you stay signed in to your wallet.</li><li><b>Google</b> loads only if you press Sign in with Google.</li><li><b>Coinbase Pay</b> opens only if you add money on mainnet.</li></ul><p>These are needed for the feature you pick. You can clear them in your browser settings, which will sign you out.</p>' +
    '<h2>Questions</h2><p>' + contactLine(b) + ' See also <a href="/privacy">Privacy</a>.</p>' },
  'data-request': { title: 'Delete my data.', body: (b) => '<h1>Delete my data</h1>' + beta +
    '<p>You can ask DOVI to delete the data it holds about you, or download a copy first.</p>' +
    '<h2>How</h2><ol><li>Sign in to DOVI and open <b>Account</b>.</li><li>Under <b>Your data</b>, choose <b>Download my data</b> if you want a copy.</li><li>Choose <b>Request deletion</b>. We record it, and you can cancel it while it is open.</li></ol><p><a class="btn sm" href="/app#account">Open my account</a></p>' +
    '<p>We ask you to sign in so we know the request is really from you.</p>' +
    '<h2>What happens</h2><ul><li>We aim to answer within 30 days.</li><li>We delete your account and the personal data we hold, and anonymise records we must keep.</li><li>Before we can finish, payments you sent that are still waiting must be claimed or taken back, and any USDC in your wallet should be withdrawn. Your wallet belongs to you and Coinbase holds the keys, not us.</li></ul>' +
    '<h2>What we cannot delete</h2><p>Payments on Base are public on the blockchain and cannot be removed by anyone. We may also keep records the law requires, for as long as it requires.</p>' +
    '<h2>Cannot sign in?</h2><p>' + contactLine(b) + '</p>' },
};

/* the legal pages are also served on the marketing domain, where the app lives on another host, so links into the app are absolute */
function appLinks(ctx, html) { return html.replace(/href="\/app/g, 'href="' + ctx.cfg.publicUrl + '/app'); }

function render(ctx, name) {
  const pg = PAGES[name]; if (!pg) return null;
  const shell = fs.readFileSync(path.join(ctx.cfg.publicDir, 'legal.html'), 'utf8');
  return appLinks(ctx, shell.replace('<!--TITLE-->', esc(pg.title)).replace('<!--LEGAL-->', () => pg.body(ctx.cfg.business || {})));
}

function judges(ctx) {
  const st = require('./stats').cached(ctx);
  const c = ctx.cfg.claim.contract;
  const net = st.testnet ? 'Base Sepolia (test network, test USDC)' : 'Base';
  const scan = (st.testnet ? 'https://sepolia.basescan.org/address/' : 'https://basescan.org/address/') + c;
  const usd = (Number(st.payments.totalMicro) / 1e6).toFixed(2);
  const body = '<h1>Try DOVI in 60 seconds</h1><p class="note">Network: ' + esc(net) + '. No real money moves on the test network.</p>' +
    '<h2>What it does</h2><p>Send dollars to an X handle or an email. The person claims them with one login and no wallet setup. If nobody claims, the sender takes them back. Payments wait in an on-chain escrow, so DOVI never holds your keys or your money.</p>' +
    '<h2>Try it</h2><ol><li><a href="/app">Open DOVI</a> and sign in with X or an email code. A wallet is created for you.</li><li>Add test money from the Add money sheet.</li><li>Choose Send, type a handle or an email, pick an amount and review. The review shows the exact fee before you approve.</li><li>Open the claim link as the recipient and claim in one step.</li><li>See it in Activity with a receipt and a proof page you can share.</li></ol>' +
    '<h2>What is real</h2><ul>' +
    (c ? '<li>Escrow contract on ' + esc(net) + ': <a href="' + esc(scan) + '"><code>' + esc(c) + '</code></a></li>' : '') +
    '<li>' + st.payments.sent + ' payments sent, ' + st.payments.claimed + ' claimed, ' + st.payments.returned + ' taken back, ' + usd + ' USDC in total. Source: the claims table, see <a href="/live">live numbers</a>.</li>' +
    '<li>Pay many people, locked payouts, scheduled release, payment links and statements.</li>' +
    '<li>Pay from X: after you link X and turn it on in the app, tweet <code>@DoviFinance send 2 usdc to @name</code>. The bot replies without a link and messages the recipient the claim steps, if their messages are open.</li>' +
    '<li>A send API for agents (MCP) with a hard dollar cap per payment and per day that no tool can raise.</li></ul>' +
    '<h2>What is not live yet</h2><ul><li>Base mainnet. DOVI stays on the test network until it is proven.</li><li>Private send, planned for the mainnet launch.</li></ul>';
  return appLinks(ctx, fs.readFileSync(path.join(ctx.cfg.publicDir, 'legal.html'), 'utf8').replace('<!--TITLE-->', 'Judges.').replace('<!--LEGAL-->', () => body));
}

function unsubPage(ctx, { title, body }) {
  const shell = fs.readFileSync(path.join(ctx.cfg.publicDir, 'legal.html'), 'utf8');
  return appLinks(ctx, shell.replace('<!--TITLE-->', esc(title)).replace('<!--LEGAL-->', () => body)).replace(/<meta name="theme-color"/, '<meta name="robots" content="noindex"><meta name="theme-color"');
}

function unsubConfirm(ctx, t, email) {
  return unsubPage(ctx, { title: 'Unsubscribe.', body: '<h1>Unsubscribe</h1><p>Stop DOVI emails about payments to <b>' + esc(unsub.mask(email)) + '</b>?</p><p class="hint">We will still send security alerts about an account you hold. Payments and claims keep working, you just will not get emails about them.</p><form method="post" action="/unsubscribe?t=' + encodeURIComponent(t) + '"><button class="btn mint" type="submit">Unsubscribe</button> <a class="btn ghost" href="/">Keep my emails</a></form>' });
}
const unsubDone = (ctx, email) => unsubPage(ctx, { title: 'Unsubscribed.', body: '<h1>You are unsubscribed</h1><p>DOVI will not send payment emails to <b>' + esc(unsub.mask(email)) + '</b> any more.</p><p class="hint">Changed your mind? Sign in to DOVI and turn notifications back on.</p>' });
const unsubBad = (ctx) => unsubPage(ctx, { title: 'Unsubscribe.', body: '<h1>That link is not valid</h1><p>It may be damaged or from an old email. Open a recent DOVI email and use its unsubscribe link, or use <b>Report a problem</b> in the app.</p>' });

module.exports = { judges, render, unsubConfirm, unsubDone, unsubBad, PAGES, businessBlock, esc };
