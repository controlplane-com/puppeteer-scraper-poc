// ANCHOR - Imports

// Third-party
import * as cheerio from 'cheerio';
import express from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';

// ANCHOR - Types

/**
 * @typedef {Object} ProcessedJob
 * @property {string} jobId
 * @property {string} url
 * @property {string | null} finalUrl
 * @property {number | null} httpStatus
 * @property {string} scrapedAt
 * @property {string} processedAt
 * @property {string} title
 * @property {string | null} description
 * @property {string | null} favicon
 * @property {string | null} ogImage
 * @property {string | null} canonical
 * @property {string | null} language
 * @property {Array<{ href: string, text: string }>} links
 * @property {number} htmlBytes
 */

/**
 * @typedef {Object} ParsedPage
 * @property {string} title
 * @property {string | null} description
 * @property {string | null} favicon
 * @property {string | null} ogImage
 * @property {string | null} canonical
 * @property {string | null} language
 * @property {Array<{ href: string, text: string }>} links
 */

// ANCHOR - Constants

/** HTTP port we listen on. */
const PORT = Number(process.env.PORT ?? 8080);

/** Hard cap on HTML size we'll accept from the scraper. */
const MAX_HTML_BYTES = Number(process.env.MAX_HTML_BYTES ?? 5_000_000);

/** Max number of links we'll extract from a page. */
const MAX_LINKS = Number(process.env.MAX_LINKS ?? 20);

/** Max number of jobs we keep in memory. FIFO eviction past this. */
const MAX_STORED_JOBS = Number(process.env.MAX_STORED_JOBS ?? 500);

/** Protocols we'll allow for image URLs rendered in the browser. */
const ALLOWED_IMAGE_PROTOCOLS = new Set(['http:', 'https:', 'data:']);

/**
 * Favicon selectors, ordered best-to-worst. apple-touch-icon is preferred
 * because it's typically higher-res than the tiny `rel="icon"` favicon.
 */
const FAVICON_SELECTORS = [
  'link[rel="apple-touch-icon"]',
  'link[rel="apple-touch-icon-precomposed"]',
  'link[rel="icon"]',
  'link[rel="shortcut icon"]',
];

// ANCHOR - State

/** Shared logger for the HTTP layer. */
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/**
 * POC storage. Restart loses state — swap in Redis for persistence.
 *
 * @type {Map<string, ProcessedJob>}
 */
const jobs = new Map();

// ANCHOR - App setup

const app = express();
app.disable('x-powered-by');
app.use(pinoHttp({ logger }));

// HTML can be large — size the body parser to accept up to MAX_HTML_BYTES
// plus a little headroom for the surrounding JSON envelope.
app.use(express.json({ limit: `${Math.ceil(MAX_HTML_BYTES / 1_000_000) + 1}mb` }));

// ANCHOR - Routes

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * POST /raw
 *
 * Called by the scraper once per cron run. Parses the HTML, stores a summary,
 * returns 200.
 */
app.post('/raw', (req, res) => {
  const { jobId, url, finalUrl, status, html, scrapedAt } = req.body ?? {};

  // Validate required fields.
  const validation = validateRaw({ jobId, url, html });
  if (validation) {
    res.status(400).json({ error: validation });
    return;
  }

  // Size cap — also enforced at the body parser, but make it explicit.
  if (html.length > MAX_HTML_BYTES) {
    res.status(413).json({ error: `html exceeds ${MAX_HTML_BYTES} bytes` });
    return;
  }

  // Use the final URL (after redirects) as the base for relative-URL resolution,
  // falling back to the submitted URL if the scraper didn't track redirects.
  const baseUrl = typeof finalUrl === 'string' && finalUrl ? finalUrl : url;

  // Parse the HTML into a compact summary.
  const parsed = parseHtml(html, baseUrl);

  // Build the stored record.
  const record = {
    jobId,
    url,
    finalUrl: finalUrl ?? null,
    // Renamed from `status` to avoid colliding with the webapp's state field.
    httpStatus: typeof status === 'number' ? status : null,
    scrapedAt: scrapedAt ?? new Date().toISOString(),
    processedAt: new Date().toISOString(),
    title: parsed.title,
    description: parsed.description,
    favicon: parsed.favicon,
    ogImage: parsed.ogImage,
    canonical: parsed.canonical,
    language: parsed.language,
    links: parsed.links,
    htmlBytes: html.length,
  };
  rememberJob(jobId, record);

  req.log.info(
    {
      jobId,
      url,
      finalUrl,
      httpStatus: record.httpStatus,
      titleLen: parsed.title?.length ?? 0,
      linkCount: parsed.links.length,
      htmlBytes: html.length,
    },
    'job processed',
  );

  res.status(200).json({ ok: true, jobId });
});

/** GET /jobs/:id — called by the webapp on behalf of the browser. */
app.get('/jobs/:id', (req, res) => {
  const record = jobs.get(req.params.id);
  if (!record) {
    res.status(404).json({ error: 'job not found', jobId: req.params.id });
    return;
  }
  res.status(200).json(record);
});

// Top-level error handler — unhandled throws shouldn't leak stack traces.
app.use((err, req, res, _next) => {
  req.log?.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'Internal error' });
});

// ANCHOR - Server start

app.listen(PORT, () => {
  logger.info(
    { port: PORT, maxStoredJobs: MAX_STORED_JOBS },
    'processor listening',
  );
});

// ANCHOR - Helpers

