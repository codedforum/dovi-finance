"use strict";
// Same-origin CDP proxy (raw http). The CDP embedded-wallet SDK calls
// api.cdp.coinbase.com; a browser on the DOVI site is CORS-blocked (and
// DNS-blocked in geo-restricted regions). Routing /cdpapi + /cdpwallet through
// here makes those calls same-origin. DOVI has no auth cookies of its own yet,
// so nothing sensitive is forwarded; CDP Set-Cookie is re-scoped to our host.
const https = require("https");
const API_HOST = "api.cdp.coinbase.com";
const WALLET_HOST = "secure-wallet.cdp.coinbase.com";
const STRIP_REQ = new Set(["host", "connection", "content-length", "accept-encoding"]);
const STRIP_RES = new Set(["content-encoding", "transfer-encoding", "connection", "content-length", "set-cookie"]);

function readBody(req) {
  return new Promise((resolve) => { const c = []; let size = 0; req.on("data", (x) => { size += x.length; if (size > 2000000) { req.destroy(); return; } c.push(x); }); req.on("end", () => resolve(Buffer.concat(c))); req.on("error", () => resolve(Buffer.alloc(0))); });
}
async function cdpProxy(req, res, url) {
  try {
    const isWallet = url.pathname.indexOf("/cdpwallet") === 0;
    const host = isWallet ? WALLET_HOST : API_HOST;
    const prefix = isWallet ? "/cdpwallet" : "/cdpapi";
    const sub = url.pathname.slice(prefix.length) + (url.search || "");
    if (sub && sub[0] !== "/" && sub[0] !== "?") { res.writeHead(400); return res.end('{"error":"bad path"}'); }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) { if (!STRIP_REQ.has(k.toLowerCase())) headers[k] = v; }
    if (headers.cookie) { headers.cookie = String(headers.cookie).split(/;\s*/).filter((c) => !/^dovi_sess=/.test(c)).join('; '); if (!headers.cookie) delete headers.cookie; }
    headers.host = host;
    const body = (req.method !== "GET" && req.method !== "HEAD") ? await readBody(req) : null;
    const preq = https.request({ host, path: sub || "/", method: req.method, headers }, (pres) => {
      if (res.headersSent || res.writableEnded) { pres.resume(); return; } // client already gone
      const rh = {};
      for (const [k, v] of Object.entries(pres.headers)) { const lk = k.toLowerCase(); if (STRIP_RES.has(lk) || lk === "x-frame-options") continue; rh[k] = v; }
      const loc = pres.headers.location;
      if (loc && loc.indexOf("https://" + host) === 0) rh.location = prefix + loc.slice(("https://" + host).length);
      const sc = pres.headers["set-cookie"];
      if (sc) rh["set-cookie"] = [].concat(sc).map((c) => String(c).replace(/;\s*Domain=[^;]+/ig, "")); // fold in BEFORE writeHead
      try { res.writeHead(pres.statusCode, rh); } catch (e) { pres.resume(); return; }
      pres.pipe(res);
    });
    req.on("aborted", () => preq.destroy());
    res.on("close", () => { if (!res.writableEnded) preq.destroy(); });
    preq.on("error", (e) => { if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "cdp_proxy: " + e.message })); });
    if (body && body.length) preq.write(body);
    preq.end();
  } catch (e) { if (!res.headersSent) res.writeHead(502); res.end(String(e.message || e)); }
}
module.exports = { cdpProxy };
