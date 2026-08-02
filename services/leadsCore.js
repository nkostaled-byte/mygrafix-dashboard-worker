/**
 * Lead Core — Scoring, AI Summary & Recommended Services
 * ==========================================================
 * Deterministic scoring engine + natural-language sales brief builder.
 * Runs entirely on the Worker (no external LLM key required) so website
 * audits and scoring are always available to every tenant.
 */

// Default pipeline stages seeded per tenant.
export const DEFAULT_STAGES = [
  { name: "Untapped", position: 0, color: "slate", is_default: true },
  { name: "New", position: 1, color: "violet" },
  { name: "Contacted", position: 2, color: "blue" },
  { name: "Qualified", position: 3, color: "emerald" },
  { name: "Proposal", position: 4, color: "amber" },
  { name: "Won", position: 5, color: "green" },
  { name: "Lost", position: 6, color: "rose" },
];

export const ALLOWED_STATUSES = ["new", "contacted", "qualified", "proposal", "won", "lost"];
export const ALLOWED_PRIORITIES = ["low", "medium", "high", "urgent"];

// My Grafix Media catalogue.
const SERVICES = [
  {
    id: "redesign",
    name: "Website Redesign",
    priceRange: "R6,500 – R18,000",
    description: "A professional, high-converting website that reflects your brand.",
    match: (a) => a && !a.brandQuality?.hasLogo,
  },
  {
    id: "responsive",
    name: "Responsive & Mobile Optimisation",
    priceRange: "R3,500 – R8,000",
    description: "A site that looks great and converts on every device.",
    match: (a) => a && !(a.signals && a.signals.responsive),
  },
  {
    id: "seo",
    name: "SEO Optimisation",
    priceRange: "R2,500/mo",
    description: "On-page SEO, meta tags, sitemaps and local search visibility.",
    match: (a) =>
      a &&
      (a.seo?.hasMetaDescription === false || a.seo?.hasTitle === false || a.seo?.hasSitemap === false),
  },
  {
    id: "ssl",
    name: "SSL & Security Upgrade",
    priceRange: "R1,000 – R3,500",
    description: "HTTPS certificate, security and visitor trust.",
    match: (a) => a && !a.ssl,
  },
  {
    id: "contact_form",
    name: "Contact Form & Lead Capture",
    priceRange: "R2,500 – R5,000",
    description: "Capture enquiries straight into your CRM.",
    match: (a) => a && !(a.signals && a.signals.hasContactForm),
  },
  {
    id: "booking",
    name: "Online Booking System",
    priceRange: "R4,000 – R9,000",
    description: "Clients book 24/7 with automated confirmations.",
    match: (a) => a && !(a.signals && a.signals.hasBookingSystem),
  },
  {
    id: "social",
    name: "Social Media Management",
    priceRange: "R1,800/mo",
    description: "A consistent, on-brand social presence.",
    match: (a) => a && (!a.socialLinks || Object.keys(a.socialLinks).length === 0),
  },
  {
    id: "performance",
    name: "Website Performance Optimisation",
    priceRange: "R2,500 – R6,000",
    description: "Faster load times and better Core Web Vitals.",
    match: (a) => a && (a.performance?.pageSizeKb || 0) > 1500,
  },
  {
    id: "content",
    name: "Content & Copywriting",
    priceRange: "R2,000 – R7,000",
    description: "Persuasive copy and trust-building content.",
    match: (a) => a && (a.seo?.contentWords || 0) < 200,
  },
  {
    id: "branding",
    name: "Branding & Logo Design",
    priceRange: "R2,500 – R6,500",
    description: "Logo, colour palette and brand guidelines.",
    match: (a) => a && !a.brandQuality?.hasLogo && !(a.brandQuality && a.brandQuality.hasLogo),
  },
  {
    id: "analytics",
    name: "Google Analytics & Tracking Setup",
    priceRange: "R1,500 – R3,000",
    description: "Track visitors and measure marketing results.",
    match: (a) => a && (a.tech?.analytics || []).length === 0,
  },
];

const SUPPORT_SERVICE = {
  id: "support",
  name: "Website Care Plan",
  priceRange: "R950/mo",
  description: "Monthly updates, backups and priority support.",
};

/**
 * Score an audit (0–100) with reasoning and deductions.
 * @param {object} audit output of analyseSite()
 */
