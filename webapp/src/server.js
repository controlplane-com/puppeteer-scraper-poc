// ANCHOR - Imports

// Node built-ins
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Third-party
import express from "express";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";

// Internal
import { runCronWorkload } from "./cpln.js";

// ANCHOR - Types

/**
 * @typedef {Object} TrackedJob
 * @property {'pending' | 'failed'} status - Current webapp-side status.
 * @property {string} url - URL submitted by the user.
 * @property {string} [error] - Human-readable error (when status === 'failed').
 */

// ANCHOR - Constants

/** Resolved path to this file's directory, for locating ./public/. */
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Where the static UI files live. */
const PUBLIC_DIR = path.resolve(THIS_DIR, "..", "public");

/** HTTP port the webapp listens on. */
const PORT = Number(process.env.PORT ?? 8080);

/** Control Plane org — auto-injected into every workload. */
const ORG = process.env.CPLN_ORG;

/** Control Plane GVC — auto-injected into every workload. */
const GVC = process.env.CPLN_GVC;

/** Image reference the scraper cron uses. */
const SCRAPER_IMAGE =
  process.env.SCRAPER_IMAGE ?? "//image/puppeteer-scraper-poc-scraper:latest";

/** CPU allocation for each scraper run. */
const SCRAPER_CPU = process.env.SCRAPER_CPU ?? "500m";

/** Memory allocation for each scraper run. */
const SCRAPER_MEMORY = process.env.SCRAPER_MEMORY ?? "1Gi";

/** Command the scraper container should run. */
const SCRAPER_COMMAND = ["node", "src/scrape.js"];

/** Processor workload name (used to build its internal DNS hostname). */
const PROCESSOR_WORKLOAD = process.env.PROCESSOR_WORKLOAD ?? "processor";

/** Processor's listening port. */
const PROCESSOR_PORT = process.env.PROCESSOR_PORT ?? "8080";

/** Hard cap on submitted URL length. */
const MAX_URL_LENGTH = 2048;

/** Cap on in-memory job tracking. FIFO eviction past this. */
const MAX_TRACKED_JOBS = 500;

/** Hostnames we refuse to scrape outright. */
const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0", "::", "::1"]);

/** Hostname suffixes we refuse to scrape (internal TLDs). */
const BLOCKED_HOSTNAME_SUFFIXES = [".local", ".internal", ".localhost"];

/**
 * Private / link-local IP ranges we refuse to scrape. Blocks trivial SSRF at
 * the request layer. A hostname that DNS-resolves to a private IP is still
 * reachable — a full defense would require resolve+connect-time checks — but
 * this stops direct IP-literal attacks on IMDS, RFC1918, and loopback.
 */
const PRIVATE_IP_PATTERNS = [
  /^127\./, // 127.0.0.0/8  loopback
  /^10\./, // 10.0.0.0/8  RFC1918
  /^192\.168\./, // 192.168.0.0/16 RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12 RFC1918
  /^169\.254\./, // 169.254.0.0/16 link-local (AWS IMDS)
  /^fc[0-9a-f]{2}:/i, // fc00::/7 unique local (IPv6)
  /^fd[0-9a-f]{2}:/i, // fd00::/7 unique local (IPv6)
  /^fe[89ab][0-9a-f]:/i, // fe80::/10 link-local (IPv6)
];

// ANCHOR - State

/** Logger shared by the HTTP layer and background tasks. */
const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

/**
 * Webapp-side job tracking. The processor is the source of truth for
 * completed results — this map covers the window between submit and
 * processor-sees-it, plus webapp-level failures the processor never hears about.
 *
 * @type {Map<string, TrackedJob>}
 */
const jobs = new Map();

/** Internal URL for reaching the processor over the GVC mesh. */
const processorInternalUrl = `http://${PROCESSOR_WORKLOAD}.${GVC}.cpln.local:${PROCESSOR_PORT}`;

// ANCHOR - Boot checks

