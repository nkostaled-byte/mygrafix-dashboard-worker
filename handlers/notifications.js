/**
 * Notifications Handler
 * ======================
 * GET  /api/notifications          — List recent notifications (max 50)
 * PATCH /api/notifications/:id     — Mark a notification as read
 * PATCH /api/notifications         — Mark all notifications as read
 * DELETE /api/notifications/:id    — Delete a notification
 *
 * All routes are authenticated. client_id is resolved server-side from JWT.
 */

import { jsonResponse } from "../lib/responses.js";
import { parseJsonBody, generateRequestId } from "../lib/utils.js";
import { verifySupabaseJwt, resolveClientId } from "../lib/auth.js";
import { supabaseFetch } from "../lib/supabase.js";

/**
 * GET /api/notifications
 * Returns the 50 most recent notifications for the authenticated client.
 */
export async function handleListNotifications(request, env) {
  const requestId = generateRequestId();

  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);

  const rows = await supabaseFetch(
    env,
    `notifications?client_id=eq.${encodeURIComponent(clientId)}&select=*&order=created_at.desc&limit=${limit}`,
    { requestId }
  );

  return jsonResponse({
    success: true,
    data: rows || [],
  });
}

/**
 * PATCH /api/notifications/:id
 * Marks a single notification as read (sets read_at = now()).
 */
export async function handleMarkNotificationRead(request, env, notificationId) {
  const requestId = generateRequestId();

  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }

  if (!notificationId) {
    return jsonResponse({ success: false, error: "Notification ID is required." }, 400);
  }

  const existing = await supabaseFetch(
    env,
    `notifications?id=eq.${encodeURIComponent(notificationId)}&client_id=eq.${encodeURIComponent(clientId)}&select=id&limit=1`,
    { requestId }
  );

  if (!existing || !existing.length) {
    return jsonResponse({ success: false, error: "Notification not found." }, 404);
  }

  await supabaseFetch(
    env,
    `notifications?id=eq.${encodeURIComponent(notificationId)}`,
    {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ read_at: new Date().toISOString() }),
      requestId,
    }
  );

  return jsonResponse({ success: true, data: { id: notificationId, read_at: new Date().toISOString() } });
}

/**
 * PATCH /api/notifications
 * Marks all unread notifications as read for the authenticated client.
 */
export async function handleMarkAllNotificationsRead(request, env) {
  const requestId = generateRequestId();

  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }

  await supabaseFetch(
    env,
    `notifications?client_id=eq.${encodeURIComponent(clientId)}&read_at=is.null`,
    {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ read_at: new Date().toISOString() }),
      requestId,
    }
  );

  return jsonResponse({ success: true, data: { marked_all_read: true } });
}

/**
 * DELETE /api/notifications/:id
 * Deletes a single notification.
 */
export async function handleDeleteNotification(request, env, notificationId) {
  const requestId = generateRequestId();

  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }

  if (!notificationId) {
    return jsonResponse({ success: false, error: "Notification ID is required." }, 400);
  }

  const existing = await supabaseFetch(
    env,
    `notifications?id=eq.${encodeURIComponent(notificationId)}&client_id=eq.${encodeURIComponent(clientId)}&select=id&limit=1`,
    { requestId }
  );

  if (!existing || !existing.length) {
    return jsonResponse({ success: false, error: "Notification not found." }, 404);
  }

  await supabaseFetch(
    env,
    `notifications?id=eq.${encodeURIComponent(notificationId)}`,
    {
      method: "DELETE",
      prefer: "return=minimal",
      requestId,
    }
  );

  return jsonResponse({ success: true, data: { deleted: true, id: notificationId } });
}
