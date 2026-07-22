/**
 * Request Payload Validators
 * ===========================
 * Validate incoming request bodies before processing.
 */

import { EMAIL_REGEX, VALID_STATUSES } from "../config/constants.js";

/**
 * Validate a form submission payload.
 * @param {object} payload
 * @returns {string|null} Error message or null if valid
 */
export function validatePayload(payload) {
  if (!payload.clientId || typeof payload.clientId !== "string") {
    return "Missing or invalid 'clientId'.";
  }

  if (!payload.formName || typeof payload.formName !== "string") {
    return "Missing or invalid 'formName'.";
  }

  if (!payload.customer || typeof payload.customer !== "object") {
    return "Missing or invalid 'customer' object.";
  }

  if (!payload.customer.name || typeof payload.customer.name !== "string") {
    return "Missing or invalid 'customer.name'.";
  }

  if (!payload.customer.email || typeof payload.customer.email !== "string") {
    return "Missing or invalid 'customer.email'.";
  }

  if (!EMAIL_REGEX.test(payload.customer.email.trim())) {
    return "Invalid 'customer.email' format.";
  }

  if (
    payload.fields !== undefined &&
    (typeof payload.fields !== "object" || payload.fields === null || Array.isArray(payload.fields))
  ) {
    return "'fields' must be an object of key/value pairs.";
  }

  if (payload.status !== undefined && !VALID_STATUSES.includes(payload.status)) {
    return `'status' must be one of: ${VALID_STATUSES.join(", ")}.`;
  }

  if (payload.website !== undefined && typeof payload.website !== "string") {
    return "'website' must be a string.";
  }

  return null;
}

/**
 * Validate an order creation payload.
 * @param {object} payload
 * @returns {string|null} Error message or null if valid
 */
export function validateOrderPayload(payload) {
  if (!payload.clientId || typeof payload.clientId !== "string") return "Missing or invalid 'clientId'.";
  if (!payload.customer || typeof payload.customer !== "object") return "Missing or invalid 'customer' object.";
  if (!payload.customer.name || typeof payload.customer.name !== "string") return "Missing or invalid 'customer.name'.";
  if (!payload.customer.email || !EMAIL_REGEX.test(String(payload.customer.email).trim())) {
    return "Missing or invalid 'customer.email'.";
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return "'items' must be a non-empty array.";
  }
  for (const item of payload.items) {
    if (!item.productId || typeof item.productId !== "string") return "Each item needs a valid 'productId'.";
    if (!Number.isInteger(item.qty) || item.qty <= 0) return "Each item needs a positive integer 'qty'.";
  }
  return null;
}

/**
 * Validate a booking creation payload.
 * @param {object} payload
 * @returns {string|null} Error message or null if valid
 */
export function validateBookingPayload(payload) {
  if (!payload.clientId || typeof payload.clientId !== "string") return "Missing or invalid 'clientId'.";
  if (!payload.customer || typeof payload.customer !== "object") return "Missing or invalid 'customer' object.";
  if (!payload.customer.name || typeof payload.customer.name !== "string") return "Missing or invalid 'customer.name'.";
  if (!payload.customer.email || !EMAIL_REGEX.test(String(payload.customer.email).trim())) {
    return "Missing or invalid 'customer.email'.";
  }
  if (!payload.serviceId || typeof payload.serviceId !== "string") return "Missing or invalid 'serviceId'.";
  if (!payload.startTime || isNaN(Date.parse(payload.startTime))) return "Missing or invalid 'startTime'.";
  return null;
}

/**
 * Validate an invoice creation payload.
 * @param {object} payload
 * @returns {string|null} Error message or null if valid
 */
export function validateInvoicePayload(payload) {
  if (!payload.customer || typeof payload.customer !== "object") return "Missing or invalid 'customer' object.";
  if (!payload.customer.id && !payload.customer.name) return "'customer' needs either an 'id' or a 'name'.";
  if (!Array.isArray(payload.items) || payload.items.length === 0) return "'items' must be a non-empty array.";
  for (const item of payload.items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) return "Each item needs a positive integer 'quantity'.";
    if (typeof item.price !== "number" || item.price < 0) return "Each item needs a numeric 'price'.";
  }
  return null;
}

