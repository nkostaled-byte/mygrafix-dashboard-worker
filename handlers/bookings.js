/**
 * Booking Handler
 * ================
 * POST /api/bookings — Public appointment scheduling
 *
 * Creates a booking with server-side service/staff validation,
 * time slot calculation, and email notifications.
 */

import { jsonResponse, rateLimitResponse } from "../lib/responses.js";
import { parseJsonBody, generateRequestId } from "../lib/utils.js";
import { validateBookingPayload } from "../lib/validation.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { IP_RATE_LIMIT, CLIENT_RATE_LIMIT } from "../config/constants.js";
import { supabaseFetch } from "../lib/supabase.js";
import { loadClient } from "../services/clientService.js";
import { findOrCreateCustomer } from "../services/customerService.js";
import { logEmail } from "../services/submissionService.js";
import { sendEmail, buildBookingCustomerEmail, buildBookingOwnerEmail } from "../lib/email.js";
import { buildFromAddress } from "../lib/email.js";

/**
 * POST /api/bookings
 */
export async function handleCreateBooking(request, env) {
  const requestId = generateRequestId();
  const ipAddress = request.headers.get("CF-Connecting-IP") || "";

  // Rate limit by IP
  const ipLimit = await checkRateLimit(env, `booking:ip:${ipAddress}`, IP_RATE_LIMIT);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfter);

  // Parse body
  const payload = await parseJsonBody(request);
  if (!payload) {
    return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);
  }

  // Validate
  const bookingError = validateBookingPayload(payload);
  if (bookingError) {
    return jsonResponse({ success: false, error: bookingError }, 400);
  }

  const { clientId, customer, serviceId, staffId, startTime } = payload;

  // Rate limit by client
  const clientLimit = await checkRateLimit(env, `booking:client:${clientId}`, CLIENT_RATE_LIMIT);
  if (!clientLimit.allowed) return rateLimitResponse(clientLimit.retryAfter);

  // Load client
  const client = await loadClient(env, clientId, { requestId });
  if (!client) return jsonResponse({ success: false, error: "Unknown client." }, 404);
  if (!client.active) return jsonResponse({ success: false, error: "Client account is inactive." }, 403);

  // Verify service
  const services = await supabaseFetch(
    env,
    `services?client_id=eq.${encodeURIComponent(clientId)}&id=eq.${encodeURIComponent(serviceId)}&select=*`,
    { requestId }
  );
  const service = services && services[0];
  if (!service || !service.active) {
    return jsonResponse({ success: false, error: "Service not found or unavailable." }, 400);
  }

  // Verify staff (if specified)
  if (staffId) {
    const staffRows = await supabaseFetch(
      env,
      `staff?client_id=eq.${encodeURIComponent(clientId)}&id=eq.${encodeURIComponent(staffId)}&select=id`,
      { requestId }
    );
    if (!staffRows || !staffRows.length) {
      return jsonResponse({ success: false, error: "Staff member not found." }, 400);
    }
  }

  // Calculate end time
  const start = new Date(startTime);
  const end = new Date(start.getTime() + service.duration_minutes * 60000);

  // Find or create customer
  const dbCustomer = await findOrCreateCustomer(env, clientId, customer, { requestId });

  // Create booking
  const [booking] = await supabaseFetch(env, "bookings", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      customer_id: dbCustomer.id,
      service_id: serviceId,
      staff_id: staffId || null,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      status: "confirmed",
    }),
    requestId,
  });

  // Send emails
  const customerEmailResult = await sendEmail(env, {
    to: customer.email,
    from: buildFromAddress(client),
    replyTo: client.reply_email || undefined,
    subject: "Booking Confirmed",
    html: buildBookingCustomerEmail(client, booking, service, customer),
  }).catch((err) => {
    console.error(`[${requestId}] Failed to send booking customer email:`, err.message);
    return { id: null };
  });

  const ownerEmailResult = await sendEmail(env, {
    to: client.owner_email,
    from: buildFromAddress(client),
    replyTo: client.reply_email || undefined,
    subject: `New booking: ${service.name}`,
    html: buildBookingOwnerEmail(client, booking, service, customer),
  }).catch((err) => {
    console.error(`[${requestId}] Failed to send booking owner email:`, err.message);
    return { id: null };
  });

  // Log emails
  await Promise.all([
    logEmail(env, {
      clientId,
      relatedType: "booking",
      relatedId: booking.id,
      recipient: customer.email,
      subject: "Booking Confirmed",
      resendId: customerEmailResult?.id || null,
    }, { requestId }),
    logEmail(env, {
      clientId,
      relatedType: "booking",
      relatedId: booking.id,
      recipient: client.owner_email,
      subject: `New booking: ${service.name}`,
      resendId: ownerEmailResult?.id || null,
    }, { requestId }),
  ]);

  return jsonResponse({
    success: true,
    bookingId: booking.id,
    startTime: booking.start_time,
    endTime: booking.end_time,
  });
}

