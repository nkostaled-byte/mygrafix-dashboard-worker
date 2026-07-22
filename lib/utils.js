/**
 * Utility Helpers
 * ===============
 * Generic reusable functions used across handlers.
 */

/**
 * Escape untrusted strings for safe HTML embedding.
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return "";

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Generate a reference string (e.g. "SUB-A1B2C3", "ORD-X9Y8Z7").
 * Uses cryptographically random bytes.
 * @param {string} prefix - e.g. "SUB", "ORD", "INV", "CLI"
 * @returns {string}
 */
export function generateReference(prefix) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);

  let suffix = "";
  for (const byte of bytes) {
    suffix += alphabet[byte % alphabet.length];
  }

  return `${prefix}-${suffix}`;
}

/**
 * Generate a submission ID (prefix "SUB").
 * @returns {string}
 */
export function generateSubmissionId() {
  return generateReference("SUB");
}

/**
 * Format a number as currency (e.g. "$12.50").
 * @param {number} value
 * @returns {string}
 */
export function formatMoney(value) {
  return `$${Number(value).toFixed(2)}`;
}

/**
 * Generate a short request ID for tracing.
 * @returns {string}
 */
export function generateRequestId() {
  const hex = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return `REQ-${hex}`;
}

/**
 * Parse JSON body safely. Returns null on failure.
 * @param {Request} request
 * @returns {Promise<object|null>}
 */
export async function parseJsonBody(request) {
  try {
    const data = await request.json();
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

