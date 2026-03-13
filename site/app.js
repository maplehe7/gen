const JOBS_KEY = "standalone-forge-pages-jobs";
const JOB_HISTORY_KEY = "standalone-forge-pages-job-history";
const JOB_STORAGE_VERSION = 2;
const WORKFLOW_FILE = "build-game.yml";
const DEFAULT_STEP_SECONDS = 55;
const PLACEHOLDER_WORKER_URL = "PASTE_CLOUDFLARE_WORKER_URL_HERE";
const STATUS_REFRESH_MS = 8000;
const PROGRESS_RENDER_MS = 400;
const MAX_HISTORY_SAMPLES = 20;
const MAX_RECORDED_RUNS = 40;
const MAX_STORED_JOBS = 20;
const ACTIVE_JOB_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const TERMINAL_JOB_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const FAILED_JOB_GRACE_MS = 30 * 1000;
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
const repoTarget = document.getElementById("repo-target");
const configWarning = document.getElementById("config-warning");
const submitButton = document.getElementById("submit-button");
const formMessage = document.getElementById("form-message");
const jobsContainer = document.getElementById("jobs");
const publishedContainer = document.getElementById("published-games");
const jobTemplate = document.getElementById("job-template");
const publishedTemplate = document.getElementById("published-template");

let catalogEntries = [];
let publishedCatalog = [];
let jobs = [];
let jobHistory = {
  stepDurations: {},
  totalDurations: [],
  recordedRunIds: [],
};
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

function createRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
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
    return job.conclusion === "success" ? "Completed" : "Stopped";
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
  return String(job?.status || "") === "completed" && String(job?.conclusion || "") && String(job?.conclusion || "") !== "success";
}

function jobRetentionMs(job) {
  return isTerminalJob(job) ? TERMINAL_JOB_RETENTION_MS : ACTIVE_JOB_RETENTION_MS;
}

