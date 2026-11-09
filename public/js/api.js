export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.details = details || null; }
}

export async function api(path, { method = 'GET', body } = {}) {
  let r;
  try {
    r = await fetch(path, { method, credentials: 'include', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'offline', 'You seem to be offline. Check your connection and try again.');
  }
  let j = null;
  try { j = await r.json(); } catch { /* not json */ }
  if (!r.ok) throw new ApiError(r.status, j && j.error, (j && j.message) || 'Something went wrong. Please try again.', j && j.details);
  return j;
}

export function idem() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export async function until(fn, { tries = 30, delay = 2000, retryOn = [409] } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!(e instanceof ApiError) || !retryOn.includes(e.status)) throw e;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw last;
}
