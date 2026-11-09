"use strict";
// DOVI email one-time-code login. CDP built-in email OTP is off under custom
// auth, so DOVI verifies the email itself, then mints the session (identity
// email:<address>) that issues the CDP wallet. In-memory code store (single
// process, testnet). Delivery uses a local sendmail MTA, or a Resend API key
// if set. In
// non-production the code is also returned so the flow never blocks.
const crypto = require("crypto");
const https = require("https");
const fs = require("fs");
const { spawn } = require("child_process");

const CODES = new Map(); // email -> { code, exp, attempts, lastSent }
const TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SENDMAIL_BIN = ["/usr/sbin/sendmail", "/usr/lib/sendmail"].find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
const FROM = process.env.EMAIL_FROM || "DOVI <noreply@dovi.finance>";
const ENVELOPE_FROM = (FROM.match(/<([^>]+)>/) || [null, FROM])[1]; // for SPF alignment

function normalize(email) { return String(email || "").trim().toLowerCase(); }
function gc() { const now = Date.now(); for (const [k, v] of CODES) if (v.exp < now) CODES.delete(k); }

function sendViaResend(email, code) {
  const key = process.env.RESEND_API_KEY;
  const payload = JSON.stringify({
    from: FROM, to: [email], subject: message(code).subject,
    html: message(code).html, text: message(code).text,
  });
  return new Promise((resolve, reject) => {
    const req = https.request("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key, "content-length": Buffer.byteLength(payload) },
    }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => (r.statusCode < 300 ? resolve(true) : reject(new Error("resend " + r.statusCode)))); });
    req.on("error", reject); req.write(payload); req.end();
  });
}

function sendViaSendmail(email, code) {
  return new Promise((resolve, reject) => {
    if (!SENDMAIL_BIN) return reject(new Error("no local MTA"));
    const m = message(code); const b = "dovi" + crypto.randomBytes(8).toString("hex");
    const part = (type, body) => ["--" + b, "Content-Type: " + type + "; charset=utf-8", "Content-Transfer-Encoding: base64", "", Buffer.from(body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n")].join("\r\n");
    const msg = [
      "From: " + FROM,
      "To: " + email,
      "Subject: " + m.subject,
      "MIME-Version: 1.0",
      "Content-Type: multipart/alternative; boundary=\"" + b + "\"",
      "", part("text/plain", m.text), part("text/html", m.html), "--" + b + "--", "",
    ].join("\r\n");
    const sm = spawn(SENDMAIL_BIN, ["-t", "-i", "-f", ENVELOPE_FROM], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    sm.stderr.on("data", (c) => (err += c));
    sm.on("error", reject);
    sm.on("close", (c) => (c === 0 ? resolve(true) : reject(new Error("sendmail exit " + c + " " + err))));
    sm.stdin.write(msg); sm.stdin.end();
  });
}
function message(code) { return require("../server/emails/templates").render("loginCode", { code }); }

const SENDS = new Map();   // email -> [timestamps]
const FAILS = new Map();   // email -> { n, until }
const SEND_COOLDOWN_MS = 30 * 1000;
const SEND_MAX_PER_HOUR = 5;
const FAIL_MAX = 10;
const LOCK_MS = 60 * 60 * 1000;
let senderOverride = null;

async function deliver(email, code) {
  if (senderOverride) return senderOverride(email, code);
  if (process.env.RESEND_API_KEY) return sendViaResend(email, code);
  if (SENDMAIL_BIN) return sendViaSendmail(email, code);
  throw new Error("no mail transport");
}

async function start(emailRaw) {
  const email = normalize(emailRaw);
  if (!EMAIL_RE.test(email)) throw new Error("enter a valid email");
  gc();
  const now = Date.now();
  const lock = FAILS.get(email);
  if (lock && lock.until > now) throw new Error("too many attempts, try again later");
  const sends = (SENDS.get(email) || []).filter((t) => now - t < 3600000);
  if (sends.length && now - sends[sends.length - 1] < SEND_COOLDOWN_MS) throw new Error("wait a moment before asking for another code");
  if (sends.length >= SEND_MAX_PER_HOUR) throw new Error("too many codes requested, try again later");
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  try { await deliver(email, code); } catch (e) { throw new Error("email delivery failed, try again"); }
  sends.push(now); SENDS.set(email, sends);
  CODES.set(email, { code, exp: now + TTL_MS, attempts: 0, lastSent: now });
  return { sent: true };
}

function verify(emailRaw, codeRaw) {
  const email = normalize(emailRaw);
  const code = String(codeRaw || "").trim();
  const now = Date.now();
  const lock = FAILS.get(email);
  if (lock && lock.until > now) throw new Error("too many attempts, try again later");
  const rec = CODES.get(email);
  if (!rec) throw new Error("request a code first");
  if (now > rec.exp) { CODES.delete(email); throw new Error("code expired, request a new one"); }
  if (rec.attempts >= MAX_ATTEMPTS) { CODES.delete(email); throw new Error("too many attempts, request a new code"); }
  rec.attempts++;
  const a = Buffer.from(code.padEnd(6, " ")); const b = Buffer.from(rec.code);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const f = FAILS.get(email) || { n: 0, until: 0, first: now };
    if (now - (f.first || now) > LOCK_MS) { f.n = 0; f.first = now; }
    f.n++; if (f.n >= FAIL_MAX) { f.until = now + LOCK_MS; f.n = 0; CODES.delete(email); }
    FAILS.set(email, f);
    throw new Error("incorrect code");
  }
  CODES.delete(email); FAILS.delete(email);
  return { identity: "email:" + email, email };
}

module.exports = { start, verify, __test: { setSender(f) { senderOverride = f; }, reset() { CODES.clear(); SENDS.clear(); FAILS.clear(); senderOverride = null; } } };
