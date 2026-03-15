import {
  describeFailureRecord,
  penaltyForCandidate,
  rejectionReasonForCandidate,
  searchOverridesForQuery,
} from "./failure_corpus.js";
import { buildSearchPayload } from "./search_payload.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
};

const PREFERRED_SEARCH_SITES = [
  {
    id: "drive-u-7-home-10",
    label: "drive-u-7-home-10",
    url: "https://sites.google.com/view/drive-u-7-home-10/",
    prefix: "/view/drive-u-7-home-10/",
  },
  {
    id: "classroom6x",
    label: "classroom6x",
    url: "https://sites.google.com/view/classroom6x/",
    prefix: "/view/classroom6x/",
  },
];
const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";
const BING_SEARCH_URL = "https://www.bing.com/search";
const BRAVE_SEARCH_URL = "https://search.brave.com/search";
const REPORTS_FILE_PATH = "reports/not-working.txt";
const PUBLISHED_GAMES_FILE_PATH = "published_games.json";
const FAILED_BUILDS_FILE_PATH = "reports/failed-builds.txt";
const FAILED_BUILD_LOGS_DIR = "reports/failed-builds";
const SEARCH_INDEX_TTL_MS = 30 * 60 * 1000;
const MAX_SITE_CANDIDATES = 8;
const MAX_WEB_CANDIDATES = 16;
const MAX_SEARCH_RESPONSE_LIMIT = 12;
const SEARCHABLE_SITE_MATCH_FLOOR = 28;
const REPORT_FILE_HEADER = "# Not Working Game Reports\n";
const FAILED_BUILD_FILE_HEADER = "# Failed Build Reports\n";
const DOWNLOAD_EXTENSIONS = [".apk", ".dmg", ".exe", ".iso", ".msi", ".pkg", ".rar", ".zip", ".7z"];
const ASSET_ONLY_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".mp3",
  ".mp4",
  ".ogg",
  ".pdf",
  ".png",
  ".svg",
  ".txt",
  ".wav",
  ".webm",
  ".webp",
  ".xml",
]);
const INFRASTRUCTURE_HOSTS = [
  "accounts.google.com",
  "apis.google.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "google.com",
  "googleapis.com",
  "googletagmanager.com",
  "gstatic.com",
  "schema.org",
  "w3.org",
  "youtube.com",
  "youtu.be",
];
const FRIENDLY_HOSTS = [
  "8games.net",
  "github.io",
  "githubusercontent.com",
  "jsdelivr.net",
  "madkidgames.com",
  "netlify.app",
  "pages.dev",
  "sites.google.com",
  "vercel.app",
  "workers.dev",
];
const PENALIZED_HOSTS = [
  "crazygames.com",
  "fandom.com",
  "itch.io",
  "poki.com",
  "spatial.io",
  "softonic.com",
  "reddit.com",
  "store.epicgames.com",
  "steamcommunity.com",
  "store.steampowered.com",
  "uptodown.com",
  "wikipedia.org",
  "y8.com",
  "youtube.com",
];
const PORTAL_HOSTS = [
  "coolmathgames.com",
  "drifted.com",
  "gamepix.com",
  "hoodamath.com",
  "hooplandgame.com",
  "mathplayground.com",
  "mortgagecalculator.org",
];
const WRAPPER_HOSTS = [
  "googleusercontent.com",
  "script.google.com",
  "sites.google.com",
];
const MEDIA_ONLY_HOSTS = [
  "youtube.com",
  "ytimg.com",
  "youtu.be",
  "vimeo.com",
];
const DIRECT_HOST_SUFFIXES = [".io", ".game", "game.io"];
const GENERIC_SITE_TITLES = new Set(["classroom g+", "home", "search this site", "unblocked games"]);

let driveSiteIndexCache = Object.fromEntries(
  PREFERRED_SEARCH_SITES.map((site) => [
    site.id,
    {
      loadedAt: 0,
      items: [],
    },
  ]),
);

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
  const requestedHeaders = request.headers.get("Access-Control-Request-Headers") || "";
  const allowedOrigins = normalizeOriginList(env.ALLOWED_ORIGIN);
  const allowAny = allowedOrigins.includes("*");
  const matchedOrigin = allowAny
    ? "*"
    : allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : allowedOrigins[0] || "*";

  return {
    "Access-Control-Allow-Origin": matchedOrigin,
    "Access-Control-Allow-Headers": requestedHeaders || "Content-Type, Cache-Control, Pragma",
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

function workerHeaders() {
  return {
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "User-Agent": "standalone-forge-proxy",
  };
}

function workflowFile(env) {
  return String(env.GITHUB_WORKFLOW_FILE || "build-game.yml").trim() || "build-game.yml";
}

function pagesStateRef(env) {
  return String(env.GITHUB_PAGES_REF || "pages-state").trim() || "pages-state";
}

function githubApiBase(env) {
  return `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}`;
}

function encodeGitHubPath(path) {
  return String(path || "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function validateEnv(env) {
  const missing = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"].filter((key) => !String(env[key] || "").trim());
  if (missing.length) {
    throw new Error(`Missing Worker environment values: ${missing.join(", ")}`);
  }
}

async function parseResponsePayload(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { raw: text };
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
  const payload = await parseResponsePayload(response);
  if (!response.ok) {
    const message = payload?.message || payload?.raw || `${label} failed with status ${response.status}`;
    throw new Error(`${label} failed with status ${response.status}: ${message}`);
  }
  return payload;
}

async function githubJsonOrNull(url, env, init = {}, label = "GitHub request") {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...githubHeaders(env),
      ...(init.headers || {}),
    },
  });
  const payload = await parseResponsePayload(response);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const message = payload?.message || payload?.raw || `${label} failed with status ${response.status}`;
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
    const payload = await parseResponsePayload(response);
    const message = payload?.message || payload?.raw || `${label} failed with status ${response.status}`;
    throw new Error(`${label} failed with status ${response.status}: ${message}`);
  }
}

async function githubText(url, env, init = {}, label = "GitHub request") {
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: {
      ...githubHeaders(env),
      ...(init.headers || {}),
    },
  });
  if (response.status >= 300 && response.status < 400) {
    const redirectUrl = response.headers.get("location") || response.headers.get("Location") || "";
    if (!redirectUrl) {
      throw new Error(`${label} failed with status ${response.status}: missing redirect location`);
    }
    const redirected = await fetch(redirectUrl, {
      method: init.method || "GET",
      headers: {
        Accept: "text/plain, */*;q=0.8",
        "User-Agent": "standalone-forge-proxy",
      },
    });
    const redirectedText = await redirected.text();
    if (!redirected.ok) {
      throw new Error(
        `${label} failed with status ${redirected.status}: ${redirectedText || redirected.statusText}`,
      );
    }
    return redirectedText;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed with status ${response.status}: ${text || response.statusText}`);
  }
  return text;
}

async function fetchText(url, init = {}, label = "Request") {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...workerHeaders(),
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${label} failed with status ${response.status}: ${text || response.statusText}`);
  }
  return response.text();
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
  const bareDomainPattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i;
  if (/\s/.test(trimmed) || !bareDomainPattern.test(trimmed)) {
    return "";
  }
  const candidate = `https://${trimmed}`;
  return looksLikeUrl(candidate) ? candidate : "";
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return String(value || "").replace(/&(#x?[0-9a-f]+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (named[lower]) {
      return named[lower];
    }
    if (lower.startsWith("#x")) {
      const parsed = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
    }
    if (lower.startsWith("#")) {
      const parsed = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
    }
    return match;
  });
}

function stripTags(value) {
  return collapseWhitespace(decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " ")));
}

function normalizeSearchText(value) {
  return collapseWhitespace(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " "),
  );
}

