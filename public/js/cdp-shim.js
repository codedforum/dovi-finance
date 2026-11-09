(function () {
  if (typeof window === 'undefined' || window.__doviCdpShim) return;
  window.__doviCdpShim = true;
  var API = 'https://api.cdp.coinbase.com', W = 'https://secure-wallet.cdp.coinbase.com';
  function rw(u) { u = String(u); if (u.indexOf(API) === 0) return '/cdpapi' + u.slice(API.length); if (u.indexOf(W) === 0) return '/cdpwallet' + u.slice(W.length); return u; }
  var of = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try { if (typeof input === 'string') return of(rw(input), init); if (input && input.url) return of(new Request(rw(input.url), input), init); } catch (e) { /* fall through */ }
    return of(input, init);
  };
  var oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { var a = [].slice.call(arguments); a[1] = rw(u); return oo.apply(this, a); };
})();
