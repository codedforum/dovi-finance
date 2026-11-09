'use strict';
const { parseUsd, MoneyError } = require('../money');
const { normalizeHandle, IdError } = require('../ids');

const AMT = '\\$?\\s*([0-9][0-9.]*)\\s*(?:usd|usdc|dollars?|bucks)?';
const TARGET = '(@?[A-Za-z0-9_]{1,15}|[^\\s@]+@[^\\s@]+\\.[^\\s@]+)';

const RULES = [
  { kind: 'balance', re: /^\s*(?:how much (?:do i have|money do i have|is in my account)|(?:what(?:'s| is) )?my balance|show (?:me )?my balance|balance)\s*\??\s*$/i },
  { kind: 'history', re: /^\s*(?:show (?:me )?(?:my )?(?:history|activity|transactions)|(?:my )?(?:history|activity|transactions)|what did i (?:send|pay)|recent (?:activity|payments))\s*\??\s*$/i },
  { kind: 'send', re: new RegExp('^\\s*(?:please\\s+)?(?:send|pay)\\s+' + AMT + '\\s+to\\s+' + TARGET + '(?:\\s+(?:for|with note)\\s+(.{1,140}))?\\s*$', 'i') },
  { kind: 'send', re: new RegExp('^\\s*(?:please\\s+)?(?:send|pay)\\s+' + TARGET + '\\s+' + AMT + '(?:\\s+(?:for|with note)\\s+(.{1,140}))?\\s*$', 'i'), swap: true },
  { kind: 'request', re: new RegExp('^\\s*(?:please\\s+)?request\\s+' + AMT + '\\s+from\\s+' + TARGET + '(?:\\s+(?:for|with note)\\s+(.{1,140}))?\\s*$', 'i') },
  { kind: 'request', re: new RegExp('^\\s*(?:please\\s+)?ask\\s+' + TARGET + '\\s+for\\s+' + AMT + '(?:\\s+(?:for|with note)\\s+(.{1,140}))?\\s*$', 'i'), swap: true },
  { kind: 'claim', re: /^\s*(?:claim|open)\s+(?:my\s+)?(?:payment|money|funds)\s*$/i },
];

const REFUSALS = [
  { re: /\b(?:limit|cap|max(?:imum)?)\b.*\b(?:raise|increase|change|remove|set)\b|\b(?:raise|increase|change|remove|set)\b.*\b(?:limit|cap)\b/i, message: 'I cannot change limits. Limits are set by DOVI to keep everyone safe.' },
  { re: /\b(?:swap|trade|buy|sell|bridge|stake|launch|borrow|lend)\b/i, message: 'I cannot do that yet. Right now I can check your balance, show your history, send, and request money.' },
  { re: /0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/, message: 'I cannot send to a raw wallet address from chat. Use an X handle or an email, or use the Send screen.' },
];

const NAV = [
  { target: 'cashout', re: /\b(?:naira|ngn|cash\s?out|cashout|bank account|opay|palmpay|kuda|moniepoint)\b/i, message: 'I can open cash out for you. You pick your bank and enter your account number.' },
  { target: 'add', re: /\b(?:add money|top\s?up|deposit|faucet|get (?:more )?(?:test )?usdc|need (?:more )?(?:test )?usdc)\b/i, message: 'I can open Add money for you.' },
  { target: 'withdraw', re: /\bwithdraw(?:al)?\b/i, message: 'I can open Withdraw for you, to move USDC to a Base wallet you control.' },
  { target: 'giveaways', re: /\bgiveaways?\b/i, message: 'I can open Giveaways for you, to pick winners from your X post.' },
];

const WORDS = {
  help: ['hello', 'hi', 'hey', 'hiya', 'yo', 'sup', 'hola', 'help', 'start', 'menu', 'commands', 'options', 'howdy', 'gm'],
  balance: ['balance', 'balances', 'holdings', 'holding', 'hodl', 'hodling', 'hodlings', 'funds', 'wallet', 'usdc', 'cash', 'savings', 'money', 'dollars'],
  history: ['history', 'activity', 'transactions', 'transaction', 'payments', 'recent', 'statement'],
};
const WEAK_BALANCE = ['money', 'dollars', 'cash', 'savings', 'usdc', 'wallet', 'funds'];
const ACTION = new Set(['send', 'pay', 'request', 'transfer', 'withdraw', 'ask', 'claim', 'swap', 'buy', 'sell']);

function dist(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
const near = (tok, list) => list.some((w) => { const lim = w.length <= 4 ? 0 : w.length <= 6 ? 1 : 2; return dist(tok, w) <= lim; });

// Plain read-only questions and greetings, with small typos allowed. Never used when the message looks like a money move.
function looseIntent(raw) {
  if (/[@\d$]/.test(raw)) return null;
  const toks = raw.toLowerCase().replace(/[^a-z\s']/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean);
  if (!toks.length || toks.length > 8) return null;
  if (toks.some((t) => ACTION.has(t))) return null;
  if (/\bwhat can you do\b|\bhow (?:does|do) (?:this|you) work\b|\bwho are you\b|\bwhat is dovi\b/i.test(raw)) return 'help';
  const has = (k) => toks.some((t) => near(t, WORDS[k]));
  if (has('history')) return 'history';
  const weak = toks.some((t) => near(t, WEAK_BALANCE));
  if (weak && (toks.length <= 3 || /\bhow much\b|\bdo i have\b|\bhave i got\b/i.test(raw))) return 'balance';
  if (toks.some((t) => near(t, WORDS.balance.filter((w) => !WEAK_BALANCE.includes(w))))) return 'balance';
  if (has('help')) return 'help';
  return null;
}

function parse(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { error: 'empty', message: 'Type what you would like to do, for example "send 5 to @amara".' };
  if (raw.length > 280) return { error: 'too_long', message: 'That is too long. Try something short like "send 5 to @amara".' };
  if (!/[@\d$]/.test(raw)) for (const nv of NAV) if (nv.re.test(raw)) return { kind: 'navigate', target: nv.target, message: nv.message };
  for (const rf of REFUSALS) if (rf.re.test(raw)) return { error: 'refused', message: rf.message };
  for (const rule of RULES) {
    const m = rule.re.exec(raw);
    if (!m) continue;
    if (['balance', 'history', 'claim', 'help'].includes(rule.kind)) return { kind: rule.kind };
    const amountText = rule.swap ? m[2] : m[1];
    const targetText = rule.swap ? m[1] : m[2];
    const note = m[3] ? m[3].trim() : null;
    let amountMicro;
    try { amountMicro = parseUsd(amountText); } catch (e) { if (e instanceof MoneyError) return { error: e.code, message: e.message }; throw e; }
    let to;
    try { const h = normalizeHandle(targetText); to = { kind: h.kind, handle: h.handle, label: h.kind === 'x' ? '@' + h.handle : h.handle }; } catch (e) { if (e instanceof IdError) return { error: e.code, message: e.message }; throw e; }
    return { kind: rule.kind, amountMicro, to, note };
  }
  const loose = looseIntent(raw);
  if (loose) return { kind: loose };
  return { error: 'unknown', message: 'I did not understand that. I can check your balance, show your history, send money, or request money. Try "how much do I have", "show my history" or "send 5 to @amara".' };
}

module.exports = { parse };
