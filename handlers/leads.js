/**
 * Lead Generation & CRM Handler
 * ==============================
 * All /api/leads* endpoints — authenticated, tenant-scoped lead generation,
 * website auditing, scoring and CRM operations (companies, contacts, notes,
 * tasks, activities, tags, pipeline stages, follow-ups, exports).
 *
 * Reuses existing Worker helpers for auth (JWT → client_id), Supabase, CSV
 * and response formatting.
 */

import { jsonResponse } from "../lib/responses.js";
import { parseJsonBody, generateRequestId } from "../lib/utils.js";
import { verifySupabaseJwt, resolveUserRole } from "../lib/auth.js";
import { supabaseFetch } from "../lib/supabase.js";
import { rowsToCsv } from "../lib/csv.js";
import { CORS_HEADERS } from "../config/constants.js";
import { loadClient } from "../services/clientService.js";
import { canAccessPlan, planAccessDenied } from "../lib/planAccess.js";
import { fetchSiteHtml, analyseSite, getDomain } from "../lib/siteScanner.js";
import { scoreAudit, buildAiBrief, DEFAULT_STAGES, ALLOWED_STATUSES, ALLOWED_PRIORITIES } from "../services/leadsCore.js";
import { searchPlaces } from "../lib/places.js";

const MIN_PLAN_CRM = "starter";
const MIN_PLAN_ADVANCED = "business";

// ------------------------------------------------------------
// AUTH
// ------------------------------------------------------------

async function authz(request, env, minPlan) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return { error: jsonResponse({ success: false, error: "Unauthorized." }, 401) };
  const resolved = await resolveUserRole(env, claims.sub);
  if (!resolved) {
    return { error: jsonResponse({ success: false, error: "No client account linked to this login." }, 403) };
  }
  const client = await loadClient(env, resolved.clientId, { requestId: generateRequestId() });
  if (!client) return { error: jsonResponse({ success: false, error: "Client not found." }, 404) };
  if (minPlan && !canAccessPlan(client, minPlan)) return { error: planAccessDenied(minPlan) };
  return { clientId: resolved.clientId, role: resolved.role, client };
}

// Returns { clientId, role, client } or { error: Response }.
async function resolveClient(request, env, minPlan) {
  const a = await authz(request, env, minPlan);
  if (a.error) return { error: a.error };
  return a;
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function camelObj(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
}

function decorateLead(row) {
  const contact = row.contact || null;
  const company = row.company || null;
  const contactName = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(" ") : "";
  const companyName = company?.name || "";
  const domain = company?.domain || getDomain(row.website || row.website_url || "");
  return {
    ...camelObj(row),
    leadName: companyName || contactName || row.website || row.id,
    contactName,
    companyName,
    domain,
    contact: contact ? camelObj(contact) : null,
    company: company ? camelObj(company) : null,
  };
}

const LEAD_SELECT = `*,company:lead_companies(id,name,domain,website,industry,logo_url),contact:lead_contacts(id,first_name,last_name,email,phone,job_title)`;

async function loadLeadDetail(env, clientId, leadId) {
  const [rows] = await supabaseFetch(
    env,
    `leads?id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}&select=${encodeURIComponent(LEAD_SELECT)}`
  );
  return rows && rows.length ? decorateLead(rows[0]) : null;
}

async function logActivity(env, clientId, leadId, type, title, description, metadata = {}) {
  return supabaseFetch(env, "lead_activities", {
    method: "POST",
    body: JSON.stringify({ client_id: clientId, lead_id: leadId, type, title, description, metadata }),
  });
}

async function findOrCreateCompany(env, clientId, input) {
  if (!input.name) return null;
  if (input.domain) {
    const found = await supabaseFetch(
      env,
      `lead_companies?client_id=eq.${encodeURIComponent(clientId)}&domain=ilike.${encodeURIComponent(input.domain)}&select=id`
    );
    if (found && found.length) return found[0];
  }
  const [rec] = await supabaseFetch(env, "lead_companies", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      name: input.name,
      domain: input.domain || null,
      website: input.website || null,
      industry: input.industry || null,
      email: input.email || null,
      phone: input.phone || null,
      address: input.address || null,
    }),
    requestId: generateRequestId(),
  });
  return rec || null;
}

// ------------------------------------------------------------
// LEADS
// ------------------------------------------------------------

