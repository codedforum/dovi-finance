'use strict';
const abi = require('./abi/DoviClaim.json');
const abi4 = require('./abi/DoviClaimV4.json');

const POOL_ABI = [
  { type: 'function', name: 'reserveA', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'reserveB', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'quote', stateMutability: 'view', inputs: [{ name: 'tokenIn', type: 'address' }, { name: 'amountIn', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'swap', stateMutability: 'nonpayable', inputs: [{ name: 'tokenIn', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'minOut', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

function makeChainClient(cfg, client = null) {
  const { createPublicClient, http, parseAbiItem } = require('viem');
  const { base, baseSepolia } = require('viem/chains');
  const pc = client || createPublicClient({ chain: cfg.base.chainId === 84532 ? baseSepolia : base, transport: http(cfg.base.rpc) });
  const address = cfg.claim.contract;
  return {
    async readClaim(id) {
      const r = await pc.readContract({ address, abi, functionName: 'claims', args: [id] });
      return { sender: r[0], amount: BigInt(r[1]), fee: BigInt(r[2]), expiry: Number(r[3]), status: Number(r[4]), recipientHash: r[5] };
    },
    async readConfig() {
      const rd = (functionName) => pc.readContract({ address, abi, functionName });
      const [feeBps, minFee, minAmount, perClaimCap] = await Promise.all([rd('feeBps'), rd('minFee'), rd('minAmount'), rd('perClaimCap')]);
      return { feeBps: BigInt(feeBps), minFee: BigInt(minFee), minAmount: BigInt(minAmount), perClaimCap: BigInt(perClaimCap) };
    },
    async readTokenClaim(id) {
      const r = await pc.readContract({ address, abi: abi4, functionName: 'tokenClaims', args: [id] });
      return { sender: r[0], token: r[1], amount: BigInt(r[2]), expiry: Number(r[3]), status: Number(r[4]), recipientHash: r[5] };
    },
    async readTokenConfig(token) {
      const r = await pc.readContract({ address, abi: abi4, functionName: 'tokens', args: [token] });
      return { enabled: !!r[0], minAmount: BigInt(r[1]), perClaimCap: BigInt(r[2]), globalCap: BigInt(r[3]), locked: BigInt(r[4]) };
    },
    async tokenBalance(token, owner) { return BigInt(await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] })); },
    async poolReserves(pool) {
      const [a, b] = await Promise.all(['reserveA', 'reserveB'].map((functionName) => pc.readContract({ address: pool, abi: POOL_ABI, functionName })));
      return { a: BigInt(a), b: BigInt(b) };
    },
    async poolFindSwap({ pool, trader, tokenIn, amountIn, lookback = 1200n, step = 190n }) {
      const head = await pc.getBlockNumber();
      const floor = head > lookback ? head - lookback : 0n;
      const event = parseAbiItem('event Swap(address indexed trader,address indexed tokenIn,uint256 amountIn,uint256 amountOut)');
      let hi = head;
      while (hi >= floor) {
        const lo = hi - step + 1n > floor ? hi - step + 1n : floor;
        const logs = await pc.getLogs({ address: pool, event, args: { trader, tokenIn }, fromBlock: lo, toBlock: hi });
        const hit = logs.filter((l) => l.args.amountIn === BigInt(amountIn)).pop();
        if (hit) return { txHash: hit.transactionHash, amountOut: BigInt(hit.args.amountOut) };
        if (lo <= floor) break;
        hi = lo - 1n;
      }
      return null;
    },
    async poolQuote(pool, tokenIn, amountIn) { return BigInt(await pc.readContract({ address: pool, abi: POOL_ABI, functionName: 'quote', args: [tokenIn, amountIn] })); },
    async readLock(id) { try { return Number(await pc.readContract({ address, abi, functionName: 'reclaimAfter', args: [id] })); } catch { return 0; } },
    async usdcBalance(owner) { return pc.readContract({ address: cfg.base.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }); },
    async readAutoPay(payer) { const r = await pc.readContract({ address, abi, functionName: 'autoPay', args: [payer] }); return { perPayment: BigInt(r[0]), perDay: BigInt(r[1]) }; },
    async readAllowance(owner) { return BigInt(await pc.readContract({ address: cfg.base.usdc, abi: ERC20_ABI, functionName: 'allowance', args: [owner, address] })); },
    async blockNumber() { return pc.getBlockNumber(); },
    async getEvents(fromBlock, toBlock) {
      const logs = await pc.getLogs({ address, fromBlock, toBlock, events: [
        parseAbiItem('event ClaimCreated(bytes32 indexed id,address indexed sender,bytes32 recipientHash,uint96 amount,uint96 fee,uint64 expiry)'),
        parseAbiItem('event ClaimClaimed(bytes32 indexed id,address indexed recipient,uint96 amount,uint96 fee)'),
        parseAbiItem('event ClaimReclaimed(bytes32 indexed id,address indexed sender,uint96 returned)'),
      ] });
      return logs.map((l) => ({ name: l.eventName, args: l.args, txHash: l.transactionHash, logIndex: l.logIndex, blockNumber: Number(l.blockNumber) }));
    },
    async getTransfer(txHash) {
      const { parseAbiItem, decodeEventLog } = require('viem');
      const r = await pc.getTransactionReceipt({ hash: txHash }).catch(() => null);
      if (!r) return null;
      const item = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
      const transfers = [];
      for (const l of r.logs) {
        try { const d = decodeEventLog({ abi: [item], data: l.data, topics: l.topics }); transfers.push({ token: l.address, from: d.args.from, to: d.args.to, value: d.args.value.toString() }); } catch { /* not a Transfer */ }
      }
      return { status: r.status, transfers };
    },
    /* the public nodes refuse log queries over about 200 blocks, so the search walks back in chunks, newest first */
    async findTransfer({ from, to, value, lookback = 1200n, step = 190n }) {
      const head = await pc.getBlockNumber();
      const floor = head > lookback ? head - lookback : 0n;
      const event = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
      let hi = head;
      while (hi >= floor) {
        const lo = hi - step + 1n > floor ? hi - step + 1n : floor;
        const logs = await pc.getLogs({ address: cfg.base.usdc, event, args: { from, to }, fromBlock: lo, toBlock: hi });
        const hit = logs.filter((l) => l.args.value === BigInt(value)).pop();
        if (hit) return { txHash: hit.transactionHash };
        if (lo <= floor) break;
        hi = lo - 1n;
      }
      return null;
    },
    async blockTime(n) { const b = await pc.getBlock({ blockNumber: BigInt(n) }); return Number(b.timestamp); },
  };
}

function makeReader(cfg) {
  const { createPublicClient, http } = require('viem');
  const { base, baseSepolia } = require('viem/chains');
  const pc = createPublicClient({ chain: cfg.base.chainId === 84532 ? baseSepolia : base, transport: http(cfg.base.rpc) });
  return { async usdcBalance(owner) { return pc.readContract({ address: cfg.base.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }); } };
}

module.exports = { POOL_ABI, makeReader, makeChainClient, ERC20_ABI, abi };
