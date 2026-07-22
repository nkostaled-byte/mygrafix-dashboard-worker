/**
 * Public Website Data Endpoints
 * ==============================
 * GET /api/public/site — Serves client-scoped public data (products, services, etc.)
 * GET /api/public/availability — Returns available time slots for booking
 */

import { jsonResponse } from "../lib/responses.js";
import { supabaseFetch } from "../lib/supabase.js";
import { loadClient } from "../services/clientService.js";
import { generateRequestId } from "../lib/utils.js";

/**
 * GET /api/public/site
 *
 * Returns all public-facing data for a client's business website.
 * Each table is independently queried so missing tables return [] instead of errors.
 *
 * Query params: ?clientId=xxx
 */
export async function handlePublicSite(url, env) {
  const requestId = generateRequestId();
  const clientId = (url.searchParams.get("clientId") || "").trim();

  if (!clientId) {
    return jsonResponse({ success: false, error: "Missing clientId." }, 400);
  }

  const client = await loadClient(env, clientId, { requestId });
  if (!client || !client.active) {
    return jsonResponse({ success: false, error: "Business not found." }, 404);
  }

  // Query each table independently — failures return [] instead of crashing
  const [products, services, staff, reviews, gallery] = await Promise.all([
    safeQuery(env, `products?client_id=eq.${encodeURIComponent(clientId)}&or=(is_hidden.is.null,is_hidden.eq.false)&select=*&order=name.asc`, requestId),
    safeQuery(env, `services?client_id=eq.${encodeURIComponent(clientId)}&active=eq.true&select=*&order=name.asc`, requestId),
    safeQuery(env, `staff?client_id=eq.${encodeURIComponent(clientId)}&active=eq.true&select=*&order=name.asc`, requestId),
    safeQuery(env, `reviews?client_id=eq.${encodeURIComponent(clientId)}&select=*&order=created_at.desc`, requestId),
    safeQuery(env, `gallery?client_id=eq.${encodeURIComponent(clientId)}&select=*&order=created_at.desc`, requestId),
  ]);

  const business = {
    client_id: client.client_id,
    business_name: client.business_name,
    logo_url: client.logo_url || "",
    primary_color: client.primary_color || "",
    secondary_color: client.secondary_color || "",
    hero_title: client.hero_title || "",
    hero_subtitle: client.hero_subtitle || "",
    phone: client.phone || "",
    email: client.owner_email || "",
    owner_email: client.owner_email || "",
    address: client.address || "",
    opening_hours: client.opening_hours || "",
    active: client.active,
    business_type: client.business_type || "general",
  };

  // Normalise staff: DB uses `full_name`, frontend expects `name`
  const normalisedStaff = (staff || []).map((s) => ({
    ...s,
    name: s.full_name || s.name || "",
  }));

  return jsonResponse({
    success: true,
    business,
    products,
    services,
    staff: normalisedStaff,
    reviews,
    gallery,
  });
}

/**
 * GET /api/public/availability
 *
 * Returns available time slots for a staff member on a given date.
 *
 * Query params: ?clientId=xxx&staffId=xxx&date=YYYY-MM-DD
 */
export async function handlePublicAvailability(url, env) {
  const requestId = generateRequestId();
  const clientId = (url.searchParams.get("clientId") || "").trim();
  const staffId = (url.searchParams.get("staffId") || "").trim();
  const date = (url.searchParams.get("date") || "").trim();

  if (!clientId || !staffId || !date) {
    return jsonResponse({ success: false, error: "Missing clientId, staffId, or date." }, 400);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse({ success: false, error: "Invalid date format. Use YYYY-MM-DD." }, 400);
  }

  // Verify staff exists and is active
  const staffRows = await supabaseFetch(
    env,
    `staff?id=eq.${encodeURIComponent(staffId)}&client_id=eq.${encodeURIComponent(clientId)}&active=eq.true&select=*`,
    { requestId }
  );

  if (!staffRows || !staffRows.length) {
    return jsonResponse({ success: false, error: "Staff member not found." }, 404);
  }

  // Generate default time slots (08:00 - 17:00, 60min intervals)
  const allSlots = [];
  for (let hour = 8; hour <= 17; hour++) {
    allSlots.push(`${String(hour).padStart(2, "0")}:00`);
  }

  // Fetch existing bookings that aren't cancelled
  const startOfDay = `${date}T00:00:00`;
  const endOfDay = `${date}T23:59:59`;

  const existingBookings = await supabaseFetch(
    env,
    `bookings?staff_id=eq.${encodeURIComponent(staffId)}&client_id=eq.${encodeURIComponent(clientId)}&start_time=gte.${encodeURIComponent(startOfDay)}&start_time=lte.${encodeURIComponent(endOfDay)}&status=neq.cancelled&select=start_time,end_time`,
    { requestId }
  );

  // Build set of booked slot start times
  const bookedSlots = new Set();
  for (const booking of existingBookings || []) {
    const start = new Date(booking.start_time);
    const hours = String(start.getHours()).padStart(2, "0");
    const mins = String(start.getMinutes()).padStart(2, "0");
    bookedSlots.add(`${hours}:${mins}`);
  }

  const availableSlots = allSlots.filter((slot) => !bookedSlots.has(slot));

  return jsonResponse({ success: true, slots: availableSlots, date, staffId });
}

/**
 * Safe query wrapper — returns [] instead of throwing.
 */
async function safeQuery(env, path, requestId) {
  try {
    const result = await supabaseFetch(env, path, { requestId });
    return result || [];
  } catch (err) {
    console.error(`[${requestId}] safeQuery failed for ${path}:`, err.message);
    return [];
  }
}

