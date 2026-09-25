import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGeminiModel, type GenerateFn, type GenerateParams } from "@/ai/gemini";
import { createGoogleNewsService } from "@/news/rss";
import { resetVoiceSkillCache } from "@/pipeline/processNote";
import { handleWebhook } from "@/pipeline/webhook";
import { createTelegramClient } from "@/telegram/client";
import { STRONG_NOTE, SAMPLE_DRAFT, WEAK_NOTE } from "../fixtures/notes";
import {
  callbackUpdate,
  channelPost,
  collectingScheduler,
  makeDeps,
  testVoiceSkill,
  webhookRequest,
} from "../helpers/fakes";
import { MemoryRepository } from "../helpers/memoryRepo";
import { feed } from "../helpers/rssFeed";

/**
 * Mocked Gemini transport. It behaves like a reasonable model would: it scores
 * notes by looking for concrete evidence (numbers, length, mechanism words).
 * This logic lives only in the test; production code has no fixture knowledge.
 */
function fakeGeminiTransport() {
  const calls: { kind: string; params: GenerateParams }[] = [];
  const generate: GenerateFn = async (params) => {
    const sys = params.config.systemInstruction;
    const note = /<note>\n([\s\S]*?)\n<\/note>/.exec(params.contents)?.[1] ?? "";
    if (sys.includes("decide whether a note has enough substance")) {
      calls.push({ kind: "score", params });
      const hasNumber = /\d/.test(note) || /\b(one|two|three|four|five|fourteen)\b/i.test(note);
      const substantive = note.length > 200 && hasNumber;
      return {
        text: JSON.stringify(
          substantive
            ? {
                score: 8,
                reason: "Specific manufacturing evidence with a clear, defensible point.",
                keywords: ["preservative", "pH stability", "certificate of analysis"],
              }
            : {
                score: 1,
                reason: "A personal reminder with no argument or evidence.",
                keywords: ["cartons", "reorder", "packaging"],
              },
        ),
      };
    }
    if (sys.includes("recent news item would materially strengthen")) {
      calls.push({ kind: "news_relevance", params });
      return {
        text: JSON.stringify({
          relevant: true,
          index: 0,
          reason: "Same issue: silent preservative changes.",
        }),
      };
    }
    if (sys.includes("You draft LinkedIn posts for Meera Pillai")) {
      calls.push({ kind: "draft", params });
      const url = /url: (https:\/\/\S+)/.exec(params.contents)?.[1];
      const headline = /headline: (.+)/.exec(params.contents)?.[1];
      return {
        text: JSON.stringify({
          draft_text: SAMPLE_DRAFT,
          news_used: Boolean(url),
          source: url
            ? { headline, publication: "Cosmetics Business", published_date: "2026-09-23", url }
            : null,
        }),
      };
    }
    throw new Error("unexpected Gemini request");
  };
  return { generate, calls };
}

function fakeTelegramFetch() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  let messageId = 7000;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const method = String(url).split("/").pop()!;
    calls.push({ method, payload: JSON.parse(String(init?.body)) });
    messageId += 1;
    return new Response(
      JSON.stringify({
        ok: true,
        result: method === "sendMessage" ? { message_id: messageId } : true,
      }),
    );
  });
  return { fetchImpl, calls };
}

function fakeRssFetch() {
  return vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(
        feed([
          {
            title: "Suppliers quietly swapping preservative systems, formulators warn",
            source: "Cosmetics Business",
            date: new Date(Date.now() - 2 * 86_400_000).toUTCString(),
            link: "https://news.google.com/rss/articles/preservative-swap",
            description: "Preservative changes affecting pH stability in finished products.",
          },
        ]),
      ),
  );
}

function buildSystem() {
  const repo = new MemoryRepository();
  const gemini = fakeGeminiTransport();
  const telegram = fakeTelegramFetch();
  const rssFetch = fakeRssFetch();
  const deps = makeDeps({
    repo,
    model: createGeminiModel({
      model: "gemini-test",
      generate: gemini.generate,
      sleep: async () => {},
    }),
    telegram: createTelegramClient({
      token: "123456789:AAEexampleexampleexampleexample1234",
      fetchImpl: telegram.fetchImpl,
    }),
    news: createGoogleNewsService({ cache: repo, fetchImpl: rssFetch }),
  });
  return { deps, repo, gemini, telegram, rssFetch };
}

async function deliver(deps: ReturnType<typeof makeDeps>, update: unknown) {
  const schedule = collectingScheduler();
  const response = await handleWebhook(webhookRequest(update), deps, schedule);
  expect(response.status).toBe(200);
  await schedule.flush();
  return response;
}

beforeEach(() => resetVoiceSkillCache());