function tokenizeSearchText(value) {
  return normalizeSearchText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeLooseToken(value) {
  let token = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (!token) {
    return "";
  }

  const suffixes = [
    "ization",
    "isation",
    "ations",
    "ation",
    "istics",
    "istic",
    "ments",
    "ment",
    "ness",
    "less",
    "able",
    "ible",
    "ally",
    "fully",
    "ously",
    "ious",
    "izing",
    "izers",
    "izer",
    "ingly",
    "edly",
    "ings",
    "ing",
    "ers",
    "er",
    "ied",
    "ies",
    "est",
    "ful",
    "ous",
    "ive",
    "ion",
    "al",
    "ly",
    "ed",
    "es",
    "s",
  ];

  for (const suffix of suffixes) {
    if (token.length >= suffix.length + 3 && token.endsWith(suffix)) {
      token = token.slice(0, -suffix.length);
      break;
    }
  }
  return token;
}

function roughlyMatchingTokens(left, right) {
  const leftToken = normalizeLooseToken(left);
  const rightToken = normalizeLooseToken(right);
  if (!leftToken || !rightToken) {
    return false;
  }
  if (leftToken === rightToken) {
    return true;
  }
  const shortest = Math.min(leftToken.length, rightToken.length);
  return shortest >= 4 && (leftToken.startsWith(rightToken) || rightToken.startsWith(leftToken));
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const results = [];
  items.forEach((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push(item);
  });
  return results;
}

function cleanExtractedUrl(rawUrl, baseUrl = "") {
  const decoded = decodeHtmlEntities(String(rawUrl || "").trim())
    .replace(/^\/\//, "https://")
    .replace(/[)\],;'\"`]+$/g, "");
  if (!decoded) {
    return "";
  }
  try {
    const parsed = baseUrl ? new URL(decoded, baseUrl) : new URL(decoded);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

function looksLikeAssetOnlyUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    const pathname = parsed.pathname.toLowerCase();
    if (!pathname || pathname.endsWith("/")) {
      return false;
    }
    if (/\/(?:data|images?|img|media|assets?)\//i.test(pathname) && /\.[a-z0-9]{2,6}$/i.test(pathname)) {
      return true;
    }
    const extensionMatch = pathname.match(/(\.[a-z0-9]{2,6})(?:$|\?)/i);
    if (!extensionMatch) {
      return false;
    }
    return ASSET_ONLY_EXTENSIONS.has(extensionMatch[1].toLowerCase());
  } catch (_error) {
    return false;
  }
}

function domainFromUrl(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch (_error) {
    return "";
  }
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/\s+/g, "");
}

function titleCaseWords(value) {
  return collapseWhitespace(String(value || ""))
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function buildQueryVariants(query) {
  const trimmed = collapseWhitespace(query);
  if (!trimmed) {
    return [];
  }

  const variants = [
    trimmed,
    collapseWhitespace(trimmed.replace(/[_\-–—:|/\\]+/g, " ")),
    titleCaseWords(trimmed),
    trimmed.toLowerCase(),
  ];

  const strippedGameWords = collapseWhitespace(
    trimmed.replace(/\b(game|online|unblocked|play|classic|free)\b/gi, " "),
  );
  if (strippedGameWords) {
    variants.push(strippedGameWords);
  }

  const beforeSeparator = collapseWhitespace(trimmed.split(/[:|\-–—]/)[0] || "");
  if (beforeSeparator) {
    variants.push(beforeSeparator);
  }

  return uniqueBy(
    variants
      .map((value) => collapseWhitespace(value))
      .filter(Boolean),
    (value) => normalizeSearchText(value),
  ).slice(0, 6);
}

function buildWebSearchTerms(query) {
  const variants = buildQueryVariants(query);
  const terms = [];
  variants.forEach((variant) => {
    terms.push(variant);
    terms.push(`"${variant}"`);
    terms.push(`"${variant}" game`);
    terms.push(`${variant} online game`);
    terms.push(`${variant} browser game`);
    terms.push(`${variant} unblocked game`);
    terms.push(`${variant} unity`);
    terms.push(`${variant} webgl`);
    terms.push(`"${variant}" unity`);
    terms.push(`"${variant}" webgl`);
  });
  return uniqueBy(terms.filter(Boolean), (value) => normalizeSearchText(value)).slice(0, 12);
}

function compactHostname(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".")
    .slice(0, -1)
    .join("")
    .replace(/[^a-z0-9]+/g, "");
}

function compactUrlPath(value) {
  try {
    return new URL(String(value || ""))
      .pathname.toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  } catch (_error) {
    return "";
  }
}

function matchesHost(host, suffixes) {
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isIgnoredInfrastructureUrl(value) {
  return matchesHost(domainFromUrl(value), INFRASTRUCTURE_HOSTS);
}

function isFriendlyHostedDomain(value) {
  return matchesHost(domainFromUrl(value), FRIENDLY_HOSTS);
}

function isPenalizedDomain(value) {
  return matchesHost(domainFromUrl(value), PENALIZED_HOSTS);
}

function isPortalDomain(value) {
  return matchesHost(domainFromUrl(value), PORTAL_HOSTS);
}

function isWrapperDomain(value) {
  return matchesHost(domainFromUrl(value), WRAPPER_HOSTS);
}

function isQuerySpecificRejectedHost(query, value) {
  return Boolean(rejectionReasonForCandidate(query, value));
}

function brandedHostScore(query, value) {
  const compactQuery = compactSearchText(query);
  if (!compactQuery || compactQuery.length < 4) {
    return 0;
  }

  const hostScoreSource = compactHostname(domainFromUrl(value));
  const pathScoreSource = compactUrlPath(value);
  let score = 0;

  if (hostScoreSource === compactQuery) {
    score += 160;
  } else if (hostScoreSource.startsWith(compactQuery) || hostScoreSource.endsWith(compactQuery)) {
    score += 125;
  } else if (hostScoreSource.includes(compactQuery)) {
    score += 95;
  } else if (compactQuery.includes(hostScoreSource) && hostScoreSource.length >= 5) {
    score += 35;
  }

  if (pathScoreSource === compactQuery) {
    score += 26;
  } else if (pathScoreSource.includes(compactQuery)) {
    score += 18;
  }

  return score;
}

function genericHostSuffixPenalty(query, value) {
  const compactQuery = compactSearchText(query);
  const hostStem = compactHostname(domainFromUrl(value));
  if (!compactQuery || !hostStem || hostStem === compactQuery || !hostStem.includes(compactQuery)) {
    return 0;
  }

  const suffix = hostStem.replace(compactQuery, "");
  if (/^(online|lite|unblocked|free|play|playnow|game|games|app|download)+$/i.test(suffix)) {
    return 48;
  }
  return 0;
}

function genericCollectionPenalty(query, value, rawTitle = "") {
  const normalizedPath = String(value || "").toLowerCase();
  const normalizedTitle = normalizeSearchText(rawTitle);
  const normalizedQuery = normalizeSearchText(query);
  let penalty = 0;

  if (/\/(?:categories?|category|tags?|tag|collections?|collection|browse|genres?|genre|topics?|topic|search)(?:\/|$)/i.test(normalizedPath)) {
    penalty += 70;
  }
  if (/\/(?:en\/)?t\/[^/]+\/?$/i.test(normalizedPath)) {
    penalty += 60;
  }
  if (/\b(?:games|simulator games|car simulator games)\b/i.test(normalizedTitle) && !/\bgames\b/.test(normalizedQuery)) {
    penalty += 26;
  }

  return penalty;
}

function hasSuspiciousWrappedAsset(urls, html = "") {
  const haystack = `${urls.join(" ")} ${html}`.toLowerCase();
  return (
    /\.xml(?:[?#\s]|$)/i.test(haystack) ||
    /streamingassets\//i.test(haystack) ||
    /cdn\.jsdelivr\.net\/gh\//i.test(haystack) ||
    /preview\.editmysite\.com/i.test(haystack) ||
    /script\.google\.com\/macros\/s\//i.test(haystack)
  );
}

function isMediaOnlyEmbedUrl(value) {
  return matchesHost(domainFromUrl(value), MEDIA_ONLY_HOSTS);
}

function hasOnlyMediaEmbeds(urls) {
  return Array.isArray(urls) && urls.length > 0 && urls.every((value) => isMediaOnlyEmbedUrl(value));
}

function looksLikeSoftwarePortal(candidate, rawTitle, description, html = "") {
  const haystack = `${candidate?.url || ""} ${rawTitle} ${description} ${html}`.toLowerCase();
  return (
    /softonic|uptodown|filehippo|download latest version|download for windows|download for android|download on pc|windows 10|windows 11|app store|google play|microsoft store/i.test(
      haystack,
    ) ||
    /free software download|latest version|license|security status/i.test(haystack)
  );
}

function looksLikeAccessBlockedPage(rawTitle, description, html = "") {
  const haystack = `${rawTitle} ${description} ${html}`.toLowerCase();
  return /access denied|forbidden|you have been blocked|blocked by|disable ad blocker|ad blocker detected|temporarily unavailable/i.test(
    haystack,
  );
}

function isDownloadUrl(value) {
  const lower = String(value || "").toLowerCase();
  if (DOWNLOAD_EXTENSIONS.some((extension) => lower.includes(extension))) {
    return true;
  }
  return /(?:\/|=)(?:download|get|setup|installer)(?:[/?#]|$)/i.test(lower);
}

function extractMetaContent(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${escapeRegex(key)}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name|itemprop)=["']${escapeRegex(key)}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return collapseWhitespace(decodeHtmlEntities(match[1]));
    }
  }
  return "";
}

function extractPageTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(match[1]) : "";
}

function extractUrlsFromHtml(html, baseUrl) {
  const decoded = decodeHtmlEntities(html);
  const candidates = [];
  const directPattern = /https?:\/\/[^\s"'<>\\]+/gi;
  const attrPattern = /(?:href|src|data-url|data-src|data-game-url|data-iframe|data-embed|data-embed-url)=["']([^"']+)["']/gi;
  let match = null;

  while ((match = directPattern.exec(decoded))) {
    const normalized = cleanExtractedUrl(match[0]);
    if (normalized) {
      candidates.push(normalized);
    }
  }

  while ((match = attrPattern.exec(decoded))) {
    const normalized = cleanExtractedUrl(match[1], baseUrl);
    if (normalized) {
      candidates.push(normalized);
    }
  }

  return uniqueBy(candidates, (value) => value);
}

function decodeJsEscapedText(value) {
  return String(value || "")
    .replace(/\\x([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

function extractEmbeddedHtmlSnippets(html) {
  const snippets = [];
  const seen = new Set();
  const sourceVariants = [String(html || ""), decodeHtmlEntities(String(html || ""))];
  const patterns = [
    /"userHtml"\s*:\s*"([\s\S]*?)"\s*,\s*"ncc"/gi,
    /\\x22userHtml\\x22:\s*\\x22([\s\S]*?)\\x22,\s*\\x22ncc\\x22/gi,
  ];

  sourceVariants.forEach((source) => {
    patterns.forEach((pattern) => {
      let match = null;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(source))) {
        const decoded = decodeJsEscapedText(match[1]).trim();
        if (!decoded || seen.has(decoded)) {
          continue;
        }
        seen.add(decoded);
        snippets.push(decoded);
      }
    });
  });

  return snippets;
}

function extractPlayableCandidateUrls(html, baseUrl) {
  const embeddedSnippets = extractEmbeddedHtmlSnippets(html);
  const urls = uniqueBy(
    [html, ...embeddedSnippets].flatMap((snippet) => extractUrlsFromHtml(snippet, baseUrl)),
    (value) => value,
  );
  return urls.filter((value) => !isIgnoredInfrastructureUrl(value));
}

function scoreQueryMatch(query, title, url = "") {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedTitle = normalizeSearchText(title);
  if (!normalizedQuery || !normalizedTitle) {
    return 0;
  }

  const queryTokens = tokenizeSearchText(query);
  const candidateTokens = uniqueBy([...tokenizeSearchText(title), ...tokenizeSearchText(url)], (token) => token);
  const matchingTokens = queryTokens.filter((token) => candidateTokens.includes(token));
  const looselyMatchingTokens = queryTokens.filter(
    (token) => !matchingTokens.includes(token) && candidateTokens.some((candidateToken) => roughlyMatchingTokens(token, candidateToken)),
  );
  const numericQueryTokens = queryTokens.filter((token) => /^\d+$/.test(token));
  const missingNumericTokens = numericQueryTokens.filter((token) => !candidateTokens.includes(token));
  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  const compactCandidate = normalizeSearchText(`${title} ${url}`).replace(/\s+/g, "");

  let score = matchingTokens.length * 24;
  score += looselyMatchingTokens.length * 18;
  if (normalizedTitle === normalizedQuery) {
    score += 170;
  }
  if (normalizedTitle.startsWith(normalizedQuery)) {
    score += 75;
  } else if (normalizedTitle.includes(normalizedQuery)) {
    score += 60;
  }
  if (matchingTokens.length && matchingTokens.length === queryTokens.length) {
    score += 55;
  }
  if (queryTokens.length && matchingTokens.length + looselyMatchingTokens.length === queryTokens.length) {
    score += 42;
  }
  if (compactQuery && compactCandidate.includes(compactQuery)) {
    score += 85;
  }
  score -= missingNumericTokens.length * 40;
  if (normalizedQuery.includes(normalizedTitle) && normalizedTitle.length >= 5) {
    score += 12;
  }
  return Math.max(score, 0);
}

function cleanDisplayTitle(query, rawTitle, fallbackTitle = "") {
  const titles = [rawTitle, fallbackTitle]
    .map((value) => collapseWhitespace(String(value || "")))
    .filter(Boolean);
  if (!titles.length) {
    return "Untitled";
  }

  const normalizedQuery = normalizeSearchText(query);
  const scored = titles
    .map((title) => {
      const parts = title.split(/\s+\|\s+|\s+-\s+/).map((part) => collapseWhitespace(part)).filter(Boolean);
      const titleVariants = parts.length > 1 ? parts : [title];
      let bestVariant = title;
      let bestScore = -1;
      titleVariants.forEach((variant) => {
        const variantScore = scoreQueryMatch(query, variant, "");
        if (variantScore > bestScore) {
          bestScore = variantScore;
          bestVariant = variant;
        }
      });

      const lower = normalizeSearchText(bestVariant);
      if (GENERIC_SITE_TITLES.has(lower) && parts.length > 1) {
        return { score: -1, title };
      }

      return {
        score: bestScore + (normalizeSearchText(title) === normalizedQuery ? 200 : 0),
        title: bestVariant,
      };
    })
    .sort((left, right) => right.score - left.score);

  return scored[0]?.title || titles[0];
}

function buildReason(candidate) {
  const reasons = [];
  if (candidate.provider === "override") {
    reasons.push("matched verified override");
  } else if (candidate.provider === "drive-site") {
    reasons.push(`matched ${candidate.searchSiteLabel || "drive-u-7-home-10"} first`);
  } else if (candidate.provider === "direct-host") {
    reasons.push("matched direct host fallback");
  } else if (candidate.provider === "web-search") {
    reasons.push("matched web fallback");
  }
  if (candidate.hostedOnline) {
    reasons.push("hosted online");
  }
  if (candidate.compatibilitySignals.length) {
    reasons.push(candidate.compatibilitySignals.slice(0, 3).join(", "));
  }
  return reasons.join(" | ");
}

function applyFailureHistoryMetadata(candidate) {
  const historyInfo = describeFailureRecord(candidate?.query || "", candidate?.sourceUrl || candidate?.url || "");
  const penalty = penaltyForCandidate(candidate?.query || "", candidate?.sourceUrl || candidate?.url || "");
  return {
    ...candidate,
    buildDisposition: historyInfo.buildDisposition,
    historyStatus: historyInfo.historyStatus,
    historySummary: historyInfo.historySummary,
    failureHistory: historyInfo.history,
    failureDisposition: historyInfo.disposition,
    historyPenalty: penalty,
    totalScore: Number(candidate?.totalScore || 0) - penalty,
    confidence: Math.max(0, Math.min(100, Math.round((Number(candidate?.totalScore || 0) - penalty) / 3))),
  };
}

function canonicalCandidateKey(candidate) {
  const normalized = cleanExtractedUrl(candidate?.sourceUrl || candidate?.url || "");
  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.hostname.toLowerCase()}${pathname}${parsed.search}`;
  } catch (_error) {
    return normalized.replace(/\/+$/, "").toLowerCase();
  }
}

function withReasonSuffix(candidate, suffix = "") {
  const trimmedSuffix = String(suffix || "").trim();
  if (!trimmedSuffix) {
    return candidate;
  }
  return {
    ...candidate,
    reason: candidate.reason
      ? `${candidate.reason}${trimmedSuffix}`
      : trimmedSuffix.replace(/^\s*\|\s*/, ""),
  };
}

function analyzeCandidateHtml(candidate, html) {
  const htmlLower = html.toLowerCase();
  const rawTitle =
    extractMetaContent(html, "og:title") ||
    extractMetaContent(html, "twitter:title") ||
    extractPageTitle(html) ||
    candidate.title;
  const description =
    extractMetaContent(html, "og:description") ||
    extractMetaContent(html, "description") ||
    extractMetaContent(html, "twitter:description");
  const imageUrl = cleanExtractedUrl(
    extractMetaContent(html, "og:image") || extractMetaContent(html, "twitter:image"),
    candidate.url,
  );
  const externalUrls = extractUrlsFromHtml(html, candidate.url).filter((value) => !isIgnoredInfrastructureUrl(value));
  const downloadableUrls = externalUrls.filter((value) => isDownloadUrl(value));
  const primaryBrandMatchScore = brandedHostScore(candidate.query, candidate.url);
  const externalBrandMatchScore = externalUrls.reduce(
    (best, value) => Math.max(best, brandedHostScore(candidate.query, value)),
    0,
  );
  const brandMatchScore = primaryBrandMatchScore + Math.round(externalBrandMatchScore * 0.35);
  const genericSuffixPenalty = genericHostSuffixPenalty(candidate.query, candidate.url);
  const collectionPenalty = genericCollectionPenalty(candidate.query, candidate.url, candidate.title);
  const suspiciousWrapperAssets = hasSuspiciousWrappedAsset(externalUrls, htmlLower);
  const softwarePortal = looksLikeSoftwarePortal(candidate, rawTitle, description, htmlLower);
  const blockedPage = looksLikeAccessBlockedPage(rawTitle, description, htmlLower);
  const mediaOnlyEmbeds = hasOnlyMediaEmbeds(externalUrls);
  const compatibilitySignals = [];
  let compatibilityScore = 0;

  const addCompatibility = (condition, points, label) => {
    if (!condition) {
      return;
    }
    compatibilityScore += points;
    compatibilitySignals.push(label);
  };

  addCompatibility(htmlLower.includes("createunityinstance"), 90, "Unity loader");
  addCompatibility(/\.loader\.js(?:\.(?:unityweb|gz|br))?/i.test(html), 50, "loader.js");
  addCompatibility(/\.framework\.js(?:\.(?:unityweb|gz|br))?/i.test(html), 35, "framework.js");
  addCompatibility(/\.wasm(?:\.(?:unityweb|gz|br))?/i.test(html), 30, "wasm");
  addCompatibility(/\.data(?:\.(?:unityweb|gz|br))?/i.test(html), 20, "data file");
  addCompatibility(htmlLower.includes("innerframegapiinitialized") || htmlLower.includes("updateuserhtmlframe("), 8, "Google Sites embed");
  addCompatibility(htmlLower.includes("googleusercontent.com/embeds/"), 4, "embed frame");
  addCompatibility(htmlLower.includes("<iframe"), 16, "iframe");
  addCompatibility(htmlLower.includes("<canvas"), 8, "canvas");
  addCompatibility(externalUrls.length > 0, 10, "hosted asset");
  const playableSignalScore = compatibilityScore;

  let hostedOnlineScore = 0;
  if (!downloadableUrls.length && (externalUrls.length > 0 || htmlLower.includes("<iframe") || htmlLower.includes("<canvas"))) {
    hostedOnlineScore += 40;
  }
  if (isFriendlyHostedDomain(candidate.url) || externalUrls.some((value) => isFriendlyHostedDomain(value))) {
    hostedOnlineScore += 24;
  }
  if (/unblocked|classroom|browser|html5|online/i.test(`${rawTitle} ${description}`)) {
    hostedOnlineScore += 10;
  }
  if (brandMatchScore >= 95) {
    hostedOnlineScore += 24;
  } else if (brandMatchScore >= 45) {
    hostedOnlineScore += 12;
  }
  if (genericSuffixPenalty > 0) {
    hostedOnlineScore -= genericSuffixPenalty;
  }
  if (collectionPenalty > 0) {
    hostedOnlineScore -= collectionPenalty;
    compatibilityScore -= Math.round(collectionPenalty * 0.45);
  }
  if (downloadableUrls.length) {
    hostedOnlineScore -= 55;
  }
  if (isWrapperDomain(candidate.url)) {
    hostedOnlineScore -= 40;
    compatibilityScore -= 10;
  }
  if (isPortalDomain(candidate.url)) {
    hostedOnlineScore -= 32;
    compatibilityScore -= 10;
  }
  if (candidate.provider === "drive-site" && !externalUrls.some((value) => brandedHostScore(candidate.query, value) >= 80)) {
    hostedOnlineScore -= 55;
    compatibilityScore -= 15;
  }
  if (suspiciousWrapperAssets) {
    hostedOnlineScore -= 30;
    compatibilityScore -= 45;
  }
  if (softwarePortal) {
    hostedOnlineScore -= 80;
    compatibilityScore -= 35;
  }
  if (blockedPage) {
    hostedOnlineScore -= 70;
    compatibilityScore -= 25;
  }
  if (mediaOnlyEmbeds) {
    hostedOnlineScore -= 55;
    compatibilityScore -= 30;
  }
  if (isPenalizedDomain(candidate.url)) {
    hostedOnlineScore -= 12;
    compatibilityScore -= 5;
  }

  const hostedOnline = hostedOnlineScore >= 20 && !downloadableUrls.length;
  const displayName = cleanDisplayTitle(candidate.query, rawTitle, candidate.title);
  const totalScore =
    candidate.textScore +
    compatibilityScore +
    hostedOnlineScore +
    brandMatchScore +
    (candidate.provider === "drive-site" ? 12 : 0);
  const confidence = Math.max(0, Math.min(100, Math.round(totalScore / 3)));

  const enriched = {
    ...candidate,
    sourceUrl: candidate.url,
    displayName,
    description,
    imageUrl,
    brandMatchScore,
    playableSignalScore,
    compatibilityScore,
    compatibilitySignals,
    hostedOnline,
    hostedOnlineScore,
    blockedPage,
    mediaOnlyEmbeds,
    softwarePortal,
    externalUrls: externalUrls.slice(0, 8),
    downloadableUrls,
    totalScore,
    confidence,
  };
  enriched.reason = buildReason(enriched);
  return applyFailureHistoryMetadata(enriched);
}

function makeRejectedCandidate(candidate, reason) {
  return applyFailureHistoryMetadata({
    ...candidate,
    sourceUrl: candidate.url,
    displayName: candidate.title,
    description: "",
    imageUrl: "",
    brandMatchScore: brandedHostScore(candidate.query, candidate.url),
    playableSignalScore: 0,
    compatibilityScore: 0,
    compatibilitySignals: [],
    hostedOnline: false,
    hostedOnlineScore: 0,
    externalUrls: [],
    downloadableUrls: [],
    totalScore: candidate.textScore,
    confidence: Math.max(0, Math.min(100, Math.round(candidate.textScore / 3))),
    reason,
  });
}

async function inspectCandidate(candidate, depth = 0, visited = new Set()) {
  const normalizedCandidateUrl = cleanExtractedUrl(candidate?.url || "");
  if (!normalizedCandidateUrl || visited.has(normalizedCandidateUrl)) {
    return makeRejectedCandidate(candidate, "duplicate or invalid candidate");
  }
  if (isQuerySpecificRejectedHost(candidate?.query || "", normalizedCandidateUrl)) {
    return makeRejectedCandidate(
      candidate,
      rejectionReasonForCandidate(candidate?.query || "", normalizedCandidateUrl) || "known rejected source",
    );
  }
  if (looksLikeAssetOnlyUrl(normalizedCandidateUrl)) {
    return makeRejectedCandidate(candidate, "asset file instead of a playable page");
  }
  visited.add(normalizedCandidateUrl);

  try {
    const html = await fetchText(candidate.url, {}, `Inspect ${candidate.title}`);
    const analyzed = analyzeCandidateHtml(candidate, html);
    if (depth >= 2) {
      return analyzed;
    }

    const shouldInspectChildren =
      candidate.provider === "drive-site" ||
      isWrapperDomain(candidate.url) ||
      analyzed.softwarePortal ||
      analyzed.blockedPage ||
      analyzed.mediaOnlyEmbeds ||
      analyzed.playableSignalScore < 20;
    if (!shouldInspectChildren) {
      return analyzed;
    }

    const childCandidates = extractPlayableCandidateUrls(html, candidate.url)
      .filter((value) => value !== normalizedCandidateUrl)
      .slice(0, 6)
      .map((url) => ({
        ...candidate,
        url,
      }));

    if (!childCandidates.length) {
      return analyzed;
    }

    const childResults = await Promise.all(
      childCandidates.map((child) => inspectCandidate(child, depth + 1, visited)),
    );
    return sortCandidates([analyzed, ...childResults])[0] || analyzed;
  } catch (_error) {
    return makeRejectedCandidate(candidate, "could not inspect candidate");
  }
}

function sortCandidates(candidates) {
  return [...candidates].sort((left, right) => {
    if (right.totalScore !== left.totalScore) {
      return right.totalScore - left.totalScore;
    }
    return right.textScore - left.textScore;
  });
}

function collectSuppressedCandidates(ranked, selected) {
  const selectedKeys = new Set((Array.isArray(selected) ? selected : []).map((candidate) => canonicalCandidateKey(candidate)).filter(Boolean));
  const seenKeys = new Set();
  const suppressed = [];

  (Array.isArray(ranked) ? ranked : []).forEach((candidate) => {
    const key = canonicalCandidateKey(candidate);
    if (!key || seenKeys.has(key) || selectedKeys.has(key)) {
      return;
    }
    const shouldInclude =
      candidate.buildDisposition === "reject_search" ||
      looksLikeAssetOnlyUrl(candidate?.sourceUrl || candidate?.url || "") ||
      !candidate.hostedOnline ||
      candidate.softwarePortal ||
      candidate.blockedPage ||
      candidate.mediaOnlyEmbeds;
    if (!shouldInclude) {
      return;
    }
    seenKeys.add(key);
    suppressed.push(candidate);
  });

  return suppressed;
}

function listAlternativeNames(candidates, selectedUrl = "", limit = 4) {
  return uniqueBy(
    (Array.isArray(candidates) ? candidates : []).filter(
      (item) => item?.url && item.url !== selectedUrl && item.buildDisposition !== "reject_search",
    ),
    (item) => item.url,
  )
    .slice(0, limit)
    .map((item) => item.displayName || item.title);
}

function isAcceptableSearchResult(candidate) {
  if (!candidate || !candidate.hostedOnline) {
    return false;
  }
  if (candidate.softwarePortal || candidate.blockedPage || candidate.mediaOnlyEmbeds) {
    return false;
  }
  if (candidate.playableSignalScore < 20) {
    return false;
  }
  if (candidate.brandMatchScore < 55 && candidate.compatibilityScore < 45) {
    return false;
  }
  if (candidate.provider === "drive-site") {
    return candidate.textScore >= 60 && candidate.totalScore >= 120;
  }
  return candidate.textScore >= 55 && candidate.totalScore >= 115;
}

function isFallbackSearchResult(candidate) {
  if (!candidate || !candidate.hostedOnline) {
    return false;
  }
  if (candidate.softwarePortal || candidate.blockedPage || candidate.mediaOnlyEmbeds) {
    return false;
  }
  if (
    candidate.playableSignalScore >= 20 &&
    candidate.textScore >= 40 &&
    (candidate.brandMatchScore >= 45 || candidate.compatibilityScore >= 35)
  ) {
    return true;
  }
  return (
    candidate.playableSignalScore >= 20 &&
    candidate.textScore >= 70 &&
    (candidate.brandMatchScore >= 55 || candidate.compatibilityScore >= 35)
  );
}

function isClosestPlayableSearchResult(candidate) {
  if (!candidate || !candidate.hostedOnline) {
    return false;
  }
  if (candidate.softwarePortal || candidate.blockedPage || candidate.mediaOnlyEmbeds) {
    return false;
  }
  return (
    candidate.playableSignalScore >= 20 &&
    candidate.textScore >= 35 &&
    candidate.totalScore >= 90 &&
    (candidate.brandMatchScore >= 20 || candidate.compatibilityScore >= 20)
  );
}

function isSafeBestEffortSearchResult(candidate) {
  if (!candidate) {
    return false;
  }
  if (candidate.softwarePortal || candidate.blockedPage || candidate.mediaOnlyEmbeds) {
    return false;
  }
  if (candidate.downloadableUrls?.length) {
    return false;
  }
  if (candidate.playableSignalScore < 10) {
    return false;
  }
  if (candidate.textScore < 28) {
    return false;
  }
  return candidate.totalScore >= 75 || candidate.brandMatchScore >= 45;
}

function selectRankedCandidates(candidates, limit = 1, reasonSuffix = "") {
  const ranked = sortCandidates(candidates);
  const selected = [];
  const seenKeys = new Set();

  const pushCandidates = (predicate, suffix = "", forceHostedOnline = false) => {
    ranked.forEach((candidate) => {
      if (selected.length >= limit || !predicate(candidate)) {
        return;
      }
      if (candidate.buildDisposition === "reject_search") {
        return;
      }
      if (looksLikeAssetOnlyUrl(candidate?.sourceUrl || candidate?.url || "")) {
        return;
      }
      const key = canonicalCandidateKey(candidate);
      if (!key || seenKeys.has(key)) {
        return;
      }
      seenKeys.add(key);
      selected.push(
        withReasonSuffix(
          forceHostedOnline ? { ...candidate, hostedOnline: true } : candidate,
          suffix || reasonSuffix,
        ),
      );
    });
  };

  pushCandidates((candidate) => isAcceptableSearchResult(candidate));
  pushCandidates((candidate) => isFallbackSearchResult(candidate), reasonSuffix || " | best available match");
  pushCandidates(
    (candidate) => isClosestPlayableSearchResult(candidate),
    reasonSuffix || " | closest playable match",
  );
  pushCandidates(
    (candidate) => isSafeBestEffortSearchResult(candidate),
    reasonSuffix || " | safe closest match",
    true,
  );

  return {
    candidates: selected.slice(0, limit),
    alternatives: listAlternativeNames(ranked, selected[0]?.url || ""),
    suppressed: collectSuppressedCandidates(ranked, selected),
  };
}

function mergeCandidateSelections(selections, limit = 1) {
  const selected = [];
  const seenKeys = new Set();
  const alternativeNames = [];
  const suppressed = [];

  (Array.isArray(selections) ? selections : []).forEach((selection) => {
    (selection?.candidates || []).forEach((candidate) => {
      if (selected.length >= limit) {
        return;
      }
      const key = canonicalCandidateKey(candidate);
      if (!key || seenKeys.has(key)) {
        return;
      }
      seenKeys.add(key);
      selected.push(candidate);
    });
    alternativeNames.push(...(selection?.alternatives || []));
    (selection?.suppressed || []).forEach((candidate) => {
      const key = canonicalCandidateKey(candidate);
      if (!key || seenKeys.has(key)) {
        return;
      }
      suppressed.push(candidate);
    });
  });

  return {
    candidates: selected.slice(0, limit),
    alternatives: uniqueBy(
      alternativeNames.map((name) => String(name || "").trim()).filter(Boolean),
      (name) => normalizeSearchText(name),
    ).slice(0, 6),
    suppressed: uniqueBy(suppressed, (candidate) => canonicalCandidateKey(candidate)).slice(0, 8),
  };
}

async function loadDriveSiteIndex(siteConfig) {
  const cacheEntry = driveSiteIndexCache[siteConfig.id] || {
    loadedAt: 0,
    items: [],
  };
  if (Date.now() - cacheEntry.loadedAt < SEARCH_INDEX_TTL_MS && cacheEntry.items.length) {
    return cacheEntry.items;
  }

  const html = await fetchText(siteConfig.url, {}, `Fetch ${siteConfig.label} index`);
  const anchorPattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const results = [];
  let match = null;

  while ((match = anchorPattern.exec(html))) {
    const href = cleanExtractedUrl(match[1], siteConfig.url);
    if (!href || !href.includes(siteConfig.prefix)) {
      continue;
    }
    const title = stripTags(match[2]);
    if (!title || GENERIC_SITE_TITLES.has(normalizeSearchText(title))) {
      continue;
    }
    results.push({
      provider: "drive-site",
      searchSiteId: siteConfig.id,
      searchSiteLabel: siteConfig.label,
      title,
      url: href,
    });
  }

  driveSiteIndexCache[siteConfig.id] = {
    loadedAt: Date.now(),
    items: uniqueBy(results, (item) => item.url),
  };
  return driveSiteIndexCache[siteConfig.id].items;
}

async function searchDriveSite(query) {
  const queryVariants = buildQueryVariants(query);
  const siteItems = await Promise.all(
    PREFERRED_SEARCH_SITES.map(async (siteConfig) => {
      try {
        const items = await loadDriveSiteIndex(siteConfig);
        const ranked = [];
        queryVariants.forEach((variant) => {
          items.forEach((item) => {
            const variantScore = scoreQueryMatch(variant, item.title, item.url);
          const queryScore = scoreQueryMatch(query, item.title, item.url);
          const textScore = Math.max(queryScore, variantScore);
          if (textScore < SEARCHABLE_SITE_MATCH_FLOOR) {
            return;
          }
          ranked.push({
            ...item,
            query,
            textScore,
          });
        });
        });
        return uniqueBy(ranked, (item) => item.url)
          .sort((left, right) => right.textScore - left.textScore)
          .slice(0, MAX_SITE_CANDIDATES);
      } catch (_error) {
        return [];
      }
    }),
  );
  const ranked = siteItems.flat().sort((left, right) => right.textScore - left.textScore).slice(0, MAX_SITE_CANDIDATES);

  if (!ranked.length) {
    return [];
  }

  const inspected = await Promise.all(ranked.map((candidate) => inspectCandidate(candidate)));
  return sortCandidates(inspected);
}

function unwrapDuckDuckGoUrl(rawUrl) {
  const normalized = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
  try {
    const parsed = new URL(normalized, DUCKDUCKGO_HTML_URL);
    const unwrapped = parsed.searchParams.get("uddg");
    return unwrapped ? decodeURIComponent(unwrapped) : parsed.toString();
  } catch (_error) {
    return "";
  }
}

function decodeBase64Loose(value) {
  try {
    const normalized = String(value || "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return atob(padded);
  } catch (_error) {
    return "";
  }
}

function unwrapBingUrl(rawUrl) {
  const normalized = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
  try {
    const parsed = new URL(normalized, BING_SEARCH_URL);
    if (parsed.hostname === "www.bing.com" && parsed.pathname.startsWith("/ck/")) {
      const encodedTarget = parsed.searchParams.get("u") || "";
      if (/^a1/i.test(encodedTarget)) {
        const decoded = decodeBase64Loose(encodedTarget.slice(2));
        const cleanDecoded = cleanExtractedUrl(decoded);
        if (cleanDecoded) {
          return cleanDecoded;
        }
      }
    }
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

function extractDuckDuckGoMatches(html, query) {
  const resultPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const matches = [];
  let match = null;
  resultPattern.lastIndex = 0;

  while ((match = resultPattern.exec(html))) {
    const resultUrl = unwrapDuckDuckGoUrl(match[1]);
    const title = stripTags(match[2]);
    if (!resultUrl || !title || isDownloadUrl(resultUrl) || isIgnoredInfrastructureUrl(resultUrl)) {
      continue;
    }
    matches.push({
      provider: "web-search",
      query,
      title,
      url: resultUrl,
      textScore: scoreQueryMatch(query, title, resultUrl),
    });
  }

  return matches;
}

function extractBingMatches(html, query) {
  const resultPattern = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/gi;
  const matches = [];
  let match = null;
  resultPattern.lastIndex = 0;

  while ((match = resultPattern.exec(html))) {
    const resultUrl = unwrapBingUrl(decodeHtmlEntities(match[1]));
    const title = stripTags(match[2]);
    if (!resultUrl || !title || isDownloadUrl(resultUrl) || isIgnoredInfrastructureUrl(resultUrl)) {
      continue;
    }
    matches.push({
      provider: "web-search",
      query,
      title,
      url: resultUrl,
      textScore: scoreQueryMatch(query, title, resultUrl),
    });
  }

  return matches;
}

function extractBraveMatches(html, query) {
  const resultPattern =
    /<div class="snippet[\s\S]*?data-type="web"[\s\S]*?<a href="([^"]+)"[^>]*class="[^"]*\bl1\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const matches = [];
  let match = null;
  resultPattern.lastIndex = 0;

  while ((match = resultPattern.exec(html))) {
    const resultUrl = cleanExtractedUrl(decodeHtmlEntities(match[1]));
    const title = stripTags(match[2]);
    if (!resultUrl || !title || isDownloadUrl(resultUrl) || isIgnoredInfrastructureUrl(resultUrl)) {
      continue;
    }
    matches.push({
      provider: "web-search",
      query,
      title,
      url: resultUrl,
      textScore: scoreQueryMatch(query, title, resultUrl),
    });
  }

  return matches;
}

function buildDirectHostCandidates(query) {
  const compactQuery = compactSearchText(query);
  if (!compactQuery || compactQuery.length < 5) {
    return [];
  }

  return uniqueBy(
    DIRECT_HOST_SUFFIXES.map((suffix) => `https://${compactQuery}${suffix.startsWith(".") ? suffix : `.${suffix}`}/`),
    (value) => value,
  );
}

async function searchDirectHostHeuristic(query) {
  const directHosts = buildDirectHostCandidates(query);
  if (!directHosts.length) {
    return [];
  }

  const inspected = await Promise.all(
    directHosts.map((url) =>
      inspectCandidate({
        provider: "direct-host",
        query,
        title: query,
        url,
        textScore: scoreQueryMatch(query, query, url),
      }),
    ),
  );

  return sortCandidates(
    inspected.filter((candidate) => candidate && !candidate.softwarePortal && !candidate.blockedPage),
  );
}

async function searchVerifiedOverrides(query) {
  const overrides = searchOverridesForQuery(query);
  if (!overrides.length) {
    return [];
  }

  const inspected = await Promise.all(
    overrides.map(async (item) => {
      const originalUrl = item.url;
      const analyzed = await inspectCandidate({
        provider: "override",
        query,
        title: item.title,
        url: originalUrl,
        textScore: Math.max(Number(item.textScore) || 0, scoreQueryMatch(query, item.title, item.url)),
      });
      if (!analyzed) {
        return null;
      }
      return {
        ...analyzed,
        provider: "override",
        title: item.title || analyzed.title,
        url: originalUrl,
        sourceUrl: originalUrl,
      };
    }),
  );

  return sortCandidates(
    inspected.filter((candidate) => candidate && !candidate.softwarePortal && !candidate.blockedPage),
  );
}

async function searchWebFallback(query) {
  const rawMatches = [];
  const searchTerms = buildWebSearchTerms(query);

  for (const searchTerm of searchTerms.slice(0, 5)) {
    const searchUrl = new URL(DUCKDUCKGO_HTML_URL);
    searchUrl.searchParams.set("q", searchTerm);
    try {
      const html = await fetchText(searchUrl.toString(), {}, "Search web fallback");
      rawMatches.push(...extractDuckDuckGoMatches(html, query));
    } catch (_error) {
      // DuckDuckGo blocks aggressively; fall through to the next provider.
    }
    if (rawMatches.length >= MAX_WEB_CANDIDATES * 2) {
      break;
    }
  }

  for (const searchTerm of searchTerms.slice(0, 5)) {
    const searchUrl = new URL(BING_SEARCH_URL);
    searchUrl.searchParams.set("q", searchTerm);
    try {
      const html = await fetchText(searchUrl.toString(), {}, "Search Bing fallback");
      rawMatches.push(...extractBingMatches(html, query));
    } catch (_error) {
      // Continue; another search term or provider may still return results.
    }
    if (rawMatches.length >= MAX_WEB_CANDIDATES * 3) {
      break;
    }
  }

  for (const searchTerm of searchTerms.slice(0, 5)) {
    const searchUrl = new URL(BRAVE_SEARCH_URL);
    searchUrl.searchParams.set("q", searchTerm);
    searchUrl.searchParams.set("source", "web");
    try {
      const html = await fetchText(searchUrl.toString(), {}, "Search Brave fallback");
      rawMatches.push(...extractBraveMatches(html, query));
    } catch (_error) {
      // Continue; another search term or provider may still return results.
    }
    if (rawMatches.length >= MAX_WEB_CANDIDATES * 4) {
      break;
    }
  }

  const ranked = uniqueBy(rawMatches, (item) => item.url)
    .filter(
      (item) =>
        item.textScore >= 30 &&
        !isPenalizedDomain(item.url) &&
        !looksLikeAssetOnlyUrl(item.url) &&
        !rejectionReasonForCandidate(query, item.url),
    )
    .sort((left, right) => right.textScore - left.textScore)
    .slice(0, MAX_WEB_CANDIDATES);

  if (!ranked.length) {
    return [];
  }

  const inspected = await Promise.all(ranked.map((candidate) => inspectCandidate(candidate)));
  return sortCandidates(inspected);
}

async function findSearchResults(query, limit = 1) {
  const driveCandidates = await searchDriveSite(query);
  const overrideCandidates = await searchVerifiedOverrides(query);
  if (overrideCandidates.length) {
    const verifiedPreferred = selectRankedCandidates(
      sortCandidates([...overrideCandidates, ...driveCandidates]),
      limit,
      driveCandidates.length ? " | verified preferred match" : " | verified fallback",
    );
    if (verifiedPreferred.candidates.length >= limit) {
      return verifiedPreferred;
    }
  }

  const driveResult = selectRankedCandidates(
    driveCandidates,
    limit,
    " | preferred Google Sites match",
  );
  if (driveResult.candidates.length >= limit) {
    return driveResult;
  }

  const overrideResult = selectRankedCandidates(
    sortCandidates([...driveCandidates, ...overrideCandidates]),
    limit,
    " | verified fallback",
  );
  if (overrideResult.candidates.length >= limit) {
    return mergeCandidateSelections([driveResult, overrideResult], limit);
  }

  const directHostCandidates = await searchDirectHostHeuristic(query);
  const directHostResult = selectRankedCandidates(
    sortCandidates([...driveCandidates, ...overrideCandidates, ...directHostCandidates]),
    limit,
    " | direct host fallback",
  );
  if (directHostResult.candidates.length >= limit) {
    return mergeCandidateSelections([driveResult, overrideResult, directHostResult], limit);
  }

  const webCandidates = await searchWebFallback(query);
  const combined = sortCandidates([...driveCandidates, ...overrideCandidates, ...directHostCandidates, ...webCandidates]);
  const webResult = selectRankedCandidates(combined, limit);
  return mergeCandidateSelections([driveResult, overrideResult, directHostResult, webResult], limit);
}

async function findBestSearchResult(query) {
  const result = await findSearchResults(query, 1);
  return {
    candidate: result.candidates[0] || null,
    alternatives: result.alternatives || [],
  };
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64Utf8(value) {
  const normalized = String(value || "").replace(/\s+/g, "");
  if (!normalized) {
    return "";
  }
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

async function readGitHubTextFile(path, env, branch = env.GITHUB_REF || "main", label = "Read text file") {
  const url = `${githubApiBase(env)}/contents/${encodeGitHubPath(path)}?ref=${encodeURIComponent(branch)}`;
  const payload = await githubJsonOrNull(url, env, {}, label);
  if (!payload) {
    return {
      sha: "",
      text: "",
    };
  }
  return {
    sha: String(payload.sha || ""),
    text: decodeBase64Utf8(payload.content || ""),
  };
}

async function writeGitHubTextFile(path, text, message, env, sha = "", branch = env.GITHUB_REF || "main", label = "Write text file") {
  const url = `${githubApiBase(env)}/contents/${encodeGitHubPath(path)}`;
  const body = {
    message,
    content: encodeBase64Utf8(text),
    branch,
  };
  if (sha) {
    body.sha = sha;
  }

  await githubJson(
    url,
    env,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    label,
  );
}

function sanitizePagesStatePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

async function readGitReference(branch, env) {
  return githubJson(
    `${githubApiBase(env)}/git/ref/heads/${encodeURIComponent(branch)}`,
    env,
    {},
    "Read git ref",
  );
}

async function readGitCommit(commitSha, env) {
  return githubJson(
    `${githubApiBase(env)}/git/commits/${encodeURIComponent(commitSha)}`,
    env,
    {},
    "Read git commit",
  );
}

async function readGitTree(treeSha, env, recursive = false) {
  const suffix = recursive ? "?recursive=1" : "";
  return githubJson(
    `${githubApiBase(env)}/git/trees/${encodeURIComponent(treeSha)}${suffix}`,
    env,
    {},
    "Read git tree",
  );
}

async function createGitBlob(text, env) {
  return githubJson(
    `${githubApiBase(env)}/git/blobs`,
    env,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: String(text || ""),
        encoding: "utf-8",
      }),
    },
    "Create git blob",
  );
}

async function createGitTree(baseTreeSha, entries, env) {
  return githubJson(
    `${githubApiBase(env)}/git/trees`,
    env,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: entries,
      }),
    },
    "Create git tree",
  );
}