async function handleListLeads(clientId, env, url) {
  const search = (url.searchParams.get("search") || "").trim();
  const status = (url.searchParams.get("status") || "").trim();
  const stage = (url.searchParams.get("stage") || "").trim();
  const priority = (url.searchParams.get("priority") || "").trim();
  const orderCol = (url.searchParams.get("order") || "created_at").trim();
  const direction = url.searchParams.get("dir") === "asc" ? "asc" : "desc";
  const limit = (url.searchParams.get("limit") || "200").trim();

  let path = `leads?client_id=eq.${encodeURIComponent(clientId)}&order=${encodeURIComponent(
    `${orderCol}.${direction}`
  )}&limit=${encodeURIComponent(limit)}&select=${encodeURIComponent(LEAD_SELECT)}`;
  if (status) path += `&status=eq.${encodeURIComponent(status)}`;
  if (stage) path += `&stage=eq.${encodeURIComponent(stage)}`;
  if (priority) path += `&priority=eq.${encodeURIComponent(priority)}`;

  let rows = (await supabaseFetch(env, path, { requestId: generateRequestId() })) || [];

  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((r) =>
      [
        r.company?.name,
        r.company?.domain,
        r.contact?.first_name,
        r.contact?.last_name,
        r.contact?.email,
        r.website,
        r.stage,
        JSON.stringify(r.tags || []),
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }

  return jsonResponse({ success: true, data: rows.map(decorateLead) });
}

async function handleCreateLead(request, env) {
  const ctx = await resolveClient(request, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const payload = await parseJsonBody(request);
  if (!payload) return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);

  const body = await buildLeadPayload(env, clientId, payload);

  // Persist audit-derived score when supplied
  if (payload.audit) {
    const a = payload.audit;
    body.website_url = body.website_url || a.url;
    body.website = body.website || a.url;
    if (typeof a.score === "number") {
      body.score = a.score;
      body.score_breakdown = { deductions: a.deductions || [] };
      body.opportunity_level = a.opportunityLevel || null;
      if (Array.isArray(a.recommendedServices)) body.recommended_services = a.recommendedServices;
      if (a.ai) body.ai_summary = a.ai;
    }
  }

  const [rec] = await supabaseFetch(env, "leads", { method: "POST", body: JSON.stringify(body) });
  if (!rec) return jsonResponse({ success: false, error: "Could not save the lead." }, 400);
  await logActivity(env, clientId, rec.id, "created", "Lead created", `Lead added with status ${body.status || "new"}.`, { score: body.score || 0 });
  const detail = await loadLeadDetail(env, clientId, rec.id);
  return jsonResponse({ success: true, data: detail });
}

async function buildLeadPayload(env, clientId, payload) {
  const body = { client_id: clientId };
  const fill = (k, v) => {
    if (v !== undefined && v !== null && v !== "") body[k] = v;
  };
  fill("source", payload.source);
  fill("status", payload.status);
  fill("stage", payload.stage);
  fill("priority", payload.priority);
  fill("notes", payload.notes);
  fill("address", payload.address);
  fill("estimated_value", payload.estimatedValue);
  fill("assigned_to", payload.assignedTo);
  fill("assigned_name", payload.assignedName);
  fill("tags", payload.tags);
  fill("custom_fields", payload.customFields);
  if (payload.nextFollowupAt) body.next_followup_at = payload.nextFollowupAt;

  const website = payload.websiteUrl || payload.website || payload.url;
  fill("website", website);
  fill("website_url", website);

  const emails = Array.isArray(payload.emails) ? payload.emails.slice() : [];
  if (payload.email) emails.push(payload.email);
  if (emails.length) body.emails = [...new Set(emails)];
  const phones = Array.isArray(payload.phones) ? payload.phones.slice() : [];
  if (payload.phone) phones.push(payload.phone);
  if (phones.length) body.phones = [...new Set(phones)];
  if (payload.socialLinks) body.social_links = payload.socialLinks;

  if (payload.companyId) body.company_id = payload.companyId;
  if (payload.contactId) body.contact_id = payload.contactId;

  if (!payload.companyId && (payload.companyName || payload.domain || website)) {
    const companyName =
      payload.companyName || payload.company || payload.domain || getDomain(website || "") || website;
    const company = await findOrCreateCompany(env, clientId, {
      name: companyName,
      domain: payload.domain || getDomain(website || ""),
      website,
      industry: payload.industry,
      email: payload.email || emails[0] || "",
      phone: payload.phone || phones[0] || "",
      address: payload.address,
    });
    if (company) body.company_id = company.id;
  }

  if (!body.status) body.status = "new";
  if (!body.stage) body.stage = DEFAULT_STAGES[0].name;
  if (!body.priority) body.priority = "medium";
  if (!body.score) body.score = 0;
  return body;
}

async function handleLeadDetail(request, env, leadId) {
  const ctx = await resolveClient(request, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;

  const [rows, notes, tasks, activities, followups] = await Promise.all([
    supabaseFetch(
      env,
      `leads?id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}&select=${encodeURIComponent(LEAD_SELECT)}`
    ),
    supabaseFetch(env, `lead_notes?lead_id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}&order=created_at.desc`),
    supabaseFetch(env, `lead_tasks?lead_id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}&order=created_at.desc`),
    supabaseFetch(env, `lead_activities?lead_id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}&order=created_at.desc`),
    supabaseFetch(env, `lead_followups?lead_id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}&order=due_at.asc`),
  ]);

  if (!rows || !rows.length) return jsonResponse({ success: false, error: "Lead not found." }, 404);
  return jsonResponse({
    success: true,
    data: {
      ...decorateLead(rows[0]),
      notesList: (notes || []).map(camelObj),
      tasks: (tasks || []).map(camelObj),
      activities: (activities || []).map(camelObj),
      followups: (followups || []).map(camelObj),
    },
  });
}

async function handleUpdateLead(req, env, leadId, statusOnly) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const payload = await parseJsonBody(req);
  if (!payload) return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);

  const existing = await supabaseFetch(
    env,
    `leads?id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}&select=id,status,stage`
  );
  if (!existing || !existing.length) return jsonResponse({ success: false, error: "Lead not found." }, 404);

  const body = {};
  if (payload.status !== undefined) {
    if (!ALLOWED_STATUSES.includes(payload.status)) {
      return jsonResponse({ success: false, error: `Status must be one of: ${ALLOWED_STATUSES.join(", ")}` }, 400);
    }
    body.status = payload.status;
    if (payload.status === "won") body.won_at = new Date().toISOString();
  }
  if (payload.stage !== undefined) body.stage = payload.stage;
  if (payload.priority !== undefined) {
    if (!ALLOWED_PRIORITIES.includes(payload.priority)) {
      return jsonResponse({ success: false, error: `Priority must be one of: ${ALLOWED_PRIORITIES.join(", ")}` }, 400);
    }
    body.priority = payload.priority;
  }
  if (!statusOnly) {
    const map = {
      notes: "notes",
      assignedTo: "assigned_to",
      assignedName: "assigned_name",
      tags: "tags",
      customFields: "custom_fields",
      estimatedValue: "estimated_value",
      address: "address",
      website: "website_url",
    };
    for (const [k, col] of Object.entries(map)) {
      if (payload[k] !== undefined) body[col] = payload[k];
    }
    if (payload.nextFollowupAt !== undefined) body.next_followup_at = payload.nextFollowupAt;
    if (payload.lossReason !== undefined) body.loss_reason = payload.lossReason;
  }

  if (!Object.keys(body).length) return jsonResponse({ success: false, error: "Nothing to update." }, 400);

  await supabaseFetch(env, `leads?id=eq.${encodeURIComponent(leadId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(body),
  });

  if (payload.status !== undefined && payload.status !== existing[0].status) {
    await logActivity(env, clientId, leadId, "status", "Status changed", `From ${existing[0].status} → ${payload.status}.`, { status: payload.status });
  }
  if (payload.stage !== undefined && payload.stage !== existing[0].stage) {
    await logActivity(env, clientId, leadId, "stage", "Stage changed", `From ${existing[0].stage} → ${payload.stage}.`, { stage: payload.stage });
  }

  const detail = await loadLeadDetail(env, clientId, leadId);
  return jsonResponse({ success: true, data: detail });
}

async function handleDeleteLead(req, env, leadId) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const existing = await supabaseFetch(env, `leads?id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}&select=id`);
  if (!existing || !existing.length) return jsonResponse({ success: false, error: "Lead not found." }, 404);
  await supabaseFetch(env, `leads?id=eq.${encodeURIComponent(leadId)}`, { method: "DELETE", prefer: "return=minimal" });
  return jsonResponse({ success: true });
}

async function handleConvert(req, env, leadId) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const existing = await supabaseFetch(env, `leads?id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}&select=id`);
  if (!existing || !existing.length) return jsonResponse({ success: false, error: "Lead not found." }, 404);
  await supabaseFetch(env, `leads?id=eq.${encodeURIComponent(leadId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({ status: "won", stage: "Won", won_at: new Date().toISOString() }),
  });
  await logActivity(env, clientId, leadId, "won", "Lead won", "Lead converted to a customer.");
  const detail = await loadLeadDetail(env, clientId, leadId);
  return jsonResponse({ success: true, data: detail });
}

