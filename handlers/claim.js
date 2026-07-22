/**
 * Account Claiming Handlers
 * ==========================
 *
 * POST /api/claim-account — Called after Supabase Auth signup.
 * POST /api/claim-account/relink — Manual relink with claim code.
 */

import { jsonResponse } from "../lib/responses.js";
import { parseJsonBody, generateReference, generateRequestId } from "../lib/utils.js";
import { verifySupabaseJwt, resolveClientId } from "../lib/auth.js";
import { supabaseFetch } from "../lib/supabase.js";
import { clientHasNoData } from "../services/submissionService.js";

/**
 * POST /api/claim-account
 *
 * Three possible outcomes:
 * 1. Already linked — no-op
 * 2. Existing client row (by email) with no auth_user_id — link it
 * 3. No existing record — create a new client
 */
export async function handleClaimAccount(request, env) {
  const requestId = generateRequestId();

  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);
  if (!claims.email) return jsonResponse({ success: false, error: "Token has no email claim." }, 400);

  const authUserId = claims.sub;
  const email = claims.email.toLowerCase();

  // 1. Already linked?
  const alreadyLinked = await supabaseFetch(
    env,
    `clients?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=client_id,business_name`,
    { requestId }
  );
  if (alreadyLinked && alreadyLinked.length) {
    return jsonResponse({ success: true, status: "already_linked", client: alreadyLinked[0] });
  }

  // 2. Pre-existing client with matching email, not yet claimed
  const unclaimed = await supabaseFetch(
    env,
    `clients?owner_email=ilike.${encodeURIComponent(email)}&auth_user_id=is.null&select=client_id,business_name`,
    { requestId }
  );
  if (unclaimed && unclaimed.length) {
    const client = unclaimed[0];
    await supabaseFetch(
      env,
      `clients?client_id=eq.${encodeURIComponent(client.client_id)}`,
      {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({ auth_user_id: authUserId }),
        requestId,
      }
    );
    return jsonResponse({ success: true, status: "linked", client });
  }

  // 3. No existing record — create new client
  const payload = await parseJsonBody(request);
  const businessName = payload?.businessName || "My Business";
  const clientId = generateReference("CLI").toLowerCase();

  const [created] = await supabaseFetch(env, "clients", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      auth_user_id: authUserId,
      business_name: businessName,
      owner_email: email,
      active: true,
    }),
    requestId,
  });

  return jsonResponse({ success: true, status: "created", client: created });
}

/**
 * POST /api/claim-account/relink
 *
 * Manual relink using a claim code. For cases like Google email mismatch.
 */
export async function handleRelinkAccount(request, env) {
  const requestId = generateRequestId();

  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const payload = await parseJsonBody(request);
  const claimCode = (payload?.claimCode || "").trim().toUpperCase();
  if (!claimCode) {
    return jsonResponse({ success: false, error: "Missing 'claimCode'." }, 400);
  }

  const authUserId = claims.sub;

  // Find target client by claim code
  const targets = await supabaseFetch(
    env,
    `clients?claim_code=eq.${encodeURIComponent(claimCode)}&select=*`,
    { requestId }
  );
  const target = targets && targets[0];
  if (!target) {
    return jsonResponse({ success: false, error: "Invalid claim code." }, 404);
  }

  // Already linked to this user
  if (target.auth_user_id === authUserId) {
    return jsonResponse({ success: true, status: "already_linked", client: target });
  }

  // Already linked to someone else
  if (target.auth_user_id) {
    return jsonResponse(
      { success: false, error: "This business is already linked to another account. Contact support." },
      409
    );
  }

  // Check if user already owns a placeholder client
  const existingOwned = await supabaseFetch(
    env,
    `clients?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=client_id`,
    { requestId }
  );

  if (existingOwned && existingOwned.length && existingOwned[0].client_id !== target.client_id) {
    const placeholderId = existingOwned[0].client_id;
    const isEmpty = await clientHasNoData(env, placeholderId, { requestId });

    if (!isEmpty) {
      return jsonResponse(
        {
          success: false,
          error:
            "Your account already has data under a different business record. This needs a manual merge — contact support rather than continuing here.",
        },
        409
      );
    }

    // Release the empty placeholder
    await supabaseFetch(
      env,
      `clients?client_id=eq.${encodeURIComponent(placeholderId)}`,
      {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({ auth_user_id: null, active: false }),
        requestId,
      }
    );
  }

  // Link target to current user
  await supabaseFetch(
    env,
    `clients?client_id=eq.${encodeURIComponent(target.client_id)}`,
    {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ auth_user_id: authUserId }),
      requestId,
    }
  );

  return jsonResponse({ success: true, status: "linked", client: { ...target, auth_user_id: authUserId } });
}

