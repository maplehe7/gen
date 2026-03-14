import { buildCandidateBadges, buildJobErrorSummary, hostFromUrl } from "./ui_helpers.js";

const JOBS_KEY = "standalone-forge-pages-jobs";
const JOB_HISTORY_KEY = "standalone-forge-pages-job-history";
const BATCH_SELECTIONS_KEY = "standalone-forge-batch-selections";
const PENDING_DELETES_KEY = "standalone-forge-pending-deletes";
const JOB_STORAGE_VERSION = 3;
const WORKFLOW_FILE = "build-game.yml";
const DEFAULT_TARGET_SUCCESSFUL_CANDIDATES = 3;
const MIN_TARGET_SUCCESSFUL_CANDIDATES = 1;
const MAX_TARGET_SUCCESSFUL_CANDIDATES = 5;
const MAX_SEARCH_POOL_COUNT = 12;
const MAX_ACTIVE_CANDIDATES_PER_BATCH = 1;
const DEFAULT_STEP_SECONDS = 55;
const PLACEHOLDER_WORKER_URL = "PASTE_CLOUDFLARE_WORKER_URL_HERE";
const STATUS_REFRESH_MS = 8000;
const PROGRESS_RENDER_MS = 400;
const MAX_HISTORY_SAMPLES = 20;
const MAX_RECORDED_RUNS = 40;
const MAX_STORED_JOBS = 20;
const ACTIVE_JOB_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const TERMINAL_JOB_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const UNCONFIRMED_DISPATCH_TIMEOUT_MS = 60 * 1000;
const UNCONFIRMED_DISPATCH_SYNC_LIMIT = 4;
const MIN_HISTORY_DURATION_SECONDS = 1;
const MAX_HISTORY_DURATION_SECONDS = 900;
const DEFAULT_STEP_DURATIONS = {
  "Checkout source": 2,
  "Restore previous Pages state": 2,
  "Setup Python": 3,
  "Install dependencies": 4,
  "Resolve workflow inputs": 1,
  "Build or update Pages site": 12,
  "Persist Pages state branch": 4,
  "Configure GitHub Pages": 2,
  "Upload Pages artifact": 3,
  "Deploy to GitHub Pages": 6,
};
const DEFAULT_WORKFLOW_STEP_ORDER = [
  "Checkout source",
  "Restore previous Pages state",
  "Setup Python",
  "Install dependencies",
  "Resolve workflow inputs",
  "Build or update Pages site",
  "Persist Pages state branch",
  "Configure GitHub Pages",
  "Upload Pages artifact",
  "Deploy to GitHub Pages",
];
const DEFAULT_WORKFLOW_DURATION_SECONDS = DEFAULT_WORKFLOW_STEP_ORDER.reduce(
  (sum, name) => sum + (DEFAULT_STEP_DURATIONS[name] || DEFAULT_STEP_SECONDS),
  0,
);

const form = document.getElementById("export-form");
const sourceInput = document.getElementById("source");
const candidateCountInput = document.getElementById("candidate-count");
const bulkToggleButton = document.getElementById("bulk-toggle");
const bulkPanel = document.getElementById("bulk-panel");
const sourceListInput = document.getElementById("source-list");
const repoTarget = document.getElementById("repo-target");
const configWarning = document.getElementById("config-warning");
const submitButton = document.getElementById("submit-button");
const formMessage = document.getElementById("form-message");
const candidatePreview = document.getElementById("candidate-preview");
const candidatePreviewStatus = document.getElementById("candidate-preview-status");
const candidatePreviewList = document.getElementById("candidate-preview-list");
const jobsContainer = document.getElementById("jobs");
const jobTemplate = document.getElementById("job-template");
const favoriteModal = document.getElementById("favorite-modal");
const favoriteTitle = document.getElementById("favorite-title");
const favoriteCopy = document.getElementById("favorite-copy");
const favoriteGrid = document.getElementById("favorite-grid");
const favoriteStatus = document.getElementById("favorite-status");

let catalogEntries = [];
let publishedCatalog = [];
let jobs = [];
let batchSelections = {};
let jobHistory = {
  stepDurations: {},
  totalDurations: [],
  recordedRunIds: [],
};
let jobSectionState = {
  active: true,
  completed: false,
  failed: false,
};
let activeFavoriteBatchId = "";
let refreshInFlight = false;
let appConfig = {
  workerUrl: "",
  owner: "",
  repo: "",
  ref: "main",
  workflowFile: WORKFLOW_FILE,
};

function nowIso() {
  return new Date().toISOString();
}

function looksLikeUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function uniqueBy(items, keyFn) {
  const results = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push(item);
  });
  return results;
}

function candidateSourceKey(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.hostname.toLowerCase()}${pathname}${parsed.search}`;
  } catch (_error) {
    return normalized.toLowerCase();
  }
}

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.min(Math.max(numeric, 0), 100);
}

function coerceInputToUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  if (looksLikeUrl(trimmed)) {
    return trimmed;
  }

  const bareDomainPattern =
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i;
  if (/\s/.test(trimmed) || !bareDomainPattern.test(trimmed)) {
    return "";
  }

  const candidate = `https://${trimmed}`;
  return looksLikeUrl(candidate) ? candidate : "";
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "game";
}

function deriveNameFromUrl(value) {
  try {
    const parsed = new URL(value);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || parsed.hostname || "game";
  } catch (_error) {
    return "game";
  }
}

function titleCaseWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function normalizeSearchVariantKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildSearchQueryVariants(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return [];
  }

  const variants = [
    trimmed,
    trimmed.replace(/[_\-–—:|/\\]+/g, " ").replace(/\s+/g, " ").trim(),
    titleCaseWords(trimmed),
    trimmed.toLowerCase(),
    trimmed.replace(/\b(game|online|unblocked|play|classic|free)\b/gi, " ").replace(/\s+/g, " ").trim(),
  ];

  return variants.filter(Boolean).filter((variant, index, items) => {
    const key = normalizeSearchVariantKey(variant);
    return key && items.findIndex((item) => normalizeSearchVariantKey(item) === key) === index;
  });
}

function extractClosestMatchesFromError(message) {
  const text = String(message || "");
  const match = text.match(/Closest matches:\s*(.+?)\.?$/i);
  if (!match || !match[1]) {
    return [];
  }
  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function createRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function loadBatchSelections() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(BATCH_SELECTIONS_KEY) || "{}");
    batchSelections = parsed && typeof parsed === "object"
      ? Object.fromEntries(
          Object.entries(parsed).map(([key, value]) => {
            const normalized = value && typeof value === "object" ? { ...value } : {};
            if (normalized.dispatchingFallback) {
              normalized.dispatchingFallback = false;
              if (normalized.state === "backfilling") {
                normalized.state = "pending";
              }
            }
            return [key, normalized];
          }),
        )
      : {};
  } catch (_error) {
    batchSelections = {};
  }
}

function saveBatchSelections() {
  window.localStorage.setItem(BATCH_SELECTIONS_KEY, JSON.stringify(batchSelections || {}));
}

function batchSelectionFor(batchId) {
  return batchSelections?.[String(batchId || "").trim()] || null;
}

function updateBatchSelection(batchId, patch) {
  const key = String(batchId || "").trim();
  if (!key) {
    return;
  }
  batchSelections[key] = {
    ...(batchSelections[key] || {}),
    ...patch,
    batchId: key,
    updatedAt: nowIso(),
  };
  saveBatchSelections();
  renderCandidatePreview();
}

function rememberPendingGalleryDelete(job) {
  const entryId = String(job?.entryId || "").trim();
  if (!entryId) {
    return;
  }
  let pendingDeletes = {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PENDING_DELETES_KEY) || "{}");
    pendingDeletes = parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    pendingDeletes = {};
  }
  pendingDeletes[entryId] = {
    startedAt: Date.now(),
    state: "accepted",
    runId: "",
    htmlUrl: "",
  };
  window.localStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(pendingDeletes));
}

function bulkModeEnabled() {
  return Boolean(bulkPanel && !bulkPanel.hidden);
}

function setBulkMode(enabled) {
  if (!bulkPanel || !bulkToggleButton || !sourceInput) {
    return;
  }

  bulkPanel.hidden = !enabled;
  bulkToggleButton.setAttribute("aria-expanded", enabled ? "true" : "false");
  sourceInput.required = !enabled;

  if (enabled) {
    sourceListInput?.focus();
  } else {
    sourceInput.focus();
  }
}

function collectRequestedSources() {
  const values = [];
  const primaryValue = String(sourceInput?.value || "").trim();
  if (primaryValue) {
    values.push(primaryValue);
  }

  if (bulkModeEnabled()) {
    String(sourceListInput?.value || "")
      .split(/\r?\n/g)
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => values.push(item));
  }

  const seen = new Set();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function resetSourceInputs() {
  if (sourceInput) {
    sourceInput.value = "";
  }
  if (sourceListInput) {
    sourceListInput.value = "";
  }
}

function readRequestedCandidateCount() {
  const numeric = Math.round(Number(candidateCountInput?.value || DEFAULT_TARGET_SUCCESSFUL_CANDIDATES));
  if (!Number.isFinite(numeric)) {
    return DEFAULT_TARGET_SUCCESSFUL_CANDIDATES;
  }
  return Math.min(
    Math.max(numeric, MIN_TARGET_SUCCESSFUL_CANDIDATES),
    MAX_TARGET_SUCCESSFUL_CANDIDATES,
  );
}

function searchPoolCountForDesiredCount(desiredCount) {
  const safeDesired = Math.min(
    Math.max(Math.round(Number(desiredCount) || DEFAULT_TARGET_SUCCESSFUL_CANDIDATES), MIN_TARGET_SUCCESSFUL_CANDIDATES),
    MAX_TARGET_SUCCESSFUL_CANDIDATES,
  );
  return Math.min(Math.max(safeDesired * 3, safeDesired + 3), MAX_SEARCH_POOL_COUNT);
}

function setFormBusy(isBusy) {
  if (submitButton) {
    submitButton.disabled = isBusy;
  }
  if (candidateCountInput) {
    candidateCountInput.disabled = isBusy;
  }
  if (bulkToggleButton) {
    bulkToggleButton.disabled = isBusy;
  }
  if (sourceInput) {
    sourceInput.disabled = isBusy;
  }
  if (sourceListInput) {
    sourceListInput.disabled = isBusy;
  }
}

function visibleProgressPercent(job, nowMs = Date.now()) {
  const actual = clampPercent(job.progressPercent || 0);
  if (job.status === "completed") {
    return actual;
  }

  const elapsedSeconds = Math.max((nowMs - timestampMs(job.progressUpdatedAt || job.submittedAt)) / 1000, 0);
  if (job.status === "queued") {
    const cap = Math.min(Math.max(actual + 5, 14), 18);
    return clampPercent(actual + elapsedSeconds * 0.45 > cap ? cap : actual + elapsedSeconds * 0.45);
  }

  if (job.status === "in_progress") {
    const cap = Math.min(Math.max(actual + 8, 28), 96);
    return clampPercent(actual + elapsedSeconds * 0.75 > cap ? cap : actual + elapsedSeconds * 0.75);
  }

  return actual;
}

