'use strict';
const { formatUsd } = require('../money');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SAFETY = 'DOVI never asks for your password, a seed phrase or a private key.';
const FOOT = 'DOVI is in beta with low limits. Balances are not insured deposits.';

function layout({ preheader, title, bodyHtml, cta, ctaHref, small }) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>' + esc(title) + '</title></head>'
    + '<body style="margin:0;padding:0;background:#f3f1e9;font-family:Inter,Arial,Helvetica,sans-serif;color:#07130f">'
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + esc(preheader) + '</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1e9"><tr><td align="center" style="padding:28px 14px">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">'
    + '<tr><td style="padding:0 4px 16px;font-size:22px;font-weight:900;letter-spacing:-.02em"><span style="display:inline-block;width:30px;height:30px;line-height:30px;text-align:center;border-radius:9px;background:#0c1c16;color:#24e47d;font-weight:900;margin-right:8px">D</span>DOVI</td></tr>'
    + '<tr><td style="background:#ffffff;border:1px solid #e0ddd2;border-radius:20px;padding:28px 24px">'
    + '<h1 style="margin:0 0 10px;font-size:24px;line-height:1.2;letter-spacing:-.02em;color:#07130f">' + esc(title) + '</h1>'
    + bodyHtml
    + (cta ? '<p style="margin:24px 0 8px"><a href="' + esc(ctaHref) + '" style="display:inline-block;background:#24e47d;color:#07130f;text-decoration:none;font-weight:800;font-size:16px;padding:14px 26px;border-radius:999px">' + esc(cta) + '</a></p>' : '')
    + (small ? '<p style="margin:14px 0 0;font-size:13px;color:#56625c">' + small + '</p>' : '')
    + '</td></tr>'
    + '<tr><td style="padding:16px 8px;font-size:12.5px;line-height:1.5;color:#56625c">' + esc(SAFETY) + ' ' + esc(FOOT) + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}

const p = (t) => '<p style="margin:0 0 12px;font-size:16px;line-height:1.55;color:#2c3a34">' + t + '</p>';
function when(expirySec, nowMs) { const left = expirySec * 1000 - nowMs; if (left <= 0) return 'soon'; if (left <= 86400000) return 'in less than a day'; const d = Math.ceil(left / 86400000); return 'in about ' + d + (d === 1 ? ' day' : ' days'); }

const APP_URL = () => (process.env.DOVI_URL || 'https://dovi.finance').replace(/\/+$/, '') + '/app';

