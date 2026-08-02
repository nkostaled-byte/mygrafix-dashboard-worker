/**
 * CSV Export Handler
 * ===================
 * GET /api/export/:table — Dashboard-triggered CSV downloads with date filtering.
 *
 * Supports: customers, submissions, orders, products, bookings, invoices
 */

import { jsonResponse } from "../lib/responses.js";
import { generateRequestId } from "../lib/utils.js";
import { verifySupabaseJwt, resolveClientId } from "../lib/auth.js";
import { supabaseFetch } from "../lib/supabase.js";
import { rowsToCsv } from "../lib/csv.js";
import { EXPORTABLE_TABLES, CORS_HEADERS } from "../config/constants.js";
import { loadClient } from "../services/clientService.js";
import { canAccessPlan, planAccessDenied } from "../lib/planAccess.js";

/**
 * GET /api/export/:table
 *
 * Query params:
 *   ?from=2026-01-01 (optional, date filter start)
 *   ?to=2026-01-31   (optional, date filter end)
 *
 * Returns a downloadable CSV file.
 */
export async function handleExport(request, env, table) {
  const requestId = generateRequestId();

  // Authenticate
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }

  // Reports & Exports require the Business plan or higher
  const client = await loadClient(env, clientId, { requestId });
  if (!client) return jsonResponse({ success: false, error: "Client not found." }, 404);
  if (!canAccessPlan(client, "business")) return planAccessDenied("business");

  // Validate export table
  const config = EXPORTABLE_TABLES[table];
  if (!config) {
    return jsonResponse(
      {
        success: false,
        error: `Unknown export table. Choose one of: ${Object.keys(EXPORTABLE_TABLES).join(", ")}`,
      },
      400
    );
  }

  const url = new URL(request.url);
  const dateFrom = url.searchParams.get("from");
  const dateTo = url.searchParams.get("to");

  let path = `${table}?client_id=eq.${encodeURIComponent(clientId)}&select=*`;
  if (dateFrom) path += `&${config.dateColumn}=gte.${encodeURIComponent(dateFrom)}`;
  if (dateTo) path += `&${config.dateColumn}=lte.${encodeURIComponent(dateTo)}`;
  path += `&order=${config.dateColumn}.desc`;

  const rows = await supabaseFetch(env, path, { requestId });
  const csv = rowsToCsv(rows || []);
  const filename = `${config.filename}-${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