async function createGitCommit(message, treeSha, parentCommitSha, env) {
  return githubJson(
    `${githubApiBase(env)}/git/commits`,
    env,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        tree: treeSha,
        parents: [parentCommitSha],
      }),
    },
    "Create git commit",
  );
}

async function updateGitReference(branch, commitSha, env) {
  return githubJson(
    `${githubApiBase(env)}/git/refs/heads/${encodeURIComponent(branch)}`,
    env,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sha: commitSha,
        force: false,
      }),
    },
    "Update git ref",
  );
}

async function commitPagesStateDeletion(branch, catalogText, folderPrefix, message, env) {
  const normalizedFolderPrefix = sanitizePagesStatePath(folderPrefix);
  const ref = await readGitReference(branch, env);
  const parentCommitSha = String(ref?.object?.sha || "").trim();
  if (!parentCommitSha) {
    throw new Error(`Pages state branch ${branch} has no commit SHA.`);
  }

  const parentCommit = await readGitCommit(parentCommitSha, env);
  const baseTreeSha = String(parentCommit?.tree?.sha || "").trim();
  if (!baseTreeSha) {
    throw new Error(`Pages state branch ${branch} has no tree SHA.`);
  }

  const recursiveTree = await readGitTree(baseTreeSha, env, true);
  const treeItems = Array.isArray(recursiveTree?.tree) ? recursiveTree.tree : [];
  const deleteEntries = normalizedFolderPrefix
    ? treeItems
        .filter((item) => String(item?.type || "") === "blob")
        .filter((item) => {
          const itemPath = sanitizePagesStatePath(item?.path || "");
          return itemPath === normalizedFolderPrefix || itemPath.startsWith(`${normalizedFolderPrefix}/`);
        })
        .map((item) => ({
          path: sanitizePagesStatePath(item.path || ""),
          mode: String(item.mode || "100644"),
          type: String(item.type || "blob"),
          sha: null,
        }))
    : [];

  const catalogBlob = await createGitBlob(catalogText, env);
  const catalogBlobSha = String(catalogBlob?.sha || "").trim();
  if (!catalogBlobSha) {
    throw new Error("Could not create updated catalog blob.");
  }

  const nextTree = await createGitTree(
    baseTreeSha,
    [
      {
        path: PUBLISHED_GAMES_FILE_PATH,
        mode: "100644",
        type: "blob",
        sha: catalogBlobSha,
      },
      ...deleteEntries,
    ],
    env,
  );
  const nextTreeSha = String(nextTree?.sha || "").trim();
  if (!nextTreeSha) {
    throw new Error("Could not create updated Pages state tree.");
  }

  const nextCommit = await createGitCommit(message, nextTreeSha, parentCommitSha, env);
  const nextCommitSha = String(nextCommit?.sha || "").trim();
  if (!nextCommitSha) {
    throw new Error("Could not create updated Pages state commit.");
  }

  await updateGitReference(branch, nextCommitSha, env);
  return {
    deletedFileCount: deleteEntries.length,
    commitSha: nextCommitSha,
  };
}

