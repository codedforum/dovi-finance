'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeChainClient } = require('../server/chain-client');

const cfg = { base: { chainId: 84532, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }, claim: { contract: '0x1111111111111111111111111111111111111111' } };
const FROM = '0x00000000000000000000000000000000000a11ce'; const TO = '0x00000000000000000000000000000000000e0ec1';

function node(head, transfers) {
  const calls = [];
  return {
    calls,
    async getBlockNumber() { return head; },
    async getLogs({ fromBlock, toBlock }) {
      calls.push([fromBlock, toBlock]);
      if (toBlock - fromBlock + 1n > 200n) throw new Error('eth_getLogs is limited to a 200 range');
      return transfers.filter((t) => t.block >= fromBlock && t.block <= toBlock).map((t) => ({ args: { value: BigInt(t.value) }, transactionHash: t.hash }));
    },
  };
}

test('the transfer search never asks the node for more than 200 blocks at once and still finds an older transfer', async () => {
  const n = node(56000000n, [{ block: 55999500n, value: '67000000', hash: '0xabc' }]);
  const c = makeChainClient(cfg, n);
  assert.deepEqual(await c.findTransfer({ from: FROM, to: TO, value: 67000000n }), { txHash: '0xabc' });
  assert.ok(n.calls.length >= 3 && n.calls.every(([a, b]) => b - a + 1n <= 200n));
});

test('the search stops at the first match, ignores other amounts, and returns null past the lookback window', async () => {
  const n = node(56000000n, [{ block: 55999990n, value: '5000000', hash: '0xnear' }, { block: 55998000n, value: '67000000', hash: '0xold' }]);
  const c = makeChainClient(cfg, n);
  assert.deepEqual(await c.findTransfer({ from: FROM, to: TO, value: 5000000n }), { txHash: '0xnear' });
  assert.equal(n.calls.length, 1, 'a recent transfer needs only the newest chunk');
  assert.equal(await c.findTransfer({ from: FROM, to: TO, value: 67000000n }), null, 'older than the window is not found');
  const young = makeChainClient(cfg, node(50n, []));
  assert.equal(await young.findTransfer({ from: FROM, to: TO, value: 1n }), null);
});