function visibleEtaLabel(job, nowMs = Date.now()) {
  if (job.status === "completed") {
    return job.conclusion === "success" ? "Completed" : "Failed";
  }

  const etaSeconds = Number(job.etaSeconds);
  if (!Number.isFinite(etaSeconds) || etaSeconds <= 0) {
    return job.etaLabel || "Calculating...";
  }

  const updatedAt = timestampMs(job.etaUpdatedAt || job.progressUpdatedAt || job.submittedAt);
  const elapsedSeconds = Math.max((nowMs - updatedAt) / 1000, 0);
  const floorSeconds = job.status === "queued" ? 6 : 1;
  return formatDuration(Math.max(etaSeconds - elapsedSeconds, floorSeconds));
}

function workerConfigured(workerUrl) {
  const normalized = normalizeUrl(workerUrl);
  return Boolean(normalized && normalized !== PLACEHOLDER_WORKER_URL && looksLikeUrl(normalized));
}

function workerEndpoint(path) {
  return `${appConfig.workerUrl}${path}`;
}

function setConfigWarning(message) {
  if (configWarning) {
    configWarning.textContent = message;
  }
}

function updateRepoTarget() {
  if (!repoTarget) {
    return;
  }

  if (appConfig.owner && appConfig.repo) {
    repoTarget.textContent = `${appConfig.owner}/${appConfig.repo}@${appConfig.ref}`;
    return;
  }

  if (workerConfigured(appConfig.workerUrl)) {
    repoTarget.textContent = "Loading worker config...";
    return;
  }

  repoTarget.textContent = "Missing Cloudflare Worker URL in site/config.js";
}

function loadConfig() {
  const configured = window.STANDALONE_FORGE_CONFIG || {};
  appConfig = {
    workerUrl: normalizeUrl(configured.workerUrl || ""),
    owner: "",
    repo: "",
    ref: "main",
    workflowFile: WORKFLOW_FILE,
  };

  updateRepoTarget();
  if (!workerConfigured(appConfig.workerUrl)) {
    setConfigWarning("Paste your Cloudflare Worker URL into site/config.js before using the demo.");
  } else {
    setConfigWarning("Worker URL loaded. Fetching worker config...");
  }
}

function loadJobs() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(JOBS_KEY) || "[]");
    const storedJobs = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    jobs = normalizeStoredJobs(storedJobs);
  } catch (_error) {
    jobs = [];
  }
  saveJobs();
}

function saveJobs() {
  jobs = normalizeStoredJobs(jobs);
  window.localStorage.setItem(
    JOBS_KEY,
    JSON.stringify({
      version: JOB_STORAGE_VERSION,
      savedAt: nowIso(),
      jobs: jobs.map(serializeJobForStorage),
    }),
  );
}

function loadJobHistory() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(JOB_HISTORY_KEY) || "{}");
    jobHistory = {
      stepDurations: sanitizeStepDurations(parsed?.stepDurations),
      totalDurations: sanitizeDurationList(parsed?.totalDurations),
      recordedRunIds: Array.isArray(parsed?.recordedRunIds) ? parsed.recordedRunIds : [],
    };
  } catch (_error) {
    jobHistory = {
      stepDurations: {},
      totalDurations: [],
      recordedRunIds: [],
    };
  }
}

function saveJobHistory() {
  window.localStorage.setItem(JOB_HISTORY_KEY, JSON.stringify(jobHistory));
}

function sanitizeDurationValue(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (numeric < MIN_HISTORY_DURATION_SECONDS || numeric > MAX_HISTORY_DURATION_SECONDS) {
    return null;
  }
  return numeric;
}

function sanitizeDurationList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map(sanitizeDurationValue)
    .filter((value) => Number.isFinite(value))
    .slice(-MAX_HISTORY_SAMPLES);
}

function sanitizeStepDurations(stepDurations) {
  if (!stepDurations || typeof stepDurations !== "object") {
    return {};
  }

  const sanitized = {};
  Object.entries(stepDurations).forEach(([name, values]) => {
    const normalizedName = String(name || "").trim();
    const sanitizedValues = sanitizeDurationList(values);
    if (!normalizedName || !sanitizedValues.length) {
      return;
    }
    sanitized[normalizedName] = sanitizedValues;
  });
  return sanitized;
}

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function dedupeJobKey(job) {
  const requestId = stringValue(job?.requestId).trim();
  const runId = String(job?.runId || "").trim();
  const submittedAt = stringValue(job?.submittedAt).trim();
  const sourceUrl = stringValue(job?.sourceUrl).trim();
  if (requestId) {
    return `request:${requestId}`;
  }
  if (runId) {
    return `run:${runId}`;
  }
  return `fallback:${sourceUrl}:${submittedAt}`;
}

function jobSortTimestamp(job) {
  return Math.max(
    timestampMs(job?.lastServerUpdateAt),
    timestampMs(job?.progressUpdatedAt),
    timestampMs(job?.submittedAt),
  );
}

function jobCreatedTimestamp(job) {
  return timestampMs(job?.submittedAt);
}

function batchCreatedTimestamp(job) {
  return timestampMs(job?.batchSubmittedAt || job?.submittedAt);
}

function candidateRankValue(job) {
  const rank = Number(job?.candidateRank);
  if (!Number.isFinite(rank) || rank <= 0) {
    return 999;
  }
  return Math.round(rank);
}

function jobSortPriority(job) {
  const status = String(job?.status || "");
  const conclusion = String(job?.conclusion || "");
  if (status === "in_progress") {
    return 0;
  }
  if (status === "queued") {
    return 1;
  }
  if (status === "completed" && conclusion === "success") {
    return 2;
  }
  if (status === "completed") {
    return 4;
  }
  return 3;
}

function isTerminalJob(job) {
  const status = String(job?.status || "");
  return status === "completed" || status === "error";
}

function isFailedJob(job) {
  return (
    String(job?.status || "") === "completed" &&
    String(job?.conclusion || "") &&
    !["success", "cancelled"].includes(String(job?.conclusion || ""))
  );
}

function isCancelledJob(job) {
  return String(job?.status || "") === "completed" && String(job?.conclusion || "") === "cancelled";
}

function jobRetentionMs(job) {
  return isTerminalJob(job) ? TERMINAL_JOB_RETENTION_MS : ACTIVE_JOB_RETENTION_MS;
}

function serializeJobForStorage(job) {
  return {
    requestId: stringValue(job.requestId),
    batchId: stringValue(job.batchId),
    batchLabel: stringValue(job.batchLabel),
    batchSubmittedAt: stringValue(job.batchSubmittedAt, stringValue(job.submittedAt, nowIso())),
    candidateRank: candidateRankValue(job),
    candidateTotal: Math.max(Number(job.candidateTotal) || 1, 1),
    candidateReason: stringValue(job.candidateReason),
    candidateConfidence: Math.max(Number(job.candidateConfidence) || 0, 0),
    owner: stringValue(job.owner),
    repo: stringValue(job.repo),
    ref: stringValue(job.ref, "main"),
    sourceInput: stringValue(job.sourceInput),
    sourceUrl: stringValue(job.sourceUrl),
    displayName: stringValue(job.displayName, "game"),
    sourceMode: stringValue(job.sourceMode),
    provider: stringValue(job.provider),
    matchedName: stringValue(job.matchedName),
    buildDisposition: stringValue(job.buildDisposition, "unknown"),
    historyStatus: stringValue(job.historyStatus, "unknown"),
    historySummary: stringValue(job.historySummary),
    submittedAt: stringValue(job.submittedAt, nowIso()),
    status: stringValue(job.status, "queued"),
    conclusion: stringValue(job.conclusion),
    progressPercent: clampPercent(job.progressPercent),
    progressUpdatedAt: timestampMs(job.progressUpdatedAt || Date.now()),
    phase: stringValue(job.phase),
    etaLabel: stringValue(job.etaLabel),
    etaSeconds: Number.isFinite(Number(job.etaSeconds)) ? Number(job.etaSeconds) : 0,
    etaUpdatedAt: timestampMs(job.etaUpdatedAt || job.progressUpdatedAt || Date.now()),
    runId: String(job.runId || "").trim(),
    runUrl: stringValue(job.runUrl),
    jobsUrl: stringValue(job.jobsUrl),
    htmlUrl: stringValue(job.htmlUrl),
    playPath: stringValue(job.playPath),
    folder: stringValue(job.folder),
    thumbnailPath: stringValue(job.thumbnailPath),
    entryId: stringValue(job.entryId),
    error: stringValue(job.error),
    failureLoggedAt: timestampMs(job.failureLoggedAt || 0),
    failedAt: isFailedJob(job) ? timestampMs(job.failedAt || job.lastServerUpdateAt || job.progressUpdatedAt || Date.now()) : 0,
    lastServerUpdateAt: timestampMs(job.lastServerUpdateAt || job.progressUpdatedAt || Date.now()),
    lastSyncAttemptAt: timestampMs(job.lastSyncAttemptAt || job.progressUpdatedAt || Date.now()),
    syncFailureCount: Math.max(Number(job.syncFailureCount) || 0, 0),
  };
}

