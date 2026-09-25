import { beforeEach, describe, expect, it } from "vitest";
import { callbackData } from "@/telegram/updates";
import { handleWebhook } from "@/pipeline/webhook";
import { resetVoiceSkillCache } from "@/pipeline/processNote";
import {
  callbackUpdate,
  channelPost,
  collectingScheduler,
  directMessage,
  makeDeps,
  webhookRequest,
} from "../helpers/fakes";

async function depsWithDraft() {
  const deps = makeDeps();
  const stored = await deps.repo.ingestNote({
    updateId: 1,
    updateType: "channel_post",
    chatId: deps.allowedChatId,
    messageId: 10,
    rawText: "note",
    receivedAt: new Date(),
    requestId: "r",
  });
  const skill = await deps.repo.ensureVoiceSkill("sha256:abc", "a".repeat(64), "voice");
  await deps.repo.createDraft({
    noteId: stored!.noteId,
    shortId: "AB23CD",
    voiceSkillId: skill.id,
    model: "m",
    draftText: "draft",
    news: null,
  });
  await deps.repo.setDraftTelegramMessage(deps.repo.drafts[0]!.id, 5001);
  return deps;
}

async function send(deps: ReturnType<typeof makeDeps>, update: unknown) {
  const schedule = collectingScheduler();
  const res = await handleWebhook(webhookRequest(update), deps, schedule);
  await schedule.flush();
  return res;
}

beforeEach(() => resetVoiceSkillCache());

describe("approval and rejection", () => {
  it("approve button moves pending -> approved and records who, when, and which update", async () => {
    const deps = await depsWithDraft();
    const update = callbackUpdate(callbackData("approved", "AB23CD"));
    await send(deps, update);

    expect(deps.repo.drafts[0]!.status).toBe("approved");
    expect(deps.repo.reviews).toHaveLength(1);
    expect(deps.repo.reviews[0]).toMatchObject({
      decision: "approved",
      source: "button",
      actorId: 42,
      actorName: "@meera",
      updateId: update.update_id,
    });
    expect(deps.repo.reviews[0]!.at).toBeInstanceOf(Date);
    expect(deps.telegram.answers[0]!.text).toMatch(/approved/);
    expect(deps.telegram.removedButtons).toEqual([{ chatId: deps.allowedChatId, messageId: 5001 }]);
    expect(deps.telegram.sent.at(-1)!.html).toMatch(/has not been published/);
  });

  it("repeated approve clicks are idempotent", async () => {
    const deps = await depsWithDraft();
    await send(deps, callbackUpdate("a:AB23CD"));
    await send(deps, callbackUpdate("a:AB23CD"));
    await send(deps, callbackUpdate("a:AB23CD"));

    expect(deps.repo.drafts[0]!.status).toBe("approved");
    expect(deps.repo.reviews).toHaveLength(1);
    expect(deps.telegram.answers.slice(1).every((a) => /already approved/.test(a.text))).toBe(true);
    // Only the first click posts a confirmation to the chat.
    expect(deps.telegram.sent).toHaveLength(1);
  });

  it("the same callback update delivered twice is deduplicated", async () => {
    const deps = await depsWithDraft();
    const update = callbackUpdate("r:AB23CD");
    await send(deps, update);
    const res = await send(deps, update);
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(deps.repo.reviews).toHaveLength(1);
    expect(deps.telegram.answers).toHaveLength(1);
  });

  it("REJECT command is idempotent and the rejected draft is kept", async () => {
    const deps = await depsWithDraft();
    await send(deps, channelPost("REJECT AB23CD"));
    await send(deps, directMessage("reject ab23cd"));

    expect(deps.repo.drafts).toHaveLength(1);
    expect(deps.repo.drafts[0]!.status).toBe("rejected");
    expect(deps.repo.reviews).toHaveLength(1);
    expect(deps.repo.reviews[0]!.source).toBe("command");
    expect(deps.telegram.sent[0]!.html).toMatch(/rejected/);
    expect(deps.telegram.sent[1]!.html).toMatch(/already rejected/);
  });

  it("a decision is final: approve after reject does not change status", async () => {
    const deps = await depsWithDraft();
    await send(deps, channelPost("REJECT AB23CD"));
    await send(deps, callbackUpdate("a:AB23CD"));
    expect(deps.repo.drafts[0]!.status).toBe("rejected");
    expect(deps.repo.reviews).toHaveLength(1);
    expect(deps.telegram.answers[0]!.text).toMatch(/already rejected/);
  });

  it("reports unknown draft IDs", async () => {
    const deps = await depsWithDraft();
    await send(deps, channelPost("APPROVE ZZ99ZZ"));
    expect(deps.telegram.sent[0]!.html).toMatch(/No draft ZZ99ZZ/);
    expect(deps.repo.reviews).toHaveLength(0);
  });

  it("dead-letters the update and tells the user when the review cannot be saved", async () => {
    const deps = await depsWithDraft();
    deps.repo.failOn.reviewDraft = new Error("db down");
    const update = callbackUpdate("a:AB23CD");
    await send(deps, update);
    expect(deps.repo.updates.get(update.update_id)?.status).toBe("dead_letter");
    expect(deps.telegram.answers[0]!.text).toMatch(/Could not record/);
    expect(deps.repo.drafts[0]!.status).toBe("pending");
  });
});
