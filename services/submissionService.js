/**
 * Submission Service
 * ===================
 * Data access for form submissions and email logging.
 */

import { supabaseFetch } from "../lib/supabase.js";

/**
 * Save a form submission record.
 */
export async function saveSubmission(env, data, options = {}) {
  const {
    submissionId,
    clientId,
    formName,
    customerName,
    customerEmail,
    fields,
    status,
    ipAddress,
    userAgent,
  } = data;

  await supabaseFetch(
    env,
    "submissions",
    {
      method: "POST",
      prefer: "return=minimal",
      body: JSON.stringify({
        submission_id: submissionId,
        client_id: clientId,
        form_name: formName,
        customer_name: customerName,
        customer_email: customerEmail,
        submission_json: fields || {},
        status,
        ip_address: ipAddress,
        user_agent: userAgent,
      }),
      requestId: options.requestId,
    }
  );
}

/**
 * Store email IDs (from Resend) against a submission.
 */
export async function saveEmailIds(env, submissionId, ids, options = {}) {
  const { customerEmailId, ownerEmailId } = ids;

  await supabaseFetch(
    env,
    `submissions?submission_id=eq.${encodeURIComponent(submissionId)}`,
    {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({
        customer_email_id: customerEmailId,
        owner_email_id: ownerEmailId,
      }),
      requestId: options.requestId,
    }
  );
}

/**
 * Log an email send to the email_log table.
 */
export async function logEmail(env, data, options = {}) {
  const { clientId, relatedType, relatedId, recipient, subject, resendId } = data;

  await supabaseFetch(
    env,
    "email_log",
    {
      method: "POST",
      prefer: "return=minimal",
      body: JSON.stringify({
        client_id: clientId,
        related_type: relatedType,
        related_id: relatedId,
        recipient,
        subject,
        resend_id: resendId,
      }),
      requestId: options.requestId,
    }
  );
}

/**
 * Check if a client has any data rows (used during relink safety check).
 */
export async function clientHasNoData(env, clientId, options = {}) {
  const tables = ["products", "orders", "bookings", "invoices", "submissions"];
  for (const table of tables) {
    const rows = await supabaseFetch(
      env,
      `${table}?client_id=eq.${encodeURIComponent(clientId)}&select=id&limit=1`,
      { requestId: options.requestId }
    );
    if (rows && rows.length) return false;
  }
  return true;
}

