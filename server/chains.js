'use strict';
const rowsDefault = require('./chains.json');

class ChainNotLive extends Error {
  constructor(id) { super('chain_not_live:' + id); this.name = 'ChainNotLive'; this.code = 'chain_not_live'; this.chain = id; }
}

function isHonest(row, allowTestnet = false) {
  if (row.status !== 'live') return true;
  if (row.verified !== true) return false;
  return row.network === 'mainnet' || (allowTestnet && row.id === 'base' && row.network === 'testnet');
}

function makeRegistry(initial, hooks = {}) {
  const allowTestnet = !!hooks.allowTestnet;
  const rows = initial.map((r) => ({ ...r }));
  const find = (id) => rows.find((r) => r.id === id);
  const api = {
    listChains: () => rows.map((r) => ({ ...r })),
    getChain: (id) => { const r = find(id); return r ? { ...r } : null; },
    isLive: (id) => { const r = find(id); return !!r && r.status === 'live'; },
    assertLive(id) { if (!api.isLive(id)) throw new ChainNotLive(id); },
    assertRegistryHonest() {
      for (const r of rows) {
        if (!isHonest(r, allowTestnet)) throw new Error('registry_dishonest:' + r.id + ' is live but ' + r.network + (r.verified ? '' : ' and unverified'));
      }
    },
    setStatus(id, status, actor) {
      const r = find(id);
      if (!r) throw new Error('unknown_chain:' + id);
      if (!['live', 'soon', 'off'].includes(status)) throw new Error('bad_status:' + status);
      if (status === 'live' && !isHonest({ ...r, status }, allowTestnet)) throw new Error('refused:' + id + ' is ' + r.network + (r.verified ? '' : ', not verified') + ' and cannot be live');
      const before = r.status;
      r.status = status;
      if (hooks.onChange) hooks.onChange({ id, before, after: status, actor: actor || 'unknown' });
    },
    publicView() {
      return rows.map((r) => ({
        id: r.id, name: r.name, status: r.status, claims: !!r.claims,
        asset: { symbol: r.asset.symbol, decimals: r.asset.decimals },
        explorerTx: r.explorerTx || '',
      }));
    },
    statusLine() {
      const live = rows.filter((r) => r.status === 'live').map((r) => r.name);
      const soon = rows.filter((r) => r.status === 'soon').map((r) => r.name);
      if (!live.length) return 'DOVI is not live on any chain yet.';
      return 'Live on ' + live.join(' and ') + '.' + (soon.length ? ' ' + soon.join(', ') + ' coming soon.' : '');
    },
  };
  api.assertRegistryHonest();
  return api;
}

function applyNetwork(rows, cfg) {
  if (cfg.network !== 'sepolia') return rows;
  return rows.map((r) => (r.id !== 'base' ? r : { ...r, name: 'Base Sepolia', chainId: 84532, network: 'testnet', verified: true, cdpNetwork: 'base-sepolia', asset: { symbol: 'USDC', decimals: 6, address: cfg.base.usdc }, explorerTx: 'https://sepolia.basescan.org/tx/' }));
}

const def = makeRegistry(rowsDefault);
module.exports = { makeRegistry, applyNetwork, ChainNotLive, ...def };
