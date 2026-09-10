/**
 * Social-Image Upload Handler
 * ============================
 * POST /api/ai/upload-social-image — Maya uploads an approved social-media
 * image into R2 and receives its public HTTPS URL for Zapier publishing.
 *
 * Reuses the SAME Maya authentication doorway already implemented in
 * handlers/product-image-ai.js (MAYA_API_KEY + MAYA_CLIENT_ID, SHA-256 +
 * timing-safe comparison, Supabase JWT fallback). No second auth system.
 *
 * Storage path (server-side key only — client filenames are sanitized and
 * never allowed to determine the R2 path):
 *   social/YYYY/MM/DD/<platform>/<safe-basename>-<uuid>.<ext>
 *
 * Public URL reuses the existing env.R2_PUBLIC_URL configuration, exactly as
 * handlers/upload.js and handlers/product-image-ai.js already do.
 */

import { jsonResponse } from "../lib/responses.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { AI_PRODUCT_IMAGE_RATE_LIMIT } from "../config/constants.js";
import { authorizeImageGeneration } from "./product-image-ai.js";

const ALLOWED_PLATFORMS = ["instagram", "facebook", "linkedin"];
const MAX_SOCIAL_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

// image/jpg is accepted from clients but normalized to image/jpeg for storage.
const STORED_TYPE_BY_INPUT = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
};
const EXTENSION_BY_STORED_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Sanitize a client-supplied filename. Strips path/directory components,
 * control characters, and unsafe characters; collapses whitespace; caps the
 * length. The extension is chosen from the validated MIME type, so the file
 * extension in the name is never trusted for path or key construction.
 */
function sanitizeFilename(raw, fallbackBase) {
  if (typeof raw !== "string") return fallbackBase;
  let name = raw.split(/[\\/]+/).pop() || "";
  name = name.replace(/[\u0000-\u001F\u007F]/g, "");
  name = name.replace(/[^A-Za-z0-9._\- ]+/g, "");
  name = name.replace(/\s+/g, "-").replace(/-+/g, "-");
  name = name.replace(/^[-.]+|[-]+$/g, "");
  if (!name || name === "." || name === "..") name = fallbackBase;
  // Strip any extension: the stored extension comes from the validated type.
  name = name.replace(/\.[A-Za-z0-9]+$/, "");
  if (!name) name = fallbackBase;
  return name.slice(0, 100);
}

function errorJson(message, status) {
  return jsonResponse({ success: false, error: message }, status);
}

export async function handleUploadSocialImage(request, env) {
  // ── Authentication (reused Maya mechanism, mandatory) ──
  const auth = await authorizeImageGeneration(request, env);
  if (!auth) return errorJson("Unauthorized", 401);
  let clientId;
  if (auth.mayaClientId) {
    clientId = auth.mayaClientId;
  } else {
    const { resolveClientId } = await import("../lib/auth.js");
    clientId = await resolveClientId(env, auth.claims.sub);
  }
  if (!clientId) return errorJson("Unauthorized", 401);

  // ── Rate limit (existing KV helper and limits, client-scoped) ──
  const requestLimit = await checkRateLimit(env, `social-image-request:${clientId}`, AI_PRODUCT_IMAGE_RATE_LIMIT);
  if (!requestLimit.allowed) {
    return jsonResponse(
      { success: false, error: "Too many requests. Please try again shortly." },
      429,
      { "Retry-After": String(requestLimit.retryAfter) }
    );
  }

  // ── Malformed request / content-type checks ──
  const contentTypeHeader = request.headers.get("Content-Type") || "";
  if (!/^multipart\/form-data/i.test(contentTypeHeader)) {
    return errorJson("Invalid image upload", 400);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return errorJson("Invalid image upload", 400);
  }

  // ── Platform validation ──
  const platformRaw = form.get("platform");
  const platform = typeof platformRaw === "string" ? platformRaw.trim().toLowerCase() : "";
  if (!ALLOWED_PLATFORMS.includes(platform)) {
    return errorJson("Platform is invalid. Supported platforms: instagram, facebook, linkedin.", 400);
  }

  // ── Image validation (presence, MIME type, size) ──
  const imageField = form.get("image");
  if (!(imageField instanceof File) || typeof imageField.type !== "string") {
    return errorJson("Invalid image upload", 400);
  }
  // image/jpg accepted but normalized for storage.
  const normalizedType = imageField.type === "image/jpg" ? "image/jpeg" : imageField.type.toLowerCase();
  if (!STORED_TYPE_BY_INPUT[normalizedType]) {
    return errorJson("Unsupported image type. Allowed: image/jpeg, image/png, image/webp.", 400);
  }
  if (imageField.size === 0) {
    return errorJson("Empty image file.", 400);
  }
  if (imageField.size > MAX_SOCIAL_IMAGE_BYTES) {
    return jsonResponse({ success: false, error: "Image exceeds maximum upload size" }, 413);
  }

  const bytes = await imageField.arrayBuffer();
  if (bytes.byteLength === 0) return errorJson("Empty image file.", 400);
  if (bytes.byteLength > MAX_SOCIAL_IMAGE_BYTES) {
    return jsonResponse({ success: false, error: "Image exceeds maximum upload size" }, 413);
  }

  // ── Server-side R2 key construction ──
  const storedType = STORED_TYPE_BY_INPUT[normalizedType];
  const extension = EXTENSION_BY_STORED_TYPE[storedType];
  const safeName = sanitizeFilename(form.get("filename"), `${platform}-image`);
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const key = `social/${year}/${month}/${day}/${platform}/${safeName}-${crypto.randomUUID()}.${extension}`;

  // ── R2 upload ──
  try {
    await env.R2_BUCKET.put(key, bytes, {
      httpMetadata: {
        contentType: storedType,
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return errorJson("Failed to upload image", 500);
  }

  // ── Public URL via the existing R2 public URL configuration ──
  const baseUrl = (env.R2_PUBLIC_URL || "").replace(/\/$/, "");
  return jsonResponse(
    {
      success: true,
      data: {
        url: `${baseUrl}/${key}`,
        key,
        filename: `${safeName}.${extension}`,
        contentType: storedType,
        platform,
      },
    },
    200,
    { "Cache-Control": "no-store" }
  );
}
