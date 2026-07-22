/**
 * Authentication & Authorization
 * ==============================
 * Supabase JWT verification and client resolution.
 *
 * NOTE: This assumes your Supabase project uses the legacy shared JWT secret
 * (Settings > API > JWT Secret). If switched to asymmetric keys (ES256/RS256),
 * you will need to verify against Supabase's JWKS endpoint instead.
 */

/**
 * Verify a Supabase-issued HS256 JWT from the Authorization header.
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

  try {
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

    const payload = JSON.parse(atob(base64UrlToStdB64(payloadB64)));

    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    if (!payload.sub) return null;

    return payload;
  } catch {
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

