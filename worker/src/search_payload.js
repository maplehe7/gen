function stringValue(value, fallback = "") {
  const trimmed = String(value || "").trim();
  return trimmed || fallback;
}

function uniqueBy(items, keyFn) {
  const results = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push(item);
  });
  return results;
}

export function summarizeCandidate(candidate) {
  return {
    query: candidate.query,
    sourceUrl: candidate.sourceUrl,
    displayName: candidate.displayName,
    matchedName: candidate.displayName,
    sourceMode:
      candidate.provider === "override"
        ? "verified-search"
        : candidate.provider === "drive-site"
        ? "drive-site-search"
        : candidate.provider === "direct-host"
          ? "direct-host-search"
          : "web-search",
    provider: candidate.provider,
    confidence: candidate.confidence,
    hostedOnline: candidate.hostedOnline,
    reason: candidate.reason,
    imageUrl: candidate.imageUrl,
    buildDisposition: candidate.buildDisposition || "unknown",
    historyStatus: candidate.historyStatus || "unknown",
    historySummary: candidate.historySummary || "No failed-build history recorded.",
  };
}

export function summarizeSuppressedCandidate(candidate) {
  return {
    sourceUrl: stringValue(candidate?.sourceUrl || candidate?.url),
    displayName: stringValue(candidate?.displayName || candidate?.title, "Candidate"),
    provider: stringValue(candidate?.provider, "web-search"),
    buildDisposition: stringValue(candidate?.buildDisposition, "unknown"),
    historyStatus: stringValue(candidate?.historyStatus, "unknown"),
    historySummary: stringValue(candidate?.historySummary, "No failed-build history recorded."),
    rejectionReason: stringValue(candidate?.reason, "Filtered by search diagnostics."),
  };
}

export function buildSearchPayload(query, result, limit = 1) {
  const summarizedCandidates = (Array.isArray(result?.candidates) ? result.candidates : []).map((candidate, index) => ({
    ...summarizeCandidate(candidate),
    rank: index + 1,
  }));
  const suppressed = uniqueBy(
    (Array.isArray(result?.suppressed) ? result.suppressed : [])
      .map((candidate) => summarizeSuppressedCandidate(candidate))
      .filter((candidate) => candidate.sourceUrl),
    (candidate) => candidate.sourceUrl,
  ).slice(0, 8);

  if (limit === 1) {
    return summarizedCandidates[0];
  }

  return {
    query,
    candidates: summarizedCandidates,
    alternatives: Array.isArray(result?.alternatives) ? result.alternatives : [],
    suppressed,
  };
}
