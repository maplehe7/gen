const JOBS_KEY = "standalone-forge-pages-jobs";
const WORKFLOW_FILE = "build-game.yml";
const DEFAULT_STEP_SECONDS = 55;
const PLACEHOLDER_TOKEN = "PASTE_FINE_GRAINED_PAT_HERE";

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
  owner: "",
  repo: "",
  ref: "main",
  token: "",
};

function nowIso() {
  return new Date().toISOString();
}

function inferRepoContext() {
  const host = window.location.hostname;
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  if (!host.endsWith(".github.io")) {
    return { owner: "", repo: "" };
  }

  const owner = host.split(".")[0] || "";
  if (!pathParts.length) {
    return { owner, repo: `${owner}.github.io` };
  }
  return { owner, repo: pathParts[0] };
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "game";
}

function looksLikeUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
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

function tokenConfigured(token) {
  return Boolean(token && token.trim() && token.trim() !== PLACEHOLDER_TOKEN);
}

function loadConfig() {
  const inferred = inferRepoContext();
  const configured = window.STANDALONE_FORGE_CONFIG || {};
  appConfig = {
    owner: String(configured.owner || inferred.owner || "").trim(),
    repo: String(configured.repo || inferred.repo || "").trim(),
    ref: String(configured.ref || "main").trim() || "main",
    token: String(configured.token || "").trim(),
  };

  if (repoTarget) {
    repoTarget.textContent =
      appConfig.owner && appConfig.repo
        ? `${appConfig.owner}/${appConfig.repo}@${appConfig.ref}`
        : "Missing owner/repo in site/config.js";
  }

  if (configWarning) {
    if (!appConfig.owner || !appConfig.repo) {
      configWarning.textContent =
        "Set owner and repo in site/config.js, or leave them blank only if this Pages URL can be auto-detected.";
    } else if (!tokenConfigured(appConfig.token)) {
      configWarning.textContent =
        "Paste your fine-grained PAT into site/config.js before using the demo.";
    } else {
      configWarning.textContent = "Config loaded. This demo will dispatch builds into the configured repo automatically.";
    }
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

  if (looksLikeUrl(trimmed)) {
    return {
      sourceUrl: trimmed,
      displayName: deriveNameFromUrl(trimmed),
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

  throw new Error("Name mode only works for entries listed in game_catalog.json.");
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
      `GitHub API request failed with status ${response.status}`;
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

async function findDispatchedRun(job, token) {
  const listUrl =
    `https://api.github.com/repos/${encodeURIComponent(job.owner)}/` +
    `${encodeURIComponent(job.repo)}/actions/workflows/${encodeURIComponent(WORKFLOW_FILE)}/runs` +
    `?event=workflow_dispatch&branch=${encodeURIComponent(job.ref)}&per_page=10`;

  const payload = await fetchJson(listUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  const submittedAt = Date.parse(job.submittedAt || nowIso());
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  const match = runs.find((run) => {
    const createdAt = Date.parse(run.created_at || "");
    return Number.isFinite(createdAt) && createdAt >= submittedAt - 120000;
  });

  if (!match) {
    throw new Error("The workflow was dispatched, but no matching run was found yet.");
  }

  return {
    runId: match.id,
    runUrl: match.url,
    htmlUrl: match.html_url,
    jobsUrl: match.jobs_url,
  };
}

async function dispatchWorkflow(job, token) {
  const dispatchUrl =
    `https://api.github.com/repos/${encodeURIComponent(job.owner)}/` +
    `${encodeURIComponent(job.repo)}/actions/workflows/${encodeURIComponent(WORKFLOW_FILE)}/dispatches?return_run_details=true`;

  const payload = await fetchJson(dispatchUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: job.ref,
      inputs: {
        source_url: job.sourceUrl,
        display_name: job.displayName,
        request_id: job.requestId,
      },
    }),
  });

  if (payload?.id || payload?.run_id) {
    return {
      runId: payload.id || payload.run_id,
      runUrl: payload.url || "",
      htmlUrl: payload.html_url || "",
      jobsUrl: payload.jobs_url || "",
    };
  }

  return findDispatchedRun(job, token);
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
    percent.textContent = `${job.progressPercent}%`;
    fill.style.width = `${Math.min(Math.max(job.progressPercent || 0, 0), 100)}%`;
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
  const token = appConfig.token;
  if (!jobs.length || !token) {
    renderJobs();
    return;
  }

  await loadPublishedCatalog();

  const refreshed = await Promise.all(
    jobs.map(async (job) => {
      if (!job.runId && !job.runUrl) {
        return job;
      }

      try {
        const runPayload = await fetchJson(
          job.runUrl ||
            `https://api.github.com/repos/${encodeURIComponent(job.owner)}/${encodeURIComponent(job.repo)}/actions/runs/${job.runId}`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${token}`,
              "X-GitHub-Api-Version": "2022-11-28",
            },
          },
        );

        const jobsPayload = runPayload.jobs_url
          ? await fetchJson(runPayload.jobs_url, {
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
              },
            })
          : { jobs: [] };

        const derived = progressFromRun(runPayload, jobsPayload);
        const entry = derived.conclusion === "success" ? publishedEntryForJob(job) : null;

        return {
          ...job,
          runId: runPayload.id || job.runId,
          runUrl: runPayload.url || job.runUrl,
          htmlUrl: runPayload.html_url || job.htmlUrl,
          jobsUrl: runPayload.jobs_url || job.jobsUrl,
          status: derived.status,
          conclusion: derived.conclusion,
          progressPercent: derived.progressPercent,
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
    const owner = appConfig.owner;
    const repo = appConfig.repo;
    const ref = appConfig.ref || "main";
    const token = appConfig.token;

    if (!owner || !repo) {
      throw new Error("Set owner and repo in site/config.js first.");
    }
    if (!tokenConfigured(token)) {
      throw new Error("Paste a fine-grained GitHub token into site/config.js first.");
    }

    const resolved = resolveSource(sourceInput.value);
    const displayName = resolved.displayName;
    const requestId = createRequestId();
    const draftJob = {
      requestId,
      owner,
      repo,
      ref,
      sourceInput: sourceInput.value.trim(),
      sourceUrl: resolved.sourceUrl,
      displayName,
      sourceMode: resolved.sourceMode,
      matchedName: resolved.matchedName,
      submittedAt: nowIso(),
      status: "queued",
      conclusion: "",
      progressPercent: 6,
      phase: "Dispatching workflow",
      etaLabel: "Calculating...",
      runId: "",
      runUrl: "",
      jobsUrl: "",
      htmlUrl: "",
      playPath: "",
      error: "",
    };

    const runInfo = await dispatchWorkflow(draftJob, token);
    const nextJob = {
      ...draftJob,
      runId: runInfo.runId,
      runUrl: runInfo.runUrl,
      jobsUrl: runInfo.jobsUrl,
      htmlUrl: runInfo.htmlUrl,
      progressPercent: 10,
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
  renderJobs();
  renderPublished();
  await refreshJobStatuses();
  window.setInterval(refreshJobStatuses, 8000);
}

init();