// ------------------------------------------------------------
// NOTES / ACTIVITIES / TASKS / FOLLOWUPS
// ------------------------------------------------------------

async function handleAddNote(req, env, leadId) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const payload = await parseJsonBody(req);
  if (!payload || typeof payload.body !== "string" || !payload.body.trim()) {
    return jsonResponse({ success: false, error: "Note text (body) is required." }, 400);
  }
  const [note] = await supabaseFetch(env, "lead_notes", {
    method: "POST",
    body: JSON.stringify({ client_id: clientId, lead_id: leadId, author: payload.author || "", body: payload.body }),
  });
  await logActivity(env, clientId, leadId, "note", "Note added", payload.body);
  return jsonResponse({ success: true, data: note || {} });
}

async function handleUpdateNote(req, env, leadId, noteId) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const payload = await parseJsonBody(req) || {};
  const body = {};
  if (payload.body !== undefined) body.body = payload.body;
  if (payload.author !== undefined) body.author = payload.author;
  if (!Object.keys(body).length) return jsonResponse({ success: false, error: "Nothing to update." }, 400);
  await supabaseFetch(env, `lead_notes?id=eq.${encodeURIComponent(noteId)}&lead_id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(body),
  });
  return jsonResponse({ success: true });
}

async function handleDeleteNote(req, env, leadId, noteId) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  await supabaseFetch(env, `lead_notes?id=eq.${encodeURIComponent(noteId)}&lead_id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}`, {
    method: "DELETE",
    prefer: "return=minimal",
  });
  return jsonResponse({ success: true });
}

async function handleAddActivity(req, env, leadId) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const payload = await parseJsonBody(req);
  if (!payload || !payload.title) return jsonResponse({ success: false, error: "'title' is required." }, 400);
  const [rec] = await supabaseFetch(env, "lead_activities", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      lead_id: leadId,
      type: payload.type || "event",
      title: payload.title,
      description: payload.description || "",
      metadata: payload.metadata || {},
    }),
  });
  return jsonResponse({ success: true, data: rec || {} });
}

async function handleListActivities(ctx, env, leadId) {
  const { clientId } = ctx;
  const rows = await supabaseFetch(env, `lead_activities?lead_id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}&order=created_at.desc`);
  return jsonResponse({ success: true, data: rows || [] });
}

async function handleAddTask(req, env, leadId) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const payload = await parseJsonBody(req);
  if (!payload || !payload.title) return jsonResponse({ success: false, error: "Task 'title' is required." }, 400);
  const [rec] = await supabaseFetch(env, "lead_tasks", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      lead_id: leadId,
      title: payload.title,
      description: payload.description || "",
      due_date: payload.dueDate || null,
      status: "pending",
      assigned_to: payload.assignedTo || null,
    }),
  });
  await logActivity(env, clientId, leadId, "task", "Task added", payload.title);
  return jsonResponse({ success: true, data: rec || {} });
}

async function handleListTasks(ctx, env, leadId) {
  const { clientId } = ctx;
  const rows = await supabaseFetch(env, `lead_tasks?lead_id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}&order=created_at.desc`);
  return jsonResponse({ success: true, data: rows || [] });
}

async function handleUpdateTask(req, env, leadId, taskId) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const payload = await parseJsonBody(req) || {};
  const body = {};
  if (payload.status !== undefined) {
    body.status = payload.status;
    body.completed_at = payload.status === "completed" ? new Date().toISOString() : null;
  }
  if (payload.title !== undefined) body.title = payload.title;
  if (payload.description !== undefined) body.description = payload.description;
  if (payload.dueDate !== undefined) body.due_date = payload.dueDate;
  if (!Object.keys(body).length) return jsonResponse({ success: false, error: "Nothing to update." }, 400);
  await supabaseFetch(env, `lead_tasks?id=eq.${encodeURIComponent(taskId)}&lead_id=eq.${encodeURIComponent(leadId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(body),
  });
  return jsonResponse({ success: true });
}

