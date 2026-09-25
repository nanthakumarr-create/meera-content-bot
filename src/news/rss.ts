import { XMLParser } from "fast-xml-parser";
import { pipelineSettings } from "@/lib/config";
import { AppError, describeError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { silentLogger } from "@/lib/logger";
import { sha256Hex } from "@/lib/security";
import type { NewsCacheStore, NewsItem, NewsService } from "./types";

const MAX_FEED_BYTES = 1_000_000;
const GOOGLE_NEWS_SEARCH = "https://news.google.com/rss/search";

export function buildNewsQuery(keywords: string[]): string {
  const terms = keywords
    .map((k) => k.replace(/["()]/g, " ").replace(/\s+/g, " ").trim())
    .filter((k) => k.length >= 2)
    .slice(0, 5)
    .map((k) => (k.includes(" ") ? `"${k}"` : k));
  return terms.join(" OR ");
}

export function buildFeedUrl(query: string, maxAgeDays: number): string {
  const params = new URLSearchParams({
    q: `${query} when:${maxAgeDays}d`,
    hl: "en-IN",
    gl: "IN",
    ceid: "IN:en",
  });
  return `${GOOGLE_NEWS_SEARCH}?${params.toString()}`;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Entities are decoded, but the parser never resolves external entities or DTDs.
  processEntities: true,
  htmlEntities: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "item",
});

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value)
    return text((value as { "#text": unknown })["#text"]);
  return "";
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse a Google News RSS document into items. Returns [] for anything unparseable. */
export function parseFeed(xml: string): NewsItem[] {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }
  const items = (doc as { rss?: { channel?: { item?: unknown[] } } })?.rss?.channel?.item;
  if (!Array.isArray(items)) return [];

  const out: NewsItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const url = text(item.link).trim();
    if (!/^https:\/\//i.test(url)) continue;

    const publication = stripHtml(text(item.source)) || null;
    let headline = stripHtml(text(item.title));
    // Google News appends " - Publication" to titles.
    if (publication && headline.endsWith(` - ${publication}`)) {
      headline = headline.slice(0, -(publication.length + 3)).trim();
    }
    if (!headline) continue;

    const pub = text(item.pubDate);
    const publishedAt = pub ? new Date(pub) : null;
    out.push({
      headline: headline.slice(0, 300),
      publication: publication?.slice(0, 120) ?? null,
      publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
      url: url.slice(0, 2000),
      description: stripHtml(text(item.description)).slice(0, 600),
    });
  }
  return out;
}

function keywordTokens(keywords: string[]): string[] {
  const tokens = new Set<string>();
  for (const k of keywords) {
    for (const t of k.toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3) tokens.add(t);
  }
  return [...tokens];
}

/** Keep recent items that share at least two keyword terms, best matches first. */
export function filterRelevant(
  items: NewsItem[],
  keywords: string[],
  now: Date,
  options: { maxAgeDays: number; limit: number } = {
    maxAgeDays: pipelineSettings.newsMaxAgeDays,
    limit: pipelineSettings.newsMaxCandidates,
  },
): NewsItem[] {
  const tokens = keywordTokens(keywords);
  const minMatches = Math.min(2, tokens.length);
  const oldest = now.getTime() - options.maxAgeDays * 86_400_000;
  return items
    .filter(
      (item) =>
        item.publishedAt &&
        item.publishedAt.getTime() >= oldest &&
        item.publishedAt <= new Date(now.getTime() + 86_400_000),
    )
    .map((item) => {
      const haystack = `${item.headline} ${item.description}`.toLowerCase();
      const matches = tokens.filter((t) => haystack.includes(t)).length;
      return { item, matches };
    })
    .filter(({ matches }) => minMatches > 0 && matches >= minMatches)
    .sort(
      (a, b) =>
        b.matches - a.matches || b.item.publishedAt!.getTime() - a.item.publishedAt!.getTime(),
    )
    .slice(0, options.limit)
    .map(({ item }) => item);
}

export interface GoogleNewsOptions {
  cache: NewsCacheStore;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * Google News RSS search. Every failure mode (timeout, HTTP error, bad XML,
 * nothing relevant) degrades to an empty list so drafting continues without news.
 */
export function createGoogleNewsService(options: GoogleNewsOptions): NewsService {
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? pipelineSettings.rssTimeoutMs;

  async function fetchFeed(url: string): Promise<NewsItem[]> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: "application/rss+xml, application/xml;q=0.9" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
    } catch (error) {
      throw new AppError("rss", "Google News RSS request failed or timed out", { cause: error });
    }
    if (!response.ok) throw new AppError("rss", `Google News RSS returned HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > MAX_FEED_BYTES)
      throw new AppError("rss", "Google News RSS response too large");
    return parseFeed(body);
  }

  return {
    async findCandidates(keywords) {
      const query = buildNewsQuery(keywords);
      if (!query) return [];
      const key = sha256Hex(`google-news:v1:${query.toLowerCase()}`);
      const current = now();

      let items: NewsItem[] | null = null;
      try {
        items = await options.cache.getNewsCache(key, current);
      } catch (error) {
        logger.warn("news.cache_read_failed", { error: describeError(error) });
      }

      if (items) {
        logger.info("news.cache_hit", { query });
      } else {
        try {
          items = await fetchFeed(buildFeedUrl(query, pipelineSettings.newsMaxAgeDays));
        } catch (error) {
          logger.warn("news.fetch_failed", { query, error: describeError(error) });
          return [];
        }
        try {
          const expiresAt = new Date(
            current.getTime() + pipelineSettings.newsCacheTtlSeconds * 1000,
          );
          await options.cache.putNewsCache(key, query, items, expiresAt);
        } catch (error) {
          logger.warn("news.cache_write_failed", { error: describeError(error) });
        }
      }

      const relevant = filterRelevant(items, keywords, current);
      logger.info("news.candidates", { query, fetched: items.length, relevant: relevant.length });
      return relevant;
    },
  };
}