function normalizeStoredJob(rawJob) {
  if (!rawJob || typeof rawJob !== "object") {
    return null;
  }

  const normalized = serializeJobForStorage(rawJob);
  if (!normalized.requestId && !normalized.runId) {
    return null;
  }
  if (!normalized.sourceUrl && !normalized.sourceInput) {
    return null;
  }

  const ageMs = Date.now() - jobSortTimestamp(normalized);
  if (ageMs > jobRetentionMs(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeStoredJobs(rawJobs) {
  const deduped = new Map();
  (Array.isArray(rawJobs) ? rawJobs : []).forEach((rawJob) => {
    const normalized = normalizeStoredJob(rawJob);
    if (!normalized) {
      return;
    }

    const key = dedupeJobKey(normalized);
    const current = deduped.get(key);
    if (!current || jobSortTimestamp(normalized) >= jobSortTimestamp(current)) {
      deduped.set(key, normalized);
    }
  });

  const batchDeduped = new Map();
  [...deduped.values()].forEach((job) => {
    const batchId = String(job?.batchId || "").trim();
    const sourceKey = candidateSourceKey(job?.sourceUrl || "");
    const rank = candidateRankValue(job);
    const batchKey = batchId
      ? (
        !isTerminalJob(job) && rank !== 999
          ? `batch:${batchId}:active-rank:${rank}`
          : `batch:${batchId}:${sourceKey || `rank:${rank}`}`
      )
      : dedupeJobKey(job);
    const current = batchDeduped.get(batchKey);
    const currentPriority = current ? jobSortPriority(current) : Number.POSITIVE_INFINITY;
    const nextPriority = jobSortPriority(job);
    if (
      !current ||
      nextPriority < currentPriority ||
      (nextPriority === currentPriority && jobSortTimestamp(job) >= jobSortTimestamp(current))
    ) {
      batchDeduped.set(batchKey, job);
    }
  });

  return [...batchDeduped.values()]
    .sort((left, right) => {
      const batchDelta = batchCreatedTimestamp(right) - batchCreatedTimestamp(left);
      if (batchDelta !== 0) {
        return batchDelta;
      }

      if (left.batchId && left.batchId === right.batchId) {
        const rankDelta = candidateRankValue(left) - candidateRankValue(right);
        if (rankDelta !== 0) {
          return rankDelta;
        }
      }

      const priorityDelta = jobSortPriority(left) - jobSortPriority(right);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      const createdDelta = jobCreatedTimestamp(right) - jobCreatedTimestamp(left);
      if (createdDelta !== 0) {
        return createdDelta;
      }

      return jobSortTimestamp(right) - jobSortTimestamp(left);
    })
    .slice(0, MAX_STORED_JOBS);
}

function formatStatus(status) {
  if (status === "completed") return "Complete";
  if (status === "error") return "Failed";
  if (status === "in_progress") return "Running";
  if (status === "queued") return "Queued";
  return "Waiting";
}

function formatJobStatus(job) {
  if (String(job?.status || "") === "completed") {
    if (String(job?.conclusion || "") === "success") {
      return "Complete";
    }
    if (String(job?.conclusion || "") === "cancelled") {
      return "Cancelled";
    }
    return "Failed";
  }
  return formatStatus(job?.status);
}

function candidateRankLabel(job) {
  const rank = candidateRankValue(job);
  const total = Math.max(Number(job?.candidateTotal) || 1, 1);
  if (rank === 999 || total <= 1) {
    return "";
  }
  if (rank === 1) {
    return `Best match of ${total}`;
  }
  if (rank === total) {
    return `Last backup of ${total}`;
  }
  return `Backup ${rank} of ${total}`;
}

function candidateSubtitle(job) {
  const parts = [];
  const batchLabel = String(job?.batchLabel || "").trim();
  const matchedName = String(job?.matchedName || "").trim();
  if (batchLabel && normalizeSearchVariantKey(batchLabel) !== normalizeSearchVariantKey(job?.displayName || "")) {
    parts.push(batchLabel);
  }
  if (matchedName && normalizeSearchVariantKey(matchedName) !== normalizeSearchVariantKey(job?.displayName || "")) {
    parts.push(`Matched ${matchedName}`);
  }
  const sourceHost = hostFromUrl(job?.sourceUrl || "");
  if (sourceHost) {
    parts.push(sourceHost);
  }
  return parts.join(" • ");
}

function successfulJob(job) {
  return String(job?.status || "") === "completed" && String(job?.conclusion || "") === "success";
}

function activeJob(job) {
  return !isTerminalJob(job);
}

function jobsForSection(sectionKey) {
  if (sectionKey === "active") {
    return jobs.filter((job) => activeJob(job));
  }
  if (sectionKey === "completed") {
    return jobs.filter((job) => successfulJob(job));
  }
  if (sectionKey === "failed") {
    return jobs.filter((job) => isFailedJob(job) || isCancelledJob(job));
  }
  return [];
}

function sectionOpenState(sectionKey) {
  if (Object.prototype.hasOwnProperty.call(jobSectionState, sectionKey)) {
    return Boolean(jobSectionState[sectionKey]);
  }
  return sectionKey === "active";
}

function jobsForBatch(batchId) {
  const normalizedBatchId = String(batchId || "").trim();
  return jobs
    .filter((job) => String(job?.batchId || "").trim() === normalizedBatchId)
    .sort((left, right) => candidateRankValue(left) - candidateRankValue(right));
}

function batchIsComplete(batchJobs) {
  return batchJobs.length > 0 && batchJobs.every((job) => isTerminalJob(job));
}

function batchSuccessfulJobs(batchJobs) {
  return batchJobs.filter((job) => successfulJob(job));
}

function batchActiveTargetCount(batchId, successfulCount = 0) {
  const desired = desiredSuccessCountForBatch(batchId);
  const remainingDesired = Math.max(desired - Math.max(Number(successfulCount) || 0, 0), 0);
  if (remainingDesired <= 0) {
    return 0;
  }
  return Math.min(MAX_ACTIVE_CANDIDATES_PER_BATCH, remainingDesired);
}

function desiredSuccessCountForBatch(batchId) {
  const desired = Number(batchSelectionFor(batchId)?.desiredSuccessCount);
  if (!Number.isFinite(desired) || desired <= 0) {
    return DEFAULT_TARGET_SUCCESSFUL_CANDIDATES;
  }
  return Math.round(desired);
}

function candidatePoolForBatch(batchId) {
  const pool = batchSelectionFor(batchId)?.candidatePool;
  return Array.isArray(pool) ? pool : [];
}

function batchHasRemainingCandidates(batchJobs) {
  const batchId = String(batchJobs[0]?.batchId || "").trim();
  const pool = candidatePoolForBatch(batchId);
  if (!pool.length) {
    return false;
  }
  const attempted = new Set(batchJobs.map((job) => candidateSourceKey(job.sourceUrl)).filter(Boolean));
  return pool.some((candidate) => {
    const key = candidateSourceKey(candidate?.sourceUrl || "");
    return key && !attempted.has(key);
  });
}

function batchReadyForFavorite(batchJobs) {
  if (batchJobs.length < 2) {
    return false;
  }
  const successful = batchSuccessfulJobs(batchJobs);
  const desired = desiredSuccessCountForBatch(batchJobs[0]?.batchId);
  const noRemaining = !batchHasRemainingCandidates(batchJobs) && batchIsComplete(batchJobs);
  if (successful.length >= desired) {
    return successful.every((job) => String(job.entryId || "").trim() && String(job.playPath || "").trim());
  }
  if (!noRemaining) {
    return false;
  }
  return successful.length >= 2 && successful.every((job) => String(job.entryId || "").trim() && String(job.playPath || "").trim());
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "Calculating...";
  }
  const rounded = Math.max(Math.round(seconds), 1);
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m remaining`;
  }
  if (minutes > 0) {
    return `${minutes}m ${remainder}s remaining`;
  }
  return `${remainder}s remaining`;
}

function formatDate(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function stepDurationSeconds(step) {
  if (!step?.started_at || !step?.completed_at) {
    return null;
  }
  const start = Date.parse(step.started_at);
  const end = Date.parse(step.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return Math.max((end - start) / 1000, 1);
}

function runTotalDurationSeconds(runPayload) {
  const start =
    Date.parse(String(runPayload?.created_at || "")) ||
    Date.parse(String(runPayload?.run_started_at || ""));
  const end =
    Date.parse(String(runPayload?.updated_at || "")) ||
    Date.parse(String(runPayload?.completed_at || ""));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return Math.max((end - start) / 1000, 1);
}

function median(values) {
  if (!Array.isArray(values) || !values.length) {
    return null;
  }
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (!sorted.length) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function expectedSecondsForStep(name) {
  const stepName = String(name || "").trim();
  const historyValues = Array.isArray(jobHistory.stepDurations?.[stepName])
    ? jobHistory.stepDurations[stepName]
    : [];
  const historicalMedian = median(historyValues);
  if (Number.isFinite(historicalMedian)) {
    return historicalMedian;
  }
  return DEFAULT_STEP_DURATIONS[stepName] || DEFAULT_STEP_SECONDS;
}

function expectedWorkflowSeconds() {
  const historicalMedian = median(jobHistory.totalDurations);
  if (Number.isFinite(historicalMedian)) {
    return historicalMedian;
  }
  return DEFAULT_WORKFLOW_DURATION_SECONDS;
}

function runElapsedSeconds(runPayload) {
  const createdAt =
    Date.parse(String(runPayload?.created_at || "")) ||
    Date.parse(String(runPayload?.run_started_at || ""));
  if (!Number.isFinite(createdAt)) {
    return 0;
  }
  return Math.max((Date.now() - createdAt) / 1000, 0);
}

function workflowStepNames(steps) {
  const names = [];
  const seen = new Set();

  (steps || []).forEach((step) => {
    const name = String(step?.name || "").trim();
    if (!name || seen.has(name)) {
      return;
    }
    seen.add(name);
    names.push(name);
  });

  DEFAULT_WORKFLOW_STEP_ORDER.forEach((name) => {
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  });

  return names;
}

function remainingSecondsForActiveStep(stepName, step) {
  const expected = expectedSecondsForStep(stepName);
  const startedAt = Date.parse(String(step?.started_at || ""));
  const elapsed = Number.isFinite(startedAt) ? Math.max((Date.now() - startedAt) / 1000, 0) : 0;

  if (elapsed <= 0) {
    return expected;
  }
  if (elapsed < expected) {
    return expected - elapsed;
  }

  return Math.max(Math.min(expected * 0.3, 35), Math.min(elapsed * 0.2, 45), 10);
}

function estimateRemainingSeconds(runPayload, jobsPayload) {
  const status = String(runPayload?.status || "queued");
  if (status === "completed") {
    return 0;
  }

  const steps = actionableStepsFromJobs(jobsPayload);
  const byName = new Map(steps.map((step) => [String(step.name || "").trim(), step]));
  const plannedNames = workflowStepNames(steps);

  if (!plannedNames.length) {
    return DEFAULT_WORKFLOW_STEP_ORDER.reduce((sum, name) => sum + expectedSecondsForStep(name), 0);
  }

  let remainingSeconds = 0;
  plannedNames.forEach((name) => {
    const step = byName.get(name);
    if (!step) {
      remainingSeconds += expectedSecondsForStep(name);
      return;
    }

    const stepStatus = String(step.status || "");
    if (stepStatus === "completed") {
      return;
    }
    if (stepStatus === "in_progress") {
      remainingSeconds += remainingSecondsForActiveStep(name, step);
      return;
    }
    remainingSeconds += expectedSecondsForStep(name);
  });

  if (status === "queued") {
    remainingSeconds += 8;
  }

  const totalRemaining = Math.max(expectedWorkflowSeconds() - runElapsedSeconds(runPayload), 1);
  if (!steps.length) {
    return totalRemaining;
  }

  return Math.max(totalRemaining, Math.min(remainingSeconds, totalRemaining + 20));
}

function estimateProgressPercent(runPayload, jobsPayload) {
  const status = String(runPayload?.status || "queued");
  const conclusion = String(runPayload?.conclusion || "");
  if (status === "completed") {
    return conclusion === "success" ? 100 : 100;
  }

  const steps = actionableStepsFromJobs(jobsPayload);
  const byName = new Map(steps.map((step) => [String(step.name || "").trim(), step]));
  const plannedNames = workflowStepNames(steps);
  const totalExpected = plannedNames.reduce((sum, name) => sum + expectedSecondsForStep(name), 0);
  if (!totalExpected) {
    return status === "queued" ? 8 : 18;
  }

  let completedEquivalent = 0;
  plannedNames.forEach((name) => {
    const step = byName.get(name);
    const expected = expectedSecondsForStep(name);
    if (!step) {
      return;
    }

    const stepStatus = String(step.status || "");
    if (stepStatus === "completed") {
      completedEquivalent += expected;
      return;
    }

    if (stepStatus === "in_progress") {
      const startedAt = Date.parse(String(step.started_at || ""));
      const elapsed = Number.isFinite(startedAt) ? Math.max((Date.now() - startedAt) / 1000, 0) : 0;
      completedEquivalent += Math.min(expected * 0.9, elapsed);
    }
  });

  const weightedPercent = Math.round((completedEquivalent / totalExpected) * 100);
  if (status === "queued") {
    return Math.max(8, Math.min(weightedPercent, 14));
  }
  return Math.max(12, Math.min(weightedPercent, 96));
}

function recordSuccessfulRunHistory(runPayload, jobsPayload) {
  const runId = String(runPayload?.id || "").trim();
  const conclusion = String(runPayload?.conclusion || "");
  if (!runId || conclusion !== "success" || jobHistory.recordedRunIds.includes(runId)) {
    return;
  }

  const steps = actionableStepsFromJobs(jobsPayload);
  let recordedAny = false;
  steps.forEach((step) => {
    const name = String(step?.name || "").trim();
    const duration = stepDurationSeconds(step);
    if (!name || !Number.isFinite(duration)) {
      return;
    }

    const current = Array.isArray(jobHistory.stepDurations[name]) ? jobHistory.stepDurations[name] : [];
    const sanitizedDuration = sanitizeDurationValue(duration);
    if (!Number.isFinite(sanitizedDuration)) {
      return;
    }
    current.push(sanitizedDuration);
    jobHistory.stepDurations[name] = sanitizeDurationList(current);
    recordedAny = true;
  });

  const totalDuration = sanitizeDurationValue(runTotalDurationSeconds(runPayload));
  if (Number.isFinite(totalDuration)) {
    jobHistory.totalDurations = sanitizeDurationList([...jobHistory.totalDurations, totalDuration]);
    recordedAny = true;
  }

  if (!recordedAny) {
    return;
  }

  jobHistory.recordedRunIds = [...jobHistory.recordedRunIds, runId].slice(-MAX_RECORDED_RUNS);
  saveJobHistory();
}

function actionableStepsFromJobs(payload) {
  const jobsPayload = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const steps = [];
  jobsPayload.forEach((job) => {
    (job.steps || []).forEach((step) => {
      const name = String(step.name || "");
      if (
        name === "Set up job" ||
        name === "Complete job" ||
        name.startsWith("Post ") ||
        name.startsWith("Complete ")
      ) {
        return;
      }
      steps.push(step);
    });
  });
  return steps;
}

function progressFromRun(runPayload, jobsPayload) {
  const status = String(runPayload?.status || "queued");
  const conclusion = String(runPayload?.conclusion || "");
  const steps = actionableStepsFromJobs(jobsPayload);
  const activeStep = steps.find((step) => step.status === "in_progress");
  const lastCompletedStep = [...steps].reverse().find((step) => step.status === "completed");
  const estimatedRemainingSeconds = estimateRemainingSeconds(runPayload, jobsPayload);

  let progressPercent = 8;
  let phase = "Queued in GitHub Actions";
  let etaSeconds = estimatedRemainingSeconds;
  let etaLabel = formatDuration(estimatedRemainingSeconds);

  if (status === "in_progress") {
    progressPercent = estimateProgressPercent(runPayload, jobsPayload);
    phase = activeStep?.name || lastCompletedStep?.name || "Starting runner";
  } else if (status === "completed") {
    progressPercent = conclusion === "success" ? 100 : Math.max(20, progressPercent);
    phase = conclusion === "success" ? "Published to GitHub Pages" : "Build failed";
    etaSeconds = 0;
    etaLabel = "Completed";
  } else if (status === "queued") {
    progressPercent = estimateProgressPercent(runPayload, jobsPayload);
    phase = "Waiting for an available runner";
    etaSeconds = 0;
    etaLabel = "Queue delay unknown";
  }

  return {
    status,
    conclusion,
    progressPercent,
    phase,
    etaSeconds,
    etaLabel,
  };
}

function resolveCatalogSource(inputValue) {
  const trimmed = String(inputValue || "").trim();
  if (!trimmed) {
    throw new Error("Enter a game URL or a catalog name.");
  }

  const normalizedUrl = coerceInputToUrl(trimmed);
  if (normalizedUrl) {
    return {
      sourceUrl: normalizedUrl,
      displayName: deriveNameFromUrl(normalizedUrl),
      sourceMode: "url",
      matchedName: "",
    };
  }

  const normalized = trimmed.toLowerCase();
  const exactMatches = catalogEntries.filter(
    (entry) => String(entry.name || "").trim().toLowerCase() === normalized,
  );
  if (exactMatches.length === 1) {
    return {
      sourceUrl: exactMatches[0].url,
      displayName: exactMatches[0].name,
      sourceMode: "catalog",
      matchedName: exactMatches[0].name,
    };
  }

  const partialMatches = catalogEntries.filter((entry) =>
    String(entry.name || "").trim().toLowerCase().includes(normalized),
  );
  if (partialMatches.length === 1) {
    return {
      sourceUrl: partialMatches[0].url,
      displayName: partialMatches[0].name,
      sourceMode: "catalog",
      matchedName: partialMatches[0].name,
    };
  }

  if (partialMatches.length > 1) {
    throw new Error(
      `Multiple catalog matches found: ${partialMatches
        .slice(0, 5)
        .map((entry) => entry.name)
        .join(", ")}`,
    );
  }

  throw new Error("Enter a full game URL, a bare domain like example.com, or a name from game_catalog.json.");
}

function normalizeResolvedCandidate(candidate, fallbackName = "") {
  return {
    rank: Math.max(Number(candidate?.rank) || 1, 1),
    sourceUrl: String(candidate?.sourceUrl || "").trim(),
    displayName: String(candidate?.displayName || fallbackName || "game").trim(),
    sourceMode: String(candidate?.sourceMode || "search").trim() || "search",
    matchedName: String(candidate?.matchedName || candidate?.displayName || fallbackName || "game").trim(),
    provider: String(candidate?.provider || "search").trim() || "search",
    confidence: Number(candidate?.confidence) || 0,
    hostedOnline: Boolean(candidate?.hostedOnline),
    resolutionReason: String(candidate?.reason || "").trim(),
    buildDisposition: String(candidate?.buildDisposition || "unknown").trim() || "unknown",
    historyStatus: String(candidate?.historyStatus || "unknown").trim() || "unknown",
    historySummary: String(candidate?.historySummary || "").trim(),
  };
}

function dedupeResolvedCandidates(candidates) {
  const seen = new Set();
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
    const key = candidateSourceKey(candidate?.sourceUrl || "");
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function searchForGameByName(query, limit = 1) {
  const searchUrl = new URL(workerEndpoint("/search"));
  searchUrl.searchParams.set("query", String(query || "").trim());
  searchUrl.searchParams.set("limit", String(Math.max(Number(limit) || 1, 1)));
  searchUrl.searchParams.set("_", String(Date.now()));
  return fetchJson(searchUrl.toString());
}

async function resolveSourceCandidates(inputValue, limit = DEFAULT_TARGET_SUCCESSFUL_CANDIDATES) {
  const trimmed = String(inputValue || "").trim();
  if (!trimmed) {
    throw new Error("Enter a game URL or a game name.");
  }

  const normalizedUrl = coerceInputToUrl(trimmed);
  if (normalizedUrl) {
    return [normalizeResolvedCandidate({
      sourceUrl: normalizedUrl,
      displayName: deriveNameFromUrl(normalizedUrl),
      sourceMode: "url",
      matchedName: "",
      provider: "direct-url",
      confidence: 100,
      hostedOnline: true,
      reason: "",
    })];
  }

  const attemptedQueries = [];
  let lastSearchError = null;
  let candidates = [];
  for (const variant of buildSearchQueryVariants(trimmed)) {
    try {
      const result = await searchForGameByName(variant, limit);
      const rawCandidates = Array.isArray(result?.candidates) ? result.candidates : [result];
      candidates = dedupeResolvedCandidates([
        ...candidates,
        ...rawCandidates.map((candidate) => normalizeResolvedCandidate(candidate, trimmed)),
      ]);
      if (candidates.length >= limit) {
        return candidates.slice(0, limit);
      }
    } catch (searchError) {
      lastSearchError = searchError;
      attemptedQueries.push(variant);
    }
  }

  if (candidates.length) {
    return candidates.slice(0, limit);
  }

  if (lastSearchError) {
    const closestMatches = extractClosestMatchesFromError(lastSearchError.message).filter(
      (candidate) => !attemptedQueries.some((attempt) => normalizeSearchVariantKey(attempt) === normalizeSearchVariantKey(candidate)),
    );
    for (const candidate of closestMatches.slice(0, 3)) {
      try {
        const result = await searchForGameByName(candidate, limit);
        const rawCandidates = Array.isArray(result?.candidates) ? result.candidates : [result];
        candidates = dedupeResolvedCandidates([
          ...candidates,
          ...rawCandidates.map((item) => normalizeResolvedCandidate(item, candidate)),
        ]);
        if (candidates.length >= limit) {
          return candidates.slice(0, limit);
        }
      } catch (_closestError) {
        // Keep falling through to catalog and then the original error.
      }
    }
  }

  if (candidates.length) {
    return candidates.slice(0, limit);
  }

  try {
    const catalogResolved = resolveCatalogSource(trimmed);
    return [normalizeResolvedCandidate({
      ...catalogResolved,
      provider: "catalog",
      confidence: 80,
      hostedOnline: true,
      reason: "Used local game catalog fallback.",
    })];
  } catch (_catalogError) {
    throw lastSearchError || new Error("No compatible hosted result was found.");
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
  });
  let payload = null;
  if (response.status !== 204) {
    payload = await response.json().catch(() => null);
  }

  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.error ||
      `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

async function loadCatalog() {
  try {
    const payload = await fetchJson(`./game_catalog.json?ts=${Date.now()}`);
    if (Array.isArray(payload)) {
      catalogEntries = payload
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          name: String(entry.name || "").trim(),
          url: String(entry.url || "").trim(),
        }))
        .filter((entry) => entry.name && entry.url);
      return;
    }

    if (payload && typeof payload === "object") {
      catalogEntries = Object.entries(payload)
        .map(([name, url]) => ({
          name: String(name || "").trim(),
          url: String(url || "").trim(),
        }))
        .filter((entry) => entry.name && entry.url);
      return;
    }
  } catch (_error) {
    catalogEntries = [];
  }
}

