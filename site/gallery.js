const PLACEHOLDER_WORKER_URL = "PASTE_CLOUDFLARE_WORKER_URL_HERE";
const ADMIN_KEY = "standalone-forge-admin";
const PENDING_DELETES_KEY = "standalone-forge-pending-deletes";
const PENDING_DELETE_TTL_MS = 24 * 60 * 60 * 1000;
const galleryContainer = document.getElementById("gallery");
const galleryTemplate = document.getElementById("gallery-template");
const adminToggle = document.getElementById("admin-toggle");
const adminPanel = document.getElementById("admin-panel");
const adminCodeInput = document.getElementById("admin-code");
const workerUrl = String(window.STANDALONE_FORGE_CONFIG?.workerUrl || "").trim().replace(/\/+$/, "");
let galleryEntries = [];

function normalizeValue(value) {
  return String(value || "").trim();
}

function entryDeleteKey(entry) {
  return (
    normalizeValue(entry?.id) ||
    normalizeValue(entry?.play_path) ||
    normalizeValue(entry?.folder) ||
    normalizeValue(entry?.source_url)
  );
}

function loadPendingDeletes() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PENDING_DELETES_KEY) || "{}");
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch (_error) {
    return {};
  }
}

function savePendingDeletes(pendingDeletes) {
  window.localStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(pendingDeletes || {}));
}

function prunePendingDeletes(rawGames, pendingDeletes) {
  const activeGames = Array.isArray(rawGames) ? rawGames : [];
  const nextDeletes = {};
  const liveKeys = new Set(activeGames.map((entry) => entryDeleteKey(entry)).filter(Boolean));
  const now = Date.now();

  Object.entries(pendingDeletes || {}).forEach(([key, timestamp]) => {
    const ageMs = now - Number(timestamp || 0);
    if (!key || ageMs > PENDING_DELETE_TTL_MS) {
      return;
    }
    if (!liveKeys.has(key)) {
      return;
    }
    nextDeletes[key] = Number(timestamp || now);
  });

  return nextDeletes;
}

function hidePendingDeletedEntries(rawGames) {
  const pendingDeletes = prunePendingDeletes(rawGames, loadPendingDeletes());
  savePendingDeletes(pendingDeletes);
  return (Array.isArray(rawGames) ? rawGames : []).filter((entry) => !pendingDeletes[entryDeleteKey(entry)]);
}

function rememberPendingDelete(entry) {
  const key = entryDeleteKey(entry);
  if (!key) {
    return;
  }
  const pendingDeletes = loadPendingDeletes();
  pendingDeletes[key] = Date.now();
  savePendingDeletes(pendingDeletes);
}

function forgetPendingDelete(entry) {
  const key = entryDeleteKey(entry);
  if (!key) {
    return;
  }
  const pendingDeletes = loadPendingDeletes();
  if (!pendingDeletes[key]) {
    return;
  }
  delete pendingDeletes[key];
  savePendingDeletes(pendingDeletes);
}

function playUrlForPath(playPath) {
  const url = new URL(playPath, window.location.href);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function thumbnailUrlForPath(thumbnailPath) {
  return new URL(thumbnailPath, window.location.href).toString();
}

function workerConfigured() {
  return Boolean(workerUrl && workerUrl !== PLACEHOLDER_WORKER_URL);
}

function adminEnabled() {
  return window.localStorage.getItem(ADMIN_KEY) === "true";
}

function setAdminEnabled(enabled) {
  window.localStorage.setItem(ADMIN_KEY, enabled ? "true" : "false");
}

function setAdminPanelVisible(visible) {
  if (!adminPanel) {
    return;
  }
  adminPanel.hidden = !visible;
  if (visible) {
    adminCodeInput?.focus();
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `Request failed with status ${response.status}`);
  }
  return payload;
}

async function fetchPublishedGames() {
  const payload = await fetchJson(`./published_games.json?ts=${Date.now()}`);
  const games = hidePendingDeletedEntries(Array.isArray(payload?.games) ? payload.games : []);
  return games.sort((left, right) => {
    const leftTime = Date.parse(String(left?.generated_at || "")) || 0;
    const rightTime = Date.parse(String(right?.generated_at || "")) || 0;
    return rightTime - leftTime;
  });
}

