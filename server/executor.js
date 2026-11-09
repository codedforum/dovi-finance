'use strict';
const { encodeFunctionData } = require('viem');
const abi = require('./abi/DoviClaim.json');
const { createPublicClient, http } = require('viem');

function makeCdpExecutor(cfg, env = process.env) {
  const { CdpClient } = require('@coinbase/cdp-sdk');
  const name = env.DOVI_EXECUTOR_ACCOUNT || 'dovi-executor';
  const cdp = new CdpClient();
  let acct = null;
  const account = async () => { if (!acct) acct = await cdp.evm.getOrCreateAccount({ name }); return acct; };
  const pc = createPublicClient({ transport: http(cfg.base.rpc) });
  return {
    mode: 'cdp',
    async address() { return (await account()).address; },
    async createClaimFor({ payer, id, recipientHash, amountMicro, expiry }) {
      const a = await account();
      const data = encodeFunctionData({ abi, functionName: 'createClaimFor', args: [payer, id, recipientHash, BigInt(amountMicro), BigInt(expiry)] });
      const r = await cdp.evm.sendTransaction({ address: a.address, network: cfg.base.cdpNetwork, transaction: { to: cfg.claim.contract, data, value: 0n } });
      const rc = await pc.waitForTransactionReceipt({ hash: r.transactionHash, timeout: 90000 });
      if (rc.status !== 'success') throw new Error('createClaimFor reverted: ' + r.transactionHash);
      return { txHash: r.transactionHash };
    },
    /* plain USDC transfer from the executor wallet, used for the test network starter amount */
    async sendUsdc({ to, amountMicro }) {
      const a = await account();
      const data = encodeFunctionData({ abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] }], functionName: 'transfer', args: [to, BigInt(amountMicro)] });
      const r = await cdp.evm.sendTransaction({ address: a.address, network: cfg.base.cdpNetwork, transaction: { to: cfg.base.usdc, data, value: 0n } });
      let rc;
      try { rc = await pc.waitForTransactionReceipt({ hash: r.transactionHash, timeout: 90000 }); }
      catch (e) { const err = new Error('usdc transfer not confirmed: ' + r.transactionHash); err.broadcast = true; throw err; }
      if (rc.status !== 'success') throw new Error('usdc transfer reverted: ' + r.transactionHash);
      return { txHash: r.transactionHash };
    },
    /* submits a claim that already carries the server attestation, so the funds go to the recipient wallet without a click */
    async claimFor({ id, recipient, deadline, attestation }) {
      const a = await account();
      const data = encodeFunctionData({ abi, functionName: 'claim', args: [id, recipient, BigInt(deadline), attestation] });
      const r = await cdp.evm.sendTransaction({ address: a.address, network: cfg.base.cdpNetwork, transaction: { to: cfg.claim.contract, data, value: 0n } });
      const rc = await pc.waitForTransactionReceipt({ hash: r.transactionHash, timeout: 90000 });
      if (rc.status !== 'success') throw new Error('claim reverted: ' + r.transactionHash);
      return { txHash: r.transactionHash };
    },
  };
}

module.exports = { makeCdpExecutor };
