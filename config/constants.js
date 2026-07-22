/**
 * My Grafix Worker — Shared Constants
 * ======================================
 * Central place for all configuration constants used across the worker.
 */

// ==================================================
// CORS
// ==================================================

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ==================================================
// VALIDATION
// ==================================================

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const VALID_STATUSES = ["received", "pending", "confirmed", "cancelled", "completed"];

// ==================================================
// RATE LIMITING
// ==================================================

export const IP_RATE_LIMIT = { max: 20, windowSeconds: 60 };
export const CLIENT_RATE_LIMIT = { max: 60, windowSeconds: 60 };

// ==================================================
// UPLOADS
// ==================================================

export const ALLOWED_UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export const EXTENSION_BY_TYPE = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB
export const ALLOWED_UPLOAD_FOLDERS = ["logos", "profile", "products"];

// ==================================================
// FORM COPY (email templates per form type)
// ==================================================

export const FORM_COPY = {
  booking: {
    subject: "Booking Confirmed",
    heading: "Booking Confirmed",
    intro: "Your booking has been confirmed. Here's a summary:",
  },
  contact: {
    subject: "We've received your enquiry",
    heading: "Thanks for reaching out",
    intro: "We've received your enquiry. Here's a summary:",
  },
  quote: {
    subject: "Your quotation request has been received",
    heading: "Quote Request Received",
    intro: "Your quotation request has been received. Here's a summary:",
  },
  reservation: {
    subject: "Your reservation request has been received",
    heading: "Reservation Received",
    intro: "Your reservation request has been received. Here's a summary:",
  },
};

export const DEFAULT_FORM_COPY = {
  subject: "Your submission has been received",
  heading: "Submission Received",
  intro: "We've received your submission. Here's a summary:",
};

// ==================================================
// CSV EXPORT
// ==================================================

export const EXPORTABLE_TABLES = {
  customers: { filename: "customers", dateColumn: "created_at" },
  submissions: { filename: "submissions", dateColumn: "created_at" },
  orders: { filename: "orders", dateColumn: "created_at" },
  products: { filename: "products", dateColumn: "created_at" },
  bookings: { filename: "bookings", dateColumn: "start_time" },
  invoices: { filename: "invoices", dateColumn: "issued_at" },
};

// ==================================================
// ALLOWED DASHBOARD RESOURCES
// ==================================================

export const ALLOWED_DASHBOARD_RESOURCES = [
  "products", "customers", "bookings", "orders",
  "invoices", "submissions", "services", "staff", "team_members",
];

// ==================================================
// PDF CONSTANTS
// ==================================================

export const PDF_PAGE_WIDTH = 595;  // A4 in points
export const PDF_PAGE_HEIGHT = 842;
export const PDF_MARGIN = 50;
export const PDF_LINE_Y_THRESHOLD = 140; // bottom margin before items get cut

// ==================================================
// TIMEOUTS & RETRIES
// ==================================================

export const SUPABASE_TIMEOUT_MS = 20_000;  // 20 seconds
export const MAX_RETRIES = 2;
export const RETRY_BASE_DELAY_MS = 100;

// ==================================================
// VERSION
// ==================================================

export const WORKER_VERSION = "1.0.0";