const T = {
  loginCode({ code, minutes = 10 }) {
    const c = String(code || '').replace(/[^0-9]/g, '').slice(0, 8);
    const mono = "'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>Your DOVI sign-in code</title></head>'
      + '<body style="margin:0;padding:0;background:#f3f1e9;font-family:Inter,Arial,Helvetica,sans-serif;color:#07130f">'
      + '<div style="display:none;max-height:0;overflow:hidden;opacity:0">Your code is ' + esc(c) + '. It expires in ' + minutes + ' minutes.</div>'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1e9"><tr><td align="center" style="padding:28px 14px">'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">'
      + '<tr><td style="padding:0 4px 16px;font-size:22px;font-weight:900;letter-spacing:-.02em"><span style="display:inline-block;width:30px;height:30px;line-height:30px;text-align:center;border-radius:9px;background:#0c1c16;color:#24e47d;font-weight:900;margin-right:8px">D</span>DOVI</td></tr>'
      + '<tr><td style="background:#07130f;border-radius:26px;padding:36px 28px 30px">'
      + '<h1 style="margin:0 0 10px;font-family:Georgia,\'Times New Roman\',serif;font-weight:600;font-size:30px;line-height:1.15;letter-spacing:-.01em;color:#f3f1e9">Your sign-in code</h1>'
      + '<p style="margin:0 0 22px;font-size:16px;line-height:1.55;color:#b9c8c0">Enter this code in DOVI to sign in. It works once and expires in ' + minutes + ' minutes.</p>'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="background:#0c1c16;border:1px solid #24503a;border-radius:18px;padding:24px 8px">'
      + '<span style="display:block;font-family:' + mono + ';font-size:44px;line-height:1.1;font-weight:700;letter-spacing:12px;padding-left:12px;color:#24e47d;-webkit-user-select:all;-moz-user-select:all;user-select:all">' + esc(c) + '</span></td></tr></table>'
      + '<p style="margin:12px 0 0;text-align:center;font-size:13px;color:#8ea299">Tap and hold the code to copy it, or double tap to select it.</p>'
      + '<p style="margin:26px 0 0;text-align:center"><a href="' + esc(APP_URL()) + '" style="display:inline-block;background:#24e47d;color:#07130f;text-decoration:none;font-weight:800;font-size:16px;padding:15px 30px;border-radius:999px">Open DOVI</a></p>'
      + '</td></tr>'
      + '<tr><td style="padding:18px 8px 6px;font-size:14px;line-height:1.55;color:#2c3a34">Did not ask for this? You can ignore this email. Nobody can sign in without the code.</td></tr>'
      + '<tr><td style="padding:0 8px 18px;font-size:12.5px;line-height:1.5;color:#56625c">' + esc(SAFETY) + ' ' + esc(FOOT) + '</td></tr>'
      + '</table></td></tr></table></body></html>';
    return {
      subject: 'Your DOVI code: ' + c,
      html,
      text: 'Your DOVI sign-in code is ' + c + '.\n\nIt works once and expires in ' + minutes + ' minutes. Open DOVI: ' + APP_URL() + '\n\nDid not ask for this? You can ignore this email. ' + SAFETY + '\n',
    };
  },
  waitlistNote({ subject, name, headline, paragraphs, ctaLabel, ctaHref }) {
    const hi = name ? 'Hi ' + String(name).split(' ')[0] + ',' : 'Hi,';
    const paras = (paragraphs || []).map(String);
    return {
      subject: String(subject),
      html: layout({ preheader: paras[0] || String(headline), title: String(headline), bodyHtml: p(esc(hi)) + paras.map((t) => p(esc(t))).join(''), cta: ctaLabel, ctaHref }),
      text: hi + '\n\n' + paras.join('\n\n') + (ctaHref ? '\n\n' + (ctaLabel || 'Open DOVI') + ': ' + ctaHref : '') + '\n\n' + SAFETY + '\n',
    };
  },
  claimInvite({ fromName, amountMicro, link, expiry, now = Date.now() }) {
    const amt = formatUsd(amountMicro); const exp = when(expiry, now);
    return {
      subject: 'Someone sent you a payment on DOVI',
      html: layout({ preheader: 'Open it and claim it with one login.', title: fromName + ' sent you ' + amt, bodyHtml: p('Claim it by signing in with this email address. There is no wallet to install and no seed phrase.') + p('This payment expires ' + esc(exp) + '. After that the sender can take it back.'), cta: 'Claim ' + amt, ctaHref: link, small: 'If the button does not work, copy this link into your browser:<br>' + esc(link) }),
      text: fromName + ' sent you ' + amt + ' on DOVI.\n\nClaim it by signing in with this email address. There is no wallet to install and no seed phrase.\nIt expires ' + exp + '. After that the sender can take it back.\n\n' + link + '\n\n' + SAFETY + '\n',
    };
  },
  tokenInvite({ fromName, amountText, link, expiry, now = Date.now() }) {
    const exp = when(expiry, now);
    return {
      subject: 'Someone sent you ' + amountText + ' on DOVI',
      html: layout({ preheader: 'Open it and claim it with one login.', title: esc(fromName) + ' sent you ' + esc(amountText), bodyHtml: p('Claim it by signing in with this email address. There is no wallet to install and no seed phrase.') + p('This payment expires ' + esc(exp) + '. After that the sender can take it back.'), cta: 'Claim ' + esc(amountText), ctaHref: link, small: 'If the button does not work, copy this link into your browser:<br>' + esc(link) }),
      text: fromName + ' sent you ' + amountText + ' on DOVI.\n\nClaim it by signing in with this email address. There is no wallet to install and no seed phrase.\nIt expires ' + exp + '. After that the sender can take it back.\n\n' + link + '\n\n' + SAFETY + '\n',
    };
  },
  recoveryNotice({ title, body, cancelLink }) {
    return {
      subject: title,
      html: layout({ preheader: 'If this was not you, cancel it now.', title, bodyHtml: p(esc(body)) + p('If this was not you, cancel it. Nothing changes until the waiting time is over, and a cancel stops it.'), cta: 'Cancel this request', ctaHref: cancelLink, small: 'If the button does not work, copy this link into your browser:<br>' + esc(cancelLink) }),
      text: title + '\n\n' + body + '\n\nIf this was not you, cancel it here:\n' + cancelLink + '\n\n' + SAFETY + '\n',
    };
  },
  claimReminder({ fromName, amountMicro, link, expiry, now = Date.now() }) {
    const amt = formatUsd(amountMicro); const exp = when(expiry, now);
    return {
      subject: 'Your DOVI payment is still waiting',
      html: layout({ preheader: 'It expires ' + exp + '.', title: amt + ' is waiting for you', bodyHtml: p(esc(fromName) + ' sent you a payment and it has not been claimed yet. It expires ' + esc(exp) + '.'), cta: 'Claim ' + amt, ctaHref: link, small: 'Link: ' + esc(link) }),
      text: fromName + ' sent you ' + amt + ' and it is still waiting. It expires ' + exp + '.\n\n' + link + '\n\n' + SAFETY + '\n',
    };
  },
  claimCompleted({ toLabel, amountMicro, link }) {
    const amt = formatUsd(amountMicro);
    return {
      subject: 'Your DOVI payment was claimed',
      html: layout({ preheader: 'It arrived.', title: toLabel + ' claimed ' + amt, bodyHtml: p('Your payment arrived. Thanks for using DOVI.'), cta: 'Open DOVI', ctaHref: link, small: '' }),
      text: toLabel + ' claimed ' + amt + '. Your payment arrived.\n\n' + link + '\n\n' + SAFETY + '\n',
    };
  },
  claimReturned({ amountMicro, link }) {
    const amt = formatUsd(amountMicro);
    return {
      subject: 'Your DOVI payment was returned',
      html: layout({ preheader: 'You got everything back.', title: amt + ' is back with you', bodyHtml: p('The payment was returned to your account. You got back the full amount and no fee was charged.'), cta: 'Open DOVI', ctaHref: link, small: '' }),
      text: amt + ' was returned to your account. You got back the full amount and no fee was charged.\n\n' + link + '\n\n' + SAFETY + '\n',
    };
  },
  paymentReceived({ fromName, amountMicro, link }) {
    const amt = formatUsd(amountMicro);
    return {
      subject: 'You received a payment on DOVI',
      html: layout({ preheader: 'It is in your account.', title: 'You received ' + amt, bodyHtml: p(esc(fromName) + ' sent you money. It is in your DOVI account now.'), cta: 'Open DOVI', ctaHref: link, small: '' }),
      text: fromName + ' sent you ' + amt + '. It is in your DOVI account now.\n\n' + link + '\n\n' + SAFETY + '\n',
    };
  },
  securityAlert({ what, when: whenText, link }) {
    return {
      subject: 'Security alert for your DOVI account',
      html: layout({ preheader: 'Was this you?', title: 'Was this you?', bodyHtml: p(esc(what) + ' ' + esc(whenText || '') + '.') + p('If this was not you, report it right away and do not share any codes.'), cta: 'Review my account', ctaHref: link, small: '' }),
      text: what + ' ' + (whenText || '') + '.\nIf this was not you, report it right away and do not share any codes.\n\n' + link + '\n\n' + SAFETY + '\n',
    };
  },
};