async function handleDeleteTask(req, env, leadId, taskId) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  await supabaseFetch(env, `lead_tasks?id=eq.${encodeURIComponent(taskId)}&lead_id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}`, {
    method: "DELETE",
    prefer: "return=minimal",
  });
  return jsonResponse({ success: true });
}

async function handleAddFollowup(req, env, leadId) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const payload = await parseJsonBody(req);
  if (!payload || !payload.dueAt) return jsonResponse({ success: false, error: "'dueAt' is required." }, 400);
  const [rec] = await supabaseFetch(env, "lead_followups", {
    method: "POST",
    body: JSON.stringify({ client_id: clientId, lead_id: leadId, due_at: payload.dueAt, note: payload.note || "", status: "pending" }),
  });
  await supabaseFetch(env, `leads?id=eq.${encodeURIComponent(leadId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({ next_followup_at: payload.dueAt }),
  });
  return jsonResponse({ success: true, data: rec || {} });
}

async function handleListFollowups(ctx, env, leadId) {
  const { clientId } = ctx;
  const rows = await supabaseFetch(env, `lead_followups?lead_id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}&order=due_at.asc`);
  return jsonResponse({ success: true, data: rows || [] });
}

async function handleUpdateFollowup(req, env, leadId, followId) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const payload = await parseJsonBody(req) || {};
  const body = {};
  if (payload.status !== undefined) body.status = payload.status === "completed" ? "completed" : "pending";
  if (payload.note !== undefined) body.note = payload.note;
  if (payload.dueAt !== undefined) body.due_at = payload.dueAt;
  await supabaseFetch(env, `lead_followups?id=eq.${encodeURIComponent(followId)}&lead_id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(body),
  });
  if (body.status === "completed") {
    await logActivity(env, clientId, leadId, "followup", "Follow-up completed", "Follow-up marked as completed.");
  }
  return jsonResponse({ success: true });
}

async function handleDeleteFollowup(req, env, leadId, followId) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  await supabaseFetch(env, `lead_followups?id=eq.${encodeURIComponent(followId)}&lead_id=eq.${encodeURIComponent(leadId)}&client_id=eq.${encodeURIComponent(clientId)}`, {
    method: "DELETE",
    prefer: "return=minimal",
  });
  return jsonResponse({ success: true });
}

// ------------------------------------------------------------
// PIPELINE / STAGES / TAGS / COMPANIES / CONTACTS
// ------------------------------------------------------------

async function ensureStages(env, clientId) {
  const existing = await supabaseFetch(
    env,
    `lead_stages?client_id=eq.${encodeURIComponent(clientId)}&select=id,name,color,position&order=position.asc`
  );
  if (existing && existing.length) return existing;
  const created = [];
  for (const s of DEFAULT_STAGES) {
    const [rec] = await supabaseFetch(env, "lead_stages", {
      method: "POST",
      body: JSON.stringify({ client_id: clientId, ...s }),
      requestId: generateRequestId(),
    });
    if (rec) created.push(rec);
  }
  return created;
}

async function handlePipeline(req, env) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const stages = await ensureStages(env, clientId);
  const leads = (await supabaseFetch(
    env,
    `leads?client_id=eq.${encodeURIComponent(clientId)}&select=${encodeURIComponent(LEAD_SELECT)}&order=score.desc`
  )) || [];

  const stageMap = new Map(stages.map((s, i) => [s.name, i]));
  const grouped = stages.map((s) => ({ id: s.id, name: s.name, color: s.color, position: s.position, count: 0, leads: [] }));
  const missing = [];
  for (const lead of leads) {
    const idx = stageMap.has(lead.stage) ? stageMap.get(lead.stage) : -1;
    const decorated = decorateLead(lead);
    if (idx >= 0) grouped[idx].leads.push(decorated);
    else missing.push(decorated);
  }
  grouped.forEach((g) => (g.count = g.leads.length));
  if (missing.length && grouped.length) {
    grouped[0].leads.unshift(...missing);
    grouped[0].count = grouped[0].leads.length;
  }
  return jsonResponse({ success: true, data: { stages: grouped, total: leads.length } });
}