function scrollToSelectedCard() {
  const entryId = decodeURIComponent(window.location.hash.replace(/^#/, "").trim());
  if (!entryId) {
    return;
  }
  const card = document.getElementById(`game-${entryId}`);
  if (!card) {
    return;
  }
  card.classList.add("is-selected");
  card.scrollIntoView({ block: "center" });
}

async function reportGame(entry, button) {
  if (!workerConfigured()) {
    throw new Error("Worker URL is not configured.");
  }

  button.disabled = true;
  button.textContent = "Reporting...";

  try {
    await fetchJson(`${workerUrl}/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entryId: entry.id || "",
        title: entry.title || entry.id || "",
        playPath: entry.play_path || entry.folder || "",
        sourceUrl: entry.source_url || "",
      }),
    });
    button.textContent = "Reported";
  } catch (error) {
    button.disabled = false;
    button.textContent = "Report Not Working";
    window.alert(error.message);
  }
}

async function deleteGame(entry, button) {
  if (!workerConfigured()) {
    throw new Error("Worker URL is not configured.");
  }

  button.disabled = true;
  button.textContent = "Deleting...";

  try {
    await fetchJson(`${workerUrl}/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entryId: entry.id || "",
        requestId: `${entry.id || "delete"}-${Date.now()}`,
      }),
    });
    rememberPendingDelete(entry);
    galleryEntries = galleryEntries.filter((item) => entryDeleteKey(item) !== entryDeleteKey(entry));
    renderGallery(galleryEntries);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Delete";
    window.alert(error.message);
  }
}

function renderGallery(entries) {
  if (!galleryContainer || !galleryTemplate) {
    return;
  }

  galleryEntries = Array.isArray(entries) ? [...entries] : [];
  galleryContainer.innerHTML = "";
  if (!galleryEntries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No generated games yet.";
    galleryContainer.append(empty);
    return;
  }

  galleryEntries.forEach((entry) => {
    const fragment = galleryTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".gallery-card");
    const link = fragment.querySelector(".gallery-link");
    const thumb = fragment.querySelector(".gallery-thumb");
    const title = fragment.querySelector(".gallery-title");
    const reportButton = fragment.querySelector(".report-button");
    const deleteButton = fragment.querySelector(".delete-button");

    card.id = `game-${entry.id || ""}`;
    link.href = playUrlForPath(entry.play_path || entry.folder || "");
    title.textContent = entry.title || entry.id || "Untitled";
    thumb.alt = title.textContent;
    thumb.src = entry.thumbnail_path
      ? thumbnailUrlForPath(entry.thumbnail_path)
      : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 360'%3E%3Crect width='640' height='360' fill='%23e9e9e9'/%3E%3C/svg%3E";

    reportButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      reportGame(entry, reportButton);
    });

    if (deleteButton) {
      deleteButton.hidden = !adminEnabled();
      deleteButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        deleteGame(entry, deleteButton);
      });
    }

    galleryContainer.append(fragment);
  });

  scrollToSelectedCard();
}

function handleAdminSubmit(event) {
  event.preventDefault();
  const code = String(adminCodeInput?.value || "").trim().toLowerCase();
  if (code !== "admin") {
    window.alert("Wrong admin code.");
    return;
  }
  setAdminEnabled(true);
  if (adminCodeInput) {
    adminCodeInput.value = "";
  }
  setAdminPanelVisible(false);
  renderGallery(galleryEntries);
}

async function initGallery() {
  setAdminPanelVisible(false);
  adminToggle?.addEventListener("click", () => {
    setAdminPanelVisible(adminPanel?.hidden ?? true);
  });
  adminPanel?.addEventListener("submit", handleAdminSubmit);

  try {
    const entries = await fetchPublishedGames();
    entries.forEach((entry) => forgetPendingDelete(entry));
    renderGallery(entries);
  } catch (_error) {
    renderGallery([]);
  }
}

initGallery();
