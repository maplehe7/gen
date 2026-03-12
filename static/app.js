const form = document.getElementById("export-form");
const sourceInput = document.getElementById("source");
const outputNameInput = document.getElementById("outputName");
const submitButton = document.getElementById("submit-button");
const formMessage = document.getElementById("form-message");
const jobsContainer = document.getElementById("jobs");
const jobTemplate = document.getElementById("job-template");

function formatStatus(status) {
  if (status === "completed") return "Complete";
  if (status === "error") return "Error";
  if (status === "running") return "Running";
  return "Queued";
}

function formatSource(job) {
  if (job.source_mode === "catalog" && job.matched_name) {
    return `${job.matched_name} -> ${job.source_url}`;
  }
  return job.source_url || job.source_input;
}

function renderActions(job, actionsRoot) {
  actionsRoot.innerHTML = "";

  if (job.play_url) {
    const playLink = document.createElement("a");
    playLink.className = "job-link";
    playLink.href = job.play_url;
    playLink.target = "_blank";
    playLink.rel = "noreferrer";
    playLink.textContent = "Play build";
    actionsRoot.append(playLink);
  }

  if (job.output_dir) {
    const folderButton = document.createElement("button");
    folderButton.className = "job-link secondary";
    folderButton.type = "button";
    folderButton.textContent = "Copy folder path";
    folderButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(job.output_dir);
        folderButton.textContent = "Copied";
        window.setTimeout(() => {
          folderButton.textContent = "Copy folder path";
        }, 1200);
      } catch (_error) {
        folderButton.textContent = "Clipboard blocked";
      }
    });
    actionsRoot.append(folderButton);
  }
}

function renderJob(job) {
  const fragment = jobTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".job-card");
  const status = fragment.querySelector(".job-status");
  const title = fragment.querySelector(".job-title");
  const percent = fragment.querySelector(".job-percent");
  const fill = fragment.querySelector(".meter-fill");
  const phase = fragment.querySelector(".job-phase");
  const eta = fragment.querySelector(".job-eta");
  const source = fragment.querySelector(".job-source");
  const folder = fragment.querySelector(".job-folder");
  const buildDir = fragment.querySelector(".job-builddir");
  const error = fragment.querySelector(".job-error");
  const logs = fragment.querySelector(".job-log-output");
  const actions = fragment.querySelector(".job-actions");

  card.classList.toggle("is-completed", job.status === "completed");
  card.classList.toggle("is-error", job.status === "error");

  status.textContent = formatStatus(job.status);
  title.textContent = job.output_name;
  percent.textContent = `${job.progress_percent}%`;
  fill.style.width = `${Math.min(Math.max(job.progress_percent, 0), 100)}%`;
  phase.textContent = job.phase || "Queued";
  eta.textContent = job.status === "completed" ? "Completed" : job.eta_label;
  source.textContent = formatSource(job);
  folder.textContent = job.output_dir;
  buildDir.textContent = job.build_dir;
  error.textContent = job.error || "";
  logs.textContent = (job.logs || []).join("\n");

  renderActions(job, actions);
  return fragment;
}

function renderJobs(jobs) {
  jobsContainer.innerHTML = "";

  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No builds yet. Start one above.";
    jobsContainer.append(empty);
    return;
  }

  jobs.forEach((job) => {
    jobsContainer.append(renderJob(job));
  });
}

async function refreshJobs() {
  try {
    const response = await fetch("/api/jobs", { cache: "no-store" });
    const payload = await response.json();
    renderJobs(payload.jobs || []);
  } catch (_error) {
    formMessage.textContent = "Could not refresh job status.";
  }
}

async function submitJob(event) {
  event.preventDefault();
  formMessage.textContent = "";
  submitButton.disabled = true;

  try {
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: sourceInput.value,
        outputName: outputNameInput.value,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Build request failed.");
    }

    sourceInput.value = "";
    outputNameInput.value = "";
    formMessage.textContent = `Build queued: ${payload.output_name}`;
    await refreshJobs();
  } catch (error) {
    formMessage.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
}

form.addEventListener("submit", submitJob);
refreshJobs();
window.setInterval(refreshJobs, 1500);