function sanitizeReportValue(value) {
  return collapseWhitespace(String(value || "").replace(/[|\r\n]+/g, " "));
}

function sanitizeLogSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "failed-build";
}

async function findRecentRun(env, submittedAtIso, requestId = "") {
  const submittedAt = Date.parse(submittedAtIso);
  const normalizedRequestId = String(requestId || "").trim();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const runs = await listWorkflowRuns(env, {
      perPage: normalizedRequestId ? 50 : 20,
      maxPages: normalizedRequestId ? 3 : 1,
    });
    if (normalizedRequestId) {
      const exactMatch = runs.find((run) => runMatchesRequestId(run, normalizedRequestId));
      if (exactMatch) {
        return exactMatch;
      }
      await sleep(1500);
      continue;
    }

    const recentRuns = runs.filter((run) => {
      const createdAt = Date.parse(run.created_at || "");
      return Number.isFinite(createdAt) && createdAt >= submittedAt - 5000;
    });
    if (recentRuns.length) {
      return recentRuns[0];
    }
    await sleep(1500);
  }

  throw new Error("Workflow was dispatched, but no matching run was found yet.");
}

async function dispatchWorkflowRun(env, sourceUrl, displayName, requestId) {
  const dispatchUrl = `${githubApiBase(env)}/actions/workflows/${encodeURIComponent(workflowFile(env))}/dispatches`;
  const submittedAtIso = new Date().toISOString();
  await githubNoContent(
    dispatchUrl,
    env,
    {
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
    },
    "Dispatch workflow",
  );

  return findRecentRun(env, submittedAtIso, requestId);
}

