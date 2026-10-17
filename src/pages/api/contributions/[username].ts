import type { APIRoute } from "astro";

export const prerender = false;

const USERNAME_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const REQUEST_TIMEOUT_MS = 8000;

type CacheEntry = {
  data: ContributionData;
  expiresAt: number;
};

type ContributionData = {
  username: string;
  total: number;
  from: string;
  to: string;
  contributions: { date: string; count: number; color: string }[];
};

type GitHubResponse = {
  data?: {
    user?: {
      login: string;
      contributionsCollection: {
        contributionCalendar: {
          totalContributions: number;
          weeks: {
            contributionDays: {
              date: string;
              contributionCount: number;
              color: string;
            }[];
          }[];
        };
      };
    } | null;
  };
  errors?: { type?: string }[];
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
      ...(status !== 200 ? { "Cache-Control": "no-store" } : {}),
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

  const to = new Date();
  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  const cacheKey = `${username.toLowerCase()}:${to.toISOString().slice(0, 10)}`;
  const now = Date.now();
  const cached = contributionCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return createJsonResponse(cached.data, 200, { "X-Cache": "HIT" });
  }

  const token = process.env.GITHUB_TOKEN || import.meta.env.GITHUB_TOKEN;
  if (!token) {
    return createJsonResponse(
      { error: "Contribution service is not configured. Please try again later." },
      503,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(
      "https://api.github.com/graphql",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: ["Bearer", token].join(" "),
          "User-Agent": "mona-mayhem/1.0",
        },
        body: JSON.stringify({
          query: `query Contributions($username: String!, $from: DateTime!, $to: DateTime!) {
            user(login: $username) {
              login
              contributionsCollection(from: $from, to: $to) {
                contributionCalendar {
                  totalContributions
                  weeks { contributionDays { date contributionCount color } }
                }
              }
            }
          }`,
          variables: { username, from: from.toISOString(), to: to.toISOString() },
        }),
        signal: controller.signal,
      },
    );

    if (upstreamResponse.status === 429 || upstreamResponse.status === 403) {
      return createJsonResponse(
        { error: "GitHub rate limit reached. Please try again later." },
        429,
        { "X-Cache": "MISS" },
      );
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

    let payload: GitHubResponse;
    try {
      payload = await upstreamResponse.json();
    } catch {
      return createJsonResponse(
        { error: "Invalid JSON received from GitHub." },
        502,
        { "X-Cache": "MISS" },
      );
    }

    if (payload.errors?.some((error) => error.type === "RATE_LIMITED")) {
      return createJsonResponse(
        { error: "GitHub rate limit reached. Please try again later." },
        429,
      );
    }

    if (payload.data?.user === null) {
      return createJsonResponse({ error: "GitHub user not found." }, 404);
    }

    const user = payload.data?.user;
    const calendar = user?.contributionsCollection?.contributionCalendar;
    if (
      payload.errors?.length ||
      !user ||
      typeof user.login !== "string" ||
      !calendar ||
      !Number.isSafeInteger(calendar.totalContributions) ||
      calendar.totalContributions < 0 ||
      !Array.isArray(calendar.weeks)
    ) {
      return createJsonResponse({ error: "Invalid contribution data received from GitHub." }, 502);
    }

    const days = calendar.weeks.flatMap((week) => week.contributionDays);
    if (!days.length || days.some((day) =>
      !day ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
      !Number.isSafeInteger(day.contributionCount) ||
      day.contributionCount < 0 ||
      !/^#[0-9a-f]{6}$/i.test(day.color)
    )) {
      return createJsonResponse({ error: "Invalid contribution data received from GitHub." }, 502);
    }

    const data: ContributionData = {
      username: user.login,
      total: calendar.totalContributions,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      contributions: days.map((day) => ({
        date: day.date,
        count: day.contributionCount,
        color: day.color,
      })),
    };

    contributionCache.set(cacheKey, {
      data,
      expiresAt: now + CACHE_TTL_MS,
    });
    trimCache();

    return createJsonResponse(data, 200, { "X-Cache": "MISS" });
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