// Fail fast if core config is missing, rather than returning 500 on first request.
if (!ORG || !GVC) {
  logger.error(
    "CPLN_ORG and CPLN_GVC env vars are required (normally auto-injected)",
  );
  process.exit(1);
}

// ANCHOR - App setup

const app = express();
app.disable("x-powered-by");

// Security headers. CSP allows images from any http(s) source because the
// result card renders favicons / og:images from arbitrary scraped sites.
// Everything else — scripts, styles — stays locked to 'self'.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:", "http:"],
        connectSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

app.use(pinoHttp({ logger }));
app.use(express.json({ limit: "16kb" }));
app.use(express.static(PUBLIC_DIR, { index: "index.html", maxAge: "5m" }));

// ANCHOR - Routes

// Health probe target matching the readiness/liveness probes in infra/webapp.yaml.
app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * POST /scrape
 *
 * Validates, mints a jobId, returns 202 immediately. The actual
 * `cpln workload cron run` call runs in the background so the browser never
 * waits on CLI latency. Status and errors surface through GET /jobs/:id.
 */
app.post("/scrape", async (req, res) => {
  // Pull the URL out of the body and trim whitespace.
  const rawUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";

  // Validate — we never reach the CLI for a bad or internal URL.
  const validationError = validateUrl(rawUrl);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  // Mint a job id and record it as pending so GET /jobs/:id returns coherently.
  const jobId = randomUUID();
  rememberJob(jobId, { status: "pending", url: rawUrl });

  // Grab a request-scoped logger reference for the background task.
  const log = req.log;

  // Fire-and-forget — the response goes out now.
  triggerCronRun({ jobId, url: rawUrl, log }).catch((error) => {
    log.error({ err: error, jobId }, "unexpected error in cron-run trigger");
  });

  res.status(202).json({ jobId, url: rawUrl });
});

/**
 * GET /jobs/:id
 *
 * Unified status lookup. Returns one of:
 *   { status: 'pending' }                         - submitted, processor hasn't reported yet
 *   { status: 'completed', ...processorPayload }  - scraper finished, data ready
 *   { status: 'failed',    error }                - webapp couldn't start the cron run
 */
app.get("/jobs/:id", async (req, res) => {
  const jobId = req.params.id;

  // Guard against clients probing with garbage — jobIds are always UUIDs.
  if (!isUuid(jobId)) {
    res.status(400).json({ error: "Invalid jobId format" });
    return;
  }

  // If the webapp saw the submission fail, return that directly.
  const webappJob = jobs.get(jobId);
  if (webappJob?.status === "failed") {
    res.status(200).json({
      jobId,
      status: "failed",
      url: webappJob.url,
      error: webappJob.error,
    });
    return;
  }

  // Ask the processor — it's the source of truth for completed results.
  try {
    const upstream = await fetch(
      `${processorInternalUrl}/jobs/${encodeURIComponent(jobId)}`,
      { signal: AbortSignal.timeout(5_000) },
    );

    // Scraper has reported in — return the full payload as 'completed'.
    if (upstream.ok) {
      const data = await upstream.json();
      // Spread first so our `status` wins any future field-name collision.
      res.status(200).json({ ...data, status: "completed" });
      return;
    }

    // Processor hasn't seen it yet but the webapp knows about it — pending.
    if (upstream.status === 404 && webappJob) {
      res.status(200).json({ jobId, status: "pending", url: webappJob.url });
      return;
    }

    // Processor returned 404 for a job the webapp never saw — just 404.
    if (upstream.status === 404) {
      res.status(404).json({ jobId, error: "job not found" });
      return;
    }

    // Other upstream error — pass it through.
    const body = await upstream.text();
    res
      .status(upstream.status)
      .type(upstream.headers.get("content-type") ?? "application/json")
      .send(body);
  } catch (error) {
    req.log.warn({ err: error, jobId }, "processor lookup failed");

    // If we know the job is in flight, treat the upstream blip as pending.
    if (webappJob) {
      res.status(200).json({ jobId, status: "pending", url: webappJob.url });
      return;
    }

    res.status(504).json({ error: "processor unreachable", jobId });
  }
});

