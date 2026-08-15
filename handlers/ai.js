/**
 * AI Chat Handler
 * ================
 * POST /api/ai/chat
 *
 * Receives a user message, calls OpenRouter with the system prompt + conversation
 * history + available tools, executes any tool calls server-side, and returns
 * the AI response.
 *
 * Security:
 * - JWT verified via existing auth.js
 * - client_id resolved server-side from JWT (never from AI or browser)
 * - OpenRouter API key stays in Worker secrets (never exposed to browser)
 * - Tools are READ-ONLY — no database modifications
 * - Every tool call uses the authenticated client_id
 */

import { jsonResponse } from "../lib/responses.js";
import { parseJsonBody, generateRequestId } from "../lib/utils.js";
import { verifySupabaseJwt, resolveUserRole } from "../lib/auth.js";
import { AI_TOOLS, executeTool } from "../lib/ai-tools.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM_PROMPT = `You are a helpful AI assistant for My Business OS, a business management platform. You help business owners understand their data and perform business operations.

CAPABILITIES:
- Answer questions about bookings, orders, products, services, customers, invoices, and business metrics.
- Create bookings, customers, products, services, and invoices.
- Update booking and order statuses.
- Cancel bookings and mark invoices as paid.

IMPORTANT RULES:
- You can only access data for the currently authenticated business.
- When a user asks a question, use the appropriate read-only tools to get the data, then summarize the findings clearly.
- When a user wants to create or modify something, use the appropriate write tool. The system will present your proposal to the user for confirmation.
- If the data is empty, say so clearly (e.g., "You don't have any bookings yet.").
- Always be concise and professional.
- Format numbers with commas for readability (e.g., R12,500).
- If you need multiple pieces of information, call tools in parallel when possible.
- Never mention internal tool names, API endpoints, or database details to the user.
- If a question is outside your scope, politely redirect to business topics.
- When showing bookings, include the client name, service, date, time, and status.
- When showing products, include name, price, and stock level.
- When showing orders, include order number, customer name, amount, and status.
- When showing invoices, include invoice number, client name, amount, and status.
- When showing metrics, present them as a clear summary.

BOOKING WORKFLOW:
When a user wants to create a booking, you MUST collect ALL required information before calling the create_booking tool:
1. Customer name (required)
2. Service name (required)
3. Date in YYYY-MM-DD format (required)
4. Time in HH:MM format, 24-hour (required)
5. Staff name (optional)
6. Amount in cents (optional, defaults to service price)
7. Notes (optional)

If the user provides partial information, ask for the missing required fields. Do NOT call create_booking until all 4 required fields are available.

Example flow:
User: "Book Sarah for tomorrow"
You: "I can help with that. What service would you like for Sarah, and what time?"
User: "Gentleman's Cut at 2 PM"
You: "Great. To confirm: Sarah, Gentleman's Cut, [tomorrow's date], 14:00. Shall I create this booking?"
User: "Yes"
You: [call create_booking tool with all 4 required fields]

FOR WRITE ACTIONS:
- If the user wants to create or modify something but hasn't provided all required details, ask for the missing information before calling the write tool.
- Present the details of what you're about to create/modify and ask for confirmation.
- For destructive actions (cancelling bookings), use stronger language: "You're about to cancel the booking for [name] on [date] at [time]. This cannot be automatically undone."
- After the user confirms, the system will execute the action and you'll receive the result.

Today's date context: use the current date when filtering "today", "this week", "this month" etc. The user will specify timeframes in their questions.`;

/**
 * POST /api/ai/chat
 * Body: { message: string, conversationId?: string }
 */
