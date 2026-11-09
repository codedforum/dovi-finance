'use strict';
/* Nigerian banks and wallets by the code the payout partner uses. banks.ng.json holds the partner's full list.
   Display names and search words are added here so people can find a bank by the name they know it by. */
const raw = require('./banks.ng.json');

const DISPLAY = { '305': 'OPay', '100033': 'PalmPay', '916': 'Paga', '058': 'GTBank', '044': 'Access Bank', '033': 'UBA', '057': 'Zenith Bank', '011': 'First Bank', '214': 'FCMB', '221': 'Stanbic IBTC', '50211': 'Kuda', '301': 'Jaiz Bank', '023': 'Citibank' };
const WORDS = { '305': 'paycom opay', '058': 'gtb guaranty trust gtbank', '033': 'united bank for africa', '011': 'firstbank first bank of nigeria', '214': 'first city monument', '50211': 'kuda microfinance', '100033': 'palm pay', '044': 'access diamond' };
const POPULAR = ['058', '044', '033', '057', '011', '305', '100033', '50211', '070', '214', '232', '035', '076', '221', '032', '050', '082', '101'];

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const all = raw.map((b) => ({ code: String(b.code), name: DISPLAY[b.code] || clean(b.name), words: (clean(b.name) + ' ' + (WORDS[b.code] || '')).toLowerCase().trim() }));
const rank = (c) => { const i = POPULAR.indexOf(c); return i < 0 ? 1000 : i; };
const BANKS = all.sort((a, b) => rank(a.code) - rank(b.code) || a.name.localeCompare(b.name));
const byCode = new Map(BANKS.map((b) => [b.code, b]));

const bankName = (code) => { const b = byCode.get(String(code)); return b ? b.name : null; };

module.exports = { BANKS, bankName };