async function findRunByRequestId(env, requestId) {
  const normalizedRequestId = String(requestId || "").trim();
  if (!normalizedRequestId) {
    return null;
  }

  const runs = await listWorkflowRuns(env, { perPage: 50, maxPages: 3 });
  return runs.find((run) => runMatchesRequestId(run, normalizedRequestId)) || null;
}

async function waitForRunByRequestId(env, requestId, attempts = 12, delayMs = 1500) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const run = await findRunByRequestId(env, requestId);
    if (run) {
      return run;
    }
    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }
  return null;
}

function workflowRunsUrl(env, perPage = 25, page = 1) {
  return (
    `${githubApiBase(env)}/actions/workflows/${encodeURIComponent(workflowFile(env))}/runs` +
    `?event=workflow_dispatch&branch=${encodeURIComponent(env.GITHUB_REF || "main")}` +
    `&per_page=${encodeURIComponent(String(perPage || 25))}` +
    `&page=${encodeURIComponent(String(page || 1))}`
  );
}

function runMatchesRequestId(run, requestId) {
  const normalizedRequestId = String(requestId || "").trim();
  if (!normalizedRequestId) {
    return false;
  }
  const displayTitle = String(run?.display_title || "").trim();
  const runName = String(run?.name || "").trim();
  return displayTitle === normalizedRequestId || runName === normalizedRequestId;
}

