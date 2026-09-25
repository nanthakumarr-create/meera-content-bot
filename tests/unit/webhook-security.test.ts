import { describe, expect, it } from "vitest";
import { safeEqual } from "@/lib/security";
import { handleWebhook } from "@/pipeline/webhook";
import {
  channelPost,
  collectingScheduler,
  FakeModel,
  makeDeps,
  webhookRequest,
  WEBHOOK_SECRET,
} from "../helpers/fakes";

const lowScoreModel = () =>
  new FakeModel({ score: () => ({ score: 2, reason: "No argument.", keywords: ["a", "b", "c"] }) });

describe("webhook secret validation", () => {
  it("rejects a missing secret header with 401 and does no work", async () => {
    const deps = makeDeps();
    const schedule = collectingScheduler();
    const res = await handleWebhook(webhookRequest(channelPost("note"), null), deps, schedule);
    expect(res.status).toBe(401);
    expect(deps.repo.updates.size).toBe(0);
    expect(schedule.count()).toBe(0);
  });

  it("rejects a wrong secret with 401", async () => {
    const deps = makeDeps();
    const res = await handleWebhook(
      webhookRequest(channelPost("note"), `${WEBHOOK_SECRET}x`),
      deps,
      collectingScheduler(),
    );
    expect(res.status).toBe(401);
    expect(deps.repo.notes).toHaveLength(0);
  });

  it("accepts the correct secret", async () => {
    const deps = makeDeps({ model: lowScoreModel() });
    const schedule = collectingScheduler();
    const res = await handleWebhook(webhookRequest(channelPost("a note")), deps, schedule);
    await schedule.flush();
    expect(res.status).toBe(200);
    expect(deps.repo.notes).toHaveLength(1);
  });

  it("safeEqual is exact and handles empty or missing input", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abd", "abc")).toBe(false);
    expect(safeEqual("abcd", "abc")).toBe(false);
    expect(safeEqual("", "abc")).toBe(false);
    expect(safeEqual(null, "abc")).toBe(false);
    expect(safeEqual(undefined, "abc")).toBe(false);
  });

  it("returns 400 for a non-JSON body", async () => {
    const res = await handleWebhook(webhookRequest("{not json"), makeDeps(), collectingScheduler());
    expect(res.status).toBe(400);
  });
});

describe("allowed chat enforcement", () => {
  it("ignores notes from any other chat without storing or replying", async () => {
    const deps = makeDeps();
    const schedule = collectingScheduler();
    const res = await handleWebhook(
      webhookRequest(channelPost("intruder note", -100999)),
      deps,
      schedule,
    );
    await schedule.flush();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "chat_not_allowed" });
    expect(deps.repo.updates.size).toBe(0);
    expect(deps.telegram.sent).toHaveLength(0);
  });

  it("ignores review commands and callbacks from other chats", async () => {
    const deps = makeDeps();
    const schedule = collectingScheduler();
    await handleWebhook(webhookRequest(channelPost("APPROVE AB23CD", -100999)), deps, schedule);
    await schedule.flush();
    expect(deps.repo.reviews).toHaveLength(0);
    expect(deps.telegram.sent).toHaveLength(0);
  });
});

describe("update idempotency", () => {
  it("processes a redelivered update_id only once", async () => {
    const model = lowScoreModel();
    const deps = makeDeps({ model });
    const schedule = collectingScheduler();
    const update = channelPost("A note that Telegram delivers twice.");

    const first = await handleWebhook(webhookRequest(update), deps, schedule);
    const second = await handleWebhook(webhookRequest(update), deps, schedule);
    await schedule.flush();

    expect(await first.json()).toMatchObject({ accepted: true });
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(deps.repo.notes).toHaveLength(1);
    expect(model.calls).toHaveLength(1);
    expect(deps.telegram.sent).toHaveLength(1);
  });

  it("stores the note before any AI call", async () => {
    const deps = makeDeps();
    const notesAtCallTime: number[] = [];
    deps.model = new FakeModel({
      score: () => {
        notesAtCallTime.push(deps.repo.notes.length);
        return { score: 1, reason: "Too thin.", keywords: ["a", "b", "c"] };
      },
    });
    const schedule = collectingScheduler();
    await handleWebhook(webhookRequest(channelPost("thin")), deps, schedule);
    await schedule.flush();
    expect(notesAtCallTime).toEqual([1]);
  });

  it("returns 500 (so Telegram retries) when the note cannot be stored", async () => {
    const deps = makeDeps();
    deps.repo.failOn.ingestNote = new Error("connection refused");
    const res = await handleWebhook(
      webhookRequest(channelPost("note")),
      deps,
      collectingScheduler(),
    );
    expect(res.status).toBe(500);
  });
});

describe("rate limiting and media", () => {
  it("stores but does not process a rate-limited note", async () => {
    const model = lowScoreModel();
    const deps = makeDeps({ model });
    deps.repo.forceRateLimited = true;
    const schedule = collectingScheduler();
    await handleWebhook(webhookRequest(channelPost("too many")), deps, schedule);
    await schedule.flush();
    expect(deps.repo.notes[0]?.status).toBe("rate_limited");
    expect(model.calls).toHaveLength(0);
    expect(deps.telegram.sent[0]?.html).toMatch(/saved but was not processed/);
  });

  it("stops processing when the global concurrency guard is full", async () => {
    const model = lowScoreModel();
    const deps = makeDeps({ model });
    deps.repo.activeSlots = 99;
    const schedule = collectingScheduler();
    await handleWebhook(webhookRequest(channelPost("busy")), deps, schedule);
    await schedule.flush();
    expect(deps.repo.notes[0]?.status).toBe("throttled");
    expect(model.calls).toHaveLength(0);
    expect(deps.telegram.sent[0]?.html).toMatch(/busy/);
  });

  it("replies with a text-only message for media", async () => {
    const deps = makeDeps();
    const schedule = collectingScheduler();
    const update = channelPost("", undefined, { text: undefined, photo: [{ file_id: "p" }] });
    await handleWebhook(webhookRequest(update), deps, schedule);
    await schedule.flush();
    expect(deps.telegram.sent).toHaveLength(1);
    expect(deps.telegram.sent[0]?.html).toMatch(/text notes only/);
    expect(deps.repo.notes).toHaveLength(0);
  });
});
