'use strict';

const TYPES = { Attest: [{ name: 'id', type: 'bytes32' }, { name: 'recipient', type: 'address' }, { name: 'deadline', type: 'uint64' }] };

function domainFor(cfg) {
  return { name: 'DoviClaim', version: '1', chainId: cfg.base.chainId, verifyingContract: cfg.claim.contract };
}

function makeLocalAttester(cfg, env = process.env) {
  const { privateKeyToAccount } = require('viem/accounts');
  const key = env[cfg.attester.keyEnv];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('attester_key_missing: set ' + cfg.attester.keyEnv + ' (local mode is for tests and staging only)');
  const account = privateKeyToAccount(key);
  return {
    mode: 'local',
    address: account.address,
    async sign({ claimId, recipient, deadline }) {
      return account.signTypedData({ domain: domainFor(cfg), types: TYPES, primaryType: 'Attest', message: { id: claimId, recipient, deadline: BigInt(deadline) } });
    },
  };
}

function makeCdpAttester(cfg, env = process.env) {
  const { CdpClient } = require('@coinbase/cdp-sdk');
  const name = env.DOVI_ATTESTER_ACCOUNT || 'dovi-attester';
  let acct = null;
  async function account() {
    if (!acct) acct = await new CdpClient().evm.getOrCreateAccount({ name });
    return acct;
  }
  return {
    mode: 'cdp',
    async address() { return (await account()).address; },
    async sign({ claimId, recipient, deadline }) {
      const a = await account();
      return a.signTypedData({ domain: domainFor(cfg), types: { ...TYPES, EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] }, primaryType: 'Attest', message: { id: claimId, recipient, deadline: BigInt(deadline) } });
    },
  };
}

function makeAttester(cfg, env = process.env) {
  return cfg.attester.mode === 'cdp' ? makeCdpAttester(cfg, env) : makeLocalAttester(cfg, env);
}

module.exports = { makeAttester, makeLocalAttester, makeCdpAttester, domainFor, TYPES };
