import { randomUUID } from "node:crypto";
import type { UpdateType } from "@/db/types";
import { pipelineSettings } from "@/lib/config";
import { describeError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { safeEqual } from "@/lib/security";
import { formatReviewOutcome, MESSAGES } from "@/telegram/format";
import { parseUpdate, type ParsedUpdate } from "@/telegram/updates";
import type { PipelineDeps, Scheduler } from "./deps";
import { processNote, safely } from "./processNote";

export const SECRET_HEADER = "x-telegram-bot-api-secret-token";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Webhook entry point. Everything that must happen before we acknowledge
 * Telegram (auth, chat check, dedupe, storing the note) happens here; the slow
 * AI work is handed to `schedule` so Telegram gets a fast 200.
 */
export async function handleWebhook(
  request: Request,
  deps: PipelineDeps,
  schedule: Scheduler,
): Promise<Response> {
  const requestId = randomUUID();
  const log = deps.logger.child({ requestId });

  if (!safeEqual(request.headers.get(SECRET_HEADER), deps.webhookSecret)) {
    log.warn("webhook.bad_secret");
    return json(401, { ok: false });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    log.warn("webhook.invalid_json");
    return json(400, { ok: false });
  }

  const parsed = parseUpdate(body);
  const updateLog = log.child({ updateId: parsed.updateId, kind: parsed.kind });

  // Allowed-chat enforcement before any database write or reply.
  if (parsed.chatId !== null && parsed.chatId !== deps.allowedChatId) {
    updateLog.warn("webhook.chat_not_allowed", { chatId: parsed.chatId });
    return json(200, { ok: true, ignored: "chat_not_allowed" });
  }

  try {
    return await route(parsed, deps, schedule, updateLog, requestId);
  } catch (error) {
    // Database unreachable before we could store the update. Return 500 so
    // Telegram redelivers; dedupe makes the redelivery safe.
    updateLog.error("webhook.failed", { error: describeError(error) });
    return json(500, { ok: false });
  }
}

async function route(
  parsed: ParsedUpdate,
  deps: PipelineDeps,
  schedule: Scheduler,
  log: Logger,
  requestId: string,
): Promise<Response> {
  const { repo, telegram } = deps;

  if (parsed.kind === "ignored") {
    log.info("webhook.ignored", { reason: parsed.reason });
    if (parsed.updateId !== null && parsed.chatId !== null) {
      await repo.recordUpdate({
        updateId: parsed.updateId,
        updateType: "unknown",
        chatId: parsed.chatId,
        requestId,
        status: "ignored",
      });
    }
    if (parsed.callbackQueryId && parsed.chatId !== null) {
      const id = parsed.callbackQueryId;
      schedule(() =>
        safely(log, "telegram.answer_callback", () =>
          telegram.answerCallbackQuery(id, "Unknown action."),
        ),
      );
    }
    return json(200, { ok: true, ignored: parsed.reason });
  }

  const updateType: UpdateType = parsed.updateType;

  if (parsed.kind === "note") {
    const stored = await repo.ingestNote({
      updateId: parsed.updateId,
      updateType,
      chatId: parsed.chatId,
      messageId: parsed.messageId,
      rawText: parsed.text,
      receivedAt: parsed.receivedAt,
      requestId,
    });
    if (!stored) {
      log.info("webhook.duplicate");
      return json(200, { ok: true, duplicate: true });
    }
    const { noteId } = stored;
    log.info("note.stored", { noteId, length: parsed.text.length });

    if (parsed.text.length > pipelineSettings.maxNoteLength) {
      await repo.updateNote(noteId, {
        status: "failed",
        failureReason: "validation: note too long",
      });
      await repo.setUpdateStatus(parsed.updateId, "completed");
      schedule(() =>
        safely(log, "telegram.too_long", () =>
          telegram.sendMessage(parsed.chatId, MESSAGES.noteTooLong, {
            replyToMessageId: parsed.messageId,
          }),
        ),
      );
      return json(200, { ok: true, rejected: "too_long" });
    }

    const allowed = await repo.hitRateLimit(
      parsed.chatId,
      "note",
      pipelineSettings.rateLimitPerChat,
      pipelineSettings.rateLimitWindowSeconds,
    );
    if (!allowed) {
      log.warn("note.rate_limited");
      await repo.updateNote(noteId, { status: "rate_limited" });
      await repo.setUpdateStatus(parsed.updateId, "completed");
      schedule(() =>
        safely(log, "telegram.rate_limited", () =>
          telegram.sendMessage(parsed.chatId, MESSAGES.rateLimited, {
            replyToMessageId: parsed.messageId,
          }),
        ),
      );
      return json(200, { ok: true, rate_limited: true });
    }

    schedule(async () => {
      await processNote(
        {
          noteId,
          updateId: parsed.updateId,
          chatId: parsed.chatId,
          messageId: parsed.messageId,
          text: parsed.text,
        },
        { ...deps, logger: log },
      );
    });
    return json(200, { ok: true, accepted: true });
  }

  // Every other kind: dedupe first.
  const isNew = await repo.recordUpdate({
    updateId: parsed.updateId,
    updateType,
    chatId: parsed.chatId,
    requestId,
    status: "processing",
  });
  if (!isNew) {
    log.info("webhook.duplicate");
    return json(200, { ok: true, duplicate: true });
  }

  if (parsed.kind === "unsupported_media") {
    await repo.setUpdateStatus(parsed.updateId, "completed");
    schedule(() =>
      safely(log, "telegram.text_only", () =>
        telegram.sendMessage(parsed.chatId, MESSAGES.textOnly, {
          replyToMessageId: parsed.messageId,
        }),
      ),
    );
    return json(200, { ok: true, unsupported: "media" });
  }

  const allowed = await repo.hitRateLimit(
    parsed.chatId,
    "review",
    60,
    pipelineSettings.rateLimitWindowSeconds,
  );
  if (!allowed) {
    await repo.setUpdateStatus(parsed.updateId, "completed");
    if (parsed.kind === "review_callback") {
      const id = parsed.callbackQueryId;
      schedule(() =>
        safely(log, "telegram.answer_callback", () =>
          telegram.answerCallbackQuery(id, "Too many actions. Try again shortly."),
        ),
      );
    }
    return json(200, { ok: true, rate_limited: true });
  }

  schedule(() => handleReview(parsed, deps, log));
  return json(200, { ok: true, accepted: true });
}

async function handleReview(
  parsed: Extract<ParsedUpdate, { kind: "review_command" | "review_callback" }>,
  deps: PipelineDeps,
  log: Logger,
): Promise<void> {
  const { repo, telegram } = deps;
  const source = parsed.kind === "review_callback" ? "button" : "command";
  try {
    const result = await repo.reviewDraft({
      shortId: parsed.shortId,
      chatId: parsed.chatId,
      decision: parsed.decision,
      actor: parsed.actor,
      source,
      updateId: parsed.updateId,
    });
    log.info("review.result", {
      shortId: parsed.shortId,
      outcome: result.outcome,
      status: result.status,
      source,
    });
    const message = formatReviewOutcome(result.outcome, parsed.shortId, result.status);

    if (parsed.kind === "review_callback") {
      await safely(log, "telegram.answer_callback", () =>
        telegram.answerCallbackQuery(parsed.callbackQueryId, message),
      );
    }
    if (
      result.outcome === "updated" ||
      result.outcome === "unchanged" ||
      result.outcome === "conflict"
    ) {
      const buttonsMessageId =
        parsed.kind === "review_callback" ? parsed.messageId : result.telegramMessageId;
      if (buttonsMessageId) {
        await safely(log, "telegram.remove_buttons", () =>
          telegram.removeButtons(parsed.chatId, buttonsMessageId),
        );
      }
    }
    if (result.outcome === "updated" || parsed.kind === "review_command") {
      await telegram.sendMessage(parsed.chatId, message, {
        replyToMessageId:
          parsed.kind === "review_command" ? parsed.messageId : (parsed.messageId ?? undefined),
      });
    }
    await repo.setUpdateStatus(parsed.updateId, "completed");
  } catch (error) {
    const described = describeError(error);
    log.error("review.failed", { error: described });
    await safely(log, "update.dead_letter", () =>
      repo.setUpdateStatus(parsed.updateId, "dead_letter", described),
    );
    if (parsed.kind === "review_callback") {
      await safely(log, "telegram.answer_callback", () =>
        telegram.answerCallbackQuery(
          parsed.callbackQueryId,
          "Could not record that decision. Please try again.",
        ),
      );
    } else {
      await safely(log, "telegram.failure_notice", () =>
        telegram.sendMessage(parsed.chatId, "Could not record that decision. Please try again.", {
          replyToMessageId: parsed.messageId,
        }),
      );
    }
  }
}
