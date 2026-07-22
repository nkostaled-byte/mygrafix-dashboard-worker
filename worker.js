/**
 * My Grafix Worker — Entry Point (Router)
 * =========================================
 *
 * This file is the single entry point for the Cloudflare Worker.
 * It routes requests to the appropriate handler modules.
 *
 * Architecture:
 *   worker.js          → Router (this file)
 *   config/            → Constants
 *   lib/               → Shared utilities (supabase, auth, responses, etc.)
 *   services/          → Data access layer
 *   handlers/          → Request handlers
 *
 * All Supabase communication goes through ONE helper: lib/supabase.js
 * The only exception is GET /api/debug/supabase which uses raw fetch().
 */

import { handleOptions, jsonResponse } from "./lib/responses.js";
import { generateRequestId } from "./lib/utils.js";
import { handleSubmission } from "./handlers/forms.js";
import { handlePublicSite, handlePublicAvailability } from "./handlers/public.js";
import { handleDashboardRoute } from "./handlers/dashboard.js";
import { handleClaimAccount, handleRelinkAccount } from "./handlers/claim.js";
import { handleSearch } from "./handlers/search.js";
import { handleUpload } from "./handlers/upload.js";
import { handleCreateOrder } from "./handlers/orders.js";
import { handleCreateBooking } from "./handlers/bookings.js";
import { handleCreateInvoice, handleSendInvoice } from "./handlers/invoices.js";
import { handleExport } from "./handlers/export.js";
import { handleHealth, handleDebugSupabase } from "./handlers/debug.js";

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return handleOptions();
    }

    const url = new URL(request.url);
    const requestId = generateRequestId();

    // Log incoming request (minimal when DEBUG=false)
    if (env.DEBUG === "true" || env.DEBUG === true) {
      console.log(`[${requestId}] ${request.method} ${url.pathname}${url.search}`);
    }

    try {
      // ---- Health & Debug ----
      if (request.method === "GET" && url.pathname === "/api/health") {
        return await handleHealth(request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/debug/supabase") {
        return await handleDebugSupabase(request, env);
      }

      // ---- Public endpoints ----
      if (request.method === "GET" && url.pathname === "/api/public/site") {
        return await handlePublicSite(url, env);
      }

      if (request.method === "GET" && url.pathname === "/api/public/availability") {
        return await handlePublicAvailability(url, env);
      }

      // ---- Dashboard CRUD ----
      if (url.pathname.startsWith("/api/dashboard/")) {
        if (["GET", "POST", "PUT", "DELETE"].includes(request.method)) {
          return await handleDashboardRoute(request, env, url);
        }
        return jsonResponse({ success: false, error: "Method not allowed." }, 405);
      }

      // ---- Claim account ----
      if (request.method === "POST" && url.pathname === "/api/claim-account") {
        return await handleClaimAccount(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/claim-account/relink") {
        return await handleRelinkAccount(request, env);
      }

      // ---- Search ----
      if (request.method === "GET" && url.pathname === "/api/search") {
        return await handleSearch(request, env);
      }

      // ---- Upload ----
      if (request.method === "POST" && url.pathname === "/api/upload") {
        return await handleUpload(request, env, url);
      }

      // ---- Orders ----
      if (request.method === "POST" && url.pathname === "/api/orders") {
        return await handleCreateOrder(request, env);
      }

      // ---- Bookings ----
      if (request.method === "POST" && url.pathname === "/api/bookings") {
        return await handleCreateBooking(request, env);
      }

      // ---- Invoices ----
      const sendInvoiceMatch = url.pathname.match(/^\/api\/invoices\/([0-9a-fA-F-]+)\/send$/);
      if (request.method === "POST" && sendInvoiceMatch) {
        return await handleSendInvoice(request, env, sendInvoiceMatch[1]);
      }

      if (request.method === "POST" && url.pathname === "/api/invoices") {
        return await handleCreateInvoice(request, env);
      }

      // ---- Export ----
      const exportMatch = url.pathname.match(/^\/api\/export\/([a-z_]+)$/);
      if (request.method === "GET" && exportMatch) {
        return await handleExport(request, env, exportMatch[1]);
      }

      // ---- Form submissions (catch-all POST) ----
      if (request.method === "POST") {
        return await handleSubmission(request, env);
      }

      // ---- Fallback ----
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    } catch (err) {
      console.error(`[${requestId}] Unhandled error:`, err.message);
      return jsonResponse(
        {
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        },
        500
      );
    }
  },
};

