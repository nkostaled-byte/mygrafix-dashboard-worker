import { jsonResponse, rateLimitResponse } from "../lib/responses.js";
import { parseJsonBody } from "../lib/utils.js";
import { verifySupabaseJwt, resolveClientId } from "../lib/auth.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { AI_PRODUCT_IMAGE_RATE_LIMIT, DEFAULT_AI_PRODUCT_IMAGE_LIMIT } from "../config/constants.js";

const MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const MAX_PROMPT_LENGTH = 1200;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const APPROVAL_TTL = 15 * 60;

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

async function digest(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function dimensions(aspectRatio) {
  if (aspectRatio === "4:5") return { width: 896, height: 1120 };
  if (aspectRatio === "16:9") return { width: 1152, height: 640 };
  return { width: 1024, height: 1024 };
}

function enhancedPrompt(body) {
  const details = [body.productName, body.prompt, body.style && `Photography style: ${body.style}`, body.background && `Background: ${body.background}`]
    .filter((value) => typeof value === "string" && value.trim())
    .join(". ");
  return `Professional commercial product photography of ${details}. Show the product clearly and centered with realistic proportions, refined lighting, clean composition, and high detail. No unnecessary text, watermark, random branding, readable labels, or fake logos unless explicitly requested by the product description.`;
}

export async function handleGenerateProductImage(request, env) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return error("Unauthorized.", 401);
  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) return error("No client account linked to this login.", 403);
  if (!env.AI) return error("Image generation is not configured. Please contact support.", 503);
  if (!env.RATE_LIMIT_KV) return error("Image generation is temporarily unavailable. Please contact support.", 503);

  const requestLimit = await checkRateLimit(env, `ai-image-request:${clientId}`, AI_PRODUCT_IMAGE_RATE_LIMIT);
  if (!requestLimit.allowed) return rateLimitResponse(requestLimit.retryAfter);
  const today = new Date().toISOString().slice(0, 10);
  const dailyLimit = Math.max(1, Number(env.AI_PRODUCT_IMAGE_LIMIT || DEFAULT_AI_PRODUCT_IMAGE_LIMIT));
  const daily = await checkRateLimit(env, `ai-image-daily:${clientId}:${today}`, { max: dailyLimit, windowSeconds: 86400 });
  if (!daily.allowed) return error("You have reached today's image generation limit. Please try again tomorrow.", 429);

  const body = await parseJsonBody(request);
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return error("A product description is required.");
  if (prompt.length > MAX_PROMPT_LENGTH) return error(`Product description must be ${MAX_PROMPT_LENGTH} characters or fewer.`);
  if (body.productName && (typeof body.productName !== "string" || body.productName.length > 200)) return error("Product name is invalid.");
  if (body.style && (typeof body.style !== "string" || body.style.length > 200)) return error("Photography style is invalid.");
  if (body.background && (typeof body.background !== "string" || body.background.length > 200)) return error("Background preference is invalid.");
  const allowedRatios = ["1:1", "4:5", "16:9"];
  if (body.aspectRatio && !allowedRatios.includes(body.aspectRatio)) return error("Invalid aspect ratio.");

  try {
    const form = new FormData();
    const { width, height } = dimensions(body.aspectRatio || "1:1");
    form.append("prompt", enhancedPrompt(body));
    form.append("width", String(width));
    form.append("height", String(height));
    const formResponse = new Response(form);
    const result = await env.AI.run(MODEL, {
      multipart: { body: formResponse.body, contentType: formResponse.headers.get("content-type") },
    });
    const imageBuffer = result instanceof ReadableStream ? await new Response(result).arrayBuffer() : result;
    if (!(imageBuffer instanceof ArrayBuffer) || imageBuffer.byteLength === 0 || imageBuffer.byteLength > MAX_IMAGE_BYTES) {
      return error("The image service returned an invalid image.", 502);
    }
    const imageData = base64FromBuffer(imageBuffer);
    const approvalToken = crypto.randomUUID();
    await env.RATE_LIMIT_KV.put(`ai-image-approval:${approvalToken}`, JSON.stringify({ clientId, digest: await digest(imageBuffer) }), { expirationTtl: APPROVAL_TTL });
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

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const key = `clients/${clientId}/products/generated/${year}/${month}/product-${crypto.randomUUID()}.png`;
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