async function loadPublishedCatalog() {
  try {
    const payload = await fetchJson(`./published_games.json?ts=${Date.now()}`);
    const games = Array.isArray(payload?.games) ? payload.games : [];
    publishedCatalog = [...games].sort((left, right) => {
      const leftTime = Date.parse(String(left?.generated_at || "")) || 0;
      const rightTime = Date.parse(String(right?.generated_at || "")) || 0;
      return rightTime - leftTime;
    });
  } catch (_error) {
    publishedCatalog = [];
  }
}

async function loadWorkerConfig() {
  if (!workerConfigured(appConfig.workerUrl)) {
    updateRepoTarget();
    return;
  }

  try {
    const payload = await fetchJson(workerEndpoint("/config"));
    appConfig.owner = String(payload?.owner || "").trim();
    appConfig.repo = String(payload?.repo || "").trim();
    appConfig.ref = String(payload?.ref || "main").trim() || "main";
    appConfig.workflowFile = String(payload?.workflowFile || WORKFLOW_FILE).trim() || WORKFLOW_FILE;
    updateRepoTarget();
    setConfigWarning("Worker connected. Builds will be dispatched through Cloudflare.");
  } catch (error) {
    updateRepoTarget();
    setConfigWarning(`Cloudflare Worker error: ${error.message}`);
  }
}

