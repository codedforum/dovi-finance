'use strict';
const path = require('node:path');

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function int(env, name, def) {
  const v = env[name];
  if (v === undefined || v === '') return BigInt(def);
  if (!/^\d+$/.test(String(v))) throw new Error('config_bad_int:' + name);
  return BigInt(v);
}

/* Extra tokens the claim contract can escrow. Only switched on for the test network. Amounts are in the token's own units. */
function extraTokens(env, testnet) {
  const out = [];
  const addr = String(env.DOVI_TOKEN_VIBES || '').trim();
  if (testnet && /^0x[0-9a-fA-F]{40}$/.test(addr)) {
    const dec = Number(env.DOVI_TOKEN_VIBES_DECIMALS || 18);
    const unit = 10n ** BigInt(dec);
    out.push({ symbol: 'VIBES', name: 'Vibes', address: addr, decimals: dec, minUnits: BigInt(env.DOVI_TOKEN_VIBES_MIN || 1) * unit, perClaimUnits: BigInt(env.DOVI_TOKEN_VIBES_CAP || 1000) * unit, test: true, faucet: env.DOVI_TOKEN_VIBES_FAUCET === '1' });
  }
  return out;
}

function loadConfig(env = process.env) {
  const root = path.join(__dirname, '..');
  const cfg = {
    root,
    port: Number(env.PORT || 3225),
    host: env.HOST || '127.0.0.1',
    publicUrl: (env.DOVI_URL || 'http://localhost:3225').replace(/\/+$/, ''),
    doviEnv: env.DOVI_ENV || 'preview',
    dbPath: env.DOVI_DB_PATH || path.join(root, 'data', 'dovi.db'),
    publicDir: path.join(root, 'public'),
    network: env.DOVI_NETWORK === 'sepolia' ? 'sepolia' : 'mainnet',
    base: env.DOVI_NETWORK === 'sepolia' ? {
      chainId: 84532,
      rpc: env.BASE_RPC_URL || 'https://sepolia.base.org',
      usdc: env.BASE_USDC || '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      cdpNetwork: 'base-sepolia',
      testnet: true,
    } : {
      chainId: 8453,
      rpc: env.BASE_RPC_URL || 'https://mainnet.base.org',
      usdc: env.BASE_USDC || BASE_USDC,
      cdpNetwork: 'base',
      testnet: false,
    },
    claim: {
      contract: env.DOVI_CLAIM_CONTRACT || '',
      feeBps: int(env, 'DOVI_FEE_BPS', 100),
      feeMinMicro: int(env, 'DOVI_FEE_MIN_MICRO', 100000),
      maxFeeBps: 150n,
      lockEnabled: env.DOVI_CLAIM_V3 === '1',
      minAmountMicro: int(env, 'DOVI_MIN_AMOUNT_MICRO', 1000000),
      perClaimCapMicro: int(env, 'DOVI_CAP_PER_CLAIM_MICRO', 10000000),
      perUserDayCapMicro: int(env, 'DOVI_CAP_PER_USER_DAY_MICRO', 50000000),
      globalCapMicro: int(env, 'DOVI_CAP_GLOBAL_MICRO', 500000000),
      expirySeconds: Number(int(env, 'DOVI_CLAIM_EXPIRY_SECONDS', 604800)),
    },
    recovery: { enabled: env.DOVI_RECOVERY === '1', delayMs: Number(env.DOVI_RECOVERY_DELAY_MS || (Math.max(1, Number(env.DOVI_RECOVERY_DELAY_HOURS || 72)) * 3600000)) },
    tokens: extraTokens(env, env.DOVI_NETWORK === 'sepolia'),
    pool: env.DOVI_NETWORK === 'sepolia' && /^0x[0-9a-fA-F]{40}$/.test(String(env.DOVI_POOL || '').trim()) ? { address: String(env.DOVI_POOL).trim() } : null,
    attester: { mode: env.DOVI_ATTESTER_MODE || 'local', keyEnv: 'DOVI_ATTESTER_KEY' },
    admins: String(env.DOVI_ADMINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    payBaseUrl: (env.DOVI_PAY_URL || env.DOVI_URL || 'http://localhost:3225').replace(/\/+$/, ''),
    ogImage: env.DOVI_OG_IMAGE || '',
    giveaway: env.DOVI_GIVEAWAY === '1',
    inviteOnly: env.DOVI_INVITE_ONLY === '1',
    business: { name: (env.DOVI_LEGAL_NAME || '').trim(), address: (env.DOVI_LEGAL_ADDRESS || '').trim(), email: (env.DOVI_CONTACT_EMAIL || '').trim(), country: (env.DOVI_LEGAL_COUNTRY || '').trim() },
    askDailyFree: Math.max(1, Number(env.DOVI_ASK_DAILY || 100)),
    x: { clientId: env.X_CLIENT_ID || '', clientSecret: env.X_CLIENT_SECRET || '', redirectUri: env.X_REDIRECT_URI || '' },
  };
  if (cfg.claim.feeBps > cfg.claim.maxFeeBps) throw new Error('config_fee_above_max');
  if (cfg.claim.perClaimCapMicro < cfg.claim.minAmountMicro) throw new Error('config_cap_below_min');
  return cfg;
}

module.exports = { loadConfig, BASE_USDC };
