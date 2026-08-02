/**
 * Google Places — Business Discovery (Lead Mining)
 * =================================================
 * Single, thin wrapper around the Google Places API (New) `places:searchText`
 * endpoint, used by the Lead Generation module to find businesses by keyword
 * + optional location.
 *
 * Requires env.GOOGLE_PLACES_API_KEY (Places API v-new; API-key auth only).
 *
 * NOTE ON USAGE: results are surfaced for manual qualification. If you plan to
 * store/bulk-export many results, review Google's Places API Terms of Service —
 * caching and aggregation are restricted without the appropriate (Atlas) tier.
 */

const PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.primaryTypeDisplayName",
  "places.types",
  "places.location",
].join(",");

/**
 * Search for businesses via Google Places Text Search (New).
 * @param {object} env - Worker bindings (GOOGLE_PLACES_API_KEY)
 * @param {object} input
 * @param {string} input.query - free-text query (e.g. "coffee shops Sandton")
 * @param {string} [input.location] - optional "lat,lng" OR "placeName" to bias
 * @param {number} [input.pageSize] - 1..20 results (default 10)
 * @returns {{data: Array} | {error: string}}
 */
export async function searchPlaces(env, { query, location, limit } = {}) {
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return { error: "GOOGLE_PLACES_API_KEY is not configured. Add it in the Worker settings." };
  }
  if (!query || !String(query).trim()) {
    return { error: "A search query is required." };
  }

  const body = {
    textQuery: String(query).trim(),
    pageSize: Math.min(Math.max(Number(limit) || 10, 1), 20),
  };

  // Optional location bias (a "lat,lng" pair or a named area string).
  if (location) {
    const trimmed = String(location).trim();
    const coords = trimmed.split(",").map((p) => Number(p.trim()));
    if (coords.length === 2 && coords.every((n) => Number.isFinite(n))) {
      body.locationBias = {
        circle: { center: { latitude: coords[0], longitude: coords[1] }, radius: 2000.0 },
      };
    } else {
      // Fall back to a loose region string inside the text query.
      body.textQuery = `${body.textQuery} ${trimmed}`.trim();
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(PLACES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = `Places API error (${res.status})`;
      try {
        const err = JSON.parse(text);
        if (err.error?.message) msg = err.error.message;
      } catch { /* ignore */ }
      return { error: msg + (env.DEBUG ? ` — ${text}` : "") };
    }

    const json = await res.json();
    const places = (json.places || []).map(normalizePlace).filter(Boolean);
    return { data: places };
  } catch (err) {
    return {
      error:
        err instanceof DOMException && err.name === "AbortError"
          ? "Places request timed out."
          : "Places request failed: " + (err?.message || "unknown error"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePlace(p) {
  if (!p || !p.id) return null;
  const address = p.formattedAddress || "";
  const name = p.displayName?.text || "";
  const lat = p.location?.latitude ?? null;
  const lng = p.location?.longitude ?? null;
  return {
    placeId: String(p.id).replace(/^places\//, "") || p.id,
    name,
    address,
    phone: p.internationalPhoneNumber || p.nationalPhoneNumber || null,
    website: p.websiteUri || null,
    rating: typeof p.rating === "number" ? p.rating : null,
    ratingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
    category: p.primaryTypeDisplayName?.text || (Array.isArray(p.types) ? p.types[0] : null) || null,
    types: Array.isArray(p.types) ? p.types : [],
    latitude: lat,
    longitude: lng,
  };
}