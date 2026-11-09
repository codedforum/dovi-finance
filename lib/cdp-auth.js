"use strict";
// DOVI identity -> CDP end-user wallet via CDP Custom Authentication. DOVI mints
// a short RS256 JWT for a DOVI identity; CDP verifies it against the public key
// at <DOVI_URL>/.well-known/jwks.json and returns that identity's wallet.
// 🚨 ISS + the JWKS URL + sub are PERMANENT once registered in the CDP portal.
// Changing any of them mints NEW wallets and orphans funds. The private key is
// an identity-signing key only, never a wallet key, 0600, never logged.
const crypto = require("crypto");
const fs = require("fs");
const jwt = require("jsonwebtoken");

const PUBLIC_URL = (process.env.DOVI_URL || "").replace(/\/+$/, "");
const KEY_PATH = (process.env.DOVI_CDP_JWT_KEY_PATH || "data/cdp-jwt.key").trim();
const ISS = (process.env.DOVI_CDP_JWT_ISS || "").trim() || PUBLIC_URL;
const AUD = (process.env.DOVI_CDP_JWT_AUD || "").trim() || (process.env.CDP_PROJECT_ID || "").trim();
const KID = (process.env.DOVI_CDP_JWT_KID || "dovi-1").trim();
const TTL = process.env.DOVI_CDP_JWT_TTL || "10m";
const PROD = ["production", "staging"].includes(process.env.DOVI_ENV);
if (PROD && !(process.env.DOVI_CDP_JWT_ISS || "").trim()) throw new Error("DOVI_CDP_JWT_ISS must be set in production");
let _priv = null, _jwk = null, _pubPem = null;

function loadKey() {
  if (_priv) return _priv;
  if (!fs.existsSync(KEY_PATH)) {
    if (PROD) throw new Error("signing key missing at " + KEY_PATH);
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    fs.writeFileSync(KEY_PATH, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    console.log("[dovi-cdp-auth] generated signing key at " + KEY_PATH);
  }
  _priv = fs.readFileSync(KEY_PATH, "utf8");
  const pub = crypto.createPublicKey(_priv);
  _jwk = Object.assign({}, pub.export({ format: "jwk" }), { kid: KID, use: "sig", alg: "RS256" });
  _pubPem = pub.export({ type: "spki", format: "pem" });
  return _priv;
}
function jwks() { loadKey(); return { keys: [_jwk] }; }
function subjectFor(id) { return "dovi:" + String(id); }
function mintFor(id) {
  if (!AUD) throw new Error("CDP_PROJECT_ID not set, cannot mint a CDP token");
  return jwt.sign({}, loadKey(), { algorithm: "RS256", keyid: KID, issuer: ISS, audience: AUD, subject: subjectFor(id), expiresIn: TTL });
}
function mintSession(identity, jti) {
  const opts = { algorithm: "RS256", keyid: KID, issuer: ISS, audience: "dovi-session", subject: String(identity), expiresIn: "30d" };
  if (jti) opts.jwtid = String(jti);
  return jwt.sign({}, loadKey(), opts);
}
function readSession(token) {
  try { loadKey(); const p = jwt.verify(token, _pubPem, { algorithms: ["RS256"], audience: "dovi-session", issuer: ISS }); return { identity: p.sub || null, jti: p.jti || null, iatMs: (p.iat || 0) * 1000 }; }
  catch (e) { return null; }
}
function verifySession(token) {
  try { loadKey(); const p = jwt.verify(token, _pubPem, { algorithms: ["RS256"], audience: "dovi-session", issuer: ISS }); return p.sub || null; }
  catch (e) { return null; }
}
function readiness() {
  if (!AUD) return { ok: false, detail: "CDP_PROJECT_ID is not set" };
  try { loadKey(); } catch (e) { return { ok: false, detail: e.message }; }
  return { ok: true, issuer: ISS, jwks: PUBLIC_URL + "/.well-known/jwks.json" };
}
module.exports = { jwks, mintFor, subjectFor, mintSession, readSession, verifySession, readiness, KID, ISS };
