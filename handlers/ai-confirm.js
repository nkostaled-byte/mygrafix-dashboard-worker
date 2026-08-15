/**
 * AI Action Confirmation Handler
 * ================================
 * POST /api/ai/confirm
 *
 * Validates and executes a pending write action after explicit user confirmation.
 *
 * Security:
 * - JWT verified via existing auth.js
 * - client_id resolved server-side from JWT
 * - Action must belong to the authenticated client
 * - Action must not have been executed already
 * - Action must not have expired
 * - All write operations use the existing authenticated CRUD patterns
 */

import { jsonResponse } from "../lib/responses.js";
import { parseJsonBody, generateRequestId } from "../lib/utils.js";
import { verifySupabaseJwt, resolveUserRole } from "../lib/auth.js";
import { getPendingAction, executeWriteAction, markActionExecuted } from "../lib/ai-tools.js";

/**
 * POST /api/ai/confirm
 * Body: { action_id: string, confirmed: boolean }
 */
export async function handleAiConfirm(request, env) {
  const requestId = generateRequestId();

  // 1. Authenticate
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) {
    return jsonResponse({ success: false, error: "Unauthorized." }, 401);
  }

  // 2. Resolve client_id server-side
  const resolved = await resolveUserRole(env, claims.sub);
  if (!resolved) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }
  const clientId = resolved.clientId;

  // 3. Parse request body
  const body = await parseJsonBody(request);
  if (!body || !body.action_id || typeof body.action_id !== "string") {
    return jsonResponse({ success: false, error: "An 'action_id' string is required." }, 400);
  }

  const confirmed = body.confirmed !== false; // default to true if not specified

  // 4. Get and validate the pending action
  const action = await getPendingAction(body.action_id, clientId, env);
  if (!action) {
    return jsonResponse({
      success: false,
      error: "This action has expired, was already executed, or does not belong to your account.",
    }, 404);
  }

  // 5. If user cancelled, just mark it and return
  if (!confirmed) {
    await markActionExecuted(action.id, env); // prevent re-use
    return jsonResponse({
      success: true,
      data: {
        reply: "Action cancelled. Nothing was changed.",
        action_type: action.type,
        status: "cancelled",
      },
    });
  }

  // 6. Execute the write action
  try {
    const result = await executeWriteAction(action, env, clientId);

    if (result && result.error) {
      return jsonResponse({
        success: false,
        data: {
          reply: `I couldn't complete this action: ${result.error}`,
          action_type: action.type,
          status: "failed",
        },
      });
    }

    // Mark as executed to prevent duplicates
    await markActionExecuted(action.id, env);

    // Generate a natural-language confirmation
    const confirmationReply = generateConfirmationReply(action, result);

    return jsonResponse({
      success: true,
      data: {
        reply: confirmationReply,
        action_type: action.type,
        status: "completed",
      },
    });

  } catch (err) {
    console.error(`[${requestId}] Action execution error:`, err.message);
    return jsonResponse({
      success: false,
      data: {
        reply: "An unexpected error occurred while executing this action. Please try again.",
        action_type: action.type,
        status: "failed",
      },
    });
  }
}

/**
 * Generate a natural-language confirmation message based on the action type and result.
 */
function generateConfirmationReply(action, result) {
  switch (action.type) {
    case "create_booking": {
      const fields = action.fields;
      return `Done. ${fields.customer}'s ${fields.service} has been booked for ${fields.date} at ${fields.time}.`;
    }
    case "create_customer": {
      return `Done. ${action.fields.name} has been added to your customers.`;
    }
    case "create_product": {
      return `Done. ${action.fields.name} has been added to your products at ${action.fields.price}.`;
    }
    case "create_service": {
      return `Done. ${action.fields.name} (${action.fields.duration}) has been added to your services at ${action.fields.price}.`;
    }
    case "create_invoice": {
      return `Done. An invoice for ${action.fields.amount} has been created for ${action.fields.client}.`;
    }
    case "update_booking_status": {
      return `Done. The booking status has been updated to "${action.fields.status}".`;
    }
    case "update_order_status": {
      return `Done. The order status has been updated to "${action.fields.status}".`;
    }
    case "cancel_booking": {
      return `Done. The booking has been cancelled.`;
    }
    case "mark_invoice_paid": {
      return `Done. The invoice has been marked as paid.`;
    }
    default:
      return `Done. The action has been completed successfully.`;
  }
}
