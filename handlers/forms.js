/**
 * Form Submission Handler
 * ========================
 * POST / — Accepts form submissions (contact/quote/booking/reservation)
 *
 * Workflow:
 * 1. Rate limit by IP
 * 2. Parse & validate JSON payload
 * 3. Rate limit by client
 * 4. Load client from Supabase
 * 5. Persist submission
 * 6. Send customer + owner emails
 * 7. Store email IDs + audit trail
 */

import { jsonResponse, rateLimitResponse } from "../lib/responses.js";
import { parseJsonBody, generateSubmissionId, generateRequestId } from "../lib/utils.js";
import { validatePayload } from "../lib/validation.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { IP_RATE_LIMIT, CLIENT_RATE_LIMIT, VALID_STATUSES } from "../config/constants.js";
import { loadClient } from "../services/clientService.js";
import { saveSubmission, saveEmailIds, logEmail } from "../services/submissionService.js";
import { sendEmail, buildCustomerEmail, buildOwnerEmail, getFormCopy, buildFromAddress } from "../lib/email.js";

/**
 * POST /
 */
export async function handleSubmission(request, env) {
  const requestId = generateRequestId();
  const ipAddress = request.headers.get("CF-Connecting-IP") || "";
  const userAgent = request.headers.get("User-Agent") || "";

  // 1. Rate limit by IP
  const ipLimit = await checkRateLimit(env, `ip:${ipAddress}`, IP_RATE_LIMIT);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfter);

  // 2. Parse JSON safely
  const payload = await parseJsonBody(request);
  if (!payload) {
    return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);
  }

  // 3. Validate payload
  const validationError = validatePayload(payload);
  if (validationError) {
    return jsonResponse({ success: false, error: validationError }, 400);
  }

  const { clientId, formName, customer, fields, website } = payload;
  const status = VALID_STATUSES.includes(payload.status) ? payload.status : "received";

  // 4. Rate limit by client
  const clientLimit = await checkRateLimit(env, `client:${clientId}`, CLIENT_RATE_LIMIT);
  if (!clientLimit.allowed) return rateLimitResponse(clientLimit.retryAfter);

  // 5. Load client
  const client = await loadClient(env, clientId, { requestId });
  if (!client) {
    return jsonResponse({ success: false, error: "Unknown client." }, 404);
  }
  if (!client.active) {
    return jsonResponse({ success: false, error: "Client account is inactive." }, 403);
  }

  // 6. Generate reference + timestamp
  const submissionId = generateSubmissionId();
  const receivedAt = new Date().toISOString();

  const context = {
    submissionId,
    clientId,
    formName,
    website: website || "",
    ipAddress,
    userAgent,
    receivedAt,
  };

  // 7. Persist submission
  await saveSubmission(env, {
    submissionId,
    clientId,
    formName,
    customerName: customer.name,
    customerEmail: customer.email,
    fields,
    status,
    ipAddress,
    userAgent,
  }, { requestId });

  // 8. Send customer confirmation email
  const customerEmailResult = await sendEmail(env, {
    to: customer.email,
    from: buildFromAddress(client),
    replyTo: client.reply_email || undefined,
    subject: getFormCopy(formName).subject,
    html: buildCustomerEmail(client, formName, customer, fields, context),
  }).catch((err) => {
    console.error(`[${requestId}] Failed to send customer email:`, err.message);
    return { id: null };
  });

  // 9. Send owner notification email
  const ownerEmailResult = await sendEmail(env, {
    to: client.owner_email,
    from: buildFromAddress(client),
    replyTo: client.reply_email || undefined,
    subject: `New ${formName} submission`,
    html: buildOwnerEmail(client, formName, customer, fields, context),
  }).catch((err) => {
    console.error(`[${requestId}] Failed to send owner email:`, err.message);
    return { id: null };
  });

  // 10. Store email IDs
  await saveEmailIds(env, submissionId, {
    customerEmailId: customerEmailResult?.id || null,
    ownerEmailId: ownerEmailResult?.id || null,
  }, { requestId });

  // 11. Log email sends
  await Promise.all([
    logEmail(env, {
      clientId,
      relatedType: "submission",
      relatedId: null,
      recipient: customer.email,
      subject: getFormCopy(formName).subject,
      resendId: customerEmailResult?.id || null,
    }, { requestId }),
    logEmail(env, {
      clientId,
      relatedType: "submission",
      relatedId: null,
      recipient: client.owner_email,
      subject: `New ${formName} submission`,
      resendId: ownerEmailResult?.id || null,
    }, { requestId }),
  ]);

  return jsonResponse({
    success: true,
    submissionId,
    receivedAt,
  });
}