function playUrlForPath(playPath) {
  return new URL(playPath, window.location.href).toString();
}

function galleryUrlForEntry(entryId = "") {
  const target = new URL("./gallery.html", window.location.href);
  if (entryId) {
    target.hash = entryId;
  }
  return target.toString();
}

function publishedEntryForJob(job) {
  const jobSourceUrl = candidateSourceKey(job.sourceUrl || "");
  return publishedCatalog.find(
    (entry) =>
      String(entry.request_id || "") === String(job.requestId || "") ||
      candidateSourceKey(entry.source_url || "") === jobSourceUrl,
  );
}

async function dispatchWorkflow(job) {
  return fetchJson(workerEndpoint("/dispatch"), {
    method: "POST",
    keepalive: true,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sourceUrl: job.sourceUrl,
      displayName: job.displayName,
      requestId: job.requestId,
    }),
  });
}

async function getRunStatus(runId) {
  return fetchJson(workerEndpoint(`/status?runId=${encodeURIComponent(runId)}`));
}

async function getRunStatusByRequestId(requestId) {
  return fetchJson(workerEndpoint(`/status?requestId=${encodeURIComponent(requestId)}`));
}

function isRecoverableDispatchError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("network request failed") ||
    message.includes("load failed") ||
    message.includes("aborted") ||
    message.includes("no matching run was found yet")
  );
}

function shouldFailUnconfirmedDispatch(job, syncAttemptCount) {
  if (String(job?.runId || "").trim()) {
    return false;
  }
  if (isTerminalJob(job)) {
    return false;
  }

  const attempts = Math.max(Number(syncAttemptCount) || 0, 0);
  const ageMs = Date.now() - timestampMs(job?.submittedAt);
  return attempts >= UNCONFIRMED_DISPATCH_SYNC_LIMIT && ageMs >= UNCONFIRMED_DISPATCH_TIMEOUT_MS;
}

function upsertJob(nextJob) {
  const normalizedJob = normalizeStoredJob(nextJob);
  if (!normalizedJob) {
    return;
  }

  const index = jobs.findIndex(
    (job) =>
      stringValue(job.requestId).trim() === normalizedJob.requestId ||
      (normalizedJob.runId && String(job.runId || "").trim() === normalizedJob.runId),
  );
  if (index >= 0) {
    jobs[index] = {
      ...jobs[index],
      ...normalizedJob,
    };
  } else {
    jobs.unshift(normalizedJob);
  }
  saveJobs();
}

async function deletePublishedGame(job, requestId) {
  const publishedEntry = publishedEntryForJob(job);
  const entryId = String(job.entryId || publishedEntry?.id || "").trim();
  const folder = String(job.folder || publishedEntry?.folder || "").trim();
  if (!entryId) {
    return;
  }

  rememberPendingGalleryDelete({ ...job, entryId, folder });
  await fetchJson(workerEndpoint("/delete"), {
    method: "POST",
    keepalive: true,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      entryId,
      folder,
      requestId,
    }),
  });
}

async function cancelWorkflowJob(job) {
  return fetchJson(workerEndpoint("/cancel"), {
    method: "POST",
    keepalive: true,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      runId: String(job?.runId || "").trim(),
      requestId: String(job?.requestId || "").trim(),
    }),
  });
}

async function trimQueuedBatchOverflow() {
  const batchIds = uniqueBy(
    jobs.map((job) => String(job?.batchId || "").trim()).filter(Boolean),
    (value) => value,
  );

  for (const batchId of batchIds) {
    const batchJobs = jobsForBatch(batchId);
    const successfulCount = batchSuccessfulJobs(batchJobs).length;
    const allowedActiveCount = batchActiveTargetCount(batchId, successfulCount);
    const activeJobs = batchJobs.filter((job) => !isTerminalJob(job));
    if (allowedActiveCount < 0 || activeJobs.length <= allowedActiveCount) {
      continue;
    }

    const prioritizedActiveJobs = [...activeJobs].sort((left, right) => {
      const leftStatus = String(left?.status || "");
      const rightStatus = String(right?.status || "");
      const leftPriority = leftStatus === "in_progress" ? 0 : leftStatus === "queued" ? 1 : 2;
      const rightPriority = rightStatus === "in_progress" ? 0 : rightStatus === "queued" ? 1 : 2;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      const rankDelta = candidateRankValue(left) - candidateRankValue(right);
      if (rankDelta !== 0) {
        return rankDelta;
      }

      return jobSortTimestamp(left) - jobSortTimestamp(right);
    });

    const overflowJobs = prioritizedActiveJobs.slice(allowedActiveCount);
    for (const job of overflowJobs) {
      try {
        const result = await cancelWorkflowJob(job);
        if (result?.alreadyCompleted && String(result?.conclusion || "").trim() !== "cancelled") {
          continue;
        }
        upsertJob({
          ...job,
          runId: String(result?.runId || job?.runId || "").trim(),
          status: "completed",
          conclusion: "cancelled",
          progressPercent: clampPercent(job.progressPercent || 0),
          progressUpdatedAt: Date.now(),
          phase: "Cancelled to free runner slot",
          etaLabel: "Cancelled",
          etaSeconds: 0,
          etaUpdatedAt: Date.now(),
          error: "Cancelled to free runner slot.",
          failedAt: 0,
          lastServerUpdateAt: Date.now(),
          lastSyncAttemptAt: Date.now(),
          syncFailureCount: 0,
        });
      } catch (error) {
        upsertJob({
          ...job,
          error: error.message || "Could not cancel overflow job.",
          lastSyncAttemptAt: Date.now(),
          syncFailureCount: Math.max(Number(job.syncFailureCount) || 0, 0) + 1,
        });
      }
    }
  }

  jobs = normalizeStoredJobs(jobs);
}

function createBatchDraftJob(batchId, batchLabel, batchSubmittedAt, candidate, poolSize) {
  const candidateRank = Math.max(Number(candidate?.rank) || 1, 1);
  return {
    requestId: createRequestId(),
    batchId,
    batchLabel,
    batchSubmittedAt,
    candidateRank,
    candidateTotal: Math.max(Number(poolSize) || candidateRank, candidateRank),
    candidateReason: String(candidate?.resolutionReason || "").trim(),
    candidateConfidence: Number(candidate?.confidence) || 0,
    owner: appConfig.owner,
    repo: appConfig.repo,
    ref: appConfig.ref,
    sourceInput: batchLabel,
    sourceUrl: String(candidate?.sourceUrl || "").trim(),
    displayName: String(candidate?.displayName || batchLabel || "game").trim(),
    sourceMode: String(candidate?.sourceMode || "search").trim() || "search",
    provider: String(candidate?.provider || "search").trim() || "search",
    matchedName: String(candidate?.matchedName || candidate?.displayName || batchLabel || "game").trim(),
    buildDisposition: String(candidate?.buildDisposition || "unknown").trim() || "unknown",
    historyStatus: String(candidate?.historyStatus || "unknown").trim() || "unknown",
    historySummary: String(candidate?.historySummary || "").trim(),
    submittedAt: nowIso(),
    status: "queued",
    conclusion: "",
    progressPercent: candidateRank === 1 ? 6 : 4,
    progressUpdatedAt: Date.now(),
    phase: "Dispatching workflow",
    etaLabel: "Calculating...",
    etaSeconds: 0,
    etaUpdatedAt: Date.now(),
    runId: "",
    runUrl: "",
    jobsUrl: "",
    htmlUrl: "",
    playPath: "",
    thumbnailPath: "",
    entryId: "",
    folder: "",
    error: "",
    failureLoggedAt: 0,
  };
}

async function logFailedJob(job) {
  if (!workerConfigured(appConfig.workerUrl) || !isFailedJob(job) || Number(job.failureLoggedAt) > 0) {
    return false;
  }

  await fetchJson(workerEndpoint("/log-failure"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requestId: job.requestId,
      batchId: job.batchId || "",
      batchLabel: job.batchLabel || "",
      candidateRank: job.candidateRank || 0,
      candidateTotal: job.candidateTotal || 0,
      displayName: job.displayName || "",
      matchedName: job.matchedName || "",
      sourceInput: job.sourceInput || "",
      sourceUrl: job.sourceUrl || "",
      sourceMode: job.sourceMode || "",
      candidateReason: job.candidateReason || "",
      candidateConfidence: job.candidateConfidence || 0,
      status: job.status || "",
      conclusion: job.conclusion || "",
      phase: job.phase || "",
      error: job.error || "",
      runId: job.runId || "",
      runUrl: job.runUrl || "",
      htmlUrl: job.htmlUrl || "",
      jobsUrl: job.jobsUrl || "",
      failedAt: job.failedAt || Date.now(),
    }),
  });

  upsertJob({
    ...job,
    failureLoggedAt: Date.now(),
  });
  return true;
}

