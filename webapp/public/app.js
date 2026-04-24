// ANCHOR - Types

/**
 * @typedef {Object} JobResult
 * @property {string} jobId
 * @property {'pending' | 'completed' | 'failed'} status
 * @property {string} [url]
 * @property {string} [finalUrl]
 * @property {string} [title]
 * @property {string} [description]
 * @property {string} [favicon]
 * @property {string} [ogImage]
 * @property {string} [canonical]
 * @property {string} [language]
 * @property {number} [httpStatus]
 * @property {Array<{ href: string, text: string }>} [links]
 * @property {string} [error]
 */

/**
 * @typedef {Object} HistoryEntry
 * @property {string} jobId
 * @property {string} url
 * @property {string} [finalUrl]
 * @property {string} [title]
 * @property {string} [favicon]
 * @property {number} [httpStatus]
 * @property {string} completedAt
 */

/**
 * @typedef {Object} PendingEntry
 * @property {string} jobId - Job id returned by POST /scrape.
 * @property {string} url - URL the user submitted.
 * @property {string} submittedAt - ISO timestamp of submit.
 */

// ANCHOR - Constants

/**
 * How long we keep polling /jobs/:id before giving up.
 *
 * The actual cadence is progressive — see pollIntervalFor() — so this is a
 * wall-clock budget, not an attempt count. Puppeteer cold-starts run
 * roughly 20–40s, so 90s gives comfortable headroom.
 */
const POLL_MAX_DURATION_MS = 90_000;

/** Max links rendered in the result card. */
const MAX_LINKS_RENDERED = 10;

/** localStorage key for the scrape history. */
const HISTORY_KEY = 'cpln-scraper-history';

/** Max number of history entries to keep. */
const HISTORY_LIMIT = 10;

/** localStorage key for in-flight jobs. */
const PENDING_KEY = 'cpln-scraper-pending';

/**
 * How long a pending job stays resumable after submit. If the user refreshes
 * later than this, we assume the processor evicted / webapp restarted the
 * record and drop the entry instead of starting a doomed poll.
 */
const PENDING_TTL_MS = 3 * 60 * 1000;

// ANCHOR - DOM refs

const form = document.getElementById('scrape-form');
const input = document.getElementById('url');
const button = document.getElementById('submit');
const errorEl = document.getElementById('error');
const resultEl = document.getElementById('result');
const resultBody = document.getElementById('result-body');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const historyEl = document.getElementById('history');
const historyList = document.getElementById('history-list');
const historyClearBtn = document.getElementById('history-clear');

// ANCHOR - State

/**
 * JobId currently displayed in the result card. Guards against stale poll
 * results overwriting a newer job the user has submitted in the meantime.
 *
 * @type {string | null}
 */
let currentCardJobId = null;

/**
 * JobIds we have an in-flight poll for. Prevents duplicate polls when the
 * page resumes via storage events or DOMContentLoaded.
 *
 * @type {Set<string>}
 */
const activePolls = new Set();

// ANCHOR - Boot

document.addEventListener('DOMContentLoaded', () => {
  renderHistory();
  resumePendingJobs();
});

historyClearBtn.addEventListener('click', () => {
  clearHistory();
  renderHistory();
});

// Cross-tab sync: when another tab adds to the history, reflect it here.
window.addEventListener('storage', (event) => {
  if (event.key === HISTORY_KEY) {
    renderHistory();
  }
  if (event.key === PENDING_KEY) {
    resumePendingJobs();
  }
});

// ANCHOR - Form handler

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();
  hideResult();

  // Validate input client-side before round-tripping to the server.
  const url = input.value.trim();
  if (!isHttpUrl(url)) {
    showError('Please enter a valid http(s) URL.');
    return;
  }

  setSubmitting(true);
  try {
    // Kick off the scrape. The backend returns 202 + jobId immediately.
    const res = await fetch('/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      showError(body.error || `Failed (${res.status})`);
      setSubmitting(false);
      return;
    }

    // Persist the pending job so a refresh or a new tab can pick up polling.
    addPending({
      jobId: body.jobId,
      url,
      submittedAt: new Date().toISOString(),
    });

    // Show pending in the card and start polling in the background. The
    // submit button stays disabled until this poll resolves (startPoll handles
    // re-enabling it in its .finally()).
    showPending(body.jobId, url);
    startPoll(body.jobId);
  } catch (err) {
    showError(err?.message || 'Network error');
    setSubmitting(false);
  }
});

// ANCHOR - Polling

/**
 * Kicks off a poll loop for a job, guarding against duplicate polls and
 * re-enabling the submit button when the displayed job's poll resolves.
 *
 * @param {string} jobId
 * @returns {void}
 */