async function listWorkflowRuns(env, options = {}) {
  const perPage = Math.min(Math.max(Number(options?.perPage) || 25, 1), 100);
  const maxPages = Math.min(Math.max(Number(options?.maxPages) || 1, 1), 5);
  const runs = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await githubJson(
      workflowRunsUrl(env, perPage, page),
      env,
      {},
      "List workflow runs",
    );
    const pageRuns = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
    runs.push(...pageRuns);
    if (pageRuns.length < perPage) {
      break;
    }
  }

  return runs;
}

async function cancelWorkflowRun(env, runId) {
  await githubNoContent(
    `${githubApiBase(env)}/actions/runs/${encodeURIComponent(String(runId || "").trim())}/cancel`,
    env,
    {
      method: "POST",
    },
    "Cancel workflow run",
  );
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

async function handleSearch(request, env) {
  const url = new URL(request.url);
  const query = collapseWhitespace(url.searchParams.get("query") || "");
  const requestedLimit = Number.parseInt(String(url.searchParams.get("limit") || "1"), 10);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 1, 1), MAX_SEARCH_RESPONSE_LIMIT);
  if (!query) {
    return json(
      { error: "query is required." },
      {
        status: 400,
        headers: corsHeaders(request, env),
      },
    );
  }

  const result = await findSearchResults(query, limit);
  if (!result.candidates.length) {
    const alternatives = result.alternatives.length ? ` Closest matches: ${result.alternatives.join(", ")}.` : "";
    return json(
      { error: `No compatible hosted result was found for "${query}".${alternatives}` },
      {
        status: 404,
        headers: corsHeaders(request, env),
      },
    );
  }

  const payload = buildSearchPayload(query, result, limit);

  return json(payload, {
    headers: corsHeaders(request, env),
  });
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

  const run = await dispatchWorkflowRun(env, sourceUrl, displayName, requestId);
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

