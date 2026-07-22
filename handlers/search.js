/**
 * Search Handler
 * ===============
 * GET /api/search — Dashboard-triggered global search via Supabase RPC.
 *
 * Query params:
 *   ?q=search_term (minimum 2 characters)
 *
 * Requires valid Supabase JWT authentication.
 */

import { jsonResponse } from "../lib/responses.js";
import { generateRequestId } from "../lib/utils.js";
import { verifySupabaseJwt, resolveClientId } from "../lib/auth.js";
import { supabaseFetch } from "../lib/supabase.js";

/**
 * GET /api/search
 */
export async function handleSearch(request, env) {
  const requestId = generateRequestId();

  // Authenticate
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();

  if (q.length < 2) {
    return jsonResponse({ success: false, error: "Search query must be at least 2 characters." }, 400);
  }

  const results = await supabaseFetch(
    env,
    "search_all",
    {
      method: "POST",
      prefer: "return=representation",
      body: JSON.stringify({ p_client_id: clientId, q }),
      isRpc: true,
      requestId,
    }
  );

  return jsonResponse({ success: true, query: q, results });
}