function startPoll(jobId) {
  if (activePolls.has(jobId)) {
    return;
  }

  activePolls.add(jobId);
  pollUntilDone(jobId).finally(() => {
    activePolls.delete(jobId);

    // Only release the submit button if the job that just finished is the
    // one the result card is displaying.
    if (jobId === currentCardJobId) {
      setSubmitting(false);
    }
  });
}

/**
 * Polls GET /jobs/:id until the job finishes, fails, or we exhaust
 * POLL_MAX_DURATION_MS. Uses a progressive cadence (see pollIntervalFor) so
 * the first few seconds feel snappy and later attempts don't hammer the API.
 *
 * @param {string} jobId
 * @returns {Promise<void>}
 */
async function pollUntilDone(jobId) {
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < POLL_MAX_DURATION_MS) {
    await sleep(pollIntervalFor(attempt));
    attempt += 1;

    try {
      const res = await fetch(`/jobs/${encodeURIComponent(jobId)}`);
      if (!res.ok) {
        // Transient HTTP error — keep polling.
        continue;
      }

      /** @type {JobResult} */
      const body = await res.json();

      if (body.status === 'completed') {
        removePending(jobId);
        saveToHistory(body);
        renderHistory();
        showResult(body);
        return;
      }
      if (body.status === 'failed') {
        removePending(jobId);
        showFailed(body.error, jobId, body.url);
        return;
      }
      // status === 'pending' → keep polling.
    } catch {
      // Network blip — keep polling.
    }
  }

  // Ran out of time. Drop the record and surface the timeout.
  removePending(jobId);
  showTimeout(jobId);
}

/**
 * Returns the delay to wait before the next poll attempt. Snappy at the
 * start (attention is peak just after submit), relaxes once we're past the
 * typical cold-start window.
 *
 * @param {number} attempt - Zero-indexed attempt count.
 * @returns {number} Delay in ms.
 */
function pollIntervalFor(attempt) {
  if (attempt < 5) {
    return 1000;
  }
  if (attempt < 15) {
    return 2000;
  }
  return 3000;
}

// ANCHOR - Pending (localStorage)

/**
 * Reads the pending-jobs array from localStorage.
 *
 * @returns {PendingEntry[]}
 */
function getPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Writes the pending-jobs array to localStorage.
 *
 * @param {PendingEntry[]} pending
 * @returns {void}
 */
function setPending(pending) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // Quota exceeded or disabled — non-fatal.
  }
}

/**
 * Records a new pending job, deduping by jobId.
 *
 * @param {PendingEntry} entry
 * @returns {void}
 */
function addPending(entry) {
  const existing = getPending().filter((p) => p.jobId !== entry.jobId);
  setPending([...existing, entry]);
}

/**
 * Removes a pending job by id.
 *
 * @param {string} jobId
 * @returns {void}
 */
function removePending(jobId) {
  setPending(getPending().filter((p) => p.jobId !== jobId));
}

/**
 * On load (or when another tab updates pending), shows the latest pending
 * job in the result card and restarts polling for any we're not already
 * polling. Drops entries older than PENDING_TTL_MS.
 *
 * @returns {void}
 */
function resumePendingJobs() {
  // Drop stale entries — their backend records may no longer exist.
  const now = Date.now();
  const all = getPending();
  const fresh = all.filter(
    (p) => now - new Date(p.submittedAt).getTime() <= PENDING_TTL_MS,
  );
  if (fresh.length !== all.length) {
    setPending(fresh);
  }

  if (fresh.length === 0) {
    return;
  }

  // Show the most recently submitted pending job in the result card, but
  // don't overwrite a job this tab is already displaying. (hideResult()
  // always nulls currentCardJobId, so that single check covers both "no
  // card rendered yet" and "card was dismissed".)
  const latest = fresh[fresh.length - 1];
  if (currentCardJobId === null) {
    showPending(latest.jobId, latest.url);
    setSubmitting(true);
  }

  // Resume polling for every pending job we aren't already polling.
  for (const entry of fresh) {
    startPoll(entry.jobId);
  }
}

// ANCHOR - UI state (form + submit button)

/**
 * Toggles the form between idle and submitting states.
 *
 * @param {boolean} loading
 * @returns {void}
 */
function setSubmitting(loading) {
  button.disabled = loading;
  button.textContent = loading ? 'Running…' : 'Scrape';
  input.readOnly = loading;
}

// ANCHOR - UI state (error line)

/** @param {string} message */
function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

/** @returns {void} */
function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = '';
}

// ANCHOR - UI state (result card)