async function handleStages(req, env, action, id) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  if (action === "list") {
    const rows = await ensureStages(env, clientId);
    return jsonResponse({ success: true, data: rows.map(camelObj) });
  }
  if (action === "create") {
    const payload = await parseJsonBody(req);
    if (!payload || !payload.name) return jsonResponse({ success: false, error: "Stage 'name' is required." }, 400);
    const [rec] = await supabaseFetch(env, "lead_stages", {
      method: "POST",
      body: JSON.stringify({ client_id: clientId, name: payload.name, position: payload.position ?? 0, color: payload.color || "violet" }),
    });
    return jsonResponse({ success: true, data: camelObj(rec || {}) });
  }
  if (action === "update") {
    const payload = await parseJsonBody(req) || {};
    const body = {};
    if (payload.name !== undefined) body.name = payload.name;
    if (payload.color !== undefined) body.color = payload.color;
    if (payload.position !== undefined) body.position = payload.position;
    await supabaseFetch(env, `lead_stages?id=eq.${encodeURIComponent(id)}&client_id=eq.${encodeURIComponent(clientId)}`, {
      method: "PATCH", prefer: "return=minimal", body: JSON.stringify(body),
    });
    return jsonResponse({ success: true });
  }
  if (action === "delete") {
    await supabaseFetch(env, `lead_stages?id=eq.${encodeURIComponent(id)}&client_id=eq.${encodeURIComponent(clientId)}`, {
      method: "DELETE", prefer: "return=minimal",
    });
    return jsonResponse({ success: true });
  }
  return jsonResponse({ success: false, error: "Unknown action." }, 400);
}

async function handleTags(req, env, action, id) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  if (action === "list") {
    const rows = await supabaseFetch(env, `lead_tags?client_id=eq.${encodeURIComponent(clientId)}&order=name.asc`);
    return jsonResponse({ success: true, data: (rows || []).map(camelObj) });
  }
  if (action === "create") {
    const payload = await parseJsonBody(req);
    if (!payload || !payload.name) return jsonResponse({ success: false, error: "Tag 'name' is required." }, 400);
    const [rec] = await supabaseFetch(env, "lead_tags", {
      method: "POST",
      body: JSON.stringify({ client_id: clientId, name: payload.name, color: payload.color || "violet" }),
    });
    return jsonResponse({ success: true, data: camelObj(rec || {}) });
  }
  if (action === "delete") {
    await supabaseFetch(env, `lead_tags?id=eq.${encodeURIComponent(id)}&client_id=eq.${encodeURIComponent(clientId)}`, {
      method: "DELETE", prefer: "return=minimal",
    });
    return jsonResponse({ success: true });
  }
  return jsonResponse({ success: false, error: "Unknown action." }, 400);
}

async function handleCompanies(req, env, action, id) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  if (action === "list") {
    const url = new URL(req.url);
    const search = (url.searchParams.get("search") || "").trim();
    let rows = (await supabaseFetch(env, `lead_companies?client_id=eq.${encodeURIComponent(clientId)}&order=name.asc`)) || [];
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) => String(r.name).toLowerCase().includes(q) || String(r.domain || "").toLowerCase().includes(q));
    }
    return jsonResponse({ success: true, data: rows.map(camelObj) });
  }
  if (action === "create") {
    const payload = await parseJsonBody(req);
    if (!payload || !payload.name) return jsonResponse({ success: false, error: "Company 'name' is required." }, 400);
    const [rec] = await supabaseFetch(env, "lead_companies", { method: "POST", body: JSON.stringify(buildCompanyPayload(payload, clientId)) });
    return jsonResponse({ success: true, data: camelObj(rec || {}) });
  }
  if (action === "update") {
    const payload = await parseJsonBody(req) || {};
    const body = { ...buildCompanyPayload(payload, clientId), updated_at: new Date().toISOString() };
    await supabaseFetch(env, `lead_companies?id=eq.${encodeURIComponent(id)}&client_id=eq.${encodeURIComponent(clientId)}`, {
      method: "PATCH", prefer: "return=minimal", body: JSON.stringify(body),
    });
    return jsonResponse({ success: true });
  }
  if (action === "delete") {
    await supabaseFetch(env, `lead_companies?id=eq.${encodeURIComponent(id)}&client_id=eq.${encodeURIComponent(clientId)}`, {
      method: "DELETE", prefer: "return=minimal",
    });
    return jsonResponse({ success: true });
  }
  return jsonResponse({ success: false, error: "Unknown action." }, 400);
}

function buildCompanyPayload(payload, clientId) {
  const b = { client_id: clientId };
  const map = {
    name: "name", industry: "industry", website: "website", domain: "domain", phone: "phone",
    email: "email", address: "address", city: "city", country: "country", sizeBucket: "size_bucket",
    description: "description", logoUrl: "logo_url", socialLinks: "social_links", tags: "tags",
  };
  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) b[col] = payload[k];
  }
  return b;
}

async function handleCompanyDetail(req, env, companyId) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const [rows] = await supabaseFetch(env, `lead_companies?id=eq.${encodeURIComponent(companyId)}&client_id=eq.${encodeURIComponent(clientId)}&select=*`);
  if (!rows || !rows.length) return jsonResponse({ success: false, error: "Company not found." }, 404);
  const contacts = await supabaseFetch(env, `lead_contacts?company_id=eq.${encodeURIComponent(companyId)}&order=created_at.desc`);
  const leads = await supabaseFetch(env, `leads?company_id=eq.${encodeURIComponent(companyId)}&client_id=eq.${encodeURIComponent(clientId)}&select=${encodeURIComponent(LEAD_SELECT)}&order=created_at.desc`);
  return jsonResponse({
    success: true,
    data: { ...camelObj(rows[0]), contacts: (contacts || []).map(camelObj), leads: (leads || []).map(decorateLead) },
  });
}