// Top-level error handler — unhandled throws shouldn't leak stack traces.
app.use((err, req, res, _next) => {
  req.log?.error({ err }, "unhandled error");
  res.status(500).json({ error: "Internal error" });
});

// ANCHOR - Server start

app.listen(PORT, () => {
  logger.info(
    { port: PORT, org: ORG, gvc: GVC, processorInternalUrl },
    "webapp listening",
  );
});

// ANCHOR - Background tasks

/**
 * Runs `cpln workload cron run` for a single scrape submission. On failure,
 * marks the job as failed on the webapp side so GET /jobs/:id can surface it.
 *
 * @param {Object} input
 * @param {string} input.jobId - Job id to record and report.
 * @param {string} input.url - Validated http(s) URL to scrape.
 * @param {import('pino').Logger} input.log - Request-scoped logger.
 * @returns {Promise<void>}
 */
async function triggerCronRun({ jobId, url, log }) {
  try {
    await runCronWorkload({
      org: ORG,
      gvc: GVC,
      image: SCRAPER_IMAGE,
      cpu: SCRAPER_CPU,
      memory: SCRAPER_MEMORY,
      env: {
        URL: url,
        JOB_ID: jobId,
        PROCESSOR_URL: `${processorInternalUrl}/raw`,
      },
      command: SCRAPER_COMMAND,
      logger: log,
    });

    log.info({ jobId, url }, "cron run triggered");
  } catch (error) {
    log.error(
      { err: error, stderr: error.stderr, jobId },
      "failed to trigger cron run",
    );
    rememberJob(jobId, {
      status: "failed",
      url,
      error: "Failed to start the scraper container.",
    });
  }
}

// ANCHOR - Helpers

/**
 * Records a job in the in-memory tracking map with FIFO eviction past
 * MAX_TRACKED_JOBS.
 *
 * @param {string} jobId - Job id.
 * @param {TrackedJob} record - Tracking record.
 * @returns {void}
 */
function rememberJob(jobId, record) {
  // Evict the oldest entry if we're at capacity (and it's not this same job).
  if (jobs.size >= MAX_TRACKED_JOBS && !jobs.has(jobId)) {
    const oldest = jobs.keys().next().value;

    if (oldest !== undefined) {
      jobs.delete(oldest);
    }
  }

  jobs.set(jobId, record);
}

/**
 * Validates a user-submitted URL. Rejects bad URL shapes plus trivial SSRF
 * targets (localhost, RFC1918, link-local, internal TLDs).
 *
 * @param {string} raw - Raw URL string from the request body.
 * @returns {string | null} Error message if invalid, otherwise null.
 */
function validateUrl(raw) {
  if (!raw) {
    return "url is required";
  }

  if (raw.length > MAX_URL_LENGTH) {
    return `url exceeds ${MAX_URL_LENGTH} chars`;
  }

  let parsed;

  try {
    parsed = new URL(raw);
  } catch {
    return "url is not a valid URL";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "url must use http or https";
  }

  if (!parsed.hostname) {
    return "url must include a hostname";
  }

  if (isBlockedHost(parsed.hostname)) {
    return "url targets a private or internal host";
  }

  return null;
}

/**
 * Returns true if the hostname resolves to (or literally is) a target the
 * webapp refuses to scrape — localhost, internal TLDs, or an IP literal in
 * a private / link-local range.
 *
 * @param {string} hostname - Hostname from a parsed URL.
 * @returns {boolean}
 */
function isBlockedHost(hostname) {
  const lower = hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(lower)) {
    return true;
  }

  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return true;
    }
  }

  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(lower)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns true if the given string looks like a UUID.
 *
 * @param {string} value - Candidate string.
 * @returns {boolean}
 */
function isUuid(value) {
  return /^[0-9a-f-]{36}$/i.test(value);
}