/** @returns {void} */
function hideResult() {
  resultEl.hidden = true;
  resultBody.innerHTML = '';
  currentCardJobId = null;
}

/**
 * Updates the status pill's visual and textual state.
 *
 * @param {'running' | 'ready' | 'failed'} kind
 * @param {string} text
 * @returns {void}
 */
function setStatus(kind, text) {
  statusEl.className = `status status-${kind}`;
  statusText.textContent = text;
}

/**
 * Renders the "submitted, scraper spinning up" state and marks this jobId
 * as the one the card is currently displaying.
 *
 * @param {string} jobId
 * @param {string} url
 * @returns {void}
 */
function showPending(jobId, url) {
  currentCardJobId = jobId;
  resultEl.hidden = false;
  setStatus('running', 'Running');
  resultBody.innerHTML = `
    <div class="result-meta">
      <dl>
        <dt>URL</dt>
        <dd>${escapeHtml(url)}</dd>
        <dt>Job</dt>
        <dd class="mono">${escapeHtml(jobId)}</dd>
      </dl>
    </div>
  `;
}

/**
 * Renders the completed scrape payload. Ignored if the user has submitted
 * a newer job since — the card now belongs to that one.
 *
 * @param {JobResult} job
 * @returns {void}
 */
function showResult(job) {
  if (job.jobId !== currentCardJobId) {
    return;
  }
  setStatus('ready', 'Ready');
  resultBody.innerHTML = `
    ${renderPreview(job)}
    ${renderOgImage(job)}
    ${renderMeta(job)}
    ${renderLinks(job)}
  `;
  bindImageErrorHandlers(resultBody);
}

/**
 * Renders a webapp-side failure. Ignored if a newer job has taken the card.
 *
 * @param {string | undefined} message
 * @param {string} jobId
 * @param {string | undefined} url
 * @returns {void}
 */
function showFailed(message, jobId, url) {
  if (jobId !== currentCardJobId) {
    return;
  }
  setStatus('failed', 'Failed');
  resultBody.innerHTML = `
    <div class="result-meta">
      <dl>
        <dt>URL</dt>
        <dd>${escapeHtml(url || '—')}</dd>
        <dt>Error</dt>
        <dd>${escapeHtml(message || 'Unknown error')}</dd>
        <dt>Job</dt>
        <dd class="mono">${escapeHtml(jobId || '—')}</dd>
      </dl>
    </div>
  `;
}

/**
 * Renders the "scraper never reported back in time" state.
 *
 * @param {string} jobId
 * @returns {void}
 */
function showTimeout(jobId) {
  if (jobId !== currentCardJobId) {
    return;
  }
  setStatus('failed', 'Timed out');
  const seconds = Math.floor(POLL_MAX_DURATION_MS / 1000);
  resultBody.insertAdjacentHTML(
    'beforeend',
    `<p class="muted">Still running after ${seconds}s. Check <code class="mono">cpln workload cron get</code>.</p>`,
  );
}

// ANCHOR - Result partials

/**
 * Favicon + title header block.
 *
 * @param {JobResult} job
 * @returns {string}
 */
function renderPreview(job) {
  const title = job.title || job.url || '(untitled)';
  return `
    <div class="preview">
      ${renderFavicon(job.favicon)}
      <div class="preview-text">
        <div class="preview-title">${escapeHtml(title)}</div>
        ${job.description ? `<div class="preview-desc">${escapeHtml(job.description)}</div>` : ''}
      </div>
    </div>
  `;
}

/** @param {string | undefined} favicon */
function renderFavicon(favicon) {
  if (!favicon) {
    return '';
  }
  return `<img class="favicon" src="${escapeHtml(favicon)}" alt="" referrerpolicy="no-referrer" />`;
}

/**
 * Optional og:image thumbnail. Proves we really loaded the page — no image
 * if the page doesn't expose one or the URL can't be loaded.
 *
 * @param {JobResult} job
 * @returns {string}
 */
function renderOgImage(job) {
  if (!job.ogImage) {
    return '';
  }
  return `
    <div class="og-image-wrap">
      <img class="og-image" src="${escapeHtml(job.ogImage)}" alt="" referrerpolicy="no-referrer" loading="lazy" />
    </div>
  `;
}

/**
 * Definition-list block with URL, HTTP status, language, job id, etc.
 *
 * @param {JobResult} job
 * @returns {string}
 */
