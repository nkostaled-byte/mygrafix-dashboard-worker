import { jsonResponse, rateLimitResponse } from "../lib/responses.js";
import { parseJsonBody } from "../lib/utils.js";
import { verifySupabaseJwt, resolveClientId } from "../lib/auth.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { AI_PRODUCT_IMAGE_RATE_LIMIT, DEFAULT_AI_PRODUCT_IMAGE_LIMIT } from "../config/constants.js";

const MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const MAX_PROMPT_LENGTH = 1200;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const APPROVAL_TTL = 15 * 60;
const REFERENCE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const PURPOSES = ["product", "service", "gallery"];

function error(message, status = 400) {
  return jsonResponse({ success: false, error: message }, status);
}

function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function bufferFromBase64(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function parseImageData(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || !REFERENCE_TYPES.includes(match[1])) return null;
  const bytes = bufferFromBase64(match[2]);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
  return { bytes, contentType: match[1] };
}

async function digest(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function normalizeGeneratedImage(result) {
  // FLUX.2 Klein returns { image: base64 }, while the fallback handles
  // stream/binary responses from compatible Workers AI runtimes.
  if (result && typeof result.image === "string") {
    const bytes = bufferFromBase64(result.image);
    return bytes ? bytes.buffer : null;
  }
  if (result instanceof ReadableStream) return await new Response(result).arrayBuffer();
  if (result instanceof ArrayBuffer) return result;
  if (ArrayBuffer.isView(result)) return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
  return null;
}

function dimensions(aspectRatio) {
  if (aspectRatio === "4:5") return { width: 896, height: 1120 };
  if (aspectRatio === "16:9") return { width: 1152, height: 640 };
  return { width: 1024, height: 1024 };
}

function enhancedPrompt(body, purpose) {
  const details = [body.productName, body.prompt, body.style && `Photography style: ${body.style}`, body.background && `Background: ${body.background}`]
    .filter((value) => typeof value === "string" && value.trim())
    .join(". ");
  const referenceInstruction = body.referenceImageData ? " Use the supplied reference image as the visual starting point, preserving the subject's important characteristics while applying the requested changes." : "";
  const subject = body.assetType === "service"
    ? "a professional service scene"
    : purpose === "gallery"
      ? "a high-quality showcase image"
      : "professional commercial product photography";
  const framing = body.assetType === "service"
    ? " Create polished commercial service or lifestyle photography that communicates the experience clearly, with natural human proportions and an authentic setting."
    : " Show the subject clearly and centered with realistic proportions.";
  return `${subject} of ${details}.${framing}${referenceInstruction} Use refined lighting, clean composition, and high detail. No unnecessary text, watermark, random branding, readable labels, or fake logos unless explicitly requested by the description.`;
}

/**
 * Constant-time comparison of two strings (e.g. presented token vs MAYA_API_KEY).
 * Both values are SHA-256 digested first so lengths never leak timing info, then
 * compared using the Workers-native timingSafeEqual (with a constant-time XOR
 * fallback for runtimes without it).
 */
async function mayaTokenMatches(token, secret) {
  try {
    const encoder = new TextEncoder();
    const digestA = await crypto.subtle.digest("SHA-256", encoder.encode(token));
    const digestB = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
    try {
      return crypto.subtle.timingSafeEqual(digestA, digestB);
    } catch {
      const a = new Uint8Array(digestA);
      const b = new Uint8Array(digestB);
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
      return diff === 0;
    }
  } catch {
    return false;
  }
}

/**
 * Authorization for image generation only.
 *
 * Path 1 (agent): Bearer token equals the configured MAYA_API_KEY secret —
 * authenticates as the fixed client resolved from the MAYA_CLIENT_ID variable.
 * No read of Supabase, no user context required.
 *
 * Path 2 (dashboard users): existing verifySupabaseJwt + resolveClientId flow,
 * completely unmodified.
 *
 * Returns { mayaClientId } | { claims } | null. null means HTTP 401;
 * { claims } without a resolvable client means HTTP 403 (kept separate from 401).
 */
export async function authorizeImageGeneration(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (env.MAYA_API_KEY && env.MAYA_CLIENT_ID && token) {
    if (await mayaTokenMatches(token, env.MAYA_API_KEY)) {
      return { mayaClientId: env.MAYA_CLIENT_ID };
    }
    // Token did not match the agent key — fall through to normal Supabase
    // verification so existing dashboard users keep working unchanged.
  }

  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return null;
  return { claims };
}

export async function handleGenerateProductImage(request, env) {
  const auth = await authorizeImageGeneration(request, env);
  if (!auth) return error("Unauthorized.", 401);
  let clientId;
  if (auth.mayaClientId) {
    clientId = auth.mayaClientId;
  } else {
    clientId = await resolveClientId(env, auth.claims.sub);
    if (!clientId) return error("No client account linked to this login.", 403);
  }
  if (!env.AI) return error("Image generation is not configured. Please contact support.", 503);
  if (!env.RATE_LIMIT_KV) return error("Image generation is temporarily unavailable. Please contact support.", 503);

  const body = await parseJsonBody(request);
  if (body?.purpose && !PURPOSES.includes(body.purpose)) return error("Image purpose is invalid.");
  const purpose = body?.purpose && PURPOSES.includes(body.purpose) ? body.purpose : "product";

  const requestLimit = await checkRateLimit(env, `ai-image-request:${clientId}`, AI_PRODUCT_IMAGE_RATE_LIMIT);
  if (!requestLimit.allowed) return rateLimitResponse(requestLimit.retryAfter);

  // Gallery images are workspace assets, not per-product generations — the
  // daily cap does not apply. The per-minute rate limit above still guards abuse.
  if (purpose !== "gallery") {
    const today = new Date().toISOString().slice(0, 10);
    const dailyLimit = Math.max(1, Number(env.AI_PRODUCT_IMAGE_LIMIT || DEFAULT_AI_PRODUCT_IMAGE_LIMIT));
    const daily = await checkRateLimit(env, `ai-image-daily:${clientId}:${today}`, { max: dailyLimit, windowSeconds: 86400 });
    if (!daily.allowed) return error("You have reached today's image generation limit. Please try again tomorrow.", 429);
  }

  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return error("A product description is required.");
  if (prompt.length > MAX_PROMPT_LENGTH) return error(`Product description must be ${MAX_PROMPT_LENGTH} characters or fewer.`);
  if (body.productName && (typeof body.productName !== "string" || body.productName.length > 200)) return error("Product name is invalid.");
  if (body.style && (typeof body.style !== "string" || body.style.length > 200)) return error("Photography style is invalid.");
  if (body.background && (typeof body.background !== "string" || body.background.length > 200)) return error("Background preference is invalid.");
  if (body.assetType && !["product", "service"].includes(body.assetType)) return error("Asset type is invalid.");
  const referenceImage = body.referenceImageData ? parseImageData(body.referenceImageData) : null;
  if (body.referenceImageData && !referenceImage) return error("Reference image is invalid or too large.");
  const allowedRatios = ["1:1", "4:5", "16:9"];
  if (body.aspectRatio && !allowedRatios.includes(body.aspectRatio)) return error("Invalid aspect ratio.");

  try {
    const form = new FormData();
    const { width, height } = dimensions(body.aspectRatio || "1:1");
    form.append("prompt", enhancedPrompt(body, purpose));
    form.append("width", String(width));
    form.append("height", String(height));
    if (referenceImage) {
      form.append("input_image_0", new Blob([referenceImage.bytes], { type: referenceImage.contentType }), "reference-image");
    }
    const formResponse = new Response(form);
    const result = await env.AI.run(MODEL, {
      multipart: { body: formResponse.body, contentType: formResponse.headers.get("content-type") },
    });
    const imageBuffer = await normalizeGeneratedImage(result);
    if (!(imageBuffer instanceof ArrayBuffer) || imageBuffer.byteLength === 0 || imageBuffer.byteLength > MAX_IMAGE_BYTES) {
      return error("The image service returned an invalid image.", 502);
    }
    const imageData = base64FromBuffer(imageBuffer);
    const approvalToken = crypto.randomUUID();
    await env.RATE_LIMIT_KV.put(`ai-image-approval:${approvalToken}`, JSON.stringify({ clientId, digest: await digest(imageBuffer), purpose }), { expirationTtl: APPROVAL_TTL });
    return jsonResponse({ success: true, data: { imageData: `data:image/png;base64,${imageData}`, approvalToken, expiresIn: APPROVAL_TTL } }, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    console.error("Product image generation failed:", err?.message || "unknown error");
    return error("The image could not be generated right now. Please try again.", 502);
  }
}

export async function handleSaveProductImage(request, env) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return error("Unauthorized.", 401);
  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) return error("No client account linked to this login.", 403);
  if (!env.R2_BUCKET || !env.RATE_LIMIT_KV) return error("Image storage is not configured. Please contact support.", 503);

  const body = await parseJsonBody(request);
  const token = typeof body?.approvalToken === "string" ? body.approvalToken : "";
  const match = typeof body?.imageData === "string" ? body.imageData.match(/^data:(image\/png);base64,([A-Za-z0-9+/]+={0,2})$/) : null;
  if (!token || !match) return error("A valid generated image is required.");
  const bytes = bufferFromBase64(match[2]);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return error("Image is invalid or too large.");
  const approvalKey = `ai-image-approval:${token}`;
  const approval = await env.RATE_LIMIT_KV.get(approvalKey, "json");
  if (!approval || approval.clientId !== clientId || approval.digest !== await digest(bytes)) return error("This generated image is no longer available. Generate a new image and try again.", 409);

  // The purpose recorded at generation time decides the storage path; a
  // mismatched request purpose is rejected so approvals can't be redirected.
  const purpose = approval.purpose && PURPOSES.includes(approval.purpose) ? approval.purpose : "product";
  if (body?.purpose && body.purpose !== purpose) return error("This generated image does not match the requested purpose.", 409);

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const folderPrefix = purpose === "gallery" ? "gallery" : "products";
  const filePrefix = purpose === "gallery" ? "gallery" : "product";
  const key = `clients/${clientId}/${folderPrefix}/generated/${year}/${month}/${filePrefix}-${crypto.randomUUID()}.png`;
  try {
    await env.R2_BUCKET.put(key, bytes, { httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" } });
    await env.RATE_LIMIT_KV.delete(approvalKey);
    const baseUrl = (env.R2_PUBLIC_URL || "").replace(/\/$/, "");
    return jsonResponse({ success: true, data: { url: `${baseUrl}/${key}`, key } }, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    console.error("Approved product image save failed:", err?.message || "unknown error");
    return error("The image could not be saved. Please try again.", 502);
  }
}
