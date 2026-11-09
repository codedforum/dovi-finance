'use strict';
// Runs the labelled tweets in test/fixtures/xintent-cases.json through the real intent model and scores them.
// Safe outcomes: an unclear or none answer where a payment was expected. Unsafe outcomes: a payment where none or unclear was expected, or the wrong person or amount.
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.DOVI_ROOT || path.resolve(__dirname, '..');
if (process.env.DOVI_ENV_FILE) require(require.resolve('dotenv', { paths: [root] })).config({ path: process.env.DOVI_ENV_FILE, quiet: true });
const { makeIntentLLM, validate, SYSTEM } = require(path.join(root, 'server', 'xintent'));
const cases = JSON.parse(fs.readFileSync(process.env.CASES || path.join(root, 'test', 'fixtures', 'xintent-cases.json'), 'utf8'));
const system = process.env.SYSTEM_FILE ? fs.readFileSync(process.env.SYSTEM_FILE, 'utf8') : SYSTEM;
(async () => {
  const env = { ...process.env, DOVI_INTENT_LLM: '1' };
  if (process.env.ONLY_MODEL) { env.RELAYSTATION_MODEL = process.env.ONLY_MODEL; env.RELAYSTATION_MODEL_FALLBACK = ''; }
  const llm = makeIntentLLM(env, fetch, { system });
  if (!llm) { console.log('model not configured'); process.exit(1); }
  const res = []; let idx = 0;
  async function worker() {
    while (idx < cases.length) {
      const i = idx++; const c = cases[i];
      await new Promise((r) => setTimeout(r, Number(process.env.DELAY_MS || 1200)));
      try { const r = await llm.classify({ text: c.text, authorId: 'eval' + i, replyTo: c.replyTo || null }); res[i] = r; }
      catch (e) { res[i] = { error: e.message }; }
    }
  }
  await worker();
  let ok = 0, safeMiss = 0, unsafe = 0, errors = 0; const bad = [];
  cases.forEach((c, i) => {
    const r = res[i];
    if (r.error) { errors++; bad.push(['ERROR', c.text, r.error]); return; }
    if (c.expect === 'pay') {
      if (r.intent === 'pay' && String(r.to).toLowerCase() === c.to.toLowerCase() && Number(r.amountUsd) === Number(c.amount)) ok++;
      else if (r.intent === 'pay') { unsafe++; bad.push(['WRONG PAY', c.text, JSON.stringify(r)]); }
      else { safeMiss++; bad.push(['missed (safe)', c.text, r.intent]); }
    } else {
      const allowed = c.ok || [c.expect];
      if (allowed.includes(r.intent)) ok++;
      else if (r.intent === 'pay') { unsafe++; bad.push(['UNSAFE PAY', c.text, JSON.stringify(r)]); }
      else { safeMiss++; bad.push(['other', c.text, r.intent]); }
    }
  });
  console.log('cases', cases.length, '| correct', ok, '| safe misses', safeMiss, '| UNSAFE', unsafe, '| errors', errors);
  bad.forEach((b) => console.log(' ', b[0].padEnd(14), JSON.stringify(b[1]).slice(0, 100), '=>', b[2]));
})();
