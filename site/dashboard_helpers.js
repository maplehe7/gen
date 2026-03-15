import { collapseWhitespace } from "./ui_helpers.js";

export function candidateSelectionKey(value) {
  const sourceUrl =
    typeof value === "string" ? String(value || "").trim() : String(value?.sourceUrl || value?.url || "").trim();
  if (!sourceUrl) {
    return "";
  }

  try {
    const parsed = new URL(sourceUrl);
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.hostname.toLowerCase()}${pathname}${parsed.search}`;
  } catch (_error) {
    return sourceUrl.replace(/\/+$/, "").toLowerCase();
  }
}

export function initialSelectedCandidateKeys(candidates, desiredCount = 1) {
  const safeDesired = Math.max(Math.round(Number(desiredCount) || 1), 1);
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => String(candidate?.buildDisposition || "unknown").trim() !== "reject_search")
    .map((candidate) => candidateSelectionKey(candidate))
    .filter(Boolean)
    .slice(0, safeDesired);
}

export function normalizeSelectedCandidateKeys(selection) {
  const candidatePool = Array.isArray(selection?.candidatePool) ? selection.candidatePool : [];
  const validKeys = new Set(candidatePool.map((candidate) => candidateSelectionKey(candidate)).filter(Boolean));
  if (Array.isArray(selection?.selectedCandidateKeys)) {
    return selection.selectedCandidateKeys.filter((key) => validKeys.has(String(key || "").trim()));
  }

  return initialSelectedCandidateKeys(candidatePool, Number(selection?.desiredSuccessCount) || 1);
}

export function selectedCandidatesForSelection(selection) {
  const selectedKeys = new Set(normalizeSelectedCandidateKeys(selection));
  return (Array.isArray(selection?.candidatePool) ? selection.candidatePool : []).filter((candidate) =>
    selectedKeys.has(candidateSelectionKey(candidate)),
  );
}

export function initialDispatchSubset(candidates, maxActiveCount = 1) {
  const safeLimit = Math.max(Math.round(Number(maxActiveCount) || 0), 0);
  return (Array.isArray(candidates) ? candidates : []).slice(0, safeLimit);
}

function candidateBucket(candidate, index = 0) {
  if (String(candidate?.buildDisposition || "unknown").trim() === "reject_search") {
    return "filtered";
  }
  if (index === 0) {
    return "recommended";
  }

  const historyStatus = String(candidate?.historyStatus || "unknown").trim();
  if (historyStatus === "known_failed" || historyStatus === "known_cancelled") {
    return "risky";
  }

  if (Number(candidate?.confidence || 0) < 50) {
    return "risky";
  }

  return "buildable";
}

export function bucketReviewCandidates(candidates) {
  const buckets = {
    recommended: [],
    buildable: [],
    risky: [],
  };

  (Array.isArray(candidates) ? candidates : []).forEach((candidate, index) => {
    const bucket = candidateBucket(candidate, index);
    if (bucket === "filtered") {
      return;
    }
    buckets[bucket].push(candidate);
  });

  return buckets;
}

export function reviewSelectionCount(selection) {
  return normalizeSelectedCandidateKeys(selection).length;
}

export function isReviewSelectionState(state) {
  return ["review", "dispatch-failed", "dispatching"].includes(String(state || "").trim());
}

export function isDispatchableSelection(selection) {
  const state = String(selection?.state || "").trim();
  if (!isReviewSelectionState(state) || state === "dispatching") {
    return false;
  }
  return reviewSelectionCount(selection) > 0;
}

export function reviewSelectionsFromState(batchSelections) {
  return Object.values(batchSelections || {})
    .filter((selection) => Array.isArray(selection?.candidatePool) && selection.candidatePool.length)
    .filter((selection) => isReviewSelectionState(selection?.state))
    .sort((left, right) => Date.parse(String(right?.updatedAt || "")) - Date.parse(String(left?.updatedAt || "")));
}

export function isCancelableJob(job) {
  const status = String(job?.status || "").trim();
  if (!status || status === "completed" || status === "error") {
    return false;
  }
  return !Boolean(job?.cancelPending);
}

export function splitBatchCancellationJobs(batchJobs) {
  const remote = [];
  const local = [];

  (Array.isArray(batchJobs) ? batchJobs : []).forEach((job) => {
    if (!isCancelableJob(job)) {
      return;
    }
    if (String(job?.runId || "").trim()) {
      remote.push(job);
      return;
    }
    local.push(job);
  });

  return { remote, local };
}

export function classifyCancellationResult(result) {
  const conclusion = String(result?.conclusion || "").trim();
  if (result?.alreadyCompleted && conclusion && conclusion !== "cancelled") {
    return "already_completed";
  }
  if (result?.found === false && !String(result?.runId || "").trim()) {
    return "awaiting_run";
  }
  if (result?.cancelled || conclusion === "cancelled") {
    return "cancelled";
  }
  return "cancelled";
}

export function groupActiveJobsByBatch(jobs) {
  const groups = new Map();
  (Array.isArray(jobs) ? jobs : []).forEach((job) => {
    const batchId = String(job?.batchId || "").trim() || String(job?.requestId || "").trim();
    const current = groups.get(batchId) || {
      batchId,
      batchLabel: String(job?.batchLabel || job?.sourceInput || job?.displayName || "Request").trim(),
      jobs: [],
    };
    current.jobs.push(job);
    groups.set(batchId, current);
  });

  return [...groups.values()]
    .map((group) => ({
      ...group,
      jobs: [...group.jobs].sort((left, right) => (Number(left?.candidateRank) || 999) - (Number(right?.candidateRank) || 999)),
    }))
    .sort((left, right) => {
      const leftTime = Date.parse(String(left.jobs[0]?.batchSubmittedAt || left.jobs[0]?.submittedAt || "")) || 0;
      const rightTime = Date.parse(String(right.jobs[0]?.batchSubmittedAt || right.jobs[0]?.submittedAt || "")) || 0;
      return rightTime - leftTime;
    });
}

export function selectionStateLabel(selection) {
  const state = String(selection?.state || "review").trim();
  if (state === "dispatching") {
    return "Dispatching";
  }
  if (state === "dispatch-failed") {
    return "Retry dispatch";
  }
  return "Ready";
}

export function dashboardSnapshot(jobs, batchSelections, lastRefreshAt = 0) {
  const reviewSelections = reviewSelectionsFromState(batchSelections);
  const activeJobs = (Array.isArray(jobs) ? jobs : []).filter((job) => {
    const status = String(job?.status || "").trim();
    return status !== "completed" && status !== "error";
  });
  const refreshText = lastRefreshAt
    ? `Refreshed ${new Date(lastRefreshAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : "Waiting for first refresh";

  return {
    activeJobCount: activeJobs.length,
    reviewBatchCount: reviewSelections.length,
    selectedCandidateCount: reviewSelections.reduce((sum, selection) => sum + reviewSelectionCount(selection), 0),
    refreshText,
  };
}

export function buildSelectionSummary(selection) {
  const selectedCount = reviewSelectionCount(selection);
  const totalCount = Array.isArray(selection?.candidatePool) ? selection.candidatePool.length : 0;
  const desiredCount = Math.max(Number(selection?.desiredSuccessCount) || selectedCount || 1, 1);
  return collapseWhitespace(
    `${selectedCount} selected${totalCount ? ` from ${totalCount}` : ""}. Target was ${desiredCount}.`,
  );
}