async function handleCancel(request, env) {
  validateEnv(env);
  const body = await request.json().catch(() => null);
  const runId = String(body?.runId || "").trim();
  const requestId = String(body?.requestId || "").trim();
  if (!runId && !requestId) {
    return json(
      { error: "runId or requestId is required." },
      {
        status: 400,
        headers: corsHeaders(request, env),
      },
    );
  }

  const run = runId
    ? await githubJsonOrNull(
        `${githubApiBase(env)}/actions/runs/${encodeURIComponent(runId)}`,
        env,
        {},
        "Get workflow run",
      )
    : await waitForRunByRequestId(env, requestId);

  if (!run) {
    return json(
      {
        ok: true,
        cancelled: false,
        found: false,
        requestId,
        runId: "",
      },
      {
        headers: corsHeaders(request, env),
      },
    );
  }

  const runStatus = String(run?.status || "").trim();
  const runConclusion = String(run?.conclusion || "").trim();
  if (runStatus === "completed") {
    return json(
      {
        ok: true,
        cancelled: runConclusion === "cancelled",
        found: true,
        alreadyCompleted: true,
        requestId,
        runId: String(run?.id || "").trim(),
        conclusion: runConclusion,
      },
      {
        headers: corsHeaders(request, env),
      },
    );
  }

  await cancelWorkflowRun(env, run.id);
  return json(
    {
      ok: true,
      cancelled: true,
      found: true,
      requestId,
      runId: String(run?.id || "").trim(),
    },
    {
      headers: corsHeaders(request, env),
    },
  );
}