describe("acceptance: strong note", () => {
  it("produces a pending draft with news, voice skill, and review buttons; approval is stored", async () => {
    const { deps, repo, gemini, telegram, rssFetch } = buildSystem();

    await deliver(deps, channelPost(STRONG_NOTE));

    // Stored note, scored and drafted.
    expect(repo.notes).toHaveLength(1);
    const note = repo.notes[0]!;
    expect(note.rawText).toBe(STRONG_NOTE);
    expect(note.status).toBe("drafted");
    expect(note.score).toBeGreaterThanOrEqual(6);

    // Gemini: score -> relevance -> draft, with the voice skill on the draft call.
    expect(gemini.calls.map((c) => c.kind)).toEqual(["score", "news_relevance", "draft"]);
    expect(gemini.calls[2]!.params.config.systemInstruction).toContain(testVoiceSkill.content);
    expect(gemini.calls[2]!.params.config.responseMimeType).toBe("application/json");
    expect(rssFetch).toHaveBeenCalledTimes(1);

    // Draft stored as pending, referencing note and voice skill, with news metadata.
    expect(repo.drafts).toHaveLength(1);
    const draft = repo.drafts[0]!;
    expect(draft).toMatchObject({ status: "pending", noteId: note.id, model: "gemini-test" });
    expect(repo.voiceSkills.find((v) => v.id === draft.voiceSkillId)?.active).toBe(true);
    expect(draft.news?.url).toBe("https://news.google.com/rss/articles/preservative-swap");

    // Telegram got the draft with the news block and inline buttons, in HTML mode.
    const sends = telegram.calls.filter((c) => c.method === "sendMessage");
    const text = sends.map((s) => String(s.payload.text)).join("\n");
    expect(text).toContain(`Draft ${draft.shortId}`);
    expect(text).toContain(
      "NEWS SOURCE: Suppliers quietly swapping preservative systems, formulators warn",
    );
    expect(text).toContain("CHECK BEFORE PUBLISHING: You are the author of this claim.");
    expect(sends.every((s) => s.payload.parse_mode === "HTML")).toBe(true);
    expect(sends.at(-1)!.payload.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "Approve", callback_data: `a:${draft.shortId}` },
          { text: "Reject", callback_data: `r:${draft.shortId}` },
        ],
      ],
    });

    // Meera approves.
    const approve = callbackUpdate(
      `a:${draft.shortId}`,
      deps.allowedChatId,
      draft.telegramMessageId!,
    );
    await deliver(deps, approve);
    expect(repo.drafts[0]!.status).toBe("approved");
    expect(repo.reviews).toEqual([
      expect.objectContaining({ decision: "approved", updateId: approve.update_id, actorId: 42 }),
    ]);
    expect(telegram.calls.map((c) => c.method)).toContain("answerCallbackQuery");
    expect(telegram.calls.map((c) => c.method)).toContain("editMessageReplyMarkup");

    // The only outbound calls are Telegram and Google News; nothing talks to LinkedIn.
    const telegramUrls = telegram.fetchImpl.mock.calls.map((c) => new URL(String(c[0])).host);
    const rssUrls = rssFetch.mock.calls.map((c) => new URL(String(c[0])).host);
    expect(new Set([...telegramUrls, ...rssUrls])).toEqual(
      new Set(["api.telegram.org", "news.google.com"]),
    );
  });
});

describe("acceptance: weak note", () => {
  it("is rejected with a reason and never reaches the drafting call", async () => {
    const { deps, repo, gemini, telegram, rssFetch } = buildSystem();

    await deliver(deps, channelPost(WEAK_NOTE));

    expect(gemini.calls.map((c) => c.kind)).toEqual(["score"]);
    expect(rssFetch).not.toHaveBeenCalled();
    expect(repo.drafts).toHaveLength(0);
    expect(repo.notes[0]).toMatchObject({ rawText: WEAK_NOTE, status: "rejected" });
    expect(repo.notes[0]!.score).toBeLessThan(6);

    const sends = telegram.calls.filter((c) => c.method === "sendMessage");
    expect(sends).toHaveLength(1);
    expect(String(sends[0]!.payload.text)).toMatch(/No draft created/);
    expect(String(sends[0]!.payload.text)).toMatch(/reminder/);
  });
});

describe("acceptance: resilience", () => {
  it("drafts without news when RSS is down", async () => {
    const { deps, repo, gemini, rssFetch } = buildSystem();
    rssFetch.mockRejectedValue(new TypeError("fetch failed"));
    await deliver(deps, channelPost(STRONG_NOTE));
    expect(gemini.calls.map((c) => c.kind)).toEqual(["score", "draft"]);
    expect(repo.drafts[0]!.news).toBeNull();
  });

  it("recovers from a transient Gemini outage within three attempts", async () => {
    const { deps, repo, gemini } = buildSystem();
    let failures = 0;
    const original = gemini.generate;
    deps.model = createGeminiModel({
      model: "gemini-test",
      sleep: async () => {},
      generate: async (params) => {
        if (failures < 2) {
          failures += 1;
          throw Object.assign(new Error("overloaded"), { status: 503 });
        }
        return original(params);
      },
    });
    await deliver(deps, channelPost(STRONG_NOTE));
    expect(failures).toBe(2);
    expect(repo.drafts).toHaveLength(1);
  });

  it("dead-letters after Gemini fails three times and tells Meera safely", async () => {
    const { deps, repo, telegram } = buildSystem();
    const generate = vi
      .fn<GenerateFn>()
      .mockRejectedValue(Object.assign(new Error("overloaded"), { status: 503 }));
    deps.model = createGeminiModel({ model: "gemini-test", generate, sleep: async () => {} });
    const update = channelPost(STRONG_NOTE);
    await deliver(deps, update);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(repo.notes[0]!.status).toBe("failed");
    expect(repo.updates.get(update.update_id)?.status).toBe("dead_letter");
    const last = telegram.calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(String(last.payload.text)).toMatch(/Something went wrong/);
  });
});
