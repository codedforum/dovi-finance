'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SKIP = /^\/(js|fonts|brand)\/|^\/(dovi\.css|mark\.svg|manifest\.json|robots\.txt|favicon)/;
const CODE = /^[2-9a-hj-km-np-zA-HJ-NP-Z]{8,12}$/;

function redact(pathname) {
  const parts = String(pathname).split('/');
  return parts.map((seg, i) => {
    if (/^0x[0-9a-fA-F]{64}$/.test(seg)) return ':hash';
    if (/^0x[0-9a-fA-F]{40}$/.test(seg)) return ':address';
    if (i === 2 && /^\/(c|p|r)\//.test(pathname) && CODE.test(seg)) return ':code';
    if (/^\/api\/(paylinks|receipt)\//.test(pathname) && CODE.test(seg)) return ':code';
    return seg;
  }).join('/').slice(0, 200);
}

function makeReqLog(env = process.env) {
  if (env.DOVI_REQUEST_LOG !== '1') return null;
  const dir = env.DOVI_LOG_DIR || path.join(process.cwd(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const stream = fs.createWriteStream(path.join(dir, 'requests.jsonl'), { flags: 'a', mode: 0o600 });
  stream.on('error', () => { /* logging never breaks a request */ });
  return (e) => { if (!SKIP.test(e.p)) stream.write(JSON.stringify(e) + '\n'); };
}

module.exports = { makeReqLog, redact };
