/**
 * Site Scanner — Website Audit Extractor
 * ========================================
 * Fetches a website's HTML and extracts publicly-available business signals
 * for lead scoring. No external API keys required; runs purely on the Worker.
 *
 * Returns a structured audit object covering: business identity, contact
 * details, tech stack, marketing/SEO, trust, accessibility and brand quality.
 */

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024; // 3MB cap

// ==================================================
// URL HELPERS
// ==================================================

export function normalizeUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

export function getDomain(url) {
  const u = String(url || "").replace(/^https?:\/\//i, "").split("/")[0] || "";
  return u.replace(/^www\./i, "").toLowerCase();
}

function resolveUrl(base, ref) {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

// ==================================================
// HTML FETCHER
// ==================================================

export async function fetchSiteHtml(env, url) {
  const target = normalizeUrl(url);
  if (!target) throw new Error("A valid website URL is required.");

  const urlObj = new URL(target);
  const withSsl = urlObj.protocol === "https:";

  const attempt = async (href) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const resp = await fetch(href, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; MyGrafixLeadScanner/1.0; +https://mygrafix.co) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        },
      });
      const body = await resp.arrayBuffer();
      const arr = new Uint8Array(body);
      const contentLength = arr.byteLength;
      const html =
        contentLength <= MAX_PAGE_BYTES
          ? new TextDecoder().decode(arr)
          : new TextDecoder().decode(arr.slice(0, MAX_PAGE_BYTES));
      return {
        html,
        finalUrl: resp.url || href,
        status: resp.status,
        ssl: /^https:/.test(resp.url || href),
        contentType: resp.headers.get("content-type") || "",
        responseBytes: contentLength,
      };
    } catch (err) {
      err.synthetic = true;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  const variants = [target];
  if (withSsl) {
    const u = new URL(target);
    variants.push(`http://${u.host}${u.pathname}${u.search}`);
  }

  let lastErr = null;
  for (const v of variants) {
    try {
      return await attempt(v);
    } catch (err) {
      lastErr = err;
    }
  }

  return {
    html: "",
    finalUrl: target,
    status: 0,
    ssl: false,
    contentType: "",
    responseBytes: 0,
    domain: urlObj.host,
    error: lastErr?.message || "Could not load the website.",
  };
}

// ==================================================
// SMALL UTILITIES
// ==================================================

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function unique(arr) {
  return Array.from(new Set(arr.map((x) => String(x).trim()).filter(Boolean)));
}

function findMeta(html, kind, nameOrProp) {
  const attr = kind === "name" ? "name" : "property";
  const re = new RegExp(`<meta[^>]*${attr}=["']${esc(nameOrProp)}["'][^>]*content=["']([^"']*)["']`, "i");
  const m1 = html.match(re);
  if (m1) return decodeEntities(m1[1]);
  const re2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*${attr}=["']${esc(nameOrProp)}["']`, "i");
  const m2 = html.match(re2);
  return m2 ? decodeEntities(m2[1]) : "";
}

function findDirectorMeta(html, name) {
  return findMeta(html, "name", name);
}

// ==================================================
// ANALYSIS ENGINE
// ==================================================

export function analyseSite(fetched, requestedUrl) {
  const html = fetched.html || "";
  const lower = html.toLowerCase();
  const base = fetched.finalUrl || normalizeUrl(requestedUrl);
  const domain = getDomain(fetched.finalUrl || requestedUrl);

  // ── Identity & SEO ──────────────────────────────────
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";
  const metaDescription =
    findMeta(html, "name", "description") || findMeta(html, "property", "og:description");
  const ogTitle = findMeta(html, "property", "og:title");
  const ogImage = findMeta(html, "property", "og:image");
  const ogUrl = findMeta(html, "property", "og:url");

  // Favicon
  let favicon = findLink(html, "icon");
  if (!favicon && findLink(html, "shortcut icon")) favicon = findLink(html, "shortcut icon");
  if (favicon) favicon = resolveUrl(base, favicon);
  else favicon = `${base.replace(/\/$/, "")}/favicon.ico`;

  // Logo (og:image or explicit logo image)
  let logo = ogImage || "";
  const logoSrc = html.match(/<(?:img|source)[^>]*class=["'][^"']*\blogo\b[^"']*["'][^>]*(?:src|data-src)=["']([^"']+)/i);
  if (logoSrc) logo = resolveUrl(base, logoSrc[1]);
  if (!logo) {
    const siteLogo = html.match(/<(?:img|source)[^>]*(?:src|data-src)=["']([^"']+)[^>]*class=["'][^"']*\blogo\b[^"']*["']/i);
    if (siteLogo) logo = resolveUrl(base, siteLogo[1]);
  }

  // ── Contact extraction ──────────────────────────────
  const emails = unique(
    readAll(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, html).filter((e) => !/(\d+\.\d+\.\d+\.\d+)/.test(e))
  );
  const phones = unique(
    readAll(/[+]?[(]?[0-9]{2,4}[)]?[\s.\-]?[0-9]{2,4}[\s.\-]?[0-9]{3,5}/g, html).filter(
      (p) => p.replace(/\D/g, "").length >= 9
    )
  );
  const phonesClean = sanitizePhones(phones);
  const address = extractAddress(html);
  const socialLinks = extractSocial(html, base);

  // ── Tech stack detection ────────────────────────────
  const cms = detectCms(lower);
  const frameworks = detectFrameworks(lower);
  const analytics = detectAnalytics(lower);

  // ── Marketing signals ───────────────────────────────
  const imageCount = (lower.match(/<img[\s>]/g) || []).length;
  const externalScripts = (html.match(/<script[^>]+src=/gi) || []).length;
  const hasContactForm = /<form[\s>]/i.test(lower) && /(name|email|phone|tel|message|submit|send)/i.test(lower);
  const contentWords = (html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean).length);

  const signals = {
    hasAddress: !!address,
    hasPhone: phonesClean.length > 0,
    hasEmail: emails.length > 0,
    hasContactPage: /href=["'][^"']*contact|contact\s+us|"contact"/i.test(lower),
    hasAboutPage: /href=["'][^"']*about|about\s+(us|our)/i.test(lower),
    hasBookingSystem:
      /(book\s*a\s*now|book\s+appointment|book-now|bookings|calendly|reservation|schedule|"book")/i.test(lower),
    hasContactForm,
    hasNewsletter: /(newsletter|subscribe)/i.test(lower),
    hasLiveChat: /(crisp|tawk|intercom|zendesk|livechat|drift|tidio|chatbox)/i.test(lower),
    hasTestimonials: /(testimonial|reviews?|rating)/i.test(lower),
    hasTrustSeals: /(trusted|secure|verified|trustpilot|ssl|badge)/i.test(lower),
    hasCookieConsent: /(cookie-consent|cookieconsent|gdpr|"cookies?"|accept.*[cC]ookie)/i.test(lower),
    hasOnlinePayments: /(paypal|stripe|paystack|flutterwave|checkout|"cart"|"shop"|woocommerce|add\s*to\s*cart)/i.test(lower),
    responsive: /(viewport|@media|initial-scale=1)/i.test(lower),
    hasSitemap: /sitemap/i.test(lower),
    hasRobots: /robots\.txt|name=["']robots/i.test(lower),
    hasFontAwesome: /font-?awesome/i.test(lower),
  };

  const hasMetaDescription = !!metaDescription && metaDescription.length >= 40;
  const hasGoodTitle = title.length >= 30 && title.length <= 70;
  const hasAltTags = imageCount === 0 ? true : (html.match(/alt=/gi) || []).length > 0;
  const missingAlt = imageCount > 0 ? Math.max(0, imageCount - (html.match(/alt=/gi) || []).length) : 0;

  return {
    url: base,
    domain,
    requestedUrl,
    scannedAt: new Date().toISOString(),
    status: fetched.status || 0,
    ssl: !!fetched.ssl,
    httpStatus: fetched.status || 0,
    sslError: fetched?.error || (fetched.ssl ? null : "Served over HTTP — no SSL detected."),
    // Identity
    businessName: inferBusinessName(title, domain),
    title,
    metaDescription,
    ogTitle,
    favicon,
    logo,
    language: (html.match(/<html[^>]*lang=["']([^"']+)/i) || [])[1] || "",
    // Contact
    emails,
    phones: phonesClean,
    address,
    socialLinks,
    services: extractServices(html),
    products: extractProducts(html),
    // Tech
    tech: {
      cms,
      generator: (findMeta(html, "name", "generator") || "").trim(),
      analytics,
      frameworks,
      hasAnyJs: /<script/i.test(lower),
    },
    // SEO
    seo: {
      titleLength: title.length,
      descriptionLength: (metaDescription || "").length,
      hasMetaDescription: hasMetaDescription,
      hasTitle: hasGoodTitle,
      contentWords,
      imageCount,
      externalScripts,
      hasCanonical: /rel=["']canonical/i.test(lower),
      hasRobots: /name=["']robots/i.test(lower),
      hasSitemap: /sitemap/i.test(lower),
      hasAltTags,
      missingAlt,
    },
    // Accessibility
    accessibility: {
      hasAltTags,
      missingAlt,
      hasLang: /<html[^>]*lang=/i.test(html),
    },
    // Performance
    performance: {
      pageSizeKb: Math.round((fetched.responseBytes || 0) / 1024),
      externalScripts,
      contentWords,
      hasMinifiedResources: /\.min\.(css|js)/.test(lower),
    },
    // Marketing signals / brand quality
    signals,
    brandQuality: {
      hasLogo: !!logo,
      hasMetaDescription: hasMetaDescription,
      hasTitle: hasGoodTitle,
      responsive: signals.responsive,
      hasConsistentContent: contentWords > 50,
    },
    trust: {
      ssl: !!fetched.ssl,
      hasLiveChat: signals.hasLiveChat,
      hasTestimonials: signals.hasTestimonials,
      hasTrustSeals: signals.hasTrustSeals,
      hasCookiePolicy: signals.hasCookieConsent,
      hasContactPage: signals.hasContactPage,
      hasReturnsPolicy: /(return|refund|privacy)/i.test(lower),
    },
  };
}

// ── Sub-readers ────────────────────────────────────

function findLink(html, rel) {
  const re = new RegExp(`<link[^>]*rel=["'][^"']*${esc(rel)}[^"']*["'][^>]*href=["']([^"']+)["']`, "i");
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : "";
}

function readAll(regex, html) {
  const out = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[0]);
  }
  return out;
}

/**
 * Filter raw phone candidates to keep only plausible phone numbers.
 * The raw regex catches any 9+ digit run, which drags in coordinates,
 * IPs, SKUs and gibberish. We drop anything containing a decimal point
 * (lat/lng like "30.3939" card-style) and anything outside E.164 bounds,
 * then dedupe by digits and cap the result.
 */
function sanitizePhones(arr, cap = 8) {
  const seen = new Set();
  const out = [];
  for (const p of arr || []) {
    if (out.length >= cap) break;
    if (typeof p !== "string") continue;
    // Decimal points indicate coordinates or decimal junk, not a phone.
    if (p.includes(".")) continue;
    // Collapse separators to check the raw dialable length.
    const digits = p.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) continue;
    // Repeated-digit noise like 00000... or 111...
    if (/^(\d)\1+$/.test(digits)) continue;
    // International short code (e.g. "411") is not a business number.
    if (!seen.has(digits)) {
      seen.add(digits);
      out.push(p);
    }
  }
  return out;
}

function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      /* ignore invalid JSON-LD */
    }
  }
  return out;
}

function extractAddress(html) {
  const addr = html.match(/<address[^>]*>([\s\S]*?)<\/address>/i);
  if (addr) {
    const cleaned = addr[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (cleaned) return cleaned;
  }
  const block = extractJsonLd(html).find((x) => x && String(x["@type"] || "").toLowerCase().includes("postaladdress"));
  if (block) {
    return [block.streetAddress, block.addressLocality, block.postalCode, block.addressRegion, block.addressCountry]
      .filter(Boolean)
      .join(", ");
  }
  return "";
}

function extractSocial(html, base) {
  const out = {};
  const rules = [
    ["facebook", /href=["'](https?:\/\/(?:www\.)?facebook\.com\/[^"' ]+)/i],
    ["instagram", /href=["'](https?:\/\/(?:www\.)?instagram\.com\/[^"' ]+)/i],
    ["linkedin", /href=["'](https?:\/\/(?:www\.)?linkedin\.com\/[^"' ]+)/i],
    ["twitter", /href=["'](https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^"' ]+)/i],
    ["youtube", /href=["'](https?:\/\/(?:www\.)?youtube\.com\/[^"' ]+)/i],
    ["tiktok", /href=["'](https?:\/\/(?:www\.)?tiktok\.com\/[^"' ]+)/i],
    ["whatsapp", /href=["'](https?:\/\/(?:wa\.me|api\.whatsapp\.com)\/[^"' ]+)/i],
  ];
  for (const [name, re] of rules) {
    const m = html.match(re);
    if (m) out[name] = decodeEntities(m[1]);
  }
  return out;
}

function extractServices(html) {
  const jsonLd = extractJsonLd(html);
  const names = jsonLd
    .filter((x) => String(x["@type"] || "").toLowerCase() === "service")
    .map((x) => x.name)
    .filter(Boolean);
  if (names.length) return unique(names);
  return [];
}

function extractProducts(html) {
  const jsonLd = extractJsonLd(html);
  const names = jsonLd
    .filter((x) => String(x["@type"] || "").toLowerCase() === "product")
    .map((x) => x.name)
    .filter(Boolean);
  if (names.length) return unique(names);
  return [];
}

function inferBusinessName(title, domain) {
  if (title && title.includes("|")) return title.split("|")[0].trim();
  if (title && title.includes("–")) return title.split("–")[0].trim();
  if (title && title.includes("-")) return title.split("-")[0].trim();
  if (title) return title.substring(0, 60).trim();
  return domain;
}

function detectFrameworks(lower) {
  const out = [];
  const rules = {
    React: /react/i,
    Vue: /vue(?:js)?|createApp/i,
    Angular: /ng-?version|angular/i,
    Next: /_next|next\.js/i,
    Nuxt: /_nuxt|nuxt/i,
    Gatsby: /gatsby/i,
    Svelte: /svelte/i,
    Bootstrap: /bootstrap/i,
    Tailwind: /tailwindcss|tw-[a-z]/i,
    jQuery: /jquery/i,
  };
  for (const [name, re] of Object.entries(rules)) {
    if (re.test(lower)) out.push(name);
  }
  return out;
}

function detectCms(lower) {
  const rules = [
    ["WordPress", /wp-content|wp-includes|wp-admin/i],
    ["Shopify", /shopify|cdn\.shopify/i],
    ["Wix", /wix\.com|wix-static/i],
    ["Squarespace", /squarespace/i],
    ["Webflow", /webflow/i],
    ["Joomla", /joomla/i],
    ["Drupal", /drupal/i],
    ["Ghost", /ghost/i],
    ["BigCommerce", /bigcommerce/i],
    ["WooCommerce", /woocommerce/i],
    ["HubSpot", /hubspot/i],
    ["Carrd", /carrd/i],
    ["Framer", /framer/i],
  ];
  for (const [name, re] of rules) {
    if (re.test(lower)) return name;
  }
  return "";
}

function detectAnalytics(lower) {
  const out = [];
  const rules = [
    ["GoogleAnalytics", /(google-analytics|googletagmanager|gtag\/js)/i],
    ["GoogleTagManager", /googletagmanager\.com\/gtm/i],
    ["FacebookPixel", /facebook\.com\/tr|fbq\(/i],
    ["MetaPixel", /connect\.facebook\.net/i],
    ["Hotjar", /hotjar/i],
    ["HubSpotAnalytics", /js\.hs-scripts\.com/i],
    ["GA4", /googletagmanager\.com\/gtag/i],
    ["Clarity", /clarity\.ms|clarityq/i],
    ["Matomo", /matomo/i],
    ["Plausible", /plausible/i],
  ];
  for (const [name, re] of rules) {
    if (re.test(lower)) out.push(name);
  }
  return out;
}