async function maybeDispatchBatchFallback(batchId) {
  const normalizedBatchId = String(batchId || "").trim();
  const selection = batchSelectionFor(normalizedBatchId);
  if (!normalizedBatchId || !selection || selection.dispatchingFallback) {
    return false;
  }
  if (selection.state === "complete" || selection.state === "auto-kept" || selection.state === "keeping") {
    return false;
  }

  const batchJobs = jobsForBatch(normalizedBatchId);
  const desired = desiredSuccessCountForBatch(normalizedBatchId);
  const successfulCount = batchSuccessfulJobs(batchJobs).length;
  const activeCount = batchJobs.filter((job) => !isTerminalJob(job)).length;
  const targetActiveCount = batchActiveTargetCount(normalizedBatchId, successfulCount);
  const openSlots = Math.min(
    Math.max(desired - (successfulCount + activeCount), 0),
    Math.max(targetActiveCount - activeCount, 0),
  );
  if (openSlots <= 0) {
    return false;
  }

  const candidatePool = candidatePoolForBatch(normalizedBatchId);
  const attempted = new Set(batchJobs.map((job) => candidateSourceKey(job.sourceUrl)).filter(Boolean));
  const remainingCandidates = candidatePool.filter((candidate) => {
    const key = candidateSourceKey(candidate?.sourceUrl || "");
    return key && !attempted.has(key);
  });
  if (!remainingCandidates.length) {
    return false;
  }

  updateBatchSelection(normalizedBatchId, {
    dispatchingFallback: true,
    state: "backfilling",
  });
  try {
    const batchLabel = String(selection.batchLabel || batchJobs[0]?.batchLabel || batchJobs[0]?.sourceInput || "").trim();
    const batchSubmittedAt = String(selection.batchSubmittedAt || batchJobs[0]?.batchSubmittedAt || nowIso());
    const fallbackDraftJobs = remainingCandidates.slice(0, openSlots).map((nextCandidate) =>
      createBatchDraftJob(
        normalizedBatchId,
        batchLabel,
        batchSubmittedAt,
        nextCandidate,
        candidatePool.length,
      ),
    );
    const results = await Promise.all(
      fallbackDraftJobs.map((draftJob) => dispatchCandidateJob(draftJob)),
    );
    const queuedCount = results.filter((result) => result.ok).length;

    updateBatchSelection(normalizedBatchId, {
      dispatchingFallback: false,
      state: queuedCount > 0 ? "pending" : "backfill-failed",
      lastFallbackAt: nowIso(),
    });
    return queuedCount > 0;
  } catch (_error) {
    updateBatchSelection(normalizedBatchId, {
      dispatchingFallback: false,
      state: "backfill-failed",
      lastFallbackAt: nowIso(),
    });
    return false;
  }
}

async function syncBatchRecoveryAndFailureLogs() {
  const failedJobs = jobs.filter((job) => isFailedJob(job) && Number(job.failureLoggedAt) <= 0);
  for (const job of failedJobs) {
    try {
      await logFailedJob(job);
    } catch (_error) {
      // Leave the job unmarked so the next refresh can retry logging.
    }
  }

  const batchIds = uniqueBy(
    jobs.map((job) => String(job.batchId || "").trim()).filter(Boolean),
    (value) => value,
  );
  for (const batchId of batchIds) {
    await maybeDispatchBatchFallback(batchId);
  }
}

function renderActions(job, actionsRoot) {
  if (!actionsRoot) {
    return;
  }
  actionsRoot.innerHTML = "";

  if (activeJob(job)) {
    const cancelButton = document.createElement("button");
    cancelButton.className = "job-link secondary";
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel job";
    cancelButton.addEventListener("click", async () => {
      cancelButton.disabled = true;
      try {
        const result = await cancelWorkflowJob(job);
        if (result?.alreadyCompleted && String(result?.conclusion || "").trim() !== "cancelled") {
          await refreshJobStatuses();
          return;
        }
        upsertJob({
          ...job,
          runId: String(result?.runId || job?.runId || "").trim(),
          status: "completed",
          conclusion: "cancelled",
          progressPercent: clampPercent(job.progressPercent || 0),
          progressUpdatedAt: Date.now(),
          phase: "Cancelled by user",
          etaLabel: "Cancelled",
          etaSeconds: 0,
          etaUpdatedAt: Date.now(),
          error: "Cancelled by user.",
          failedAt: 0,
          lastServerUpdateAt: Date.now(),
          lastSyncAttemptAt: Date.now(),
          syncFailureCount: 0,
        });
        renderJobs();
        await syncBatchRecoveryAndFailureLogs();
      } catch (error) {
        upsertJob({
          ...job,
          error: error.message || "Could not cancel this job.",
          lastSyncAttemptAt: Date.now(),
          syncFailureCount: Math.max(Number(job.syncFailureCount) || 0, 0) + 1,
        });
        renderJobs();
      }
    });
    actionsRoot.append(cancelButton);
  }

  if (successfulJob(job) && job.playPath) {
    const playLink = document.createElement("a");
    playLink.className = "job-link";
    playLink.href = playUrlForPath(job.playPath);
    playLink.target = "_blank";
    playLink.rel = "noreferrer";
    playLink.textContent = job.candidateTotal > 1 ? "Play candidate" : "Play game";
    actionsRoot.append(playLink);

    const galleryLink = document.createElement("a");
    galleryLink.className = "job-link secondary";
    galleryLink.href = galleryUrlForEntry(job.entryId || "");
    galleryLink.textContent = "Open gallery";
    actionsRoot.append(galleryLink);
  }
}

function setFavoriteModalVisible(visible) {
  if (!favoriteModal) {
    return;
  }
  favoriteModal.hidden = !visible;
}

function closeFavoriteModal() {
  activeFavoriteBatchId = "";
  if (favoriteGrid) {
    favoriteGrid.innerHTML = "";
  }
  if (favoriteStatus) {
    favoriteStatus.textContent = "";
  }
  setFavoriteModalVisible(false);
}

async function keepFavoriteCandidate(batchId, favoriteRequestId) {
  const batchJobs = jobsForBatch(batchId);
  const favoriteJob = batchJobs.find((job) => String(job.requestId || "") === String(favoriteRequestId || ""));
  if (!favoriteJob) {
    return;
  }

  updateBatchSelection(batchId, {
    favoriteRequestId,
    state: "keeping",
    startedAt: nowIso(),
  });
  if (favoriteStatus) {
    favoriteStatus.textContent = `Keeping ${favoriteJob.displayName} and removing the other builds...`;
  }

  const loserJobs = batchJobs.filter((job) => String(job.requestId || "") !== String(favoriteRequestId || ""));
  const successfulLosers = loserJobs.filter((job) => successfulJob(job));
  const deletionErrors = [];

  for (const [index, job] of successfulLosers.entries()) {
    try {
      await deletePublishedGame(job, `cleanup-${batchId}-${index + 1}-${Date.now()}`);
    } catch (error) {
      deletionErrors.push(`${job.displayName}: ${error.message}`);
    }
  }

  if (deletionErrors.length) {
    updateBatchSelection(batchId, {
      favoriteRequestId,
      state: "error",
      error: deletionErrors.join(" | "),
    });
    if (favoriteStatus) {
      favoriteStatus.textContent = deletionErrors.join(" | ");
    }
    return;
  }

  jobs = normalizeStoredJobs(
    jobs
      .filter((job) => String(job.batchId || "") !== String(batchId || "") || String(job.requestId || "") === String(favoriteRequestId || ""))
      .map((job) =>
        String(job.requestId || "") === String(favoriteRequestId || "")
          ? {
              ...job,
              phase: "Kept after comparison",
              error: "",
            }
          : job,
      ),
  );
  saveJobs();
  updateBatchSelection(batchId, {
    favoriteRequestId,
    state: "complete",
    keptAt: nowIso(),
  });
  closeFavoriteModal();
  renderJobs();
}

function renderFavoriteChooser(batchJobs) {
  if (!favoriteGrid || !favoriteTitle || !favoriteCopy) {
    return;
  }

  const batchLabel = String(batchJobs[0]?.batchLabel || batchJobs[0]?.sourceInput || batchJobs[0]?.displayName || "this game").trim();
  favoriteTitle.textContent = `Pick which ${batchLabel} build to keep`;
  favoriteCopy.textContent = "Candidate 1 is the strongest match. You can preview any finished build, then keep one and remove the rest.";
  favoriteGrid.innerHTML = "";
  if (favoriteStatus) {
    favoriteStatus.textContent = "";
  }

  batchJobs.forEach((job) => {
    const card = document.createElement("article");
    card.className = "favorite-card";
    card.classList.toggle("is-success", successfulJob(job));
    card.classList.toggle("is-failed", isFailedJob(job));

    const rank = document.createElement("p");
    rank.className = "favorite-rank";
    rank.textContent = candidateRankLabel(job) || `Candidate ${candidateRankValue(job)}`;
    card.append(rank);

    if (job.thumbnailPath) {
      const image = document.createElement("img");
      image.className = "favorite-thumb";
      image.src = new URL(job.thumbnailPath, window.location.href).toString();
      image.alt = job.displayName;
      card.append(image);
    }

    const title = document.createElement("h3");
    title.className = "favorite-card-title";
    title.textContent = job.displayName;
    card.append(title);

    if (job.candidateReason) {
      const reason = document.createElement("p");
      reason.className = "favorite-reason";
      reason.textContent = job.candidateReason;
      card.append(reason);
    }

    const actions = document.createElement("div");
    actions.className = "favorite-actions";

    if (successfulJob(job) && job.playPath) {
      const previewLink = document.createElement("a");
      previewLink.className = "job-link secondary";
      previewLink.href = playUrlForPath(job.playPath);
      previewLink.target = "_blank";
      previewLink.rel = "noreferrer";
      previewLink.textContent = "Preview";
      actions.append(previewLink);

      const keepButton = document.createElement("button");
      keepButton.className = "job-link favorite-button";
      keepButton.type = "button";
      keepButton.textContent = "Keep this one";
      keepButton.addEventListener("click", () => {
        if (favoriteStatus) {
          favoriteStatus.textContent = "";
        }
        keepFavoriteCandidate(job.batchId, job.requestId);
      });
      actions.append(keepButton);
    } else {
      const failedText = document.createElement("p");
      failedText.className = "favorite-failed-text";
      failedText.textContent = job.error || "This candidate failed.";
      actions.append(failedText);
    }

    card.append(actions);
    favoriteGrid.append(card);
  });
}

function syncFavoriteChooser() {
  const batches = new Map();
  jobs.forEach((job) => {
    const batchId = String(job.batchId || "").trim();
    if (!batchId) {
      return;
    }
    const current = batches.get(batchId) || [];
    current.push(job);
    batches.set(batchId, current);
  });

  [...batches.entries()].forEach(([batchId, batchJobs]) => {
    const selection = batchSelectionFor(batchId);
    const successful = batchSuccessfulJobs(batchJobs);
    if ((!selection || !selection.favoriteRequestId) && batchIsComplete(batchJobs) && !batchHasRemainingCandidates(batchJobs) && successful.length === 1) {
      updateBatchSelection(batchId, {
        favoriteRequestId: successful[0].requestId,
        state: "auto-kept",
        keptAt: nowIso(),
      });
    }
  });

  const nextBatch = [...batches.entries()]
    .sort((left, right) => batchCreatedTimestamp(right[1][0]) - batchCreatedTimestamp(left[1][0]))
    .find(([batchId, batchJobs]) => {
      const selection = batchSelectionFor(batchId);
      if (selection?.state === "complete" || selection?.state === "auto-kept") {
        return false;
      }
      return batchReadyForFavorite(batchJobs);
    });

  if (!nextBatch) {
    closeFavoriteModal();
    return;
  }

  const [batchId, batchJobs] = nextBatch;
  activeFavoriteBatchId = batchId;
  renderFavoriteChooser(batchJobs);
  setFavoriteModalVisible(true);
}

