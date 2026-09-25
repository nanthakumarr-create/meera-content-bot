import { z } from "zod";
import { AppError, isAbortOrTimeout, isNetworkError, isTransientStatus } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { withRetry } from "@/lib/retry";

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface SendMessageOptions {
  replyToMessageId?: number;
  buttons?: InlineButton[][];
}

export interface TelegramClient {
  sendMessage(
    chatId: number,
    html: string,
    options?: SendMessageOptions,
  ): Promise<{ messageId: number }>;
  answerCallbackQuery(callbackQueryId: string, text: string): Promise<void>;
  removeButtons(chatId: number, messageId: number): Promise<void>;
}

const apiResponse = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

type FetchLike = typeof fetch;

export interface TelegramClientOptions {
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export function createTelegramClient(options: TelegramClientOptions): TelegramClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;

  async function call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    return withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetchImpl(`https://api.telegram.org/bot${options.token}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          // Never include the URL: it contains the bot token.
          throw new AppError("telegram", `Telegram ${method} request failed`, {
            retryable: isAbortOrTimeout(error) || isNetworkError(error),
          });
        }
        const parsed = apiResponse.safeParse(await response.json().catch(() => null));
        if (!parsed.success) {
          throw new AppError("telegram", `Telegram ${method} returned an unreadable response`, {
            retryable: isTransientStatus(response.status),
            status: response.status,
          });
        }
        if (!parsed.data.ok) {
          const status = parsed.data.error_code ?? response.status;
          // "message is not modified" is harmless for idempotent edits.
          if (/message is not modified/i.test(parsed.data.description ?? "")) return null;
          throw new AppError(
            status === 401 || status === 403 ? "authorization" : "telegram",
            `Telegram ${method} failed (${status}): ${parsed.data.description ?? "no description"}`,
            { retryable: isTransientStatus(status), status },
          );
        }
        return parsed.data.result;
      },
      {
        attempts: 3,
        baseDelayMs: 400,
        maxDelayMs: 3_000,
        sleep: options.sleep,
        onRetry: ({ attempt, delayMs }) =>
          options.logger?.warn("telegram.retry", { method, attempt, delayMs }),
      },
    );
  }

  return {
    async sendMessage(chatId, html, sendOptions = {}) {
      const result = await call("sendMessage", {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(sendOptions.replyToMessageId
          ? {
              reply_parameters: {
                message_id: sendOptions.replyToMessageId,
                allow_sending_without_reply: true,
              },
            }
          : {}),
        ...(sendOptions.buttons ? { reply_markup: { inline_keyboard: sendOptions.buttons } } : {}),
      });
      const messageId = z.object({ message_id: z.number() }).safeParse(result);
      if (!messageId.success) {
        throw new AppError("telegram", "Telegram sendMessage returned no message_id");
      }
      return { messageId: messageId.data.message_id };
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: text.slice(0, 190),
      });
    },
    async removeButtons(chatId, messageId) {
      await call("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    },
  };
}
