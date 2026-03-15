export function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function hostFromUrl(value) {
  try {
    return new URL(String(value || "")).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (_error) {
    return "";
  }
}

export function buildCandidateBadges(candidate) {
  const badges = [];
  const buildDisposition = String(candidate?.buildDisposition || "unknown").trim();
  const historyStatus = String(candidate?.historyStatus || "unknown").trim();
  const provider = String(candidate?.provider || candidate?.sourceMode || "").trim();

  if (buildDisposition === "allow_build") {
    badges.push({ label: "Buildable", tone: "good" });
  } else if (buildDisposition === "reject_search") {
    badges.push({ label: "Filtered", tone: "danger" });
  }

  if (historyStatus === "known_failed") {
    badges.push({ label: "Known failed", tone: "danger" });
  } else if (historyStatus === "known_cancelled") {
    badges.push({ label: "Known cancelled", tone: "warn" });
  }

  if (provider) {
    const label =
      provider === "override"
        ? "Verified seed"
        : provider === "drive-site"
          ? "Google Sites"
          : provider === "direct-host"
            ? "Direct host"
            : provider === "direct-url"
              ? "Direct URL"
              : provider === "catalog"
                ? "Catalog"
                : "Web search";
    badges.push({ label, tone: "neutral" });
  }

  return badges;
}

export function buildJobErrorSummary(job) {
  const explicitError = collapseWhitespace(job?.error || "");
  const historySummary = collapseWhitespace(job?.historySummary || "");
  if (explicitError && historySummary && explicitError !== historySummary) {
    return `${explicitError} ${historySummary}`.trim();
  }
  if (explicitError) {
    return explicitError;
  }
  if (historySummary && String(job?.buildDisposition || "") === "reject_search") {
    return historySummary;
  }
  if (String(job?.status || "") === "completed" && String(job?.conclusion || "").trim() && String(job?.conclusion || "") !== "success") {
    return `Failed: ${job.conclusion}`;
  }
  return "";
}

export function gallerySearchText(entry) {
  return collapseWhitespace(
    [
      entry?.title,
      entry?.id,
      entry?.folder,
      entry?.source_url,
      hostFromUrl(entry?.source_url),
      entry?.generated_at,
    ]
      .filter(Boolean)
      .join(" "),
  ).toLowerCase();
}

export function filterGalleryEntries(entries, query) {
  const needle = collapseWhitespace(query).toLowerCase();
  if (!needle) {
    return Array.isArray(entries) ? [...entries] : [];
  }
  return (Array.isArray(entries) ? entries : []).filter((entry) => gallerySearchText(entry).includes(needle));
}
