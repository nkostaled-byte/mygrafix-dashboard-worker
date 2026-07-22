/**
 * Upload Handler
 * ===============
 * POST /api/upload — Authenticated file uploads to R2
 *
 * Accepts image uploads (PNG, JPEG, WebP, GIF) and stores them in R2.
 * Requires valid Supabase JWT authentication.
 */

import { jsonResponse } from "../lib/responses.js";
import { verifySupabaseJwt, resolveClientId } from "../lib/auth.js";
import {
  ALLOWED_UPLOAD_TYPES,
  EXTENSION_BY_TYPE,
  MAX_UPLOAD_BYTES,
  ALLOWED_UPLOAD_FOLDERS,
} from "../config/constants.js";

/**
 * POST /api/upload
 *
 * Query params:
 *   ?folder=logos|profile|products
 *
 * Headers:
 *   Authorization: Bearer <supabase-jwt>
 *   Content-Type: image/png|image/jpeg|image/webp|image/gif
 *
 * Body: raw image bytes
 */
export async function handleUpload(request, env, url) {
  // Authenticate
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) {
    return jsonResponse({ success: false, error: "Unauthorized." }, 401);
  }

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }

  // Validate folder
  const folderParam = (url.searchParams.get("folder") || "misc").toLowerCase();
  const folder = ALLOWED_UPLOAD_FOLDERS.includes(folderParam) ? folderParam : "misc";

  // Validate content type
  const contentType = request.headers.get("Content-Type") || "";
  if (!ALLOWED_UPLOAD_TYPES.includes(contentType)) {
    return jsonResponse(
      { success: false, error: `Unsupported file type: ${contentType || "unknown"}` },
      400
    );
  }

  // Read body
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) {
    return jsonResponse({ success: false, error: "Empty file." }, 400);
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return jsonResponse({ success: false, error: "File too large (max 5MB)." }, 400);
  }

  // Generate key and upload to R2
  const extension = EXTENSION_BY_TYPE[contentType];
  const key = `clients/${clientId}/${folder}/${crypto.randomUUID()}.${extension}`;

  await env.R2_BUCKET.put(key, bytes, {
    httpMetadata: { contentType },
  });

  const baseUrl = (env.R2_PUBLIC_URL || "").replace(/\/$/, "");
  const publicUrl = `${baseUrl}/${key}`;

  return jsonResponse({ success: true, url: publicUrl, key, folder });
}

