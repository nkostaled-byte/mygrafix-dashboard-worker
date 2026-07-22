/**
 * Supabase Client Helper
 * =======================
 * SINGLE reusable helper for all Supabase (PostgREST) communication.
 *
 * Requirements:
 * - All Supabase requests go through this helper (except /api/debug/supabase)
 * - AbortController with 20s timeout
 * - Retry on network failures (exponential backoff, 2 retries)
 * - Do NOT retry 4xx errors
 * - DEBUG=true logging (endpoint, query, URL, status, response time)
 * - Descriptive errors, never leak stack traces
 * - Supports GET, POST, PATCH, DELETE, RPC
 */

import {
  SUPABASE_TIMEOUT_MS,
  MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
} from "../config/constants.js";

/**
 * Execute a Supabase PostgREST request.
 *
 * @param {object} env - Worker env bindings (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
 * @param {string} path - PostgREST path (e.g. "products?client_id=eq.xxx&select=*")
 * @param {object} [options={}] - Optional overrides
 * @param {string} [options.method] - HTTP method (default: GET)
 * @param {string} [options.body] - JSON request body string
 * @param {string} [options.prefer] - Prefer header value (default: "return=representation")
 * @param {object} [options.headers] - Extra headers
 * @param {string} [options.requestId] - Request ID for debug logging
 * @param {boolean} [options.isRpc] - If true, uses /rpc/ path instead of /rest/v1/
 * @returns {Promise<object|Array|null>} Parsed JSON response
 */
export async function supabaseFetch(env, path, options = {}) {
  const baseUrl = (env.SUPABASE_URL || "").replace(/\/$/, "");
  const isRpc = options.isRpc === true;

  // Build the full URL
  const url = isRpc
    ? `${baseUrl}/rest/v1/rpc/${path}`
    : `${baseUrl}/rest/v1/${path}`;

  const method = options.method || "GET";
  const prefer = options.prefer || "return=representation";
  const requestId = options.requestId || "";
  const startTime = Date.now();

  // Debug log: request
  if (env.DEBUG === "true" || env.DEBUG === true) {
    const debugInfo = {
      requestId,
      method,
      path,
      url,
      body: options.body ? tryParseJsonPreview(options.body) : undefined,
    };
    console.log(`[${requestId}] SUPABASE_REQ:`, JSON.stringify(debugInfo));
  }

  // Attempt with retries
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);

      const response = await fetch(url, {
        method,
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: prefer,
          ...(options.headers || {}),
        },
        body: options.body || undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const elapsed = Date.now() - startTime;

      // Debug log: response
      if (env.DEBUG === "true" || env.DEBUG === true) {
        console.log(
          `[${requestId}] SUPABASE_RESP: ${response.status} ${method} ${path} ${elapsed}ms`
        );
      }

      if (!response.ok) {
        // Do NOT retry 4xx errors
        if (response.status >= 400 && response.status < 500) {
          const errorText = await response.text().catch(() => "Unknown error");
          throw new SupabaseError(
            `Supabase error (${response.status}) on ${path}: ${errorText}`,
            response.status
          );
        }

        // 5xx errors: retry
        if (response.status >= 500) {
          lastError = new SupabaseError(
            `Supabase error (${response.status}) on ${path}`,
            response.status
          );
          if (attempt < MAX_RETRIES) {
            await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
            continue;
          }
          throw lastError;
        }

        const errorText = await response.text().catch(() => "Unknown error");
        throw new SupabaseError(
          `Supabase error (${response.status}) on ${path}: ${errorText}`,
          response.status
        );
      }

      // 204 No Content
      if (response.status === 204) {
        if (env.DEBUG === "true" || env.DEBUG === true) {
          console.log(`[${requestId}] SUPABASE_DONE: ${method} ${path} ${elapsed}ms [204]`);
        }
        return null;
      }

      const text = await response.text();
      const result = text ? JSON.parse(text) : null;

      if (env.DEBUG === "true" || env.DEBUG === true) {
        console.log(`[${requestId}] SUPABASE_DONE: ${method} ${path} ${elapsed}ms [${response.status}]`);
      }

      return result;
    } catch (err) {
      // If it's a timeout (AbortError), throw immediately — no retry for timeouts
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new SupabaseError(
          `Supabase timeout after ${SUPABASE_TIMEOUT_MS}ms on ${path}`,
          504
        );
      }

      // If already a SupabaseError from 5xx handling, re-throw after retries exhausted
      if (err instanceof SupabaseError) {
        if (attempt < MAX_RETRIES && err.statusCode >= 500) {
          lastError = err;
          await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }

      // Network error — retry
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
    }
  }

  // All retries exhausted
  const elapsed = Date.now() - startTime;
  if (env.DEBUG === "true" || env.DEBUG === true) {
    console.log(`[${requestId}] SUPABASE_FAILED: ${method} ${path} ${elapsed}ms`);
  }
  throw new SupabaseError(
    lastError?.message || `Supabase request failed after ${MAX_RETRIES + 1} attempts on ${path}`,
    502
  );
}

// ---- Internal helpers ----

class SupabaseError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "SupabaseError";
    this.statusCode = statusCode;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryParseJsonPreview(str) {
  try {
    const parsed = JSON.parse(str);
    // Return a preview (truncate if too large)
    const preview = JSON.stringify(parsed);
    return preview.length > 500 ? preview.slice(0, 500) + "..." : preview;
  } catch {
    return str ? str.slice(0, 200) : undefined;
  }
}

