import { beforeEach, describe, expect, it } from "vitest";
import type { JsonRequest } from "@/ai/gemini";
import { processNote, resetVoiceSkillCache, type NoteJob } from "@/pipeline/processNote";
import type { NewsItem } from "@/news/types";
import { ALLOWED_CHAT_ID, FakeModel, FakeNews, makeDeps, testVoiceSkill } from "../helpers/fakes";
import { SAMPLE_DRAFT } from "../fixtures/notes";

async function seededJob(
  deps: ReturnType<typeof makeDeps>,
  text = "Some note text for scoring.",
): Promise<NoteJob> {
  const stored = await deps.repo.ingestNote({
    updateId: Math.floor(Math.random() * 1e9),
    updateType: "channel_post",
    chatId: ALLOWED_CHAT_ID,
    messageId: Math.floor(Math.random() * 1e9),
    rawText: text,
    receivedAt: new Date(),
    requestId: "req",
  });
  const note = deps.repo.note(stored!.noteId);
  return {
    noteId: note.id,
    updateId: note.updateId,
    chatId: note.chatId,
    messageId: note.messageId,
    text,
  };
}

const scoreOf = (score: number) => () => ({
  score,
  reason: `Scored ${score}.`,
  keywords: ["preservative", "ph", "coa"],
});
const plainDraft = () => ({ draft_text: SAMPLE_DRAFT, news_used: false, source: null });

const newsItem: NewsItem = {
  headline: "Regulator tightens preservative disclosure rules",
  publication: "Cosmetics Weekly",
  publishedAt: new Date("2026-09-20T08:00:00Z"),
  url: "https://example.com/preservative-rules",
  description: "New disclosure rules for preservative systems in cosmetics.",
};

beforeEach(() => resetVoiceSkillCache());

describe("score threshold", () => {
  it("score 5 stops the pipeline: saved, rejected, no news or draft call", async () => {
    const model = new FakeModel({ score: scoreOf(5), draft: plainDraft });
    const news = new FakeNews([newsItem]);
    const deps = makeDeps({ model, news });
    const job = await seededJob(deps);

    const outcome = await processNote(job, deps);

    expect(outcome).toEqual({ status: "rejected", score: 5 });
    expect(model.tasks()).toEqual(["score"]);
    expect(news.calls).toHaveLength(0);
    expect(deps.repo.drafts).toHaveLength(0);
    const note = deps.repo.note(job.noteId);
    expect(note).toMatchObject({ status: "rejected", score: 5, scoreReason: "Scored 5." });
    expect(deps.telegram.sent).toHaveLength(1);
    expect(deps.telegram.sent[0]!.html).toMatch(/No draft created/);
    expect(deps.telegram.sent[0]!.html).toContain("Scored 5.");
    expect(deps.repo.updates.get(job.updateId)?.status).toBe("completed");
  });

  it("score 6 continues to drafting and sends a pending draft with buttons", async () => {
    const model = new FakeModel({ score: scoreOf(6), draft: plainDraft });
    const deps = makeDeps({ model });
    const job = await seededJob(deps);

    const outcome = await processNote(job, deps);

    expect(outcome).toMatchObject({ status: "drafted", score: 6, newsUsed: false });
    expect(model.tasks()).toEqual(["score", "draft"]);
    expect(deps.repo.drafts).toHaveLength(1);
    const draft = deps.repo.drafts[0]!;
    expect(draft.status).toBe("pending");
    expect(draft.noteId).toBe(job.noteId);
    expect(draft.voiceSkillId).toBe(deps.repo.voiceSkills[0]!.id);
    expect(deps.repo.note(job.noteId).status).toBe("drafted");

    const last = deps.telegram.sent.at(-1)!;
    expect(last.options.buttons?.[0]?.map((b) => b.text)).toEqual(["Approve", "Reject"]);
    expect(deps.telegram.sent[0]!.html).toContain(`Draft ${draft.shortId}`);
    expect(deps.telegram.sent[0]!.html).toContain("Score: 6/10");
    expect(draft.telegramMessageId).toBe(5000 + deps.telegram.sent.length);
  });
});

describe("voice skill injection", () => {
  it("sends the voice skill on every drafting request", async () => {
    const model = new FakeModel({ score: scoreOf(8), draft: plainDraft });
    const deps = makeDeps({ model });
    for (let i = 0; i < 3; i += 1) await processNote(await seededJob(deps, `note ${i}`), deps);

    const drafts = model.calls.filter((c) => c.task === "draft");
    expect(drafts).toHaveLength(3);
    for (const call of drafts) expect(call.systemInstruction).toContain(testVoiceSkill.content);
    // Scoring calls do not need it.
    expect(model.calls.find((c) => c.task === "score")!.systemInstruction).not.toContain(
      testVoiceSkill.content,
    );
    // One voice-skill version, referenced by every draft.
    expect(deps.repo.voiceSkills).toHaveLength(1);
    expect(new Set(deps.repo.drafts.map((d) => d.voiceSkillId)).size).toBe(1);
  });
});

