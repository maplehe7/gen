const JOBS_KEY = "standalone-forge-pages-jobs";
const WORKFLOW_FILE = "build-game.yml";
const DEFAULT_STEP_SECONDS = 55;
const PLACEHOLDER_WORKER_URL = "PASTE_CLOUDFLARE_WORKER_URL_HERE";
const STATUS_REFRESH_MS = 8000;
const PROGRESS_RENDER_MS = 400;

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
    jobs = JSON.parse(window.localStorage.getItem(JOBS_KEY) || "[]");
  } catch (_error) {
    jobs = [];
  }
}

function saveJobs() {
  window.localStorage.setItem(JOBS_KEY, JSON.stringify(jobs));
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

function estimateFromSteps(steps, status) {
  if (status === "completed") {
    return "Completed";
  }

  const completedSteps = steps.filter((step) => step.status === "completed");
  const durations = completedSteps
    .map((step) => {
      if (!step.started_at || !step.completed_at) return null;
      const start = Date.parse(step.started_at);
      const end = Date.parse(step.completed_at);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      return Math.max((end - start) / 1000, 1);
    })
    .filter(Boolean);

  const averageStepSeconds = durations.length
    ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
    : DEFAULT_STEP_SECONDS;

  const remainingSteps = Math.max(steps.length - completedSteps.length, status === "queued" ? 5 : 1);
  return formatDuration(averageStepSeconds * remainingSteps);
}

function progressFromRun(runPayload, jobsPayload) {
  const status = String(runPayload?.status || "queued");
  const conclusion = String(runPayload?.conclusion || "");
  const steps = actionableStepsFromJobs(jobsPayload);
  const completedSteps = steps.filter((step) => step.status === "completed").length;
  const activeStep = steps.find((step) => step.status === "in_progress");
  const lastCompletedStep = [...steps].reverse().find((step) => step.status === "completed");

  let progressPercent = 8;
  let phase = "Queued in GitHub Actions";

  if (status === "in_progress") {
    progressPercent = steps.length
      ? Math.max(12, Math.min(96, Math.round(10 + (completedSteps / steps.length) * 85)))
      : 40;
    phase = activeStep?.name || lastCompletedStep?.name || "Starting runner";
  } else if (status === "completed") {
    progressPercent = conclusion === "success" ? 100 : Math.max(20, progressPercent);
    phase = conclusion === "success" ? "Published to GitHub Pages" : "Build failed";
  } else if (status === "queued") {
    progressPercent = 8;
    phase = "Waiting for an available runner";
  }

  return {
    status,
    conclusion,
    progressPercent,
    phase,
    etaLabel: estimateFromSteps(steps, status === "completed" ? "completed" : status),
  };
}

function resolveSource(inputValue) {
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
    publishedCatalog = Array.isArray(payload?.games) ? payload.games : [];
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

function publishedEntryForJob(job) {
  return publishedCatalog.find(
    (entry) =>
      String(entry.request_id || "") === String(job.requestId || "") ||
      String(entry.source_url || "") === String(job.sourceUrl || ""),
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
  const index = jobs.findIndex((job) => job.requestId === nextJob.requestId);
  if (index >= 0) {
    jobs[index] = nextJob;
  } else {
    jobs.unshift(nextJob);
  }
  jobs = jobs.slice(0, 12);
  saveJobs();
}

function renderActions(job, actionsRoot) {
  actionsRoot.innerHTML = "";

  if (job.playPath) {
    const playLink = document.createElement("a");
    playLink.className = "job-link";
    playLink.href = playUrlForPath(job.playPath);
    playLink.target = "_blank";
    playLink.rel = "noreferrer";
    playLink.textContent = "Play build";
    actionsRoot.append(playLink);
  }

  if (job.htmlUrl) {
    const workflowLink = document.createElement("a");
    workflowLink.className = "job-link secondary";
    workflowLink.href = job.htmlUrl;
    workflowLink.target = "_blank";
    workflowLink.rel = "noreferrer";
    workflowLink.textContent = "Open workflow";
    actionsRoot.append(workflowLink);
  }
}

function renderJobs() {
  jobsContainer.innerHTML = "";

  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No workflow requests yet.";
    jobsContainer.append(empty);
    return;
  }

  jobs.forEach((job) => {
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
    const source = fragment.querySelector(".job-source");
    const request = fragment.querySelector(".job-request");
    const repo = fragment.querySelector(".job-repo");
    const error = fragment.querySelector(".job-error");
    const actions = fragment.querySelector(".job-actions");

    card.classList.toggle("is-completed", job.status === "completed" && job.conclusion === "success");
    card.classList.toggle("is-error", job.status === "completed" && job.conclusion && job.conclusion !== "success");

    status.textContent = formatStatus(job.status);
    title.textContent = job.displayName;
    percent.textContent = `${roundedProgress}%`;
    fill.style.width = `${progressPercent.toFixed(1)}%`;
    phase.textContent = job.phase || "Queued";
    eta.textContent =
      job.status === "completed" && job.conclusion === "success" ? "Completed" : job.etaLabel;
    source.textContent = job.sourceUrl;
    request.textContent = job.requestId;
    repo.textContent = `${job.owner}/${job.repo}@${job.ref}`;
    error.textContent = job.error || "";
    renderActions(job, actions);

    jobsContainer.append(fragment);
  });
}

function renderPublished() {
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
    playLink.textContent = "Play build";
    actions.append(playLink);

    if (entry.source_url) {
      const sourceLink = document.createElement("a");
      sourceLink.className = "job-link secondary";
      sourceLink.href = entry.source_url;
      sourceLink.target = "_blank";
      sourceLink.rel = "noreferrer";
      sourceLink.textContent = "Open source";
      actions.append(sourceLink);
    }

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
          etaLabel: derived.etaLabel,
          playPath: entry?.play_path || job.playPath || "",
          error:
            derived.conclusion && derived.conclusion !== "success"
              ? `Workflow finished with conclusion: ${derived.conclusion}`
              : "",
        };
      } catch (error) {
        return {
          ...job,
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

    const resolved = resolveSource(sourceInput.value);
    const displayName = resolved.displayName;
    const requestId = createRequestId();
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
      runId: "",
      runUrl: "",
      jobsUrl: "",
      htmlUrl: "",
      playPath: "",
      error: "",
    };

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
    };

    upsertJob(nextJob);
    renderJobs();

    sourceInput.value = "";
    formMessage.textContent = `Workflow started for ${displayName}`;
    await refreshJobStatuses();
  } catch (error) {
    formMessage.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
}

form.addEventListener("submit", handleSubmit);

async function init() {
  loadConfig();
  loadJobs();
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