function renderMeta(job) {
  const href = job.finalUrl || job.url || '';
  return `
    <div class="result-meta">
      <dl>
        <dt>URL</dt>
        <dd><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a></dd>
        <dt>HTTP</dt>
        <dd class="mono">${job.httpStatus ?? '—'}</dd>
        ${job.language ? `<dt>Language</dt><dd class="mono">${escapeHtml(job.language)}</dd>` : ''}
        ${job.canonical && job.canonical !== href
          ? `<dt>Canonical</dt><dd><a href="${escapeHtml(job.canonical)}" target="_blank" rel="noopener noreferrer">${escapeHtml(job.canonical)}</a></dd>`
          : ''}
        <dt>Job</dt>
        <dd class="mono">${escapeHtml(job.jobId)}</dd>
      </dl>
    </div>
  `;
}

/**
 * Links sub-section. Each link opens the original URL in a new tab.
 *
 * @param {JobResult} job
 * @returns {string}
 */
function renderLinks(job) {
  const links = Array.isArray(job.links) ? job.links.slice(0, MAX_LINKS_RENDERED) : [];
  return `
    <div class="result-links">
      <div class="section-label">Links (${links.length})</div>
      ${links.length === 0
        ? '<p class="muted">(none)</p>'
        : `<ul>${links
            .map(
              (l) => `
                <li>
                  <a href="${escapeHtml(l.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.text || l.href)}</a>
                </li>`,
            )
            .join('')}</ul>`}
    </div>
  `;
}

// ANCHOR - History

/**
 * Reads the history array from localStorage.
 *
 * @returns {HistoryEntry[]}
 */
function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Writes the history array to localStorage.
 *
 * @param {HistoryEntry[]} history
 * @returns {void}
 */
function setHistory(history) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Quota exceeded or disabled — non-fatal.
  }
}

/**
 * Pushes a completed scrape into history, dedupes by URL, caps at HISTORY_LIMIT.
 *
 * @param {JobResult} job
 * @returns {void}
 */
function saveToHistory(job) {
  const url = job.finalUrl || job.url;
  if (!url) {
    return;
  }

  /** @type {HistoryEntry} */
  const entry = {
    jobId: job.jobId,
    url: job.url ?? url,
    finalUrl: job.finalUrl,
    title: job.title,
    favicon: job.favicon,
    httpStatus: job.httpStatus,
    completedAt: new Date().toISOString(),
  };

  // Dedupe by resolved URL and put the freshest on top.
  const existing = getHistory().filter((h) => (h.finalUrl || h.url) !== url);
  setHistory([entry, ...existing].slice(0, HISTORY_LIMIT));
}

/** Clears the history. */
function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // Non-fatal.
  }
}

/** Re-renders the history section from localStorage. */
function renderHistory() {
  const history = getHistory();

  if (history.length === 0) {
    historyEl.hidden = true;
    historyList.innerHTML = '';
    return;
  }

  historyEl.hidden = false;
  historyList.innerHTML = history.map(renderHistoryItem).join('');
  bindImageErrorHandlers(historyList);
}

/** @param {HistoryEntry} entry */
function renderHistoryItem(entry) {
  const href = entry.finalUrl || entry.url;
  const titleText = entry.title || entry.url;
  return `
    <li class="history-item">
      ${entry.favicon
        ? `<img class="favicon" src="${escapeHtml(entry.favicon)}" alt="" referrerpolicy="no-referrer" />`
        : '<span class="favicon favicon-placeholder"></span>'}
      <div class="history-item-body">
        <a class="history-item-title" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(titleText)}</a>
        <div class="history-item-url">${escapeHtml(href)}</div>
      </div>
      <time class="history-item-time" datetime="${escapeHtml(entry.completedAt)}">${timeAgo(entry.completedAt)}</time>
    </li>
  `;
}

// ANCHOR - Helpers

/**
 * Wires up error handlers on every image inside a container. Favicons that
 * fail to load simply disappear; a broken og:image takes its wrapper with it.
 * Done programmatically (not via inline `onerror`) so the page stays within
 * a strict Content-Security-Policy.
 *
 * @param {HTMLElement} container
 * @returns {void}
 */
function bindImageErrorHandlers(container) {
  for (const img of container.querySelectorAll('img.favicon')) {
    img.addEventListener('error', () => img.remove(), { once: true });
  }
  for (const img of container.querySelectorAll('img.og-image')) {
    img.addEventListener(
      'error',
      () => {
        img.parentElement?.remove();
      },
      { once: true },
    );
  }
}

/**
 * Checks if a string is a valid http(s) URL.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Sleeps for `ms` milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Formats an ISO timestamp as a compact relative duration ("2m ago").
 *
 * @param {string} iso
 * @returns {string}
 */
function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) {
    return '';
  }

  const seconds = Math.floor(ms / 1000);
  if (seconds < 45) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Escapes HTML-unsafe characters so user/server data can be rendered inline.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