export async function handleAiChat(request, env) {
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
  if (!body || !body.message || typeof body.message !== "string") {
    return jsonResponse({ success: false, error: "A 'message' string is required." }, 400);
  }

  const userMessage = body.message.trim();
  if (!userMessage) {
    return jsonResponse({ success: false, error: "Message cannot be empty." }, 400);
  }

  // 4. Get the model from env (configurable, never hardcoded)
  const model = env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
  const apiKey = env.OPENROUTER_API_KEY;

  if (!apiKey) {
    console.error(`[${requestId}] OPENROUTER_API_KEY is not configured.`);
    return jsonResponse({ success: false, error: "AI service is not configured. Please contact support." }, 503);
  }

  // 5. Build conversation messages
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];

  // 6. Call OpenRouter with tool calling
  try {
    const openrouterResponse = await fetch(OPENROUTER_BASE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.APP_URL || "https://app.grafixos.com",
        "X-Title": "My Business OS AI Assistant",
      },
      body: JSON.stringify({
        model,
        messages,
        tools: AI_TOOLS,
        tool_choice: "auto",
        temperature: 0.3,
        max_tokens: 1024,
      }),
    });

    if (!openrouterResponse.ok) {
      const errorText = await openrouterResponse.text().catch(() => "Unknown error");
      console.error(`[${requestId}] OpenRouter error: ${openrouterResponse.status} ${errorText}`);
      return jsonResponse({ success: false, error: "AI service temporarily unavailable. Please try again." }, 502);
    }

    const aiResult = await openrouterResponse.json();
    const choice = aiResult.choices && aiResult.choices[0];

    if (!choice || !choice.message) {
      console.error(`[${requestId}] OpenRouter returned no choice.`);
      return jsonResponse({ success: false, error: "AI returned an empty response. Please try again." }, 502);
    }

    const aiMessage = choice.message;

    // 7. If the AI wants to call tools, execute them
    if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
      const toolResults = [];
      let pendingAction = null;

      for (const toolCall of aiMessage.tool_calls) {
        const toolName = toolCall.function.name;
        let toolArgs = {};
        try {
          toolArgs = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          toolArgs = {};
        }

        console.log(`[${requestId}] Executing tool: ${toolName} with args:`, JSON.stringify(toolArgs));

        // Execute the tool with the server-resolved clientId
        const result = await executeTool(toolName, toolArgs, env, clientId);

        // Check if this is a pending write action
        if (result && result.status === "pending_confirmation") {
          pendingAction = {
            id: result.action_id,
            type: result.action_type,
            label: result.label,
            destructive: result.destructive,
            fields: result.details,
          };
          // Send a synthetic result back to the AI so it knows confirmation is needed
          toolResults.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: toolName,
            content: JSON.stringify({
              status: "pending_confirmation",
              message: "This action requires explicit user confirmation. Present the details clearly and ask the user to confirm before proceeding. Do not execute the action yet.",
              details: result.details,
            }),
          });
        } else {
          toolResults.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: toolName,
            content: JSON.stringify(result),
          });
        }
      }

      // 8. Send tool results back to OpenRouter for final response
      const followupMessages = [
        ...messages,
        aiMessage,
        ...toolResults,
      ];

      const followupResponse = await fetch(OPENROUTER_BASE_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": env.APP_URL || "https://app.grafixos.com",
          "X-Title": "My Business OS AI Assistant",
        },
        body: JSON.stringify({
          model,
          messages: followupMessages,
          temperature: 0.3,
          max_tokens: 1024,
        }),
      });

      if (!followupResponse.ok) {
        const errorText = await followupResponse.text().catch(() => "Unknown error");
        console.error(`[${requestId}] OpenRouter followup error: ${followupResponse.status} ${errorText}`);
        return jsonResponse({ success: false, error: "AI service temporarily unavailable. Please try again." }, 502);
      }

      const followupResult = await followupResponse.json();
      const followupChoice = followupResult.choices && followupResult.choices[0];

      if (!followupChoice || !followupChoice.message) {
        return jsonResponse({ success: false, error: "AI returned an empty response after tool execution." }, 502);
      }

      const responseData = {
        reply: followupChoice.message.content || "",
        tools_used: toolResults.map(t => t.name),
      };

      if (pendingAction) {
        responseData.pending_action = pendingAction;
      }

      return jsonResponse({
        success: true,
        data: responseData,
      });
    }

    // 9. No tool calls — return the AI's direct response
    return jsonResponse({
      success: true,
      data: {
        reply: aiMessage.content || "",
        tools_used: [],
      },
    });

  } catch (err) {
    console.error(`[${requestId}] AI chat error:`, err.message);
    return jsonResponse({ success: false, error: "An unexpected error occurred. Please try again." }, 500);
  }
}