async function handleDelete(request, env) {
  validateEnv(env);
  const body = await request.json().catch(() => null);
  const entryId = sanitizeReportValue(body?.entryId);
  const requestedFolder = sanitizePagesStatePath(body?.folder);
  const requestId = sanitizeReportValue(body?.requestId) || `delete-${entryId}-${Date.now()}`;
  if (!entryId) {
    return json(
      { error: "entryId is required." },
      {
        status: 400,
        headers: corsHeaders(request, env),
      },
    );
  }

  const branch = pagesStateRef(env);
  const existing = await readGitHubTextFile(
    PUBLISHED_GAMES_FILE_PATH,
    env,
    branch,
    "Read published games catalog",
  );
  if (!existing.text.trim()) {
    return json(
      { error: "Published games catalog was not found on the Pages state branch." },
      {
        status: 404,
        headers: corsHeaders(request, env),
      },
    );
  }

  let catalog = {};
  try {
    catalog = JSON.parse(existing.text);
  } catch (_error) {
    throw new Error("Published games catalog is invalid JSON.");
  }

  const games = Array.isArray(catalog?.games) ? catalog.games : [];
  const targetGame = games.find((game) => String(game?.id || "").trim() === entryId) || null;
  const nextGames = games.filter((game) => String(game?.id || "").trim() !== entryId);
  if (!targetGame || nextGames.length === games.length) {
    return json(
      { error: `Game ${entryId} was not found.` },
      {
        status: 404,
        headers: corsHeaders(request, env),
      },
    );
  }

  const folderPrefix =
    requestedFolder ||
    sanitizePagesStatePath(targetGame?.folder) ||
    sanitizePagesStatePath(`games/${entryId}`);
  const nextCatalogText = `${JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      games: nextGames,
    },
    null,
    2,
  )}\n`;

  const deletionSummary = await commitPagesStateDeletion(
    branch,
    nextCatalogText,
    folderPrefix,
    `Remove ${entryId} from published games`,
    env,
  );

  const run = await dispatchWorkflowRun(env, "", "", requestId);
  return json(
    {
      ok: true,
      entryId,
      folder: folderPrefix,
      deletedFileCount: Number(deletionSummary?.deletedFileCount || 0),
      runId: run.id,
      htmlUrl: run.html_url,
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
  const requestId = String(url.searchParams.get("requestId") || "").trim();
  if (!runId && !requestId) {
    return json(
      { error: "runId or requestId is required." },
      {
        status: 400,
        headers: corsHeaders(request, env),
      },
    );
  }

  const run = runId
    ? await githubJson(`${githubApiBase(env)}/actions/runs/${encodeURIComponent(runId)}`, env, {}, "Get workflow run")
    : await findRunByRequestId(env, requestId);
  if (!run) {
    return json(
      {
        owner: env.GITHUB_OWNER,
        repo: env.GITHUB_REPO,
        ref: env.GITHUB_REF || "main",
        requestId,
        run: null,
        jobs: {
          total_count: 0,
          jobs: [],
        },
      },
      {
        headers: corsHeaders(request, env),
      },
    );
  }

  const jobs = await githubJson(
    `${githubApiBase(env)}/actions/runs/${encodeURIComponent(String(run?.id || runId))}/jobs?per_page=100`,
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

function formatFailureLogSection(job, logText) {
  const lines = [
    `Job: ${String(job?.name || job?.id || "unknown")}`,
    `id: ${String(job?.id || "")}`,
    `status: ${String(job?.status || "")}`,
    `conclusion: ${String(job?.conclusion || "")}`,
    `started_at: ${String(job?.started_at || "")}`,
    `completed_at: ${String(job?.completed_at || "")}`,
    "steps:",
  ];

  (Array.isArray(job?.steps) ? job.steps : []).forEach((step) => {
    lines.push(
      `- ${String(step?.name || "").trim()} | status=${String(step?.status || "")} | conclusion=${String(step?.conclusion || "")}`,
    );
  });
  lines.push("", "full_log:");
  lines.push(logText || "<no log text>");
  return lines.join("\n");
}

async function buildFailureLogText(body, env) {
  const runId = String(body?.runId || "").trim();
  const summaryLines = [
    `logged_at: ${new Date().toISOString()}`,
    `request_id: ${sanitizeReportValue(body?.requestId) || "-"}`,
    `batch_id: ${sanitizeReportValue(body?.batchId) || "-"}`,
    `batch_label: ${sanitizeReportValue(body?.batchLabel) || "-"}`,
    `candidate_rank: ${sanitizeReportValue(body?.candidateRank) || "-"}`,
    `candidate_total: ${sanitizeReportValue(body?.candidateTotal) || "-"}`,
    `display_name: ${sanitizeReportValue(body?.displayName) || "-"}`,
    `matched_name: ${sanitizeReportValue(body?.matchedName) || "-"}`,
    `source_input: ${sanitizeReportValue(body?.sourceInput) || "-"}`,
    `source_url: ${sanitizeReportValue(body?.sourceUrl) || "-"}`,
    `source_mode: ${sanitizeReportValue(body?.sourceMode) || "-"}`,
    `candidate_reason: ${sanitizeReportValue(body?.candidateReason) || "-"}`,
    `candidate_confidence: ${sanitizeReportValue(body?.candidateConfidence) || "-"}`,
    `status: ${sanitizeReportValue(body?.status) || "-"}`,
    `conclusion: ${sanitizeReportValue(body?.conclusion) || "-"}`,
    `phase: ${sanitizeReportValue(body?.phase) || "-"}`,
    `error: ${sanitizeReportValue(body?.error) || "-"}`,
    `run_id: ${runId || "-"}`,
    `run_url: ${sanitizeReportValue(body?.runUrl) || "-"}`,
    `html_url: ${sanitizeReportValue(body?.htmlUrl) || "-"}`,
    `jobs_url: ${sanitizeReportValue(body?.jobsUrl) || "-"}`,
    `failed_at: ${sanitizeReportValue(body?.failedAt) || "-"}`,
  ];

  if (!runId) {
    return {
      logText: `${summaryLines.join("\n")}\n`,
      run: null,
      jobs: null,
    };
  }

  const run = await githubJson(`${githubApiBase(env)}/actions/runs/${encodeURIComponent(runId)}`, env, {}, "Get workflow run");
  const jobsPayload = await githubJson(
    `${githubApiBase(env)}/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=100`,
    env,
    {},
    "List workflow jobs",
  );
  const jobEntries = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : [];
  const logSections = [];

  for (const job of jobEntries) {
    let logText = "";
    try {
      logText = await githubText(
        `${githubApiBase(env)}/actions/jobs/${encodeURIComponent(String(job?.id || ""))}/logs`,
        env,
        {},
        `Download job logs for ${String(job?.name || job?.id || "job")}`,
      );
    } catch (error) {
      logText = `<could not download logs: ${error instanceof Error ? error.message : "unknown error"}>`;
    }
    logSections.push(formatFailureLogSection(job, logText));
  }

  return {
    logText: [
      summaryLines.join("\n"),
      "",
      "run_payload:",
      JSON.stringify(run, null, 2),
      "",
      "jobs_payload:",
      JSON.stringify(jobsPayload, null, 2),
      "",
      "job_logs:",
      logSections.join("\n\n====================\n\n"),
      "",
    ].join("\n"),
    run,
    jobs: jobsPayload,
  };
}

async function handleLogFailure(request, env) {
  validateEnv(env);
  const body = await request.json().catch(() => null);
  const requestId = sanitizeReportValue(body?.requestId) || `failed-build-${Date.now()}`;
  const displayName = sanitizeReportValue(body?.displayName) || "generated game";
  const sourceUrl = sanitizeReportValue(body?.sourceUrl) || "-";
  const runId = sanitizeReportValue(body?.runId) || "-";
  const errorText = sanitizeReportValue(body?.error) || sanitizeReportValue(body?.conclusion) || "failure";
  const slugBase = sanitizeLogSlug(requestId || runId || displayName);
  const detailPath = `${FAILED_BUILD_LOGS_DIR}/${slugBase}.txt`;
  const detailExisting = await readGitHubTextFile(detailPath, env);
  const { logText } = await buildFailureLogText(body, env);

  await writeGitHubTextFile(
    detailPath,
    logText,
    `Log failed build for ${displayName}`,
    env,
    detailExisting.sha,
    env.GITHUB_REF || "main",
    "Write failed build detail log",
  );

  const summaryExisting = await readGitHubTextFile(FAILED_BUILDS_FILE_PATH, env);
  const lines = [summaryExisting.text.trimEnd()];
  if (!summaryExisting.text.trim()) {
    lines.length = 0;
    lines.push(FAILED_BUILD_FILE_HEADER.trimEnd());
  }
  const marker = `request_id=${requestId}`;
  if (!summaryExisting.text.includes(marker)) {
    lines.push([
      new Date().toISOString(),
      marker,
      `display_name=${displayName}`,
      `source_url=${sourceUrl}`,
      `run_id=${runId}`,
      `error=${errorText}`,
      `detail_path=${detailPath}`,
    ].join(" | "));
    await writeGitHubTextFile(
      FAILED_BUILDS_FILE_PATH,
      `${lines.filter(Boolean).join("\n")}\n`,
      `Index failed build for ${displayName}`,
      env,
      summaryExisting.sha,
      env.GITHUB_REF || "main",
      "Write failed build summary",
    );
  }

  return json(
    {
      ok: true,
      requestId,
      detailPath,
      summaryPath: FAILED_BUILDS_FILE_PATH,
    },
    {
      headers: corsHeaders(request, env),
    },
  );
}

async function handleReport(request, env) {
  validateEnv(env);
  const body = await request.json().catch(() => null);
  const entryId = sanitizeReportValue(body?.entryId);
  const title = sanitizeReportValue(body?.title);
  const playPath = sanitizeReportValue(body?.playPath);
  const sourceUrl = sanitizeReportValue(body?.sourceUrl);

  if (!entryId && !title && !sourceUrl) {
    return json(
      { error: "entryId, title, or sourceUrl is required." },
      {
        status: 400,
        headers: corsHeaders(request, env),
      },
    );
  }

  const existing = await readGitHubTextFile(REPORTS_FILE_PATH, env);
  const lines = [existing.text.trimEnd()];
  if (!existing.text.trim()) {
    lines.length = 0;
    lines.push(REPORT_FILE_HEADER.trimEnd());
  }
  lines.push([
    new Date().toISOString(),
    `id=${entryId || "-"}`,
    `title=${title || "-"}`,
    `play=${playPath || "-"}`,
    `source=${sourceUrl || "-"}`,
  ].join(" | "));

  await writeGitHubTextFile(
    REPORTS_FILE_PATH,
    `${lines.filter(Boolean).join("\n")}\n`,
    `Add not-working report for ${title || entryId || "generated game"}`,
    env,
    existing.sha,
    env.GITHUB_REF || "main",
    "Write report file",
  );

  return json(
    {
      ok: true,
      filePath: REPORTS_FILE_PATH,
      title: title || entryId || "generated game",
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
      if (request.method === "GET" && url.pathname === "/search") {
        return await handleSearch(request, env);
      }
      if (request.method === "POST" && url.pathname === "/dispatch") {
        return await handleDispatch(request, env);
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return await handleStatus(request, env);
      }
      if (request.method === "POST" && url.pathname === "/report") {
        return await handleReport(request, env);
      }
      if (request.method === "POST" && url.pathname === "/delete") {
        return await handleDelete(request, env);
      }
      if (request.method === "POST" && url.pathname === "/cancel") {
        return await handleCancel(request, env);
      }
      if (request.method === "POST" && url.pathname === "/log-failure") {
        return await handleLogFailure(request, env);
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

export { findBestSearchResult, findSearchResults };
