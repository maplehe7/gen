const galleryContainer = document.getElementById("gallery");
const galleryTemplate = document.getElementById("gallery-template");

function formatDate(value) {
  if (!value) {
    return "Unknown";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function playUrlForPath(playPath) {
  return new URL(playPath, window.location.href).toString();
}

async function fetchPublishedGames() {
  const response = await fetch(`./published_games.json?ts=${Date.now()}`);
  const payload = await response.json().catch(() => ({}));
  return Array.isArray(payload?.games) ? payload.games : [];
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
    fragment.querySelector(".job-title").textContent = entry.title || entry.id || "Untitled";
    fragment.querySelector(".gallery-source").textContent = entry.source_url || "";
    fragment.querySelector(".gallery-meta").textContent = formatDate(entry.generated_at);

    const actions = fragment.querySelector(".job-actions");
    const openLink = document.createElement("a");
    openLink.className = "job-link";
    openLink.href = playUrlForPath(entry.play_path || entry.folder || "");
    openLink.target = "_blank";
    openLink.rel = "noreferrer";
    openLink.textContent = "Open game";
    actions.append(openLink);

    galleryContainer.append(fragment);
  });
}

async function initGallery() {
  try {
    renderGallery(await fetchPublishedGames());
  } catch (_error) {
    renderGallery([]);
  }
}

initGallery();
