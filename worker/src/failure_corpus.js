import failureIndex from "../../reports/failed-builds-index.json" with { type: "json" };
import dispositions from "../../reports/failed-build-dispositions.json" with { type: "json" };

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function normalizeSearchText(value) {
  return collapseWhitespace(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " "),
  );
}

export function normalizeSourceUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_error) {
    try {
      parsed = new URL(`https://${trimmed}`);
    } catch (_innerError) {
      return "";
    }
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return "";
  }

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/+$/, "") : "/";
  return `${parsed.protocol}//${hostname}${pathname}${parsed.search}`;
}

function hostFromUrl(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase();
  } catch (_error) {
    return "";
  }
}

function sortQueries(queries) {
  return [...new Set((queries || []).map((value) => normalizeSearchText(value)).filter(Boolean))];
}

const historyEntries = Array.isArray(failureIndex?.entries) ? failureIndex.entries : [];
const dispositionEntries = Array.isArray(dispositions?.entries) ? dispositions.entries : [];

const historyBySourceUrl = new Map(
  historyEntries
    .map((entry) => [normalizeSourceUrl(entry?.source_url || ""), entry])
    .filter(([key]) => Boolean(key)),
);

const normalizedDispositions = dispositionEntries
  .map((entry) => ({
    ...entry,
    source_url: normalizeSourceUrl(entry?.source_url || ""),
    normalized_queries: sortQueries(entry?.queries || []),
    host: hostFromUrl(entry?.source_url || ""),
  }))
  .filter((entry) => entry.source_url);

function queryMatches(entry, normalizedQuery) {
  if (!entry.normalized_queries.length) {
    return true;
  }
  return entry.normalized_queries.includes(normalizedQuery);
}

function exactDispositionMatches(entry, normalizedSourceUrl) {
  return entry.match_type === "exact" && entry.source_url === normalizedSourceUrl;
}

function hostDispositionMatches(entry, normalizedSourceUrl) {
  if (entry.match_type !== "host" || !entry.host) {
    return false;
  }
  const sourceHost = hostFromUrl(normalizedSourceUrl);
  return sourceHost === entry.host || sourceHost.endsWith(`.${entry.host}`);
}

export function findHistory(sourceUrl) {
  const normalizedSourceUrl = normalizeSourceUrl(sourceUrl);
  return historyBySourceUrl.get(normalizedSourceUrl) || null;
}

export function findDisposition(query, sourceUrl) {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedSourceUrl = normalizeSourceUrl(sourceUrl);
  if (!normalizedSourceUrl) {
    return null;
  }

  const exact = normalizedDispositions.find(
    (entry) => queryMatches(entry, normalizedQuery) && exactDispositionMatches(entry, normalizedSourceUrl),
  );
  if (exact) {
    return exact;
  }

  return (
    normalizedDispositions.find(
      (entry) => queryMatches(entry, normalizedQuery) && hostDispositionMatches(entry, normalizedSourceUrl),
    ) || null
  );
}

export function historyStatusFromRecord(history) {
  if (!history) {
    return "unknown";
  }
  if (Number(history?.history_counts?.known_failed || 0) > 0) {
    return "known_failed";
  }
  if (Number(history?.history_counts?.known_cancelled || 0) > 0) {
    return "known_cancelled";
  }
  return "unknown";
}

export function summarizeHistory(history) {
  if (!history) {
    return "No failed-build history recorded.";
  }

  const failed = Number(history?.history_counts?.known_failed || 0);
  const cancelled = Number(history?.history_counts?.known_cancelled || 0);
  const parts = [];
  if (failed) {
    parts.push(`${failed} failed`);
  }
  if (cancelled) {
    parts.push(`${cancelled} cancelled`);
  }
  const queryPart = Array.isArray(history?.queries) && history.queries.length ? ` for ${history.queries.join(", ")}` : "";
  return parts.length ? `Previously seen ${parts.join(", ")}${queryPart}.` : "Failed-build history exists.";
}

export function describeFailureRecord(query, sourceUrl) {
  const disposition = findDisposition(query, sourceUrl);
  const history = findHistory(sourceUrl);
  const historyStatus = historyStatusFromRecord(history);
  const buildDisposition = disposition?.action || "unknown";
  let historySummary = summarizeHistory(history);

  if (disposition?.action === "allow_build") {
    historySummary = disposition.note || "Probe/export verification marked this source buildable.";
  } else if (disposition?.action === "reject_search") {
    historySummary = disposition.note || historySummary;
  }

  return {
    buildDisposition,
    historyStatus,
    historySummary,
    disposition,
    history,
  };
}

export function searchOverridesForQuery(query) {
  const normalizedQuery = normalizeSearchText(query);
  return normalizedDispositions
    .filter((entry) => entry.action === "allow_build" && entry.preferred_search && queryMatches(entry, normalizedQuery))
    .sort((left, right) => (Number(right.search_score) || 0) - (Number(left.search_score) || 0))
    .map((entry) => ({
      title: entry.title || query,
      url: entry.source_url,
      textScore: Number(entry.search_score) || 220,
    }));
}

export function rejectedHostsForQuery(query) {
  const normalizedQuery = normalizeSearchText(query);
  return normalizedDispositions
    .filter(
      (entry) =>
        entry.action === "reject_search" &&
        entry.match_type === "host" &&
        entry.host &&
        queryMatches(entry, normalizedQuery),
    )
    .map((entry) => entry.host.replace(/^www\./, ""));
}

export function rejectionReasonForCandidate(query, sourceUrl) {
  const disposition = findDisposition(query, sourceUrl);
  if (disposition?.action !== "reject_search") {
    return "";
  }
  return disposition.note || "known rejected source";
}

export function penaltyForCandidate(query, sourceUrl) {
  const { buildDisposition, historyStatus } = describeFailureRecord(query, sourceUrl);
  if (buildDisposition === "reject_search") {
    return 160;
  }
  if (buildDisposition === "allow_build") {
    return 0;
  }
  if (historyStatus === "known_failed") {
    return 72;
  }
  if (historyStatus === "known_cancelled") {
    return 36;
  }
  return 0;
}
