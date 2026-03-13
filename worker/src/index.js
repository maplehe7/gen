const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
};

function json(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...(init.headers || {}),
    },
  });
}

function normalizeOriginList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const requestOrigin = request.headers.get("Origin") || "";
  const allowedOrigins = normalizeOriginList(env.ALLOWED_ORIGIN);
  const allowAny = allowedOrigins.includes("*");
  const matchedOrigin = allowAny
    ? "*"
    : allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : allowedOrigins[0] || "*";

  return {
    "Access-Control-Allow-Origin": matchedOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function rejectDisallowedOrigin(request, env) {
  const allowedOrigins = normalizeOriginList(env.ALLOWED_ORIGIN);
  if (!allowedOrigins.length || allowedOrigins.includes("*")) {
    return null;
  }

  const requestOrigin = request.headers.get("Origin") || "";
  if (!requestOrigin || allowedOrigins.includes(requestOrigin)) {
    return null;
  }

  return json(
    { error: `Origin not allowed: ${requestOrigin}` },
    {
      status: 403,
      headers: corsHeaders(request, env),
    },
  );
}

function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "standalone-forge-proxy",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function workflowFile(env) {
  return String(env.GITHUB_WORKFLOW_FILE || "build-game.yml").trim() || "build-game.yml";
}

function githubApiBase(env) {
  return `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}`;
}

function validateEnv(env) {
  const missing = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"].filter((key) => !String(env[key] || "").trim());
  if (missing.length) {
    throw new Error(`Missing Worker environment values: ${missing.join(", ")}`);
  }
}

async function githubJson(url, env, init = {}, label = "GitHub request") {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...githubHeaders(env),
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.raw ||
      `${label} failed with status ${response.status}`;
    throw new Error(`${label} failed with status ${response.status}: ${message}`);
  }

  return payload;
}

async function githubNoContent(url, env, init = {}, label = "GitHub request") {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...githubHeaders(env),
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (_error) {
        payload = { raw: text };
      }
    }
    const message =
      payload?.message ||
      payload?.raw ||
      `${label} failed with status ${response.status}`;
    throw new Error(`${label} failed with status ${response.status}: ${message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function normalizeSourceUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  if (looksLikeUrl(trimmed)) {
    return trimmed;
  }

  const bareDomainPattern =
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i;
  if (/\s/.test(trimmed) || !bareDomainPattern.test(trimmed)) {
    return "";
  }

  const candidate = `https://${trimmed}`;
  return looksLikeUrl(candidate) ? candidate : "";
}

async function findRecentRun(env, submittedAtIso) {
  const runsUrl =
    `${githubApiBase(env)}/actions/workflows/${encodeURIComponent(workflowFile(env))}/runs` +
    `?event=workflow_dispatch&branch=${encodeURIComponent(env.GITHUB_REF || "main")}&per_page=10`;

  const submittedAt = Date.parse(submittedAtIso);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const payload = await githubJson(runsUrl, env, {}, "List workflow runs");
    const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
    const match = runs.find((run) => {
      const createdAt = Date.parse(run.created_at || "");
      return Number.isFinite(createdAt) && createdAt >= submittedAt - 120000;
    });
    if (match) {
      return match;
    }
    await sleep(1500);
  }

  throw new Error("Workflow was dispatched, but no matching run was found yet.");
}

async function handleConfig(request, env) {
  validateEnv(env);
  return json(
    {
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      ref: env.GITHUB_REF || "main",
      workflowFile: workflowFile(env),
    },
    {
      headers: corsHeaders(request, env),
    },
  );
}

async function handleDispatch(request, env) {
  validateEnv(env);
  const body = await request.json().catch(() => null);
  const sourceUrl = normalizeSourceUrl(body?.sourceUrl);
  const displayName = String(body?.displayName || "").trim();
  const requestId = String(body?.requestId || "").trim();

  if (!sourceUrl) {
    return json(
      { error: "A valid sourceUrl is required. Bare domains like example.com are allowed." },
      {
        status: 400,
        headers: corsHeaders(request, env),
      },
    );
  }

  const dispatchUrl = `${githubApiBase(env)}/actions/workflows/${encodeURIComponent(workflowFile(env))}/dispatches`;
  const submittedAtIso = new Date().toISOString();
  await githubNoContent(dispatchUrl, env, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: env.GITHUB_REF || "main",
      inputs: {
        source_url: sourceUrl,
        display_name: displayName,
        request_id: requestId,
      },
    }),
  }, "Dispatch workflow");

  const run = await findRecentRun(env, submittedAtIso);
  return json(
    {
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      ref: env.GITHUB_REF || "main",
      runId: run.id,
      runUrl: run.url,
      htmlUrl: run.html_url,
      jobsUrl: run.jobs_url,
    },
    {
      headers: corsHeaders(request, env),
    },
  );
}

async function handleStatus(request, env) {
  validateEnv(env);
  const url = new URL(request.url);
  const runId = String(url.searchParams.get("runId") || "").trim();
  if (!runId) {
    return json(
      { error: "runId is required." },
      {
        status: 400,
        headers: corsHeaders(request, env),
      },
    );
  }

  const run = await githubJson(
    `${githubApiBase(env)}/actions/runs/${encodeURIComponent(runId)}`,
    env,
    {},
    "Get workflow run",
  );
  const jobs = await githubJson(
    `${githubApiBase(env)}/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=100`,
    env,
    {},
    "List workflow jobs",
  );

  return json(
    {
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      ref: env.GITHUB_REF || "main",
      run,
      jobs,
    },
    {
      headers: corsHeaders(request, env),
    },
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors,
      });
    }

    const blocked = rejectDisallowedOrigin(request, env);
    if (blocked) {
      return blocked;
    }

    try {
      if (request.method === "GET" && url.pathname === "/config") {
        return await handleConfig(request, env);
      }

      if (request.method === "POST" && url.pathname === "/dispatch") {
        return await handleDispatch(request, env);
      }

      if (request.method === "GET" && url.pathname === "/status") {
        return await handleStatus(request, env);
      }

      return json(
        { error: "Not found." },
        {
          status: 404,
          headers: cors,
        },
      );
    } catch (error) {
      console.error(error);
      return json(
        {
          error: error instanceof Error ? error.message : "Worker error.",
        },
        {
          status: 500,
          headers: cors,
        },
      );
    }
  },
};