function serializeJobForStorage(job) {
  return {
    requestId: stringValue(job.requestId),
    owner: stringValue(job.owner),
    repo: stringValue(job.repo),
    ref: stringValue(job.ref, "main"),
    sourceInput: stringValue(job.sourceInput),
    sourceUrl: stringValue(job.sourceUrl),
    displayName: stringValue(job.displayName, "game"),
    sourceMode: stringValue(job.sourceMode),
    matchedName: stringValue(job.matchedName),
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
    entryId: stringValue(job.entryId),
    error: stringValue(job.error),
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
  if (!normalized.sourceUrl) {
    return null;
  }
  if (isFailedJob(normalized) && Date.now() - timestampMs(normalized.failedAt || Date.now()) > FAILED_JOB_GRACE_MS) {
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

  return [...deduped.values()]
    .sort((left, right) => {
      const priorityDelta = jobSortPriority(left) - jobSortPriority(right);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return jobSortTimestamp(right) - jobSortTimestamp(left);
    })
    .slice(0, MAX_STORED_JOBS);
}

function formatStatus(status) {
  if (status === "completed") return "Complete";
  if (status === "error") return "Error";
  if (status === "in_progress") return "Running";
  if (status === "queued") return "Queued";
  return "Waiting";
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

  let progressPercent = 8;
  let phase = "Queued in GitHub Actions";

  if (status === "in_progress") {
    progressPercent = estimateProgressPercent(runPayload, jobsPayload);
    phase = activeStep?.name || lastCompletedStep?.name || "Starting runner";
  } else if (status === "completed") {
    progressPercent = conclusion === "success" ? 100 : Math.max(20, progressPercent);
    phase = conclusion === "success" ? "Published to GitHub Pages" : "Build failed";
  } else if (status === "queued") {
    progressPercent = estimateProgressPercent(runPayload, jobsPayload);
    phase = "Waiting for an available runner";
  }

  return {
    status,
    conclusion,
    progressPercent,
    phase,
    etaSeconds: estimateRemainingSeconds(runPayload, jobsPayload),
    etaLabel: status === "completed" ? "Completed" : formatDuration(estimateRemainingSeconds(runPayload, jobsPayload)),
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

async function searchForGameByName(query) {
  return fetchJson(workerEndpoint(`/search?query=${encodeURIComponent(String(query || "").trim())}`));
}

async function resolveSource(inputValue) {
  const trimmed = String(inputValue || "").trim();
  if (!trimmed) {
    throw new Error("Enter a game URL or a game name.");
  }

  const normalizedUrl = coerceInputToUrl(trimmed);
  if (normalizedUrl) {
    return {
      sourceUrl: normalizedUrl,
      displayName: deriveNameFromUrl(normalizedUrl),
      sourceMode: "url",
      matchedName: "",
      provider: "direct-url",
      confidence: 100,
      hostedOnline: true,
      resolutionReason: "",
    };
  }

  try {
    const result = await searchForGameByName(trimmed);
    return {
      sourceUrl: result?.sourceUrl || "",
      displayName: result?.displayName || trimmed,
      sourceMode: result?.sourceMode || "search",
      matchedName: result?.matchedName || result?.displayName || trimmed,
      provider: result?.provider || "search",
      confidence: Number(result?.confidence) || 0,
      hostedOnline: Boolean(result?.hostedOnline),
      resolutionReason: String(result?.reason || "").trim(),
    };
  } catch (searchError) {
    try {
      const catalogResolved = resolveCatalogSource(trimmed);
      return {
        ...catalogResolved,
        provider: "catalog",
        confidence: 80,
        hostedOnline: true,
        resolutionReason: "Used local game catalog fallback.",
      };
    } catch (_catalogError) {
      throw searchError;
    }
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
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
  const jobSourceUrl = normalizeUrl(job.sourceUrl || "");
  return publishedCatalog.find(
    (entry) =>
      String(entry.request_id || "") === String(job.requestId || "") ||
      normalizeUrl(entry.source_url || "") === jobSourceUrl,
  );
}

async function dispatchWorkflow(job) {
  return fetchJson(workerEndpoint("/dispatch"), {
    method: "POST",
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

function renderActions(job, actionsRoot) {
  if (!actionsRoot) {
    return;
  }
  actionsRoot.innerHTML = "";

  if (job.playPath || (job.status === "completed" && job.conclusion === "success")) {
    const galleryLink = document.createElement("a");
    galleryLink.className = "job-link";
    galleryLink.href = galleryUrlForEntry(job.entryId || "");
    galleryLink.textContent = "Open gallery";
    actionsRoot.append(galleryLink);
  }
}

function renderJobs() {
  if (!jobsContainer || !jobTemplate) {
    return;
  }
  jobsContainer.innerHTML = "";

  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No workflow requests yet.";
    jobsContainer.append(empty);
    return;
  }

  jobs.forEach((job) => {
    const nowMs = Date.now();
    const progressPercent = visibleProgressPercent(job);
    const roundedProgress = Math.round(progressPercent);
    const fragment = jobTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".job-card");
    const status = fragment.querySelector(".job-status");
    const title = fragment.querySelector(".job-title");
    const percent = fragment.querySelector(".job-percent");
    const fill = fragment.querySelector(".meter-fill");
    const phase = fragment.querySelector(".job-phase");
    const eta = fragment.querySelector(".job-eta");
    const error = fragment.querySelector(".job-error");
    const actions = fragment.querySelector(".job-actions");

    card.classList.toggle("is-completed", job.status === "completed" && job.conclusion === "success");
    card.classList.toggle("is-error", isFailedJob(job));

    status.textContent = formatStatus(job.status);
    title.textContent = job.displayName;
    percent.textContent = `${roundedProgress}%`;
    fill.style.width = `${progressPercent.toFixed(1)}%`;
    phase.textContent = job.phase || "Queued";
    eta.textContent = visibleEtaLabel(job, nowMs);
    error.textContent = job.error || "";
    renderActions(job, actions);

    jobsContainer.append(fragment);
  });
}

function renderPublished() {
  if (!publishedContainer || !publishedTemplate) {
    return;
  }
  publishedContainer.innerHTML = "";

  if (!publishedCatalog.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No published games yet.";
    publishedContainer.append(empty);
    return;
  }

  publishedCatalog.forEach((entry) => {
    const fragment = publishedTemplate.content.cloneNode(true);
    fragment.querySelector(".job-title").textContent = entry.title || entry.id || "Untitled";
    fragment.querySelector(".job-source").textContent = entry.source_url || "";
    fragment.querySelector(".job-folder").textContent = entry.folder || "";
    fragment.querySelector(".job-built").textContent = formatDate(entry.generated_at);

    const actions = fragment.querySelector(".job-actions");

    const playLink = document.createElement("a");
    playLink.className = "job-link";
    playLink.href = playUrlForPath(entry.play_path || entry.folder || "");
    playLink.target = "_blank";
    playLink.rel = "noreferrer";
    playLink.textContent = "Open game";
    actions.append(playLink);

    publishedContainer.append(fragment);
  });
}

async function refreshJobStatuses() {
  if (!jobs.length || !workerConfigured(appConfig.workerUrl)) {
    renderJobs();
    return;
  }

  await loadPublishedCatalog();

  const refreshed = await Promise.all(
    jobs.map(async (job) => {
      if (!job.runId) {
        return job;
      }

      try {
        const payload = await getRunStatus(job.runId);
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
          playPath: entry?.play_path || job.playPath || "",
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
        return {
          ...job,
          lastSyncAttemptAt: Date.now(),
          syncFailureCount: Math.max(Number(job.syncFailureCount) || 0, 0) + 1,
          error: error.message,
        };
      }
    }),
  );

  jobs = refreshed;
  saveJobs();
  renderJobs();
  renderPublished();
}

async function handleSubmit(event) {
  event.preventDefault();
  formMessage.textContent = "";
  submitButton.disabled = true;
  let pendingRequestId = "";

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

    formMessage.textContent = "Searching for the best hosted match...";
    const resolved = await resolveSource(sourceInput.value);
    const displayName = resolved.displayName;
    const requestId = createRequestId();
    pendingRequestId = requestId;
    const draftJob = {
      requestId,
      owner: appConfig.owner,
      repo: appConfig.repo,
      ref: appConfig.ref,
      sourceInput: sourceInput.value.trim(),
      sourceUrl: resolved.sourceUrl,
      displayName,
      sourceMode: resolved.sourceMode,
      matchedName: resolved.matchedName,
      submittedAt: nowIso(),
      status: "queued",
      conclusion: "",
      progressPercent: 6,
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
      error: "",
    };

    upsertJob(draftJob);
    renderJobs();

    if (resolved.resolutionReason) {
      formMessage.textContent = `Matched ${displayName}: ${resolved.resolutionReason}`;
    }

    const runInfo = await dispatchWorkflow(draftJob);
    const nextJob = {
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
    };

    upsertJob(nextJob);
    renderJobs();

    sourceInput.value = "";
    formMessage.textContent = resolved.resolutionReason
      ? `Workflow started for ${displayName}. ${resolved.resolutionReason}`
      : `Workflow started for ${displayName}`;
    await refreshJobStatuses();
  } catch (error) {
    if (pendingRequestId) {
      jobs = jobs.filter((job) => String(job.requestId || "").trim() !== pendingRequestId);
      saveJobs();
      renderJobs();
    }
    formMessage.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
}

form.addEventListener("submit", handleSubmit);

async function init() {
  loadConfig();
  loadJobs();
  loadJobHistory();
  await loadCatalog();
  await loadPublishedCatalog();
  await loadWorkerConfig();
  renderJobs();
  renderPublished();
  await refreshJobStatuses();
  window.setInterval(refreshJobStatuses, STATUS_REFRESH_MS);
  window.setInterval(() => {
    if (jobs.some((job) => job.status !== "completed")) {
      renderJobs();
    }
  }, PROGRESS_RENDER_MS);
}

init();
