'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { originOk } = require('../server/http');
const req = (o) => ({ headers: o ? { origin: o } : {} });

test('origin must match the public URL', () => {
  assert.ok(originOk(req('https://dovi.example'), 'https://dovi.example'));
  assert.ok(!originOk(req('https://evil.example'), 'https://dovi.example'));
  assert.ok(!originOk(req(), 'https://dovi.example'));
});
test('loopback spellings match only when the public URL is loopback', () => {
  assert.ok(originOk(req('http://127.0.0.1:3226'), 'http://localhost:3226'));
  assert.ok(!originOk(req('http://127.0.0.1:9999'), 'http://localhost:3226'));
  assert.ok(!originOk(req('http://localhost:3226'), 'https://dovi.example'));
  assert.ok(!originOk(req('http://127.0.0.1:3226'), 'https://dovi.example'));
});
