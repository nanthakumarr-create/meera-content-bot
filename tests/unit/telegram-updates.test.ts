import { describe, expect, it } from "vitest";
import { callbackData, parseUpdate } from "@/telegram/updates";
import { ALLOWED_CHAT_ID, callbackUpdate, channelPost, directMessage } from "../helpers/fakes";

describe("parseUpdate", () => {
  it("parses a channel post as a note", () => {
    const update = channelPost("A real observation about pH drift.");
    const parsed = parseUpdate(update);
    expect(parsed).toMatchObject({
      kind: "note",
      updateType: "channel_post",
      chatId: ALLOWED_CHAT_ID,
      updateId: update.update_id,
      messageId: update.channel_post.message_id,
      text: "A real observation about pH drift.",
    });
    if (parsed.kind === "note")
      expect(parsed.receivedAt.toISOString()).toBe("2026-09-21T14:13:20.000Z");
  });

  it("parses a direct message as a note", () => {
    const parsed = parseUpdate(directMessage("Customer asked why niacinamide stings."));
    expect(parsed).toMatchObject({
      kind: "note",
      updateType: "message",
      text: "Customer asked why niacinamide stings.",
    });
  });

  it("parses approve/reject callbacks", () => {
    const approve = parseUpdate(callbackUpdate(callbackData("approved", "AB23CD")));
    expect(approve).toMatchObject({
      kind: "review_callback",
      decision: "approved",
      shortId: "AB23CD",
      chatId: ALLOWED_CHAT_ID,
      actor: { id: 42, name: "@meera" },
    });
    const reject = parseUpdate(callbackUpdate("r:AB23CD"));
    expect(reject).toMatchObject({ kind: "review_callback", decision: "rejected" });
  });

  it("ignores callbacks with unknown data but keeps the id to answer it", () => {
    const parsed = parseUpdate(callbackUpdate("delete:everything"));
    expect(parsed).toMatchObject({ kind: "ignored", reason: "unknown_callback_data" });
    expect(parsed.kind === "ignored" && parsed.callbackQueryId).toBeTruthy();
  });

  it("parses APPROVE/REJECT text commands case-insensitively", () => {
    expect(parseUpdate(channelPost("APPROVE AB23CD"))).toMatchObject({
      kind: "review_command",
      decision: "approved",
      shortId: "AB23CD",
    });
    expect(parseUpdate(directMessage("reject ab23cd"))).toMatchObject({
      kind: "review_command",
      decision: "rejected",
      shortId: "AB23CD",
      actor: { id: 42, name: "@meera" },
    });
  });

  it("treats a command with an impossible id as an ordinary note", () => {
    expect(parseUpdate(channelPost("APPROVE O0I1L0"))).toMatchObject({ kind: "note" });
  });

  it("ignores messages from bots to prevent loops", () => {
    expect(parseUpdate(directMessage("Draft AB23CD", ALLOWED_CHAT_ID, true))).toMatchObject({
      kind: "ignored",
      reason: "from_bot",
    });
    const viaBot = channelPost("hello", ALLOWED_CHAT_ID, {
      via_bot: { id: 1, is_bot: true, first_name: "x" },
    });
    expect(parseUpdate(viaBot)).toMatchObject({ kind: "ignored", reason: "from_bot" });
  });

  it("flags media without text as unsupported", () => {
    const photo = channelPost("", ALLOWED_CHAT_ID, { text: undefined, photo: [{ file_id: "x" }] });
    expect(parseUpdate(photo)).toMatchObject({ kind: "unsupported_media" });
    const voice = directMessage("");
    (voice.message as Record<string, unknown>).text = undefined;
    (voice.message as Record<string, unknown>).voice = { file_id: "v" };
    expect(parseUpdate(voice)).toMatchObject({ kind: "unsupported_media" });
  });

  it("returns ignored for malformed payloads without throwing", () => {
    expect(parseUpdate(null)).toMatchObject({
      kind: "ignored",
      reason: "malformed_update",
      updateId: null,
    });
    expect(parseUpdate("text")).toMatchObject({ kind: "ignored", reason: "malformed_update" });
    expect(parseUpdate({ update_id: "7" })).toMatchObject({
      kind: "ignored",
      reason: "malformed_update",
    });
    expect(parseUpdate({ update_id: 7, message: { chat: {} } })).toMatchObject({
      kind: "ignored",
      reason: "malformed_update",
      updateId: 7,
    });
    expect(parseUpdate({ update_id: 8 })).toMatchObject({
      kind: "ignored",
      reason: "unsupported_update_type",
    });
  });

  it("ignores slash commands and empty messages", () => {
    expect(parseUpdate(directMessage("/start"))).toMatchObject({
      kind: "ignored",
      reason: "bot_command",
    });
    expect(parseUpdate(directMessage("   "))).toMatchObject({
      kind: "ignored",
      reason: "empty_message",
    });
  });
});
