/**
 * Rate Limiting
 * ==============
 * Fixed-window rate limiter backed by Workers KV.
 * Degrades gracefully (allows the request) if RATE_LIMIT_KV is not bound.
 */

/**
 * Check whether a request is within the rate limit.
 * @param {object} env - Worker env bindings
 * @param {string} key - KV key (e.g. "ip:1.2.3.4", "client:abc-123")
 * @param {{ max: number, windowSeconds: number }} limit
 * @returns {Promise<{ allowed: boolean, retryAfter: number }>}
 */
export async function checkRateLimit(env, key, { max, windowSeconds }) {
  if (!env.RATE_LIMIT_KV) {
    return { allowed: true, retryAfter: 0 };
  }

  const now = Date.now();
  const raw = await env.RATE_LIMIT_KV.get(key);
  let record = raw ? JSON.parse(raw) : null;

  if (!record || now > record.resetAt) {
    record = { count: 0, resetAt: now + windowSeconds * 1000 };
  }

  record.count += 1;

  const secondsUntilReset = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
  // Cloudflare KV requires expirationTtl >= 60
  const kvTtl = Math.max(60, secondsUntilReset);
  await env.RATE_LIMIT_KV.put(key, JSON.stringify(record), { expirationTtl: kvTtl });

  if (record.count > max) {
    return { allowed: false, retryAfter: secondsUntilReset };
  }

  return { allowed: true, retryAfter: 0 };
}

