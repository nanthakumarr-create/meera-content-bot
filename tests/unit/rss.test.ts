import { describe, expect, it, vi } from "vitest";
import {
  buildFeedUrl,
  buildNewsQuery,
  createGoogleNewsService,
  filterRelevant,
  parseFeed,
} from "@/news/rss";
import { MemoryRepository } from "../helpers/memoryRepo";
import { feed } from "../helpers/rssFeed";

const NOW = new Date("2026-09-25T12:00:00Z");

const relevantXml = feed([
  {
    title: "Preservative supplier changes spark pH stability recalls",
    source: "Cosmetics Business",
    date: "Tue, 23 Sep 2026 09:00:00 GMT",
    link: "https://news.google.com/rss/articles/one",
    description: "Formulators report preservative blend swaps affecting pH.",
  },
  {
    title: "Old preservative pH story",
    source: "Archive Daily",
    date: "Mon, 02 Jun 2025 09:00:00 GMT",
    link: "https://news.google.com/rss/articles/old",
  },
  {
    title: "Cricket final tickets sell out",
    source: "Sports Now",
    date: "Wed, 24 Sep 2026 09:00:00 GMT",
    link: "https://news.google.com/rss/articles/cricket",
  },
]);

const keywords = ["preservative", "pH stability", "CoA"];

function okResponse(body: string) {
  return new Response(body, { status: 200, headers: { "content-type": "application/rss+xml" } });
}

describe("RSS parsing", () => {
  it("extracts headline, publication, date, URL, and plain-text description", () => {
    const items = parseFeed(relevantXml);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      headline: "Preservative supplier changes spark pH stability recalls",
      publication: "Cosmetics Business",
      publishedAt: new Date("2026-09-23T09:00:00Z"),
      url: "https://news.google.com/rss/articles/one",
      description: expect.stringContaining("Formulators report preservative blend swaps"),
    });
    expect(items[0]!.description).not.toMatch(/[<>]/);
  });

  it("returns [] for malformed or non-RSS input", () => {
    expect(parseFeed("<html><body>captcha</body></html>")).toEqual([]);
    expect(parseFeed("not xml at all <<<")).toEqual([]);
    expect(parseFeed("")).toEqual([]);
  });

  it("does not expand external entities", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<rss><channel><item><title>&xxe;</title><link>https://a.example/x</link><pubDate>Tue, 23 Sep 2026 09:00:00 GMT</pubDate></item></channel></rss>`;
    const items = parseFeed(xxe);
    for (const item of items) expect(item.headline).not.toContain("root:");
  });

  it("keeps only recent items that match the keywords", () => {
    const relevant = filterRelevant(parseFeed(relevantXml), keywords, NOW);
    expect(relevant.map((i) => i.url)).toEqual(["https://news.google.com/rss/articles/one"]);
  });

  it("builds a bounded Google News query", () => {
    expect(buildNewsQuery(["pH stability", "preservative", 'bad"quote'])).toBe(
      '"pH stability" OR preservative OR "bad quote"',
    );
    expect(buildFeedUrl("x", 21)).toMatch(
      /^https:\/\/news\.google\.com\/rss\/search\?q=x\+when%3A21d/,
    );
  });
});

describe("Google News service", () => {
  it("returns relevant candidates and caches identical searches", async () => {
    const repo = new MemoryRepository();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => okResponse(relevantXml));
    const service = createGoogleNewsService({ cache: repo, fetchImpl, now: () => NOW });

    const first = await service.findCandidates(keywords);
    const second = await service.findCandidates(keywords);

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toMatch(
      /^https:\/\/news\.google\.com\/rss\/search/,
    );
  });

  it("falls back to no news on timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("timed out", "TimeoutError")),
        );
      });
      return okResponse(relevantXml);
    });
    const service = createGoogleNewsService({
      cache: new MemoryRepository(),
      fetchImpl,
      now: () => NOW,
      timeoutMs: 20,
    });
    await expect(service.findCandidates(keywords)).resolves.toEqual([]);
  });

  it("falls back to no news on HTTP errors", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 503 }));
    const service = createGoogleNewsService({
      cache: new MemoryRepository(),
      fetchImpl,
      now: () => NOW,
    });
    await expect(service.findCandidates(keywords)).resolves.toEqual([]);
  });

  it("returns [] when results are irrelevant", async () => {
    const irrelevant = feed([
      {
        title: "Cricket final tickets sell out",
        source: "Sports Now",
        date: "Wed, 24 Sep 2026 09:00:00 GMT",
      },
    ]);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse(irrelevant));
    const service = createGoogleNewsService({
      cache: new MemoryRepository(),
      fetchImpl,
      now: () => NOW,
    });
    await expect(service.findCandidates(keywords)).resolves.toEqual([]);
  });

  it("returns [] when the feed has no items", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse(feed([])));
    const service = createGoogleNewsService({
      cache: new MemoryRepository(),
      fetchImpl,
      now: () => NOW,
    });
    await expect(service.findCandidates(keywords)).resolves.toEqual([]);
  });

  it("still works when the cache is unavailable", async () => {
    const repo = new MemoryRepository();
    repo.getNewsCache = async () => {
      throw new Error("db down");
    };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => okResponse(relevantXml));
    const service = createGoogleNewsService({ cache: repo, fetchImpl, now: () => NOW });
    await expect(service.findCandidates(keywords)).resolves.toHaveLength(1);
  });
});
