'use strict';
const crypto = require('node:crypto');
const { keccak256, toBytes, isAddress, getAddress } = require('viem');

class IdError extends Error {
  constructor(code, message) { super(message || code); this.name = 'IdError'; this.code = code; }
}

function normalizeProviderId(kind, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (kind === 'email') {
    const e = s.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw new IdError('bad_email', 'That does not look like an email address.');
    return e;
  }
  if (kind === 'x') {
    if (!/^\d{1,20}$/.test(s)) throw new IdError('bad_x_id', 'That is not a valid X account id.');
    return s;
  }
  if (kind === 'google') {
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(s)) throw new IdError('bad_google_id');
    return s;
  }
  if (kind === 'telegram') {
    if (!/^\d{1,20}$/.test(s)) throw new IdError('bad_telegram_id');
    return s;
  }
  throw new IdError('bad_kind', 'Unknown identity kind.');
}

function recipientHash(kind, providerId) {
  const canon = normalizeProviderId(kind, providerId);
  return keccak256(toBytes('dovi:v1:' + kind + ':' + canon));
}

function newClaimId() { return '0x' + crypto.randomBytes(32).toString('hex'); }

function parseAddress(a) {
  if (typeof a !== 'string' || !isAddress(a, { strict: false })) throw new IdError('bad_address', 'That is not a valid wallet address.');
  return getAddress(a.toLowerCase());
}

function normalizeHandle(text) {
  const s = String(text == null ? '' : text).trim();
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(s)) return { kind: 'x', handle: s.replace(/^@/, '') };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { kind: 'email', handle: s.toLowerCase() };
  throw new IdError('bad_handle', 'Enter an X handle like @amara or an email address.');
}

module.exports = { IdError, normalizeProviderId, recipientHash, newClaimId, parseAddress, normalizeHandle };
