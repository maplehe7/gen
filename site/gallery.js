const PLACEHOLDER_WORKER_URL = "PASTE_CLOUDFLARE_WORKER_URL_HERE";
const galleryContainer = document.getElementById("gallery");
const galleryTemplate = document.getElementById("gallery-template");
const workerUrl = String(window.STANDALONE_FORGE_CONFIG?.workerUrl || "").trim().replace(/\/+$/, "");

function playUrlForPath(playPath) {
  return new URL(playPath, window.location.href).toString();
}

function thumbnailUrlForPath(thumbnailPath) {
  return new URL(thumbnailPath, window.location.href).toString();
}

function workerConfigured() {
  return Boolean(workerUrl && workerUrl !== PLACEHOLDER_WORKER_URL);
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
  const games = Array.isArray(payload?.games) ? payload.games : [];
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

function renderGallery(entries) {
  if (!galleryContainer || !galleryTemplate) {
    return;
  }

  galleryContainer.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No generated games yet.";
    galleryContainer.append(empty);
    return;
  }

  entries.forEach((entry) => {
    const fragment = galleryTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".gallery-card");
    const link = fragment.querySelector(".gallery-link");
    const thumb = fragment.querySelector(".gallery-thumb");
    const title = fragment.querySelector(".gallery-title");
    const reportButton = fragment.querySelector(".report-button");

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

    galleryContainer.append(fragment);
  });

  scrollToSelectedCard();
}

async function initGallery() {
  try {
    renderGallery(await fetchPublishedGames());
  } catch (_error) {
    renderGallery([]);
  }
}

initGallery();
