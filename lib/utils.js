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

/**
 * Recursively convert all object keys from snake_case to camelCase.
 * Handles nested objects and arrays. Leaves non-plain values unchanged.
 * @param {*} value
 * @returns {*}
 */
export function snakeToCamel(value) {
  if (Array.isArray(value)) {
    return value.map(snakeToCamel);
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      result[camelKey] = snakeToCamel(val);
    }
    return result;
  }
  return value;
}

/**
 * Recursively convert all object keys from camelCase to snake_case.
 * Handles nested objects and arrays. Leaves non-plain values unchanged.
 * @param {*} value
 * @returns {*}
 */
export function camelToSnake(value) {
  if (Array.isArray(value)) {
    return value.map(camelToSnake);
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
      result[snakeKey] = camelToSnake(val);
    }
    return result;
  }
  return value;
}

/**
 * Resource-specific field overrides for snake_case ↔ camelCase mapping.
 * Keys are the GENERICALLY TRANSFORMED key (after snakeToCamel or camelToSnake),
 * values are the final desired key.
 */
const RESOURCE_FIELD_MAP_READ = {
  products: {
    stockQty: "stock",
  },
  orders: {
    total: "totalAmount",
  },
  invoices: {
    total: "totalAmount",
  },
  gallery: {
    beforeUrl: "imageUrl",
  },
  reviews: {
    name: "customerName",
    text: "comment",
    service: "serviceOrProduct",
  },
};

const RESOURCE_FIELD_MAP_WRITE = {
  products: {
    stock: "stock_qty",
  },
  orders: {
    total_amount: "total",
  },
  invoices: {
    total_amount: "total",
  },
  gallery: {
    image_url: "before_url",
  },
  reviews: {
    customer_name: "name",
    comment: "text",
    service_or_product: "service",
  },
};

/**
 * Apply resource-aware field mapping to an object or array of objects.
 * Applies generic key conversion first, then checks for explicit field overrides.
 * @param {*} value - object, array, or primitive
 * @param {string} resource - e.g. "products", "orders"
 * @param {string} direction - "toCamel" (db→frontend) or "toSnake" (frontend→db)
 * @returns {*}
 */
export function mapResourceFields(value, resource, direction) {
  const fieldMap = direction === "toCamel" ? RESOURCE_FIELD_MAP_READ[resource] : RESOURCE_FIELD_MAP_WRITE[resource];

  if (Array.isArray(value)) {
    return value.map(v => mapResourceFields(v, resource, direction));
  }

  if (value && typeof value === "object" && !(value instanceof Date)) {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      const transformedKey = direction === "toCamel"
        ? key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
        : key.replace(/([A-Z])/g, "_$1").toLowerCase();
      const finalKey = fieldMap?.[transformedKey] || transformedKey;
      result[finalKey] = mapResourceFields(val, resource, direction);
    }
    return result;
  }

  return value;
}

