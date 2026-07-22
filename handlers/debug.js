/**
 * Debug & Health Endpoints
 * =========================
 * Temporary endpoints for debugging Worker and Supabase connectivity.
 *
 * GET /api/health
 * GET /api/debug/supabase
 */

import { jsonResponse } from "../lib/responses.js";
import { WORKER_VERSION } from "../config/constants.js";

/**
 * GET /api/health
 * Returns worker alive status.
 */
export async function handleHealth(request, env) {
  return jsonResponse({
    success: true,
    worker: true,
    version: WORKER_VERSION,
  });
}

/**
 * GET /api/debug/supabase
 *
 * IMPORTANT: This endpoint MUST NOT use supabaseFetch().
 * It directly calls fetch() to verify raw connectivity.
 *
 * Performs exactly one request:
 *   GET /rest/v1/clients?select=client_id&limit=1
 *
 * Returns the request URL, HTTP status, response headers, response body, and timing.
 */
export async function handleDebugSupabase(request, env) {
  const baseUrl = (env.SUPABASE_URL || "").replace(/\/$/, "");
  const url = `${baseUrl}/rest/v1/clients?select=client_id&limit=1`;

  const startTime = Date.now();
  let status = 0;
  let headers = {};
  let body = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY || "",
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || ""}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    status = response.status;
    // Collect relevant headers
    const headerNames = ["content-type", "x-request-id", "retry-after", "content-range"];
    for (const name of headerNames) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }

    const text = await response.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return jsonResponse({
        success: false,
        error: "Supabase timeout",
        url,
        timeMs: Date.now() - startTime,
      }, 504);
    }
    return jsonResponse({
      success: false,
      error: err.message || "Unknown error",
      url,
      timeMs: Date.now() - startTime,
    }, 502);
  }

  const elapsed = Date.now() - startTime;

  return jsonResponse({
    success: true,
    url,
    status,
    headers,
    body,
    timeMs: elapsed,
  });
}

