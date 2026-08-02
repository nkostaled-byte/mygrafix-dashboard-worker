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
import { verifySupabaseJwt, resolveUserRole } from "../lib/auth.js";
import { supabaseFetch } from "../lib/supabase.js";
import { clientHasNoData } from "../services/submissionService.js";

/**
 * GET /api/claim-account/status
 *
 * Lightweight check: is the authenticated user linked to a business?
 * Returns { linked: boolean, clientId: string | null, businessName: string | null, role: string | null }
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
      role: "owner",
    });
  }

  const teamRows = await supabaseFetch(
    env,
    `team_members?auth_user_id=eq.${encodeURIComponent(authUserId)}&active=eq.true&select=client_id,role&limit=1`,
    { requestId: generateRequestId() }
  );

  if (teamRows && teamRows.length) {
    return jsonResponse({
      success: true,
      linked: true,
      clientId: teamRows[0].client_id,
      businessName: null,
      role: teamRows[0].role || "staff",
    });
  }

  return jsonResponse({
    success: true,
    linked: false,
    clientId: null,
    businessName: null,
    role: null,
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
 * GET /api/client-settings
 * Returns the authenticated client's business/invoice settings for the Settings page.
 */
export async function handleGetClientSettings(request, env) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  // Resolve the client exactly like the dashboard handlers do — supports both
  // client owners (clients.auth_user_id) and linked team members.
  const resolved = await resolveUserRole(env, claims.sub);
  if (!resolved) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 404);
  }
  // Settings are owner/admin only — staff roles are excluded
  if (resolved.role === "staff") {
    return jsonResponse({ success: false, error: "Insufficient permissions." }, 403);
  }
  const clientId = resolved.clientId;

  // Use select=* so a missing column (e.g. a not-yet-applied migration) never
  // fails the whole request — PostgREST only returns columns that exist.
  const clients = await supabaseFetch(
    env,
    `clients?client_id=eq.${encodeURIComponent(clientId)}&select=*`,
    { requestId: generateRequestId() }
  );
  const raw = clients && clients[0];
  if (!raw) {
    return jsonResponse({ success: false, error: "Client not found." }, 404);
  }

  return jsonResponse({
    success: true,
    data: {
      businessName: raw.business_name ?? "",
      phone: raw.phone ?? "",
      address: raw.address ?? "",
      openingHours: raw.opening_hours ?? "",
      bankName: raw.bank_name ?? "",
      bankAccountName: raw.bank_account_name ?? "",
      bankAccountNumber: raw.bank_account_number ?? "",
      bankBranchCode: raw.bank_branch_code ?? "",
      bankAccountType: raw.bank_account_type ?? "",
      bankReference: raw.bank_reference ?? "",
      paymentInstructions: raw.payment_instructions ?? "",
      logoUrl: raw.logo_url ?? "",
      primaryColor: raw.primary_color ?? "",
      secondaryColor: raw.secondary_color ?? "",
      ownerEmail: raw.owner_email ?? "",
    },
  });
}

/**
 * PUT /api/client-settings
 * Updates the authenticated client's business/invoice settings.
 * Accepts any subset of: business_name, phone, address, opening_hours,
 * bank_name, bank_account_name, bank_account_number, bank_branch_code,
 * bank_account_type, bank_reference, payment_instructions, logo_url,
 * primary_color, secondary_color, reply_email.
 */
export async function handleUpdateClientSettings(request, env) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const resolved = await resolveUserRole(env, claims.sub);
  if (!resolved) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }
  // Settings are owner/admin only — staff roles are excluded
  if (resolved.role === "staff") {
    return jsonResponse({ success: false, error: "Insufficient permissions." }, 403);
  }
  const clientId = resolved.clientId;

  const clients = await supabaseFetch(
    env,
    `clients?client_id=eq.${encodeURIComponent(clientId)}&select=*`,
    { requestId: generateRequestId() }
  );
  const existingRow = clients && clients[0];
  if (!existingRow) {
    return jsonResponse({ success: false, error: "Client not found." }, 404);
  }

  const payload = await parseJsonBody(request);
  if (!payload) return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);

  const allowedFields = [
    "business_name", "phone", "address", "opening_hours",
    "bank_name", "bank_account_name", "bank_account_number",
    "bank_branch_code", "bank_account_type", "bank_reference",
    "payment_instructions",
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
    bankAccountType: "bank_account_type",
    bank_account_type: "bank_account_type",
    bankReference: "bank_reference",
    bank_reference: "bank_reference",
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

  // Only PATCH columns that actually exist on the client row. This keeps the
  // save from failing when a column hasn't been added to the database yet
  // (e.g. a not-yet-applied migration for bank_account_type/bank_reference).
  const existingColumns = new Set(Object.keys(existingRow));
  const finalUpdates = {};
  for (const [column, value] of Object.entries(updates)) {
    if (existingColumns.has(column)) {
      finalUpdates[column] = value;
    }
  }

  if (Object.keys(finalUpdates).length === 0) {
    return jsonResponse({ success: false, error: "No valid fields to update." }, 400);
  }

  await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(clientId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(finalUpdates),
    requestId: generateRequestId(),
  });

  return jsonResponse({ success: true });
}

