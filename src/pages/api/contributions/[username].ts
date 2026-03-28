import type { APIRoute } from "astro";

export const prerender = false;

const USERNAME_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const REQUEST_TIMEOUT_MS = 8000;

type CacheEntry = {
  data: unknown;
  expiresAt: number;
};

const contributionCache = new Map<string, CacheEntry>();

const baseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control":
    "public, max-age=300, s-maxage=300, stale-while-revalidate=60",
};

const createJsonResponse = (
  body: unknown,
  status: number,
  extraHeaders?: HeadersInit,
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...baseHeaders,
      ...(extraHeaders ?? {}),
    },
  });

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const trimCache = () => {
  if (contributionCache.size <= MAX_CACHE_ENTRIES) {
    return;
  }

  const oldestKey = contributionCache.keys().next().value;
  if (oldestKey) {
    contributionCache.delete(oldestKey);
  }
};

export const GET: APIRoute = async ({ params }) => {
  const username = params.username?.trim();
  if (!username || !USERNAME_PATTERN.test(username)) {
    return createJsonResponse({ error: "Invalid GitHub username." }, 400, {
      "X-Cache": "SKIP",
    });
  }

  const cacheKey = username.toLowerCase();
  const now = Date.now();
  const cached = contributionCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return createJsonResponse(cached.data, 200, { "X-Cache": "HIT" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(
      `https://github.com/${encodeURIComponent(username)}.contribs`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "mona-mayhem/1.0",
        },
        signal: controller.signal,
      },
    );

    if (upstreamResponse.status === 404) {
      return createJsonResponse({ error: "GitHub user not found." }, 404, {
        "X-Cache": "MISS",
      });
    }

    if (!upstreamResponse.ok) {
      return createJsonResponse(
        {
          error: "GitHub upstream request failed.",
          upstreamStatus: upstreamResponse.status,
        },
        502,
        { "X-Cache": "MISS" },
      );
    }

    let payload: unknown;
    try {
      payload = await upstreamResponse.json();
    } catch {
      return createJsonResponse(
        { error: "Invalid JSON received from GitHub." },
        502,
        { "X-Cache": "MISS" },
      );
    }

    contributionCache.set(cacheKey, {
      data: payload,
      expiresAt: now + CACHE_TTL_MS,
    });
    trimCache();

    return createJsonResponse(payload, 200, { "X-Cache": "MISS" });
  } catch (error) {
    if (cached) {
      return createJsonResponse(cached.data, 200, {
        Warning: "110 - Response is stale",
        "X-Cache": "STALE",
      });
    }

    if (isAbortError(error)) {
      return createJsonResponse(
        { error: "GitHub upstream request timed out." },
        504,
        { "X-Cache": "MISS" },
      );
    }

    return createJsonResponse(
      { error: "Failed to fetch contributions from GitHub." },
      502,
      {
        "X-Cache": "MISS",
      },
    );
  } finally {
    clearTimeout(timeout);
  }
};