async function handleContacts(req, env, action, id) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  if (action === "list") {
    const url = new URL(req.url);
    const search = (url.searchParams.get("search") || "").trim();
    const companyId = (url.searchParams.get("companyId") || "").trim();
    let path = `lead_contacts?client_id=eq.${encodeURIComponent(clientId)}&order=created_at.desc&select=*,company:lead_companies(id,name,domain)`;
    if (companyId) path += `&company_id=eq.${encodeURIComponent(companyId)}`;
    let rows = (await supabaseFetch(env, path)) || [];
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        [r.first_name, r.last_name, r.email, r.phone, r.job_title, r.company?.name]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      );
    }
    rows = rows.map((r) => ({
      ...r,
      contactName: [r.first_name, r.last_name].filter(Boolean).join(" "),
      companyName: r.company?.name || "",
    }));
    return jsonResponse({ success: true, data: rows });
  }
  if (action === "create") {
    const payload = await parseJsonBody(req);
    if (!payload || !payload.lastName) return jsonResponse({ success: false, error: "A last name is required." }, 400);
    const b = {
      client_id: clientId,
      first_name: payload.firstName || "",
      last_name: payload.lastName,
      email: payload.email || null,
      phone: payload.phone || null,
      job_title: payload.jobTitle || null,
      company_id: payload.companyId || null,
      avatar_url: payload.avatarUrl || null,
      notes: payload.notes || null,
    };
    const [rec] = await supabaseFetch(env, "lead_contacts", { method: "POST", body: JSON.stringify(b) });
    return jsonResponse({ success: true, data: rec || {} });
  }
  if (action === "update") {
    const payload = await parseJsonBody(req) || {};
    const b = {};
    if (payload.firstName !== undefined) b.first_name = payload.firstName;
    if (payload.lastName !== undefined) b.last_name = payload.lastName;
    if (payload.email !== undefined) b.email = payload.email;
    if (payload.phone !== undefined) b.phone = payload.phone;
    if (payload.jobTitle !== undefined) b.job_title = payload.jobTitle;
    if (payload.companyId !== undefined) b.company_id = payload.companyId;
    if (payload.notes !== undefined) b.notes = payload.notes;
    b.updated_at = new Date().toISOString();
    await supabaseFetch(env, `lead_contacts?id=eq.${encodeURIComponent(id)}&client_id=eq.${encodeURIComponent(clientId)}`, {
      method: "PATCH", prefer: "return=minimal", body: JSON.stringify(b),
    });
    return jsonResponse({ success: true });
  }
  if (action === "delete") {
    await supabaseFetch(env, `lead_contacts?id=eq.${encodeURIComponent(id)}&client_id=eq.${encodeURIComponent(clientId)}`, {
      method: "DELETE", prefer: "return=minimal",
    });
    return jsonResponse({ success: true });
  }
  return jsonResponse({ success: false, error: "Unknown action." }, 400);
}

// ------------------------------------------------------------
// SCAN / AUDIT / SEARCH / BULK / EXPORT
// ------------------------------------------------------------

async function handleScan(req, env) {
  const ctx = await resolveClient(req, env, MIN_PLAN_ADVANCED);
  if (ctx.error) return ctx.error;
  const payload = await parseJsonBody(req);
  if (!payload || !payload.url) return jsonResponse({ success: false, error: "A website 'url' is required." }, 400);
  const fetched = await fetchSiteHtml(env, payload.url);
  const audit = analyseSite(fetched, payload.url);
  return jsonResponse({ success: true, data: { audit } });
}

async function handleAudit(req, env) {
  const ctx = await resolveClient(req, env, MIN_PLAN_ADVANCED);
  if (ctx.error) return ctx.error;
  const payload = await parseJsonBody(req);
  if (!payload || !payload.url) return jsonResponse({ success: false, error: "A website 'url' is required." }, 400);
  const fetched = await fetchSiteHtml(env, payload.url);
  const audit = analyseSite(fetched, payload.url);
  const score = scoreAudit(audit);
  const ai = buildAiBrief(audit, score, payload.businessName || audit.businessName);
  return jsonResponse({ success: true, data: { audit, score, ai } });
}

async function handleBusinessSearch(req, env) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const payload = await parseJsonBody(req).catch(() => null);
  const q = (payload && payload.query) || new URL(req.url).searchParams.get("q") || "";
  if (!q.trim()) return jsonResponse({ success: false, error: "'query' is required." }, 400);
  const domain = getDomain(q.trim().toLowerCase());
  const nameGuess = domain ? String(domain).split(".")[0] : q.trim().replace(/\.com.*$/i, "");
  return jsonResponse({
    success: true,
    candidates: [
      {
        name: titleCase(nameGuess),
        domain,
        website: domain ? `https://${domain}` : "",
        searchUrl: `https://www.google.com/search?q=${encodeURIComponent(q.trim())}`,
        confident: !!domain,
      },
    ],
  });
}

function titleCase(s) {
  return String(s || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function handleFindBusinesses(req, env) {
  const ctx = await resolveClient(req, env, MIN_PLAN_ADVANCED);
  if (ctx.error) return ctx.error;
  const url = new URL(req.url);
  const query = (url.searchParams.get("q") || "").trim();
  const location = (url.searchParams.get("location") || "").trim() || undefined;
  const limit = url.searchParams.get("limit") || "10";
  const result = await searchPlaces(env, { query, location, limit });
  if (result.error) return jsonResponse({ success: false, error: result.error }, 502);
  return jsonResponse({ success: true, data: result.data });
}

async function handleBulk(req, env) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const payload = await parseJsonBody(req);
  if (!payload || !Array.isArray(payload.ids) || !payload.ids.length) {
    return jsonResponse({ success: false, error: "An array of 'ids' is required." }, 400);
  }
  const ids = payload.ids.map((i) => `"${i}"`).join(",");
  const action = payload.action || "";
  if (action === "delete") {
    await supabaseFetch(env, `leads?client_id=eq.${encodeURIComponent(clientId)}&id=in.(${ids})`, { method: "DELETE", prefer: "return=minimal" });
    return jsonResponse({ success: true, deleted: payload.ids.length });
  }
  if (["status", "stage", "priority"].includes(action)) {
    if (!payload.value) return jsonResponse({ success: false, error: "'value' is required." }, 400);
    await supabaseFetch(env, `leads?client_id=eq.${encodeURIComponent(clientId)}&id=in.(${ids})`, {
      method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ [action]: payload.value }),
    });
    return jsonResponse({ success: true, updated: payload.ids.length });
  }
  return jsonResponse({ success: false, error: `Unknown bulk action: ${action}` }, 400);
}

