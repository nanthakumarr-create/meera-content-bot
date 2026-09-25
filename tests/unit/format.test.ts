import { describe, expect, it } from "vitest";
import { escapeHtml, escapeMarkdownV2 } from "@/lib/escape";
import {
  formatDraftMessages,
  formatScoreRejection,
  newsReviewBlock,
  reviewButtons,
  TELEGRAM_MESSAGE_LIMIT,
} from "@/telegram/format";

describe("escaping", () => {
  it("escapes HTML special characters for Telegram HTML mode", () => {
    expect(escapeHtml(`pH < 5 & > 3 "quoted"`)).toBe("pH &lt; 5 &amp; &gt; 3 &quot;quoted&quot;");
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("escapes every MarkdownV2 reserved character", () => {
    const reserved = "_*[]()~`>#+-=|{}.!\\";
    const escaped = escapeMarkdownV2(reserved);
    expect(escaped).toBe("\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\");
    expect(escapeMarkdownV2("pH 5.5 (approx)")).toBe("pH 5\\.5 \\(approx\\)");
  });

  it("escapes user- and model-supplied text inside draft messages", () => {
    const [html] = formatDraftMessages({
      shortId: "AB23CD",
      score: 7,
      scoreReason: "Uses <b>bold</b> & specifics",
      draftText: "Draft with <i>tags</i> & ampersands",
      news: null,
    });
    expect(html).toContain("Uses &lt;b&gt;bold&lt;/b&gt; &amp; specifics");
    expect(html).toContain("Draft with &lt;i&gt;tags&lt;/i&gt; &amp; ampersands");
    expect(formatScoreRejection(3, "a < b")).toContain("a &lt; b");
  });
});

describe("draft message formatting", () => {
  const news = {
    headline: "Headline & more",
    publication: "Pub",
    publishedAt: new Date("2026-09-20T10:00:00Z"),
    url: "https://example.com/a?b=1&c=2",
  };

  it("produces the exact news review block", () => {
    expect(newsReviewBlock(news)).toBe(
      "NEWS SOURCE: Headline & more\nFROM: Pub | 2026-09-20\nLINK: https://example.com/a?b=1&c=2\nCHECK BEFORE PUBLISHING: You are the author of this claim.",
    );
  });

  it("includes the short ID, score, reason, and escaped news block", () => {
    const html = formatDraftMessages({
      shortId: "AB23CD",
      score: 8,
      scoreReason: "Strong.",
      draftText: "Body.",
      news,
    }).join("");
    expect(html).toContain("Draft AB23CD");
    expect(html).toContain("Score: 8/10 · Strong.");
    expect(html).toContain("NEWS SOURCE: Headline &amp; more");
    expect(html).toContain("CHECK BEFORE PUBLISHING: You are the author of this claim.");
    expect(html).toContain("APPROVE AB23CD");
  });

  it("splits very long drafts under Telegram's limit on paragraph boundaries", () => {
    const paragraph = "Evidence & mechanism. ".repeat(60).trim();
    const draftText = Array.from({ length: 8 }, () => paragraph).join("\n\n");
    const chunks = formatDraftMessages({
      shortId: "AB23CD",
      score: 7,
      scoreReason: "ok",
      draftText,
      news,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThan(TELEGRAM_MESSAGE_LIMIT);
      expect(chunk).not.toMatch(/&[a-z]*$/);
    }
  });

  it("builds Approve and Reject buttons with compact callback data", () => {
    const [[approve, reject]] = reviewButtons("AB23CD") as [
      [{ text: string; callback_data: string }, { text: string; callback_data: string }],
    ];
    expect(approve).toEqual({ text: "Approve", callback_data: "a:AB23CD" });
    expect(reject).toEqual({ text: "Reject", callback_data: "r:AB23CD" });
  });
});
