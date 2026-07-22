/**
 * Client Service
 * ===============
 * Data access for the `clients` table.
 */

import { supabaseFetch } from "../lib/supabase.js";

/**
 * Load a client by client_id.
 * @param {object} env
 * @param {string} clientId
 * @param {object} [options]
 * @param {string} [options.requestId]
 * @returns {Promise<object|null>}
 */
export async function loadClient(env, clientId, options = {}) {
  const path = `clients?client_id=eq.${encodeURIComponent(clientId)}&select=*`;
  const rows = await supabaseFetch(env, path, {
    requestId: options.requestId,
  });
  return (rows && rows[0]) || null;
}