async function handleExportCsv(req, env) {
  const ctx = await resolveClient(req, env, MIN_PLAN_ADVANCED);
  if (ctx.error) return ctx.error;
  const { clientId } = ctx;
  const url = new URL(req.url);
  const status = (url.searchParams.get("status") || "").trim();
  const stage = (url.searchParams.get("stage") || "").trim();
  let path = `leads?client_id=eq.${encodeURIComponent(clientId)}&select=${encodeURIComponent(LEAD_SELECT)}&order=created_at.desc`;
  if (status) path += `&status=eq.${encodeURIComponent(status)}`;
  if (stage) path += `&stage=eq.${encodeURIComponent(stage)}`;
  const rows = (await supabaseFetch(env, path, { requestId: generateRequestId() })) || [];

  const mapped = rows.map((r) => {
    const d = decorateLead(r);
    return {
      "Lead Name": d.leadName,
      "Company": r.company?.name || "",
      "Domain": r.company?.domain || "",
      "Contact": d.contactName,
      "Email": r.contact?.email || (Array.isArray(r.emails) ? r.emails[0] : "") || "",
      "Phone": r.contact?.phone || (Array.isArray(r.phones) ? r.phones[0] : "") || "",
      "Website": r.website || r.website_url || "",
      "Status": r.status || "",
      "Stage": r.stage || "",
      "Priority": r.priority || "",
      "Score": r.score || 0,
      "Opportunity": r.opportunity_level || "",
      "Estimated Value": r.estimated_value || "",
      "Assigned": r.assigned_name || "",
      "Notes": r.notes || "",
      "Created At": r.created_at || "",
    };
  });

  const filename = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(rowsToCsv(mapped), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

// ------------------------------------------------------------
// ROUTER
// ------------------------------------------------------------

export async function handleLeadsRoute(req, env, url) {
  const method = req.method;
  const path = url.pathname;

  const Rx = {
    notes: /^\/api\/leads\/([0-9a-fA-F-]+)\/notes$/,
    noteId: /^\/api\/leads\/([0-9a-fA-F-]+)\/notes\/([0-9a-fA-F-]+)$/,
    activities: /^\/api\/leads\/([0-9a-fA-F-]+)\/activities$/,
    tasks: /^\/api\/leads\/([0-9a-fA-F-]+)\/tasks$/,
    taskId: /^\/api\/leads\/([0-9a-fA-F-]+)\/tasks\/([0-9a-fA-F-]+)$/,
    followups: /^\/api\/leads\/([0-9a-fA-F-]+)\/followups$/,
    followupId: /^\/api\/leads\/([0-9a-fA-F-]+)\/followups\/([0-9a-fA-F-]+)$/,
    status: /^\/api\/leads\/([0-9a-fA-F-]+)\/status$/,
    convert: /^\/api\/leads\/([0-9a-fA-F-]+)\/convert$/,
    detail: /^\/api\/leads\/([0-9a-fA-F-]+)$/,
    companyId: /^\/api\/leads\/companies\/([0-9a-fA-F-]+)$/,
    contactId: /^\/api\/leads\/contacts\/([0-9a-fA-F-]+)$/,
    stageId: /^\/api\/leads\/stages\/([0-9a-fA-F-]+)$/,
    tagId: /^\/api\/leads\/tags\/([0-9a-fA-F-]+)$/,
  };

  // Static routes
  if (path === "/api/leads/pipeline" && method === "GET") return await handlePipeline(req, env);
  if (path === "/api/leads/stages") {
    if (method === "GET") return await handleStages(req, env, "list");
    if (method === "POST") return await handleStages(req, env, "create");
  }
  if (path === "/api/leads/tags") {
    if (method === "GET") return await handleTags(req, env, "list");
    if (method === "POST") return await handleTags(req, env, "create");
  }
  if (path === "/api/leads/companies") {
    if (method === "GET") return await handleCompanies(req, env, "list");
    if (method === "POST") return await handleCompanies(req, env, "create");
  }
  if (path === "/api/leads/contacts") {
    if (method === "GET") return await handleContacts(req, env, "list");
    if (method === "POST") return await handleContacts(req, env, "create");
  }
  if (path === "/api/leads/export" && method === "GET") return await handleExportCsv(req, env);
  if (path === "/api/leads/search/businesses" && method === "GET") return await handleBusinessSearch(req, env);
  if (path === "/api/leads/search" && method === "POST") return await handleBusinessSearch(req, env);
  if (path === "/api/leads/scan" && method === "POST") return await handleScan(req, env);
  if (path === "/api/leads/audit" && method === "POST") return await handleAudit(req, env);
  if (path === "/api/leads/find-businesses" && method === "GET") return await handleFindBusinesses(req, env);
  if (path === "/api/leads/bulk" && method === "POST") return await handleBulk(req, env);
  if (path === "/api/leads" && method === "GET") {
    const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
    if (ctx.error) return ctx.error;
    return await handleListLeads(ctx.clientId, env, url);
  }
  if (path === "/api/leads" && method === "POST") return await handleCreateLead(req, env);

  // ID routes
  const detail = path.match(Rx.detail);
  if (detail) {
    const [, leadId] = detail;
    if (method === "GET") return await handleLeadDetail(req, env, leadId);
    if (method === "PUT") return await handleUpdateLead(req, env, leadId, false);
    if (method === "DELETE") return await handleDeleteLead(req, env, leadId);
    return jsonResponse({ success: false, error: "Method not allowed." }, 405);
  }

  const cid = path.match(Rx.companyId);
  if (cid) {
    if (method === "GET") return await handleCompanyDetail(req, env, cid[1]);
    if (method === "PUT") return await handleCompanies(req, env, "update", cid[1]);
    if (method === "DELETE") return await handleCompanies(req, env, "delete", cid[1]);
  }
  const ctid = path.match(Rx.contactId);
  if (ctid) {
    if (method === "PUT") return await handleContacts(req, env, "update", ctid[1]);
    if (method === "DELETE") return await handleContacts(req, env, "delete", ctid[1]);
  }
  const sid = path.match(Rx.stageId);
  if (sid) {
    if (method === "PUT") return await handleStages(req, env, "update", sid[1]);
    if (method === "DELETE") return await handleStages(req, env, "delete", sid[1]);
  }
  const tid = path.match(Rx.tagId);
  if (tid && method === "DELETE") return await handleTags(req, env, "delete", tid[1]);

  const n = path.match(Rx.notes);
  if (n) {
    if (method === "POST") return await handleAddNote(req, env, n[1]);
    if (method === "GET") {
      const c = await authzCtx(req, env);
      if (c.error) return c.error;
      const rows = await supabaseFetch(env, `lead_notes?lead_id=eq.${encodeURIComponent(n[1])}&client_id=eq.${encodeURIComponent(c.clientId)}&order=created_at.desc`);
      return jsonResponse({ success: true, data: (rows || []).map(camelObj) });
    }
  }
  const noteId = path.match(Rx.noteId);
  if (noteId) {
    if (method === "PUT") return await handleUpdateNote(req, env, noteId[1], noteId[2]);
    if (method === "DELETE") return await handleDeleteNote(req, env, noteId[1], noteId[2]);
  }
  const acts = path.match(Rx.activities);
  if (acts) {
    if (method === "GET") { const c = await authzCtx(req, env); return c.error || (await handleListActivities(c, env, acts[1])); }
    if (method === "POST") return await handleAddActivity(req, env, acts[1]);
  }
  const t = path.match(Rx.tasks);
  if (t) {
    if (method === "GET") { const c = await authzCtx(req, env); return c.error || (await handleListTasks(c, env, t[1])); }
    if (method === "POST") return await handleAddTask(req, env, t[1]);
  }
  const tv = path.match(Rx.taskId);
  if (tv) {
    if (method === "PUT") return await handleUpdateTask(req, env, tv[1], tv[2]);
    if (method === "DELETE") return await handleDeleteTask(req, env, tv[1], tv[2]);
  }
  const f = path.match(Rx.followups);
  if (f) {
    if (method === "GET") { const c = await authzCtx(req, env); return c.error || (await handleListFollowups(c, env, f[1])); }
    if (method === "POST") return await handleAddFollowup(req, env, f[1]);
  }
  const fv = path.match(Rx.followupId);
  if (fv) {
    if (method === "PUT") return await handleUpdateFollowup(req, env, fv[1], fv[2]);
    if (method === "DELETE") return await handleDeleteFollowup(req, env, fv[1], fv[2]);
  }
  const st = path.match(Rx.status);
  if (st && method === "PUT") return await handleUpdateLead(req, env, st[1], true);
  const cv = path.match(Rx.convert);
  if (cv && method === "POST") return await handleConvert(req, env, cv[1]);

  return jsonResponse({ success: false, error: "Not found." }, 404);
}

const Rx = {
  notes: /^\/api\/leads\/([0-9a-fA-F-]+)\/notes$/,
  noteId: /^\/api\/leads\/([0-9a-fA-F-]+)\/notes\/([0-9a-fA-F-]+)$/,
  activities: /^\/api\/leads\/([0-9a-fA-F-]+)\/activities$/,
  tasks: /^\/api\/leads\/([0-9a-fA-F-]+)\/tasks$/,
  taskId: /^\/api\/leads\/([0-9a-fA-F-]+)\/tasks\/([0-9a-fA-F-]+)$/,
  followups: /^\/api\/leads\/([0-9a-fA-F-]+)\/followups$/,
  followupId: /^\/api\/leads\/([0-9a-fA-F-]+)\/followups\/([0-9a-fA-F-]+)$/,
  status: /^\/api\/leads\/([0-9a-fA-F-]+)\/status$/,
  convert: /^\/api\/leads\/([0-9a-fA-F-]+)\/convert$/,
  detail: /^\/api\/leads\/([0-9a-fA-F-]+)$/,
  companyId: /^\/api\/leads\/companies\/([0-9a-fA-F-]+)$/,
  contactId: /^\/api\/leads\/contacts\/([0-9a-fA-F-]+)$/,
  stageId: /^\/api\/leads\/stages\/([0-9a-fA-F-]+)$/,
  tagId: /^\/api\/leads\/tags\/([0-9a-fA-F-]+)$/,
};

async function authzCtx(req, env) {
  const ctx = await resolveClient(req, env, MIN_PLAN_CRM);
  return ctx.error ? { ok: false, error: ctx.error } : { ok: true, ...ctx };
}