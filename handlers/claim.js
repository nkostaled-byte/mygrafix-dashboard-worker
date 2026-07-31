/**
 * Account Claiming Handlers
 * ==========================
 *
 * GET /api/claim-account/status — Check if user is linked to a business
 * POST /api/claim-account — Create a new business or link existing
 * POST /api/claim-account/relink — Manual relink with claim code
 */

import { jsonResponse } from "../lib/responses.js";
import { parseJsonBody, generateReference, generateRequestId } from "../lib/utils.js";
import { verifySupabaseJwt, resolveClientId } from "../lib/auth.js";
import { supabaseFetch } from "../lib/supabase.js";
import { clientHasNoData } from "../services/submissionService.js";

/**
 * GET /api/claim-account/status
 *
 * Lightweight check: is the authenticated user linked to a business?
 * Returns { linked: boolean, clientId: string | null, businessName: string | null }
 */
export async function handleClaimStatus(request, env) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const authUserId = claims.sub;

  const clients = await supabaseFetch(
    env,
    `clients?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=client_id,business_name&limit=1`,
    { requestId: generateRequestId() }
  );

  if (clients && clients.length) {
    return jsonResponse({
      success: true,
      linked: true,
      clientId: clients[0].client_id,
      businessName: clients[0].business_name,
    });
  }

  return jsonResponse({
    success: true,
    linked: false,
    clientId: null,
    businessName: null,
  });
}

/**
 * POST /api/claim-account
 *
 * Three possible outcomes:
 * 1. Already linked — no-op
 * 2. Existing client row (by email) with no auth_user_id — link it
 * 3. No existing record — create a new client with full business details
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
    `clients?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=client_id,business_name,business_type,country,currency,timezone,owner_email,phone,primary_color,logo_url`,
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

  // 3. No existing record — create new client with full business details
  const payload = await parseJsonBody(request);
  const businessName = payload?.businessName || "My Business";
  const businessType = payload?.businessType || null;
  const country = payload?.country || null;
  const currency = payload?.currency || null;
  const timezone = payload?.timezone || null;
  const phone = payload?.phone || null;
  const primaryColor = payload?.primaryColor || null;
  const logoUrl = payload?.logoUrl || null;
  const clientId = generateReference("CLI").toLowerCase();

  const [created] = await supabaseFetch(env, "clients", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      auth_user_id: authUserId,
      business_name: businessName,
      business_type: businessType,
      country: country,
      currency: currency,
      timezone: timezone,
      owner_email: email,
      phone: phone,
      primary_color: primaryColor,
      logo_url: logoUrl,
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

/**
 * PUT /api/client-settings
 * Updates the authenticated client's business/invoice settings.
 * Accepts any subset of: business_name, phone, address, opening_hours,
 * bank_name, bank_account_name, bank_account_number, bank_branch_code,
 * payment_instructions, logo_url, primary_color, secondary_color.
 */
export async function handleUpdateClientSettings(request, env) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const authUserId = claims.sub;

  const clients = await supabaseFetch(
    env,
    `clients?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=client_id`,
    { requestId: generateRequestId() }
  );
  if (!clients || !clients.length) {
    return jsonResponse({ success: false, error: "Client not found." }, 404);
  }
  const clientId = clients[0].client_id;

  const payload = await parseJsonBody(request);
  if (!payload) return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);

  const allowedFields = [
    "business_name", "phone", "address", "opening_hours",
    "bank_name", "bank_account_name", "bank_account_number",
    "bank_branch_code", "payment_instructions",
    "logo_url", "primary_color", "secondary_color",
    "reply_email",
  ];

  // Map camelCase payload keys to snake_case DB columns
  const keyMap = {
    businessName: "business_name",
    business_name: "business_name",
    phone: "phone",
    address: "address",
    openingHours: "opening_hours",
    opening_hours: "opening_hours",
    bankName: "bank_name",
    bank_name: "bank_name",
    bankAccountName: "bank_account_name",
    bank_account_name: "bank_account_name",
    bankAccountNumber: "bank_account_number",
    bank_account_number: "bank_account_number",
    bankBranchCode: "bank_branch_code",
    bank_branch_code: "bank_branch_code",
    paymentInstructions: "payment_instructions",
    payment_instructions: "payment_instructions",
    logoUrl: "logo_url",
    logo_url: "logo_url",
    primaryColor: "primary_color",
    primary_color: "primary_color",
    secondaryColor: "secondary_color",
    secondary_color: "secondary_color",
    replyEmail: "reply_email",
    reply_email: "reply_email",
  };

  const updates = {};
  for (const [key, value] of Object.entries(payload)) {
    const dbColumn = keyMap[key];
    if (dbColumn && allowedFields.includes(dbColumn)) {
      updates[dbColumn] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    return jsonResponse({ success: false, error: "No valid fields to update." }, 400);
  }

  await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(clientId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(updates),
    requestId: generateRequestId(),
  });

  return jsonResponse({ success: true });
}

