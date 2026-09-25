import { z } from "zod";
import { SHORT_ID_PATTERN } from "@/lib/security";

const user = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

const chat = z.object({
  id: z.number().int(),
  type: z.string(),
  title: z.string().optional(),
  username: z.string().optional(),
});

const message = z.object({
  message_id: z.number().int(),
  date: z.number().int(),
  chat,
  from: user.optional(),
  sender_chat: chat.optional(),
  via_bot: user.optional(),
  author_signature: z.string().optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  // Presence-only checks for media; we never download files.
  photo: z.array(z.unknown()).optional(),
  document: z.unknown().optional(),
  voice: z.unknown().optional(),
  audio: z.unknown().optional(),
  video: z.unknown().optional(),
  video_note: z.unknown().optional(),
  animation: z.unknown().optional(),
  sticker: z.unknown().optional(),
});

const callbackQuery = z.object({
  id: z.string().min(1),
  from: user,
  message: z
    .object({
      message_id: z.number().int(),
      chat,
    })
    .optional(),
  data: z.string().max(64).optional(),
});

export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: message.optional(),
  channel_post: message.optional(),
  callback_query: callbackQuery.optional(),
});

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
export type TelegramMessage = z.infer<typeof message>;

export type ReviewDecision = "approved" | "rejected";

interface Base {
  updateId: number;
  updateType: "message" | "channel_post" | "callback_query";
  chatId: number;
}

export interface Actor {
  id: number | null;
  name: string | null;
}

export type ParsedUpdate =
  | (Base & {
      kind: "note";
      messageId: number;
      text: string;
      receivedAt: Date;
    })
  | (Base & {
      kind: "review_command";
      messageId: number;
      decision: ReviewDecision;
      shortId: string;
      actor: Actor;
    })
  | (Base & {
      kind: "review_callback";
      callbackQueryId: string;
      messageId: number | null;
      decision: ReviewDecision;
      shortId: string;
      actor: Actor;
    })
  | (Base & {
      kind: "unsupported_media";
      messageId: number;
    })
  | {
      kind: "ignored";
      updateId: number | null;
      chatId: number | null;
      reason: string;
      callbackQueryId?: string;
    };

const COMMAND_PATTERN = /^\s*(APPROVE|REJECT)\s+([A-Za-z0-9]{4,12})\s*$/i;
const CALLBACK_PATTERN = /^(a|r):([A-Z0-9]{6})$/;

export function callbackData(decision: ReviewDecision, shortId: string): string {
  return `${decision === "approved" ? "a" : "r"}:${shortId}`;
}

function actorFromMessage(msg: TelegramMessage): Actor {
  if (msg.from) {
    const name = msg.from.username
      ? `@${msg.from.username}`
      : [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || null;
    return { id: msg.from.id, name };
  }
  // Channel posts carry no `from`; the channel itself (and optional signature) is the actor.
  return {
    id: msg.sender_chat?.id ?? msg.chat.id,
    name: msg.author_signature ?? msg.sender_chat?.title ?? msg.chat.title ?? null,
  };
}

function hasMedia(msg: TelegramMessage): boolean {
  return Boolean(
    msg.photo ||
    msg.document ||
    msg.voice ||
    msg.audio ||
    msg.video ||
    msg.video_note ||
    msg.animation ||
    msg.sticker,
  );
}

/** Turn a raw webhook body into a small, typed description of what to do. Never throws. */
export function parseUpdate(body: unknown): ParsedUpdate {
  const result = telegramUpdateSchema.safeParse(body);
  if (!result.success) {
    const updateId =
      body &&
      typeof body === "object" &&
      typeof (body as { update_id?: unknown }).update_id === "number"
        ? ((body as { update_id: number }).update_id ?? null)
        : null;
    return { kind: "ignored", updateId, chatId: null, reason: "malformed_update" };
  }
  const update = result.data;

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat.id ?? null;
    if (chatId === null) {
      return {
        kind: "ignored",
        updateId: update.update_id,
        chatId: null,
        reason: "callback_without_message",
        callbackQueryId: cq.id,
      };
    }
    if (cq.from.is_bot) {
      return { kind: "ignored", updateId: update.update_id, chatId, reason: "from_bot" };
    }
    const match = CALLBACK_PATTERN.exec(cq.data ?? "");
    if (!match) {
      return {
        kind: "ignored",
        updateId: update.update_id,
        chatId,
        reason: "unknown_callback_data",
        callbackQueryId: cq.id,
      };
    }
    return {
      kind: "review_callback",
      updateId: update.update_id,
      updateType: "callback_query",
      chatId,
      callbackQueryId: cq.id,
      messageId: cq.message?.message_id ?? null,
      decision: match[1] === "a" ? "approved" : "rejected",
      shortId: match[2]!,
      actor: {
        id: cq.from.id,
        name: cq.from.username ? `@${cq.from.username}` : (cq.from.first_name ?? null),
      },
    };
  }

  const updateType = update.channel_post ? "channel_post" : update.message ? "message" : null;
  const msg = update.channel_post ?? update.message;
  if (!msg || !updateType) {
    return {
      kind: "ignored",
      updateId: update.update_id,
      chatId: null,
      reason: "unsupported_update_type",
    };
  }
  const chatId = msg.chat.id;

  // Loop prevention: never react to anything a bot sent, including our own drafts.
  if (msg.from?.is_bot || msg.via_bot) {
    return { kind: "ignored", updateId: update.update_id, chatId, reason: "from_bot" };
  }

  const text = msg.text?.trim();
  if (text) {
    const command = COMMAND_PATTERN.exec(text);
    if (command) {
      const shortId = command[2]!.toUpperCase();
      if (SHORT_ID_PATTERN.test(shortId)) {
        return {
          kind: "review_command",
          updateId: update.update_id,
          updateType,
          chatId,
          messageId: msg.message_id,
          decision: command[1]!.toUpperCase() === "APPROVE" ? "approved" : "rejected",
          shortId,
          actor: actorFromMessage(msg),
        };
      }
    }
    if (text.startsWith("/")) {
      return { kind: "ignored", updateId: update.update_id, chatId, reason: "bot_command" };
    }
    return {
      kind: "note",
      updateId: update.update_id,
      updateType,
      chatId,
      messageId: msg.message_id,
      text,
      receivedAt: new Date(msg.date * 1000),
    };
  }

  if (hasMedia(msg)) {
    return {
      kind: "unsupported_media",
      updateId: update.update_id,
      updateType,
      chatId,
      messageId: msg.message_id,
    };
  }

  return { kind: "ignored", updateId: update.update_id, chatId, reason: "empty_message" };
}
