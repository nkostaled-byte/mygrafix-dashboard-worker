/**
 * Authentication & Authorization
 * ==============================
 * Supabase JWT verification and client resolution.
 *
 * Supports both:
 *   - HS256 (legacy shared secret via SUPABASE_JWT_SECRET)
 *   - ES256 (asymmetric via JWKS endpoint https://<PROJECT_REF>.supabase.co/auth/v1/.well-known/jwks.json)
 *
 * The JWKS URL is auto-derived from SUPABASE_URL if available.
 * Falls back to HS256 if the token algorithm matches.
 */

const JWKS_CACHE_TTL = 3600_000; // 1 hour
let jwksCache = { keys: null, fetchedAt: 0 };

/**
 * Debug logger — only logs when env.DEBUG is truthy
 */
function debug(env, ...args) {
  if (env.DEBUG) {
    console.log(...args);
  }
}

/**
 * Fetch and cache Supabase JWKS keys
 */
async function getJwksKeys(env) {
  const now = Date.now();
  if (jwksCache.keys && now - jwksCache.fetchedAt < JWKS_CACHE_TTL) {
    console.log("[JWKS] Using cached keys (fetched at:", new Date(jwksCache.fetchedAt).toISOString(), ")");
    return jwksCache.keys;
  }

  let jwksUrl = "";
  if (env.SUPABASE_URL) {
    const base = env.SUPABASE_URL.replace(/\/$/, "");
    jwksUrl = `${base}/auth/v1/.well-known/jwks.json`;
    console.log("[JWKS] Derived JWKS URL from SUPABASE_URL:", jwksUrl);
  } else if (env.SUPABASE_JWT_SECRET) {
    console.log("[JWKS] No SUPABASE_URL — falling back to HS256 (JWKS unavailable)");
    return null;
  } else {
    console.log("[JWKS] No SUPABASE_URL and no SUPABASE_JWT_SECRET — cannot verify any JWT");
    return null;
  }

  try {
    console.log("[JWKS] Fetching JWKS from:", jwksUrl);
    const resp = await fetch(jwksUrl);
    console.log("[JWKS] Fetch response status:", resp.status, resp.statusText);
    if (!resp.ok) {
      console.log("[JWKS] FAIL: fetch returned", resp.status, "— returning null");
      return null;
    }
    const jwks = await resp.json();
    const bodyPreview = JSON.stringify(jwks).substring(0, 500);
    console.log("[JWKS] Response body:", bodyPreview);
    console.log("[JWKS] Parsed JWKS response, keys count:", (jwks.keys || []).length);
    jwksCache = { keys: jwks.keys || [], fetchedAt: now };
    console.log("[JWKS] Cache updated at:", new Date(now).toISOString(), "with", (jwks.keys || []).length, "keys");
    return jwksCache.keys;
  } catch (err) {
    console.log("[JWKS] FAIL: fetch threw exception —", err.message, "(stack:", err.stack, ")");
    return null;
  }
}

/**
 * Import a JWK key for ES256 or RS256 verification
 */
async function importJwkKey(jwk) {
  try {
    return await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
  } catch {
    // Try RS256 fallback
    try {
      return await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSA-PSS", hash: "SHA-256" },
        false,
        ["verify"]
      );
    } catch {
      return null;
    }
  }
}

/**
 * Verify an ES256 ECDSA signature using Web Crypto
 */
async function verifyEs256(token, headerB64, payloadB64, signatureB64, jwk) {
  const key = await importJwkKey(jwk);
  if (!key) return false;

  try {
    const encoder = new TextEncoder();
    const signature = base64UrlToArrayBuffer(signatureB64);
    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    // ECDSA requires the raw (r||s) format, not DER — convert if needed
    // Supabase returns raw format, so this should work directly
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      key,
      signature,
      data
    );
  } catch {
    return false;
  }
}

/**
 * Verify a Supabase-issued JWT from the Authorization header.
 * Supports HS256 (HMAC) and ES256 (ECDSA via JWKS).
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<object|null>} Decoded payload or null
 */
