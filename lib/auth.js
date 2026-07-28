/**
 * Authentication & Authorization
 * ==============================
 * Supabase JWT verification and client resolution.
 *
 * Supports both:
 *   - HS256 (legacy shared secret via SUPABASE_JWT_SECRET)
 *   - ES256 (asymmetric via JWKS endpoint https://<PROJECT_REF>.supabase.co/.well-known/jwks.json)
 *
 * The JWKS URL is auto-derived from SUPABASE_URL if available.
 * Falls back to HS256 if the token algorithm matches.
 */

const JWKS_CACHE_TTL = 3600_000; // 1 hour
let jwksCache = { keys: null, fetchedAt: 0 };

/**
 * Fetch and cache Supabase JWKS keys
 */
async function getJwksKeys(env) {
  const now = Date.now();
  if (jwksCache.keys && now - jwksCache.fetchedAt < JWKS_CACHE_TTL) {
    return jwksCache.keys;
  }

  let jwksUrl = "";
  if (env.SUPABASE_URL) {
    const base = env.SUPABASE_URL.replace(/\/$/, "");
    jwksUrl = `${base}/.well-known/jwks.json`;
  } else if (env.SUPABASE_JWT_SECRET) {
    // Can't derive JWKS URL, will fall back to HS256
    return null;
  } else {
    return null;
  }

  try {
    const resp = await fetch(jwksUrl);
    if (!resp.ok) return null;
    const jwks = await resp.json();
    jwksCache = { keys: jwks.keys || [], fetchedAt: now };
    return jwksCache.keys;
  } catch {
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
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  // Parse algorithm from header
  let header;
  try {
    header = JSON.parse(atob(base64UrlToStdB64(headerB64)));
  } catch {
    return null;
  }

  const alg = header?.alg || "";

  try {
    const payload = JSON.parse(atob(base64UrlToStdB64(payloadB64)));

    // Check expiration
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    if (!payload.sub) return null;

    if (alg === "HS256") {
      // ─── HMAC-SHA256 verification ───
      if (!env.SUPABASE_JWT_SECRET) return null;

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

      if (!valid) return null;
      return payload;

    } else if (alg === "ES256") {
      // ─── ECDSA P-256 verification via JWKS ───
      const keys = await getJwksKeys(env);
      if (!keys || !keys.length) return null;

      // Match key by key ID (kid)
      const kid = header.kid;
      const matchingKeys = kid
        ? keys.filter((k) => k.kid === kid)
        : keys;

      for (const jwk of matchingKeys) {
        const valid = await verifyEs256(token, headerB64, payloadB64, signatureB64, jwk);
        if (valid) return payload;
      }

      return null;

    } else {
      // Unknown algorithm
      console.warn(`[Auth] Unsupported JWT algorithm: ${alg}`);
      return null;
    }
  } catch (err) {
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