export function scoreAudit(audit) {
  if (!audit || audit.status === 0 && (audit.html === undefined ? false : audit.html.length === 0)) {
    const noWebsite = {
      name: "Website Redesign",
      priceRange: SERVICES[0].priceRange,
      description: SERVICES[0].description,
    };
    return buildScoreSummary(0, audit, [
      {
        label: "No accessible website",
        points: 100,
        note: "No reachable website was found. This is a prime opportunity for a complete website build.",
      },
    ]);
  }

  const deductions = [];
  let score = 100;

  const deduct = (label, points, note) => {
    score = Math.max(0, score - points);
    deductions.push({ label, points, note: note || label });
  };

  if (!audit.ssl) {
    deduct("No SSL certificate", 12, "The site is served without SSL (over HTTP), undermining visitor trust and security.");
  }

  const s = audit.signals || {};
  if (!s.responsive) {
    deduct("Not mobile-optimised", 10, "No mobile viewport detected — the site will render poorly for the majority of visitors on phones.");
  }

  const seo = audit.seo || {};
  if (seo.hasMetaDescription === false) {
    deduct("Missing meta description", 8, "No useful meta description set, which weakens search results and click-through.");
  }
  if (!seo.hasTitle) {
    deduct("Weak page title", 6, "The page title is missing or too short, hurting SEO and brand recall.");
  }
  if (seo.hasSitemap === false) {
    deduct("No XML sitemap", 4, "No sitemap found, slowing down search-engine indexing.");
  }
  if ((seo.contentWords || 0) < 200) {
    deduct("Thin content", 6, "Very little written content on the homepage — poor for SEO and trust.");
  }

  if (!s.hasContactForm) {
    deduct("No contact form", 7, "No contact form is present, so enquiries are being lost and unmeasured.");
  }
  if (!s.hasPhone) {
    deduct("No visible phone number", 3, "No phone number found, making it harder for customers to get in touch.");
  }
  if (!s.hasBookingSystem) {
    deduct("No online booking", 7, "No online booking mechanism — manual scheduling loses customers after hours.");
  }
  if (audit.socialLinks && Object.keys(audit.socialLinks).length === 0) {
    deduct("No social media presence", 5, "No social media links detected, reducing reach and trust.");
  }
  if (audit.brandQuality && !audit.brandQuality.hasLogo) {
    deduct("Missing branding / logo", 5, "No clear logo branding detected across the site.");
  }
  if ((audit.performance?.pageSizeKb || 0) > 1500) {
    deduct("Slow page weight", 5, `Homepage ~${audit.performance.pageSizeKb}KB is heavy, slowing mobile load.`);
  }
  if (audit.accessibility && audit.accessibility.missingAlt > 0) {
    deduct("Missing image alt text", 3, `${audit.accessibility.missingAlt} image(s) without alt text hurt accessibility and SEO.`);
  }

  return buildScoreSummary(score, audit, deductions);
}

/**
 * Build a scored result: classification, priority, services, reasoning.
 * @param {number|null} score computed 0-100 (null → derive from deductions)
 * @param {object} audit
 * @param {Array} deductions
 */
export function buildScoreSummary(score, audit, deductions = []) {
  const finalScore = typeof score === "number" ? score : classifyFromDeductions(deductions);

  // Guard: scoreAudit's "no website" shortcut already has max deductions.
  const normalizedScore = Math.max(0, Math.min(100, Math.round(finalScore)));

  const recommended = computeRecommendations(normalizedScore, audit);
  const reasoning = deductions.length ? deductions.map((d) => d.note) : [];
  if (!reasoning.length) {
    reasoning.push("The website looks solid — the opportunity is in ongoing care, SEO and converting traffic into enquiries.");
  }

  return {
    score: normalizedScore,
    opportunityLevel: classifyOpportunity(normalizedScore),
    opportunityLabel: classifyOpportunity(normalizedScore),
    priority: computePriority(normalizedScore),
    recommendedServices: recommended.map((s) => ({ id: s.id, name: s.name, priceRange: s.priceRange, description: s.description })),
    reasoning,
    deductions,
  };
}

function computeRecommendations(score, audit) {
  const picks = [];
  for (const s of SERVICES) {
    let matched = false;
    try {
      matched = s.match(audit);
    } catch {
      matched = false;
    }
    if (matched) picks.push(s);
  }
  if (score >= 30) {
    picks.push(SUPPORT_SERVICE);
  }
  return picks.slice(0, 6);
}

function classifyOpportunity(score) {
  if (score >= 80) return "High";
  if (score >= 55) return "Opportunity";
  if (score >= 30) return "Moderate";
  if (score > 0) return "Potential";
  return "Low";
}

function computePriority(score) {
  if (score >= 70) return "urgent";
  if (score >= 45) return "high";
  if (score >= 20) return "medium";
  return "low";
}

/**
 * Build a human-readable AI brief: what's wrong, suggested improvements,
 * recommended services, and a ready-to-send sales message.
 * @param {object} audit
 * @param {object} scoreResult from buildScoreSummary
 * @param {string} businessName
 */
export function buildAiBrief(audit, scoreResult, businessName) {
  const name = businessName || audit?.businessName || audit?.domain || "your business";
  const whatIsWrong = (scoreResult.reasoning || []).slice(0, 4);
  const improvements = (scoreResult.deductions || []).map((d) => `Add ${d.label.toLowerCase() ? "a" : ""} ${d.label} / ${d.note}`).concat(
    (scoreResult.reasoning || []).slice(4, 8)
  );

  const services = (scoreResult.recommendedServices || []).slice(0, 4);
  const serviceLine = services.length ? services.map((s) => s.name).join(", ") : "a full website build";

  const problemSentence =
    whatIsWrong.length
      ? `Right now your website ${whatIsWrong[0].toLowerCase()}${whatIsWrong.length > 1 ? ", and more" : "."}`
      : "your website is in strong shape and just needs ongoing polish.";

  const salesMessage = [
    `Hi there 👋 — My Grafix Media recently reviewed the website for ${name}.`,
    problemSentence,
    `We can fix this with ${serviceLine}, built around your goals and budget.`,
    `Would you like a free, no-obligation proposal & free website audit report? Just reply and we'll send it over.`,
  ].join(" ");

  return {
    whatIsWrong,
    improvements,
    recommended: services.map((s) => s.name),
    salesMessage,
  };
}