function previewSelections() {
  return Object.values(batchSelections || {})
    .filter((selection) => Array.isArray(selection?.candidatePool) && selection.candidatePool.length)
    .sort((left, right) => timestampMs(right?.updatedAt) - timestampMs(left?.updatedAt))
    .slice(0, 6);
}

function appendBadgeRow(root, candidate) {
  const badges = buildCandidateBadges(candidate);
  if (!badges.length) {
    return;
  }
  const badgeRow = document.createElement("div");
  badgeRow.className = "badge-row";
  badges.forEach((badge) => {
    const chip = document.createElement("span");
    chip.className = `badge-chip tone-${badge.tone}`;
    chip.textContent = badge.label;
    badgeRow.append(chip);
  });
  root.append(badgeRow);
}

function renderCandidatePreview() {
  if (!candidatePreview || !candidatePreviewList || !candidatePreviewStatus) {
    return;
  }

  const selections = previewSelections();
  candidatePreview.hidden = selections.length === 0;
  candidatePreviewList.innerHTML = "";
  if (!selections.length) {
    candidatePreviewStatus.textContent = "";
    return;
  }

  const candidateCount = selections.reduce(
    (sum, selection) => sum + (Array.isArray(selection?.candidatePool) ? selection.candidatePool.length : 0),
    0,
  );
  candidatePreviewStatus.textContent = `${candidateCount} candidate${candidateCount === 1 ? "" : "s"} indexed`;

  selections.forEach((selection) => {
    const batchCard = document.createElement("article");
    batchCard.className = "preview-batch";

    const header = document.createElement("div");
    header.className = "preview-batch-header";

    const heading = document.createElement("div");
    const title = document.createElement("h3");
    title.className = "preview-batch-title";
    title.textContent = String(selection?.batchLabel || "Request").trim() || "Request";
    const copy = document.createElement("p");
    copy.className = "preview-batch-copy";
    copy.textContent = `Keeping ${Math.max(Number(selection?.desiredSuccessCount) || 1, 1)} successful candidate${Math.max(Number(selection?.desiredSuccessCount) || 1, 1) === 1 ? "" : "s"}.`;
    heading.append(title, copy);

    const state = document.createElement("p");
    state.className = "preview-batch-state";
    state.textContent = String(selection?.state || "pending").replace(/-/g, " ");
    header.append(heading, state);
    batchCard.append(header);

    const list = document.createElement("div");
    list.className = "preview-candidate-list";

    (selection.candidatePool || []).forEach((candidate, index) => {
      const item = document.createElement("div");
      item.className = "preview-candidate";

      const topline = document.createElement("div");
      topline.className = "preview-candidate-topline";
      const name = document.createElement("strong");
      name.className = "preview-candidate-title";
      name.textContent = `${Math.max(Number(candidate?.rank) || index + 1, index + 1)}. ${candidate?.displayName || selection?.batchLabel || "Candidate"}`;
      const confidence = document.createElement("span");
      confidence.className = "preview-candidate-confidence";
      confidence.textContent = `${Math.max(Number(candidate?.confidence) || 0, 0)}%`;
      topline.append(name, confidence);
      item.append(topline);

      const source = document.createElement("p");
      source.className = "preview-candidate-source";
      source.textContent = hostFromUrl(candidate?.sourceUrl || "") || String(candidate?.sourceUrl || "").trim();
      item.append(source);

      appendBadgeRow(item, candidate);

      const reason = document.createElement("p");
      reason.className = "preview-candidate-reason";
      reason.textContent =
        String(candidate?.historySummary || "").trim() ||
        String(candidate?.resolutionReason || "").trim() ||
        "No historical failures recorded.";
      item.append(reason);
      list.append(item);
    });

    batchCard.append(list);
    candidatePreviewList.append(batchCard);
  });
}

function buildJobCardFragment(job) {
  const nowMs = Date.now();
  const progressPercent = visibleProgressPercent(job);
  const roundedProgress = Math.round(progressPercent);
  const fragment = jobTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".job-card");
  const rank = fragment.querySelector(".job-rank");
  const status = fragment.querySelector(".job-status");
  const title = fragment.querySelector(".job-title");
  const subtitle = fragment.querySelector(".job-subtitle");
  const percent = fragment.querySelector(".job-percent");
  const fill = fragment.querySelector(".meter-fill");
  const phase = fragment.querySelector(".job-phase");
  const eta = fragment.querySelector(".job-eta");
  const error = fragment.querySelector(".job-error");
  const actions = fragment.querySelector(".job-actions");

  card.classList.toggle("is-completed", job.status === "completed" && job.conclusion === "success");
  card.classList.toggle("is-error", isFailedJob(job));
  card.classList.toggle(
    "is-favorite",
    String(batchSelectionFor(job.batchId)?.favoriteRequestId || "") === String(job.requestId || ""),
  );

  status.textContent = formatJobStatus(job);
  rank.textContent = candidateRankLabel(job);
  title.textContent = job.displayName;
  subtitle.textContent = candidateSubtitle(job);
  appendBadgeRow(fragment.querySelector(".job-heading"), job);
  percent.textContent = `${roundedProgress}%`;
  fill.style.width = `${progressPercent.toFixed(1)}%`;
  phase.textContent = job.phase || "Queued";
  eta.textContent = visibleEtaLabel(job, nowMs);
  error.textContent = buildJobErrorSummary(job);
  renderActions(job, actions);

  return fragment;
}

function buildJobSection(sectionKey, title, copy, sectionJobs, emptyMessage) {
  const details = document.createElement("details");
  details.className = "job-section";
  details.open = sectionOpenState(sectionKey);
  details.addEventListener("toggle", () => {
    jobSectionState[sectionKey] = details.open;
  });

  const summary = document.createElement("summary");
  summary.className = "job-section-summary";

  const labelWrap = document.createElement("div");
  labelWrap.className = "job-section-label-wrap";

  const chevron = document.createElement("span");
  chevron.className = "job-section-chevron";
  chevron.textContent = ">";
  labelWrap.append(chevron);

  const heading = document.createElement("h2");
  heading.className = "job-section-title";
  heading.textContent = title;
  labelWrap.append(heading);

  const count = document.createElement("span");
  count.className = "job-section-count";
  count.textContent = String(sectionJobs.length);
  labelWrap.append(count);

  const summaryCopy = document.createElement("p");
  summaryCopy.className = "job-section-copy";
  summaryCopy.textContent = copy;

  summary.append(labelWrap, summaryCopy);
  details.append(summary);

  const content = document.createElement("div");
  content.className = "job-section-content";
  if (sectionJobs.length) {
    sectionJobs.forEach((job) => {
      content.append(buildJobCardFragment(job));
    });
  } else {
    const empty = document.createElement("p");
    empty.className = "job-section-empty";
    empty.textContent = emptyMessage;
    content.append(empty);
  }
  details.append(content);

  return details;
}

function renderJobs() {
  if (!jobsContainer || !jobTemplate) {
    renderCandidatePreview();
    return;
  }
  jobsContainer.innerHTML = "";

  if (!jobs.length) {
    closeFavoriteModal();
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No workflow requests yet.";
    jobsContainer.append(empty);
    renderCandidatePreview();
    return;
  }

  jobsContainer.append(
    buildJobSection(
      "active",
      "Running / Candidates",
      "Currently building or waiting to build.",
      jobsForSection("active"),
      "No running or queued candidates right now.",
    ),
  );
  jobsContainer.append(
    buildJobSection(
      "completed",
      "Completed",
      "Finished builds that published successfully.",
      jobsForSection("completed"),
      "No completed jobs yet.",
    ),
  );
  jobsContainer.append(
    buildJobSection(
      "failed",
      "Failed",
      "Builds that stopped, were cancelled, or did not verify.",
      jobsForSection("failed"),
      "No failed jobs.",
    ),
  );
  syncFavoriteChooser();
  renderCandidatePreview();
}

async function refreshJobStatuses() {
  if (refreshInFlight) {
    return;
  }
  refreshInFlight = true;
  try {
  if (!jobs.length || !workerConfigured(appConfig.workerUrl)) {
    renderJobs();
    return;
  }

  await loadPublishedCatalog();

  const refreshed = await Promise.all(
    jobs.map(async (job) => {
      if (isTerminalJob(job)) {
        return job;
      }

      try {
        const payload = job.runId
          ? await getRunStatus(job.runId)
          : await getRunStatusByRequestId(job.requestId);
        if (!payload?.run) {
          const nextSyncFailureCount = Math.max(Number(job.syncFailureCount) || 0, 0) + 1;
          if (shouldFailUnconfirmedDispatch(job, nextSyncFailureCount)) {
            return {
              ...job,
              status: "completed",
              conclusion: "failure",
              progressPercent: 0,
              progressUpdatedAt: Date.now(),
              phase: "Build failed",
              etaLabel: "Failed",
              etaSeconds: 0,
              etaUpdatedAt: Date.now(),
              failedAt: timestampMs(job.failedAt || Date.now()),
              lastServerUpdateAt: Date.now(),
              lastSyncAttemptAt: Date.now(),
              syncFailureCount: nextSyncFailureCount,
              error: "Workflow dispatch was not confirmed.",
            };
          }
          return {
            ...job,
            status: "queued",
            progressPercent: Math.max(Number(job.progressPercent) || 0, 4),
            progressUpdatedAt: Date.now(),
            phase: "Waiting for workflow run",
            etaLabel: job.etaLabel || "Calculating...",
            etaUpdatedAt: Date.now(),
            lastSyncAttemptAt: Date.now(),
            syncFailureCount: nextSyncFailureCount,
            error: "",
          };
        }
        recordSuccessfulRunHistory(payload.run, payload.jobs);
        const derived = progressFromRun(payload.run, payload.jobs);
        const entry = derived.conclusion === "success" ? publishedEntryForJob(job) : null;

        return {
          ...job,
          owner: payload.owner || job.owner,
          repo: payload.repo || job.repo,
          ref: payload.ref || job.ref,
          runId: payload.run?.id || job.runId,
          runUrl: payload.run?.url || job.runUrl,
          htmlUrl: payload.run?.html_url || job.htmlUrl,
          jobsUrl: payload.run?.jobs_url || job.jobsUrl,
          status: derived.status,
          conclusion: derived.conclusion,
          progressPercent: derived.progressPercent,
          progressUpdatedAt: Date.now(),
          phase: derived.phase,
          etaSeconds: derived.etaSeconds,
          etaUpdatedAt: Date.now(),
          etaLabel: derived.etaLabel,
          folder: entry?.folder || job.folder || "",
          playPath: entry?.play_path || job.playPath || "",
          thumbnailPath: entry?.thumbnail_path || job.thumbnailPath || "",
          entryId: entry?.id || job.entryId || "",
          failedAt:
            derived.conclusion && derived.conclusion !== "success"
              ? timestampMs(job.failedAt || Date.now())
              : 0,
          lastServerUpdateAt: Date.now(),
          lastSyncAttemptAt: Date.now(),
          syncFailureCount: 0,
          error:
            derived.conclusion && derived.conclusion !== "success"
              ? `Workflow finished with conclusion: ${derived.conclusion}`
              : "",
        };
      } catch (error) {
        const nextSyncFailureCount = Math.max(Number(job.syncFailureCount) || 0, 0) + 1;
        return {
          ...job,
          status: job.runId ? job.status : "queued",
          lastSyncAttemptAt: Date.now(),
          syncFailureCount: nextSyncFailureCount,
          error: error.message,
        };
      }
    }),
  );

  jobs = normalizeStoredJobs(
    refreshed.map((job) => {
      if (String(job.status || "") === "completed" && String(job.conclusion || "") && String(job.conclusion || "") !== "success") {
        return {
          ...job,
          error:
            String(job.conclusion || "") === "cancelled"
              ? (job.error || "Cancelled by user.")
              : (job.error || `Failed: ${job.conclusion}`),
        };
      }
      return job;
    }),
  );
  await trimQueuedBatchOverflow();
  saveJobs();
  await syncBatchRecoveryAndFailureLogs();
  renderJobs();
  } finally {
    refreshInFlight = false;
  }
}

