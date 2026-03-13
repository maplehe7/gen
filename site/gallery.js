const galleryContainer = document.getElementById("gallery");
const galleryTemplate = document.getElementById("gallery-template");

function playUrlForPath(playPath) {
  return new URL(playPath, window.location.href).toString();
}

function thumbnailUrlForPath(thumbnailPath) {
  return new URL(thumbnailPath, window.location.href).toString();
}

async function fetchPublishedGames() {
  const response = await fetch(`./published_games.json?ts=${Date.now()}`);
  const payload = await response.json().catch(() => ({}));
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

    card.id = `game-${entry.id || ""}`;
    link.href = playUrlForPath(entry.play_path || entry.folder || "");
    title.textContent = entry.title || entry.id || "Untitled";
    thumb.alt = title.textContent;
    thumb.src = entry.thumbnail_path
      ? thumbnailUrlForPath(entry.thumbnail_path)
      : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 360'%3E%3Crect width='640' height='360' fill='%23e9e9e9'/%3E%3C/svg%3E";

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
