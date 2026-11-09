"use strict";
// Verify a Google Identity Services ID token against Google's public keys, with
// no external dependency. Returns the verified Google identity (sub is stable
// per Google account, so it maps to one DOVI wallet forever).
const crypto = require("crypto");
const https = require("https");
const jwt = require("jsonwebtoken");

const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
let _certs = null, _exp = 0;

function fetchCerts() {
  return new Promise((resolve, reject) => {
    https.get(CERTS_URL, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
async function certs() {
  const now = Date.now();
  if (_certs && now < _exp) return _certs;
  const j = await fetchCerts();
  const out = {};
  for (const k of j.keys) out[k.kid] = crypto.createPublicKey({ key: k, format: "jwk" }).export({ type: "spki", format: "pem" });
  _certs = out; _exp = now + 3600e3; // cache 1h
  return out;
}
async function verifyGoogleIdToken(idToken, clientId) {
  if (!idToken) throw new Error("missing credential");
  if (!clientId) throw new Error("Google client id not configured");
  const dec = jwt.decode(idToken, { complete: true });
  if (!dec || !dec.header || !dec.header.kid) throw new Error("malformed token");
  let pem = (await certs())[dec.header.kid];
  if (!pem) { _exp = 0; pem = (await certs())[dec.header.kid]; } // key rotated, refetch once
  if (!pem) throw new Error("unknown signing key");
  const p = jwt.verify(idToken, pem, {
    algorithms: ["RS256"],
    audience: clientId,
    issuer: ["https://accounts.google.com", "accounts.google.com"],
  });
  return { sub: p.sub, email: p.email, name: p.name, emailVerified: p.email_verified === true || p.email_verified === "true", picture: p.picture };
}
module.exports = { verifyGoogleIdToken };