async function dispatchCandidateJob(draftJob) {
  upsertJob(draftJob);
  renderJobs();

  try {
    const runInfo = await dispatchWorkflow(draftJob);
    upsertJob({
      ...draftJob,
      runId: runInfo.runId,
      runUrl: runInfo.runUrl || "",
      jobsUrl: runInfo.jobsUrl || "",
      htmlUrl: runInfo.htmlUrl || "",
      progressPercent: 10,
      progressUpdatedAt: Date.now(),
      phase: "Workflow queued",
      etaSeconds: draftJob.etaSeconds,
      etaUpdatedAt: Date.now(),
    });
    renderJobs();
    return {
      ok: true,
      job: draftJob,
    };
  } catch (error) {
    const recoverable = isRecoverableDispatchError(error);
    upsertJob({
      ...draftJob,
      status: recoverable ? "queued" : "completed",
      conclusion: recoverable ? "" : "failure",
      progressPercent: recoverable ? Math.max(Number(draftJob.progressPercent) || 0, 4) : 0,
      progressUpdatedAt: Date.now(),
      phase: recoverable ? "Waiting for workflow run" : "Build failed",
      etaLabel: recoverable ? "Calculating..." : "Failed",
      etaSeconds: recoverable ? Math.max(Number(draftJob.etaSeconds) || 0, 0) : 0,
      etaUpdatedAt: Date.now(),
      error: recoverable ? "" : error.message,
      failedAt: recoverable ? 0 : Date.now(),
      lastServerUpdateAt: recoverable ? 0 : Date.now(),
      lastSyncAttemptAt: Date.now(),
      syncFailureCount: recoverable ? 1 : 0,
    });
    renderJobs();
    return {
      ok: recoverable,
      job: draftJob,
      error: error.message,
    };
  }
}

async function queueSourceBatch(rawInput, index, total, requestedCandidateCount = DEFAULT_TARGET_SUCCESSFUL_CANDIDATES) {
  const inputValue = String(rawInput || "").trim();
  const progressLabel = total > 1 ? `${index + 1} of ${total}` : "";
  const batchId = createRequestId();
  const batchSubmittedAt = nowIso();
  const desiredCandidateCount = Number.isFinite(Number(requestedCandidateCount))
    ? Math.min(
        Math.max(
          Math.round(Number(requestedCandidateCount) || DEFAULT_TARGET_SUCCESSFUL_CANDIDATES),
          MIN_TARGET_SUCCESSFUL_CANDIDATES,
        ),
        MAX_TARGET_SUCCESSFUL_CANDIDATES,
      )
    : DEFAULT_TARGET_SUCCESSFUL_CANDIDATES;
  const searchPoolLimit = searchPoolCountForDesiredCount(desiredCandidateCount);

  formMessage.textContent = progressLabel
    ? `Searching ${progressLabel}: ${inputValue}`
    : "Searching for the best hosted matches...";

  try {
    const resolvedCandidates = dedupeResolvedCandidates(
      await resolveSourceCandidates(inputValue, searchPoolLimit),
    ).slice(0, searchPoolLimit);
    if (!resolvedCandidates.length) {
      throw new Error(`No distinct candidates were found for ${inputValue}.`);
    }
    const desiredSuccessCount = Math.min(desiredCandidateCount, resolvedCandidates.length);

    updateBatchSelection(batchId, {
      batchId,
      batchLabel: inputValue,
      batchSubmittedAt,
      desiredSuccessCount,
      state: "pending",
      candidatePool: resolvedCandidates.map((candidate, poolIndex) => ({
        ...candidate,
        rank: Math.max(Number(candidate?.rank) || poolIndex + 1, poolIndex + 1),
      })),
    });

    const initialDispatchCount = Math.min(
      desiredSuccessCount,
      batchActiveTargetCount(batchId, 0),
    );
    const initialCandidates = resolvedCandidates.slice(0, initialDispatchCount);
    formMessage.textContent = `Queueing ${initialDispatchCount} of ${desiredSuccessCount} candidate${desiredSuccessCount === 1 ? "" : "s"} for ${inputValue}`;
    const draftJobs = initialCandidates.map((candidate) =>
      createBatchDraftJob(batchId, inputValue, batchSubmittedAt, candidate, resolvedCandidates.length),
    );
    const results = await Promise.all(draftJobs.map((draftJob) => dispatchCandidateJob(draftJob)));

    const queuedCount = results.filter((result) => result.ok).length;
    const failureCount = results.length - queuedCount;
    await syncBatchRecoveryAndFailureLogs();
    return {
      ok: queuedCount > 0,
      inputValue,
      batchId,
      candidateCount: desiredSuccessCount,
      successCount: queuedCount,
      failureCount,
      displayName: resolvedCandidates[0]?.displayName || inputValue,
      resolutionReason: resolvedCandidates[0]?.resolutionReason || "",
      error: queuedCount > 0 ? "" : (results.find((result) => !result.ok)?.error || "No workflows were queued."),
    };
  } catch (error) {
    upsertJob({
      requestId: createRequestId(),
      batchId,
      batchLabel: inputValue,
      batchSubmittedAt,
      candidateRank: 1,
      candidateTotal: 1,
      candidateReason: "",
      candidateConfidence: 0,
      owner: appConfig.owner,
      repo: appConfig.repo,
      ref: appConfig.ref,
      sourceInput: inputValue,
      sourceUrl: "",
      displayName: inputValue,
      sourceMode: "failed",
      matchedName: "",
      submittedAt: nowIso(),
      status: "completed",
      conclusion: "failure",
      progressPercent: 0,
      progressUpdatedAt: Date.now(),
      phase: "Build failed",
      etaLabel: "Failed",
      etaSeconds: 0,
      etaUpdatedAt: Date.now(),
      runId: "",
      runUrl: "",
      jobsUrl: "",
      htmlUrl: "",
      playPath: "",
      error: error.message,
      failedAt: Date.now(),
      lastServerUpdateAt: Date.now(),
      lastSyncAttemptAt: Date.now(),
      syncFailureCount: 0,
    });
    renderJobs();
    await syncBatchRecoveryAndFailureLogs();
    return {
      ok: false,
      inputValue,
      error: error.message,
    };
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  formMessage.textContent = "";
  setFormBusy(true);

  try {
    if (!workerConfigured(appConfig.workerUrl)) {
      throw new Error("Paste your Cloudflare Worker URL into site/config.js first.");
    }
    if (!appConfig.owner || !appConfig.repo) {
      await loadWorkerConfig();
    }
    if (!appConfig.owner || !appConfig.repo) {
      throw new Error("Cloudflare Worker config could not be loaded.");
    }

    const requestedSources = collectRequestedSources();
    const requestedCandidateCount = readRequestedCandidateCount();
    if (!requestedSources.length) {
      throw new Error("Enter at least one game URL or name.");
    }

    const successes = [];
    const failures = [];
    for (const [index, inputValue] of requestedSources.entries()) {
      const result = await queueSourceBatch(
        inputValue,
        index,
        requestedSources.length,
        requestedCandidateCount,
      );
      if (result.ok) {
        successes.push(result);
      } else {
        failures.push(result);
      }
    }

    if (!successes.length) {
      throw new Error(failures[0]?.error || "No workflows were queued.");
    }

    resetSourceInputs();
    if (successes.length === 1 && !failures.length) {
      const success = successes[0];
      const candidateText = `${success.successCount || success.candidateCount} of ${success.candidateCount} candidate${success.candidateCount === 1 ? "" : "s"}`;
      const failureText = success.failureCount ? ` ${success.failureCount} failed to queue.` : "";
      formMessage.textContent = success.resolutionReason
        ? `Queued ${candidateText} for ${success.displayName}.${failureText} ${success.resolutionReason}`.trim()
        : `Queued ${candidateText} for ${success.displayName}.${failureText}`.trim();
    } else {
      const totalCandidates = successes.reduce((sum, item) => sum + (item.candidateCount || 0), 0);
      const successText = `Queued ${totalCandidates} candidate build${totalCandidates === 1 ? "" : "s"} across ${successes.length} request${successes.length === 1 ? "" : "s"}.`;
      const failureText = failures.length
        ? ` Failed: ${failures
            .slice(0, 3)
            .map((item) => `${item.inputValue} (${item.error})`)
            .join("; ")}`
        : "";
      formMessage.textContent = `${successText}${failureText}`;
    }
    await refreshJobStatuses();
  } catch (error) {
    formMessage.textContent = error.message;
  } finally {
    setFormBusy(false);
  }
}

form.addEventListener("submit", handleSubmit);
bulkToggleButton?.addEventListener("click", () => {
  setBulkMode(!bulkModeEnabled());
});

async function init() {
  loadConfig();
  loadJobs();
  loadBatchSelections();
  loadJobHistory();
  await loadCatalog();
  await loadPublishedCatalog();
  await loadWorkerConfig();
  setBulkMode(false);
  renderJobs();
  await refreshJobStatuses();
  window.setInterval(refreshJobStatuses, STATUS_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshJobStatuses();
    }
  });
  window.addEventListener("focus", () => {
    void refreshJobStatuses();
  });
  window.setInterval(() => {
    if (jobs.some((job) => job.status !== "completed")) {
      renderJobs();
    }
  }, PROGRESS_RENDER_MS);
}

init();
