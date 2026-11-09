"use strict";
// DOVI on-ramp: buy USDC with card or bank, delivered to the user's address.
// Coinbase Onramp (global card / Apple Pay, session-token secured) and Transak
// (Nigeria: pay in NGN with a Nigerian bank or card). Providers appear only when
// their credentials are configured.
const { generateJwt } = require("@coinbase/cdp-sdk/auth");
const https = require("https");

const CB_HOST = "api.developer.coinbase.com";
const CB_TOKEN_PATH = "/onramp/v1/token";
const CB_NET = { base: "base", solana: "solana", ethereum: "ethereum" };

function post(host, path, token, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = https.request({ hostname: host, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: "Bearer " + token } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { resolve({ status: r.statusCode, json: JSON.parse(d || "{}") }); } catch (e) { resolve({ status: r.statusCode, json: {}, raw: d.slice(0, 300) }); } });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

async function coinbaseUrl({ address, chain, amount }) {
  const apiKeyId = process.env.CDP_API_KEY_ID, apiKeySecret = process.env.CDP_API_KEY_SECRET;
  if (!apiKeyId || !apiKeySecret) throw new Error("coinbase onramp not configured");
  if (!address) throw new Error("no address");
  const net = CB_NET[chain] || "base";
  const jwt = await generateJwt({ apiKeyId, apiKeySecret, requestMethod: "POST", requestHost: CB_HOST, requestPath: CB_TOKEN_PATH, expiresIn: 120 });
  const r = await post(CB_HOST, CB_TOKEN_PATH, jwt, { addresses: [{ address, blockchains: [net] }], assets: ["USDC"] });
  const sess = r.json && (r.json.token || (r.json.data && r.json.data.token));
  if (!sess) { const e = new Error("coinbase token mint failed"); e.detail = { status: r.status, body: r.json || r.raw }; throw e; }
  return { url: "https://pay.coinbase.com/buy/select-asset?sessionToken=" + encodeURIComponent(sess) + "&defaultAsset=USDC&defaultNetwork=" + net + "&defaultPaymentMethod=CARD" + (amount && /^\d{1,6}(\.\d{1,2})?$/.test(String(amount)) ? "&presetFiatAmount=" + encodeURIComponent(String(amount)) + "&fiatCurrency=USD" : ""), provider: "Coinbase" };
}

function transakUrl({ address, chain, fiat }) {
  const key = process.env.TRANSAK_API_KEY;
  if (!key) throw new Error("transak not configured");
  if (!address) throw new Error("no address");
  const env = (process.env.TRANSAK_ENV || "production").toLowerCase();
  const host = env === "staging" ? "https://global-stg.transak.com" : "https://global.transak.com";
  const net = chain === "solana" ? "solana" : "base";
  const p = new URLSearchParams({
    apiKey: key,
    walletAddress: address,
    cryptoCurrencyCode: "USDC",
    network: net,
    fiatCurrency: fiat || process.env.TRANSAK_FIAT || "NGN",
    productsAvailed: "BUY",
    disableWalletAddressForm: "true",
    themeColor: "24E47D",
  });
  return { url: host + "/?" + p.toString(), provider: "Transak" };
}

function providers() {
  const out = [];
  if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) out.push({ id: "coinbase", title: "Card or Apple Pay", sub: "Visa, Mastercard, Apple Pay", icon: "💳" });
  if (process.env.TRANSAK_API_KEY) out.push({ id: "transak", title: "Naira: card or bank", sub: "Pay in NGN with a Nigerian bank or card", icon: "🇳🇬" });
  return out;
}

async function onrampUrl({ provider, address, chain, fiat, amount }) {
  if (provider === "transak") return transakUrl({ address, chain, fiat });
  return coinbaseUrl({ address, chain, amount });
}

module.exports = { onrampUrl, providers };
