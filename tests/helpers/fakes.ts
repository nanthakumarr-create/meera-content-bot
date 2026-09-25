import type { JsonModel, JsonRequest } from "@/ai/gemini";
import { silentLogger } from "@/lib/logger";
import type { NewsItem, NewsService } from "@/news/types";
import type { PipelineDeps, Scheduler } from "@/pipeline/deps";
import type { SendMessageOptions, TelegramClient } from "@/telegram/client";
import { voiceSkillFromContent } from "@/voice/voiceSkill";
import { readFileSync } from "node:fs";
import { MemoryRepository } from "./memoryRepo";

export const ALLOWED_CHAT_ID = -1001234567890;
export const WEBHOOK_SECRET = "test_webhook_secret_0123456789_abcdefghij";

export class FakeTelegram implements TelegramClient {
  sent: { chatId: number; html: string; options: SendMessageOptions }[] = [];
  answers: { id: string; text: string }[] = [];
  removedButtons: { chatId: number; messageId: number }[] = [];
  private nextMessageId = 5000;

  async sendMessage(chatId: number, html: string, options: SendMessageOptions = {}) {
    this.sent.push({ chatId, html, options });
    this.nextMessageId += 1;
    return { messageId: this.nextMessageId };
  }
  async answerCallbackQuery(id: string, text: string) {
    this.answers.push({ id, text });
  }
  async removeButtons(chatId: number, messageId: number) {
    this.removedButtons.push({ chatId, messageId });
  }
}

type Handler = (request: JsonRequest<unknown>) => unknown;

/** Scripted model: each task maps to a handler. Records every request it receives. */
export class FakeModel implements JsonModel {
  readonly model = "fake-gemini";
  calls: JsonRequest<unknown>[] = [];
  constructor(private handlers: Record<string, Handler>) {}

  async generateJson<T>(request: JsonRequest<T>): Promise<T> {
    this.calls.push(request as JsonRequest<unknown>);
    const handler = this.handlers[request.task];
    if (!handler) throw new Error(`FakeModel has no handler for task ${request.task}`);
    // Run the real schema so tests exercise validation.
    return request.schema.parse(await handler(request as JsonRequest<unknown>));
  }

  tasks(): string[] {
    return this.calls.map((c) => c.task);
  }
}

export class FakeNews implements NewsService {
  calls: string[][] = [];
  constructor(private items: NewsItem[] = []) {}
  async findCandidates(keywords: string[]) {
    this.calls.push(keywords);
    return this.items;
  }
}

export const testVoiceSkill = voiceSkillFromContent(readFileSync("voice-skill.txt", "utf8"));

export function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps & {
  repo: MemoryRepository;
  telegram: FakeTelegram;
} {
  return {
    repo: new MemoryRepository(),
    telegram: new FakeTelegram(),
    model: new FakeModel({}),
    news: new FakeNews(),
    loadVoiceSkill: async () => testVoiceSkill,
    logger: silentLogger,
    allowedChatId: ALLOWED_CHAT_ID,
    webhookSecret: WEBHOOK_SECRET,
    ...overrides,
  } as PipelineDeps & { repo: MemoryRepository; telegram: FakeTelegram };
}

/** Collects scheduled background tasks so tests can await them deterministically. */
export function collectingScheduler(): Scheduler & {
  flush: () => Promise<void>;
  count: () => number;
} {
  const tasks: Promise<void>[] = [];
  const schedule = ((task: () => Promise<void>) => {
    tasks.push(task());
  }) as Scheduler & { flush: () => Promise<void>; count: () => number };
  schedule.flush = async () => {
    while (tasks.length) await tasks.shift();
  };
  schedule.count = () => tasks.length;
  return schedule;
}

export function webhookRequest(body: unknown, secret: string | null = WEBHOOK_SECRET): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  return new Request("https://example.test/api/telegram/webhook", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let nextUpdateId = 900_000;
let nextMessageId = 100;

export function channelPost(
  text: string,
  chatId = ALLOWED_CHAT_ID,
  extra: Record<string, unknown> = {},
) {
  nextUpdateId += 1;
  nextMessageId += 1;
  return {
    update_id: nextUpdateId,
    channel_post: {
      message_id: nextMessageId,
      date: 1_790_000_000,
      chat: { id: chatId, type: "channel", title: "Meera notes" },
      sender_chat: { id: chatId, type: "channel", title: "Meera notes" },
      text,
      ...extra,
    },
  };
}

export function directMessage(text: string, chatId = ALLOWED_CHAT_ID, fromBot = false) {
  nextUpdateId += 1;
  nextMessageId += 1;
  return {
    update_id: nextUpdateId,
    message: {
      message_id: nextMessageId,
      date: 1_790_000_000,
      chat: { id: chatId, type: "private" },
      from: { id: 42, is_bot: fromBot, first_name: "Meera", username: "meera" },
      text,
    },
  };
}

export function callbackUpdate(data: string, chatId = ALLOWED_CHAT_ID, messageId = 5001) {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    callback_query: {
      id: `cbq-${nextUpdateId}`,
      from: { id: 42, is_bot: false, first_name: "Meera", username: "meera" },
      message: { message_id: messageId, chat: { id: chatId, type: "channel" } },
      data,
    },
  };
}
