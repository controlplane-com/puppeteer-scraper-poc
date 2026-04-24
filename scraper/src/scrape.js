// ANCHOR - Imports

// Third-party
import puppeteer from 'puppeteer';

// ANCHOR - Types

/**
 * @typedef {Object} ScrapeResult
 * @property {string} html - Full page HTML.
 * @property {string | undefined} finalUrl - URL after redirects.
 * @property {number | undefined} httpStatus - HTTP status of the navigation response.
 */

// ANCHOR - Constants

/** URL to scrape. Injected per-run by the webapp via --env. */
const URL_ENV = process.env.URL;

/** Job id the webapp minted for this run. Injected per-run. */
const JOB_ID = process.env.JOB_ID;

/** Internal processor endpoint to POST raw HTML to. Injected per-run. */
const PROCESSOR_URL = process.env.PROCESSOR_URL;

/** How long page.goto() may take before we bail. */
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS ?? 30_000);

/** How long the POST to the processor may take. */
const POST_TIMEOUT_MS = Number(process.env.POST_TIMEOUT_MS ?? 15_000);

/** Chromium flags required when running inside a rootless container. */
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

/** User-Agent string we present to target sites. */
const USER_AGENT = 'puppeteer-scraper-poc/1.0 (+https://controlplane.com)';

// ANCHOR - Entry

main().catch((err) => {
  log('error', {
    msg: 'scrape failed',
    jobId: JOB_ID,
    err: String(err),
    stack: err?.stack,
  });
  process.exit(1);
});

// ANCHOR - Main

/**
 * Orchestrates the scrape: launch Puppeteer, navigate, POST HTML to processor.
 *
 * @returns {Promise<void>}
 */
async function main() {
  // Fail loudly if the webapp didn't hand us the expected env.
  if (!URL_ENV || !JOB_ID || !PROCESSOR_URL) {
    log('error', {
      msg: 'missing required env',
      URL: !!URL_ENV,
      JOB_ID: !!JOB_ID,
      PROCESSOR_URL: !!PROCESSOR_URL,
    });
    process.exit(1);
  }

  const startedAt = Date.now();
  log('info', { msg: 'scrape start', jobId: JOB_ID, url: URL_ENV });

  // Scrape the page.
  const result = await scrape(URL_ENV);

  const scrapedAt = new Date().toISOString();
  log('info', {
    msg: 'scrape ok',
    jobId: JOB_ID,
    status: result.httpStatus,
    finalUrl: result.finalUrl,
    htmlBytes: result.html.length,
    durationMs: Date.now() - startedAt,
  });

  // Hand the payload to the processor.
  await postToProcessor({ scrapedAt, ...result });

  log('info', { msg: 'handed off to processor', jobId: JOB_ID });
}

// ANCHOR - Scrape

/**
 * Launches Puppeteer, navigates to the URL, and returns the page HTML.
 *
 * @param {string} url - URL to load.
 * @returns {Promise<ScrapeResult>}
 */
async function scrape(url) {
  // Launch a fresh headless Chromium.
  const browser = await puppeteer.launch({
    headless: 'new',
    args: CHROMIUM_ARGS,
  });

  try {
    const page = await browser.newPage();

    // Identify ourselves politely — sites can allow/deny this UA.
    await page.setUserAgent(USER_AGENT);

    // domcontentloaded is enough for head meta + anchors. Switch to
    // networkidle2 if the POC ever needs JS-rendered content.
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });

    return {
      html: await page.content(),
      finalUrl: page.url(), // after redirects
      httpStatus: response?.status(),
    };
  } finally {
    // Always close, even on throw — Chromium hangs the container otherwise.
    await browser.close().catch(() => {});
  }
}

// ANCHOR - POST to processor

/**
 * Sends the scrape payload to the internal processor.
 *
 * @param {Object} input
 * @param {string} input.html - Raw page HTML.
 * @param {string | undefined} input.finalUrl - URL after redirects.
 * @param {number | undefined} input.httpStatus - HTTP status of the navigation.
 * @param {string} input.scrapedAt - ISO timestamp when the scrape finished.
 * @returns {Promise<void>}
 */
async function postToProcessor({ html, finalUrl, httpStatus, scrapedAt }) {
  const response = await fetch(PROCESSOR_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jobId: JOB_ID,
      url: URL_ENV,
      finalUrl,
      status: httpStatus,
      html,
      scrapedAt,
    }),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });

  // If the processor rejected the payload, log and exit with a distinct code.
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    log('error', {
      msg: 'processor rejected',
      jobId: JOB_ID,
      status: response.status,
      body: bodyText.slice(0, 500),
    });
    process.exit(2);
  }
}

// ANCHOR - Helpers

/**
 * Writes a single JSON log line to stdout. Cron containers don't stay up long
 * enough to justify pulling in pino; one line of JSON is plenty and renders
 * cleanly in `cpln logs`.
 *
 * @param {string} level - Log level ('info', 'error', etc.).
 * @param {Record<string, unknown>} fields - Fields to include in the record.
 * @returns {void}
 */
function log(level, fields) {
  process.stdout.write(
    JSON.stringify({ level, time: new Date().toISOString(), ...fields }) + '\n',
  );
}
