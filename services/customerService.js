/**
 * Customer Service
 * =================
 * Data access for customers — find-or-create logic used by orders & bookings.
 */

import { supabaseFetch } from "../lib/supabase.js";

/**
 * Find an existing customer by email, or create a new one.
 * @param {object} env
 * @param {string} clientId
 * @param {{ name: string, email?: string, phone?: string }} customerData
 * @param {object} [options]
 * @param {string} [options.requestId]
 * @returns {Promise<object>}
 */
export async function findOrCreateCustomer(env, clientId, customerData, options = {}) {
  const { name, email, phone } = customerData;

  if (email) {
    const existing = await supabaseFetch(
      env,
      `customers?client_id=eq.${encodeURIComponent(clientId)}&email=eq.${encodeURIComponent(email)}&select=*`,
      { requestId: options.requestId }
    );
    if (existing && existing.length) return existing[0];
  }

  const created = await supabaseFetch(
    env,
    "customers",
    {
      method: "POST",
      body: JSON.stringify({
        client_id: clientId,
        name,
        email: email || null,
        phone: phone || null,
      }),
      requestId: options.requestId,
    }
  );

  return created[0];
}