/**
 * Records a job in the in-memory store with FIFO eviction past MAX_STORED_JOBS.
 *
 * @param {string} jobId - Job id.
 * @param {ProcessedJob} record - The record to store.
 * @returns {void}
 */
function rememberJob(jobId, record) {
  // Map preserves insertion order, so the first key is the oldest.
  if (jobs.size >= MAX_STORED_JOBS) {
    const oldest = jobs.keys().next().value;
    if (oldest !== undefined) {
      jobs.delete(oldest);
    }
  }
  jobs.set(jobId, record);
}

/**
 * Validates the payload the scraper POSTs to /raw.
 *
 * @param {{ jobId: unknown, url: unknown, html: unknown }} input
 * @returns {string | null} Error message, or null when valid.
 */
function validateRaw({ jobId, url, html }) {
  if (typeof jobId !== 'string' || !jobId) {
    return 'jobId is required';
  }
  if (typeof url !== 'string' || !url) {
    return 'url is required';
  }
  if (typeof html !== 'string') {
    return 'html must be a string';
  }
  return null;
}

/**
 * Extracts a summary (title + meta + favicon + og:image + links) from HTML.
 * Hard-caps field lengths so a pathological page can't blow up the record.
 *
 * @param {string} html - Raw page HTML.
 * @param {string} baseUrl - Base URL for resolving relative hrefs.
 * @returns {ParsedPage}
 */
function parseHtml(html, baseUrl) {
  const $ = cheerio.load(html);

  // Honor <base href> if present — it overrides the document's base URL.
  const baseHref = $('head > base[href]').attr('href')?.trim();
  const resolvedBase = baseHref ? resolveUrl(baseHref, baseUrl) ?? baseUrl : baseUrl;

  // Title: prefer <title>, fall back to og:title.
  const rawTitle =
    $('head > title').first().text() || $('meta[property="og:title"]').attr('content') || '';
  const title = rawTitle.trim().slice(0, 500);

  // Description: prefer <meta name="description">, fall back to og:description.
  const rawDescription =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    '';
  const description = rawDescription.trim().slice(0, 1000) || null;

  // Misc page-level metadata.
  const language = $('html').attr('lang')?.trim().slice(0, 20) || null;
  const canonical = resolveUrl($('link[rel="canonical"]').attr('href'), resolvedBase);
  const favicon = findFavicon($, resolvedBase);
  const ogImage = resolveImageUrl($('meta[property="og:image"]').attr('content'), resolvedBase);

  // Anchors — absolute href + visible text, capped at MAX_LINKS.
  const links = extractLinks($, resolvedBase);

  return { title, description, favicon, ogImage, canonical, language, links };
}

/**
 * Extracts anchor tags from the page, resolving relative hrefs to absolute
 * URLs so the browser navigates to the original site rather than the webapp.
 *
 * @param {cheerio.CheerioAPI} $ - Loaded cheerio document.
 * @param {string} baseUrl - Base URL for resolution.
 * @returns {Array<{ href: string, text: string }>}
 */
function extractLinks($, baseUrl) {
  const links = [];

  $('a[href]').each((_, el) => {
    // Stop iterating once we have enough links.
    if (links.length >= MAX_LINKS) {
      return false;
    }

    // Resolve the raw href against the base URL; skip anything unsafe.
    const rawHref = $(el).attr('href')?.trim();
    const href = resolveUrl(rawHref, baseUrl);
    if (!href) {
      return undefined;
    }

    const text = $(el).text().trim().slice(0, 200);
    links.push({ href: href.slice(0, 1000), text });
    return undefined;
  });

  return links;
}

/**
 * Finds the best favicon URL for a page, falling back to /favicon.ico at
 * the origin if no <link rel="icon"> tag is present.
 *
 * @param {cheerio.CheerioAPI} $ - Loaded cheerio document.
 * @param {string} baseUrl - Base URL for resolution.
 * @returns {string | null}
 */
function findFavicon($, baseUrl) {
  // Walk the selector list in preference order.
  for (const selector of FAVICON_SELECTORS) {
    const href = $(selector).first().attr('href')?.trim();
    const resolved = resolveImageUrl(href, baseUrl);
    if (resolved) {
      return resolved;
    }
  }

  // Fall back to /favicon.ico at the page's origin.
  try {
    const origin = new URL(baseUrl).origin;
    return `${origin}/favicon.ico`;
  } catch {
    return null;
  }
}

/**
 * Resolves a possibly-relative URL against a base. Blocks `javascript:` URLs
 * — they'd be dangerous if rendered as link href attributes.
 *
 * @param {string | undefined} rawUrl - Raw URL from an href attribute.
 * @param {string} base - Base URL to resolve against.
 * @returns {string | null} Absolute URL, or null when invalid/unsafe.
 */
function resolveUrl(rawUrl, base) {
  if (!rawUrl) {
    return null;
  }
  try {
    const resolved = new URL(rawUrl, base);
    if (resolved.protocol === 'javascript:') {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Resolves an image URL but only accepts http/https/data protocols. Used for
 * favicon and og:image so we never render a `<img src="javascript:…">` tag.
 *
 * @param {string | undefined} rawUrl - Raw URL from an attribute.
 * @param {string} base - Base URL to resolve against.
 * @returns {string | null}
 */
function resolveImageUrl(rawUrl, base) {
  if (!rawUrl) {
    return null;
  }
  try {
    const resolved = new URL(rawUrl, base);
    if (!ALLOWED_IMAGE_PROTOCOLS.has(resolved.protocol)) {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}
