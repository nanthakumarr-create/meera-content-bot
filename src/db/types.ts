import type { PriorDraft } from "@/ai/prompts";
import type { NewsCacheStore, NewsItem } from "@/news/types";
import type { Actor, ReviewDecision } from "@/telegram/updates";

export type UpdateType = "message" | "channel_post" | "callback_query" | "unknown";
export type UpdateStatus = "received" | "processing" | "completed" | "ignored" | "dead_letter";
export type NoteStatus =
  | "received"
  | "rate_limited"
  | "throttled"
  | "scoring"
  | "rejected"
  | "finding_news"
  | "drafting"
  | "drafted"
  | "failed";
export type DraftStatus = "pending" | "approved" | "rejected";
export type ReviewOutcome = "updated" | "unchanged" | "conflict" | "not_found";

export interface NewNote {
  updateId: number;
  updateType: UpdateType;
  chatId: number;
  messageId: number;
  rawText: string;
  receivedAt: Date;
  requestId: string;
}

export interface NotePatch {
  status?: NoteStatus;
  score?: number;
  scoreReason?: string;
  keywords?: string[];
  failureReason?: string | null;
}

export interface VoiceSkillRecord {
  id: string;
  version: string;
}

export interface NewDraft {
  noteId: string;
  shortId: string;
  voiceSkillId: string;
  model: string;
  draftText: string;
  news: NewsItem | null;
}

export interface ReviewInput {
  shortId: string;
  chatId: number;
  decision: ReviewDecision;
  actor: Actor;
  source: "button" | "command";
  updateId: number;
}

export interface ReviewResult {
  outcome: ReviewOutcome;
  draftId: string | null;
  status: DraftStatus | null;
  telegramMessageId: number | null;
}

/**
 * Everything the app needs from Postgres. Multi-row writes are implemented as
 * single SQL functions so they commit or roll back atomically.
 */
export interface Repository extends NewsCacheStore {
  /** Insert telegram_updates + notes atomically. Returns null when the update_id was already seen. */
  ingestNote(note: NewNote): Promise<{ noteId: string } | null>;
  /** Record a non-note update. Returns false when the update_id was already seen. */
  recordUpdate(input: {
    updateId: number;
    updateType: UpdateType;
    chatId: number | null;
    requestId: string;
    status: UpdateStatus;
  }): Promise<boolean>;
  setUpdateStatus(
    updateId: number,
    status: UpdateStatus,
    error?: { category: string; message: string },
  ): Promise<void>;
  /** Sliding-window per-chat rate limit. Records the event when allowed. */
  hitRateLimit(
    chatId: number,
    bucket: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean>;
  /** Global concurrency guard: marks the note as scoring if a slot is free. */
  tryBeginProcessing(noteId: string, maxConcurrent: number, staleSeconds: number): Promise<boolean>;
  updateNote(noteId: string, patch: NotePatch): Promise<void>;
  recentReviewedDrafts(chatId: number, limit: number): Promise<PriorDraft[]>;
  ensureVoiceSkill(version: string, sha256: string, content: string): Promise<VoiceSkillRecord>;
  /** Insert the draft and mark its note drafted, atomically. */
  createDraft(draft: NewDraft): Promise<{ draftId: string; shortId: string }>;
  setDraftTelegramMessage(draftId: string, messageId: number): Promise<void>;
  /** Idempotent pending -> approved/rejected transition plus review record, atomically. */
  reviewDraft(input: ReviewInput): Promise<ReviewResult>;
  ping(): Promise<void>;
}