describe("news handling", () => {
  it("uses a relevant news item and appends the exact review block", async () => {
    const model = new FakeModel({
      score: scoreOf(8),
      news_relevance: () => ({ relevant: true, index: 0, reason: "Same issue." }),
      draft: (req: JsonRequest<unknown>) => {
        expect(req.prompt).toContain(newsItem.url);
        return {
          draft_text: SAMPLE_DRAFT,
          news_used: true,
          source: {
            headline: newsItem.headline,
            publication: newsItem.publication,
            published_date: "2026-09-20",
            url: newsItem.url,
          },
        };
      },
    });
    const deps = makeDeps({ model, news: new FakeNews([newsItem]) });
    const outcome = await processNote(await seededJob(deps), deps);

    expect(outcome).toMatchObject({ status: "drafted", newsUsed: true });
    const text = deps.telegram.sent.map((m) => m.html).join("\n");
    expect(text).toContain(
      [
        "NEWS SOURCE: Regulator tightens preservative disclosure rules",
        "FROM: Cosmetics Weekly | 2026-09-20",
        "LINK: https://example.com/preservative-rules",
        "CHECK BEFORE PUBLISHING: You are the author of this claim.",
      ].join("\n"),
    );
    expect(deps.repo.drafts[0]!.news?.url).toBe(newsItem.url);
  });

  it("drafts without news when the model says the item is irrelevant", async () => {
    const model = new FakeModel({
      score: scoreOf(8),
      news_relevance: () => ({ relevant: false, index: null, reason: "Different topic." }),
      draft: (req: JsonRequest<unknown>) => {
        expect(req.prompt).not.toContain(newsItem.url);
        return plainDraft();
      },
    });
    const deps = makeDeps({ model, news: new FakeNews([newsItem]) });
    await processNote(await seededJob(deps), deps);
    expect(deps.repo.drafts[0]!.news).toBeNull();
    expect(deps.telegram.sent.map((m) => m.html).join("")).not.toContain("NEWS SOURCE");
  });

  it("skips the relevance call when RSS returns nothing", async () => {
    const model = new FakeModel({ score: scoreOf(7), draft: plainDraft });
    const deps = makeDeps({ model, news: new FakeNews([]) });
    await processNote(await seededJob(deps), deps);
    expect(model.tasks()).toEqual(["score", "draft"]);
  });

  it("continues without news if the relevance call fails", async () => {
    const model = new FakeModel({
      score: scoreOf(7),
      news_relevance: () => {
        throw new Error("gemini down");
      },
      draft: plainDraft,
    });
    const deps = makeDeps({ model, news: new FakeNews([newsItem]) });
    expect(await processNote(await seededJob(deps), deps)).toMatchObject({
      status: "drafted",
      newsUsed: false,
    });
  });

  it("rejects a draft that cites a source it was not given", async () => {
    const model = new FakeModel({
      score: scoreOf(7),
      draft: () => ({
        draft_text: SAMPLE_DRAFT,
        news_used: true,
        source: {
          headline: "Invented",
          publication: null,
          published_date: null,
          url: "https://fake.example/x",
        },
      }),
    });
    const deps = makeDeps({ model });
    const job = await seededJob(deps);
    expect(await processNote(job, deps)).toMatchObject({
      status: "failed",
      category: "validation",
    });
    expect(deps.repo.drafts).toHaveLength(0);
  });
});

describe("failure handling", () => {
  it("marks the note failed, dead-letters the update, and sends a safe message", async () => {
    const model = new FakeModel({
      score: () => {
        throw Object.assign(new Error("secret internal detail"), { status: 500 });
      },
    });
    const deps = makeDeps({ model });
    const job = await seededJob(deps);
    const outcome = await processNote(job, deps);

    expect(outcome.status).toBe("failed");
    expect(deps.repo.note(job.noteId).status).toBe("failed");
    expect(deps.repo.note(job.noteId).failureReason).toBeTruthy();
    expect(deps.repo.updates.get(job.updateId)?.status).toBe("dead_letter");
    expect(deps.telegram.sent[0]!.html).toMatch(/Something went wrong/);
    expect(deps.telegram.sent[0]!.html).not.toContain("secret internal detail");
    // The note is never deleted.
    expect(deps.repo.notes).toHaveLength(1);
  });

  it("strips emojis and hashtags the model adds anyway", async () => {
    const model = new FakeModel({
      score: scoreOf(7),
      draft: () => ({
        draft_text: `${SAMPLE_DRAFT} 🚀\n\n#skincare #founders`,
        news_used: false,
        source: null,
      }),
    });
    const deps = makeDeps({ model });
    await processNote(await seededJob(deps), deps);
    const text = deps.repo.drafts[0]!.draftText;
    expect(text).not.toMatch(/🚀|#skincare|#founders/);
    expect(text.endsWith("first approved batch?")).toBe(true);
  });
});