export async function verifySupabaseJwt(request, env) {
  debug(env, "[AUTH START]");

  const authHeader = request.headers.get("Authorization") || "";
  debug(env, "[AUTH] Authorization header received:", authHeader ? authHeader.substring(0, 80) + "..." : "(empty)");

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const bearerPresent = authHeader.replace(/^Bearer\s+/i, "").trim() !== authHeader || authHeader === "";
  debug(env, "[AUTH] Bearer present:", !!token);
  if (!token) {
    debug(env, "[AUTH] FAIL: no token — returning null (auth.js line ~37)");
    return null;
  }

  const parts = token.split(".");
  debug(env, "[AUTH] Token parts count:", parts.length);
  if (parts.length !== 3) {
    debug(env, "[AUTH] FAIL: not 3 parts — returning null (auth.js line ~40)");
    return null;
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  // Parse algorithm from header
  let header;
  try {
    header = JSON.parse(atob(base64UrlToStdB64(headerB64)));
  } catch {
    debug(env, "[AUTH] FAIL: bad header (could not parse JSON) — returning null (auth.js line ~47)");
    return null;
  }

  const alg = header?.alg || "";
  const kid = header?.kid || "(none)";
  debug(env, "[AUTH] JWT header — alg:", alg, "kid:", kid);

  try {
    const payload = JSON.parse(atob(base64UrlToStdB64(payloadB64)));
    debug(env, "[AUTH] JWT payload — iss:", payload.iss || "(not set)", "aud:", payload.aud || "(not set)", "sub:", payload.sub || "(not set)", "exp:", payload.exp || "(not set)");

    // Check expiration
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      debug(env, "[AUTH] FAIL: token expired (exp:", payload.exp, "now:", Date.now() / 1000, ") — returning null (auth.js line ~56)");
      return null;
    }
    if (!payload.sub) {
      debug(env, "[AUTH] FAIL: no sub claim — returning null (auth.js line ~59)");
      return null;
    }

    if (alg === "HS256") {
      debug(env, "[AUTH] Using HS256 verification path");
      // ─── HMAC-SHA256 verification ───
      if (!env.SUPABASE_JWT_SECRET) {
        debug(env, "[AUTH] FAIL: HS256 but no SUPABASE_JWT_SECRET set — returning null (auth.js line ~64)");
        return null;
      }

      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(env.SUPABASE_JWT_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"]
      );

      const signature = base64UrlToArrayBuffer(signatureB64);
      const valid = await crypto.subtle.verify(
        "HMAC",
        key,
        signature,
        encoder.encode(`${headerB64}.${payloadB64}`)
      );

      if (!valid) {
        debug(env, "[AUTH] FAIL: HS256 signature invalid — returning null (auth.js line ~79)");
        return null;
      }
      debug(env, "[AUTH] SUCCESS: HS256 verification passed");
      return payload;

    } else if (alg === "ES256") {
      debug(env, "[AUTH] Using ES256 verification path");
      // ─── ECDSA P-256 verification via JWKS ───
      console.log("[JWKS] Cache state before fetch: populated =", !!jwksCache.keys, "| fetchedAt =", jwksCache.fetchedAt ? new Date(jwksCache.fetchedAt).toISOString() : "never");
      const keys = await getJwksKeys(env);
      if (!keys || !keys.length) {
        debug(env, "[AUTH] FAIL: ES256 but no JWKS keys available — returning null (auth.js line ~87)");
        return null;
      }
      debug(env, "[AUTH] JWKS keys count:", keys.length);

      // Match key by key ID (kid)
      const matchingKeys = kid && kid !== "(none)"
        ? keys.filter((k) => k.kid === kid)
        : keys;
      debug(env, "[AUTH] Matching JWKS keys for kid '" + kid + "':", matchingKeys.length);

      for (const jwk of matchingKeys) {
        const valid = await verifyEs256(token, headerB64, payloadB64, signatureB64, jwk);
        if (valid) {
          debug(env, "[AUTH] SUCCESS: ES256 verification passed");
          return payload;
        }
      }

      debug(env, "[AUTH] FAIL: ES256 no matching key verified — returning null (auth.js line ~98)");
      return null;

    } else {
      // Unknown algorithm
      debug(env, "[AUTH] FAIL: unsupported algorithm '" + alg + "' — returning null (auth.js line ~103)");
      console.warn(`[Auth] Unsupported JWT algorithm: ${alg}`);
      return null;
    }
  } catch (err) {
    debug(env, "[AUTH] FAIL: catch error —", err.message, "(auth.js line ~108)");
    console.error(`[Auth] JWT verification error:`, err.message);
    return null;
  }
}

/**
 * Resolve a Supabase auth user ID to a client_id.
 * Checks both client owners and active team members.
 * @param {object} env
 * @param {string} authUserId - The `sub` claim from JWT
 * @returns {Promise<string|null>}
 */
export async function resolveClientId(env, authUserId) {
  const { supabaseFetch } = await import("./supabase.js");

  const ownerRows = await supabaseFetch(
    env,
    `clients?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=client_id`
  );
  if (ownerRows.length) return ownerRows[0].client_id;

  const teamRows = await supabaseFetch(
    env,
    `team_members?auth_user_id=eq.${encodeURIComponent(authUserId)}&active=eq.true&select=client_id`
  );
  if (teamRows.length) return teamRows[0].client_id;

  return null;
}

/**
 * Resolve a user's role + client. Checks client owners first, then active team members.
 * @param {object} env
 * @param {string} authUserId - The `sub` claim from JWT
 * @returns {Promise<{role: string, clientId: string}|null>}
 */
export async function resolveUserRole(env, authUserId) {
  const { supabaseFetch } = await import("./supabase.js");

  const ownerRows = await supabaseFetch(
    env,
    `clients?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=client_id`
  );
  if (ownerRows.length) return { role: "owner", clientId: ownerRows[0].client_id };

  const teamRows = await supabaseFetch(
    env,
    `team_members?auth_user_id=eq.${encodeURIComponent(authUserId)}&active=eq.true&select=client_id,role`
  );
  if (teamRows.length) return { role: teamRows[0].role || "staff", clientId: teamRows[0].client_id };

  return null;
}

// ---- Base64 URL helpers ----

function base64UrlToStdB64(b64url) {
  const std = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (std.length % 4)) % 4;
  return std + "=".repeat(padLength);
}

function base64UrlToArrayBuffer(b64url) {
  const raw = atob(base64UrlToStdB64(b64url));
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}
