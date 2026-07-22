/**
 * HTTP Response Helpers
 * ======================
 * Consistent JSON response builders used across all handlers.
 */

import { CORS_HEADERS } from "../config/constants.js";

/**
 * Create a JSON response with CORS headers.
 * @param {*} body - The JSON body to return
 * @param {number} [status=200] - HTTP status code
 * @param {object} [extraHeaders={}] - Additional headers
 * @returns {Response}
 */
export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: { ...CORS_HEADERS, ...extraHeaders },
  });
}

/**
 * Create a 429 rate-limit response.
 * @param {number} retryAfter - Seconds to wait before retrying
 * @returns {Response}
 */
export function rateLimitResponse(retryAfter) {
  return jsonResponse(
    { success: false, error: "Too many requests. Please try again shortly." },
    429,
    { "Retry-After": String(retryAfter) }
  );
}

/**
 * Handle CORS preflight OPTIONS request.
 * @returns {Response}
 */
export function handleOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