const OPTIONAL_KINDS = new Set(['claimInvite', 'tokenInvite', 'claimReminder', 'claimCompleted', 'claimReturned', 'paymentReceived', 'waitlistNote']);
const WAITLIST_KINDS = new Set(['waitlistNote']);

function footerOf({ unsubUrl, business, reason = 'a payment on DOVI involves this address' }) {
  const b = business || {};
  const who = [b.name, b.address, b.country].filter(Boolean).join(', ');
  const html = '<tr><td style="padding:0 8px 18px;font-size:12.5px;line-height:1.55;color:#56625c">'
    + (unsubUrl ? 'You get this email because ' + esc(reason) + '. <a href="' + esc(unsubUrl) + '" style="color:#07130f;text-decoration:underline">Unsubscribe from DOVI emails</a>.<br>' : '')
    + (who ? esc(who) + (b.email ? ', ' + esc(b.email) : '') : (b.email ? esc(b.email) : ''))
    + '</td></tr>';
  const text = '\n--\n' + (unsubUrl ? 'You get this email because ' + reason + '.\nUnsubscribe: ' + unsubUrl + '\n' : '') + (who ? who + (b.email ? ', ' + b.email : '') + '\n' : '');
  return { html, text };
}

function render(kind, data, opts = {}) {
  if (!T[kind]) throw new Error('unknown_email:' + kind);
  const m = T[kind](data);
  const f = footerOf({ unsubUrl: OPTIONAL_KINDS.has(kind) ? opts.unsubUrl : null, business: opts.business, reason: WAITLIST_KINDS.has(kind) ? 'you joined the DOVI waitlist' : undefined });
  const tail = '</table></td></tr></table></body></html>';
  return { ...m, html: m.html.endsWith(tail) ? m.html.slice(0, -tail.length) + f.html + tail : m.html, text: String(m.text || '') + f.text, headers: OPTIONAL_KINDS.has(kind) && opts.unsubUrl ? { 'List-Unsubscribe': '<' + opts.unsubUrl + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined };
}

module.exports = { render, SAFETY, esc, OPTIONAL_KINDS };
