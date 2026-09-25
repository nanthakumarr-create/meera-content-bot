import { randomUUID } from "node:crypto";
import type { PriorDraft } from "@/ai/prompts";
import type {
  DraftStatus,
  NewDraft,
  NoteStatus,
  Repository,
  ReviewInput,
  ReviewResult,
  UpdateStatus,
  UpdateType,
} from "@/db/types";
import type { NewsItem } from "@/news/types";

export interface MemUpdate {
  updateId: number;
  updateType: UpdateType;
  chatId: number | null;
  status: UpdateStatus;
  error?: { category: string; message: string };
}

export interface MemNote {
  id: string;
  updateId: number;
  chatId: number;
  messageId: number;
  rawText: string;
  receivedAt: Date;
  status: NoteStatus;
  score?: number;
  scoreReason?: string;
  keywords?: string[];
  failureReason?: string | null;
}

export interface MemDraft extends NewDraft {
  id: string;
  status: DraftStatus;
  telegramMessageId: number | null;
  reviewedAt: Date | null;
}

export interface MemReview {
  draftId: string;
  decision: "approved" | "rejected";
  source: "button" | "command";
  actorId: number | null;
  actorName: string | null;
  updateId: number;
  at: Date;
}

/** A faithful in-memory stand-in for the Supabase repository and its SQL functions. */
export class MemoryRepository implements Repository {
  updates = new Map<number, MemUpdate>();
  notes: MemNote[] = [];
  drafts: MemDraft[] = [];
  reviews: MemReview[] = [];
  voiceSkills: { id: string; version: string; sha256: string; content: string; active: boolean }[] =
    [];
  newsCache = new Map<string, { items: NewsItem[]; expiresAt: Date }>();
  rateEvents: { chatId: number; bucket: string; at: number }[] = [];
  activeSlots = 0;
  forceRateLimited = false;
  failOn: Partial<Record<keyof Repository, Error>> = {};

  private maybeFail(method: keyof Repository) {
    const error = this.failOn[method];
    if (error) throw error;
  }

  async ingestNote(note: Parameters<Repository["ingestNote"]>[0]) {
    this.maybeFail("ingestNote");
    if (this.updates.has(note.updateId)) return null;
    this.updates.set(note.updateId, {
      updateId: note.updateId,
      updateType: note.updateType,
      chatId: note.chatId,
      status: "processing",
    });
    if (this.notes.some((n) => n.chatId === note.chatId && n.messageId === note.messageId)) {
      this.updates.get(note.updateId)!.status = "ignored";
      return null;
    }
    const id = randomUUID();
    this.notes.push({ id, ...note, status: "received" });
    return { noteId: id };
  }

  async recordUpdate(input: Parameters<Repository["recordUpdate"]>[0]) {
    this.maybeFail("recordUpdate");
    if (this.updates.has(input.updateId)) return false;
    this.updates.set(input.updateId, { ...input });
    return true;
  }

  async setUpdateStatus(
    updateId: number,
    status: UpdateStatus,
    error?: { category: string; message: string },
  ) {
    const update = this.updates.get(updateId);
    if (update) {
      update.status = status;
      update.error = error;
    }
  }

  async hitRateLimit(chatId: number, bucket: string, limit: number) {
    if (this.forceRateLimited) return false;
    const count = this.rateEvents.filter((e) => e.chatId === chatId && e.bucket === bucket).length;
    if (count >= limit) return false;
    this.rateEvents.push({ chatId, bucket, at: Date.now() });
    return true;
  }

  async tryBeginProcessing(noteId: string, maxConcurrent: number) {
    if (this.activeSlots >= maxConcurrent) return false;
    const note = this.note(noteId);
    if (note.status !== "received") return false;
    note.status = "scoring";
    return true;
  }

  async updateNote(noteId: string, patch: Parameters<Repository["updateNote"]>[1]) {
    this.maybeFail("updateNote");
    Object.assign(
      this.note(noteId),
      Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    );
  }

  async recentReviewedDrafts(chatId: number, limit: number): Promise<PriorDraft[]> {
    return this.drafts
      .filter((d) => d.status !== "pending" && this.note(d.noteId).chatId === chatId)
      .slice(-limit)
      .map((d) => ({
        status: d.status as PriorDraft["status"],
        excerpt: d.draftText.slice(0, 280),
      }));
  }

  async ensureVoiceSkill(version: string, sha256: string, content: string) {
    let skill = this.voiceSkills.find((v) => v.sha256 === sha256);
    if (!skill) {
      skill = { id: randomUUID(), version, sha256, content, active: false };
      this.voiceSkills.push(skill);
    }
    for (const v of this.voiceSkills) v.active = v.id === skill.id;
    return { id: skill.id, version: skill.version };
  }

  async createDraft(draft: NewDraft) {
    this.maybeFail("createDraft");
    if (!this.voiceSkills.some((v) => v.id === draft.voiceSkillId))
      throw new Error("fk voice_skill_id");
    if (this.drafts.some((d) => d.noteId === draft.noteId)) throw new Error("duplicate note_id");
    const id = randomUUID();
    this.drafts.push({
      ...draft,
      id,
      status: "pending",
      telegramMessageId: null,
      reviewedAt: null,
    });
    this.note(draft.noteId).status = "drafted";
    return { draftId: id, shortId: draft.shortId };
  }

  async setDraftTelegramMessage(draftId: string, messageId: number) {
    const draft = this.drafts.find((d) => d.id === draftId);
    if (draft) draft.telegramMessageId = messageId;
  }

  async reviewDraft(input: ReviewInput): Promise<ReviewResult> {
    this.maybeFail("reviewDraft");
    const draft = this.drafts.find(
      (d) =>
        d.shortId === input.shortId.toUpperCase() && this.note(d.noteId).chatId === input.chatId,
    );
    if (!draft)
      return { outcome: "not_found", draftId: null, status: null, telegramMessageId: null };
    if (draft.status === "pending") {
      draft.status = input.decision;
      draft.reviewedAt = new Date();
      this.reviews.push({
        draftId: draft.id,
        decision: input.decision,
        source: input.source,
        actorId: input.actor.id,
        actorName: input.actor.name,
        updateId: input.updateId,
        at: draft.reviewedAt,
      });
      return {
        outcome: "updated",
        draftId: draft.id,
        status: draft.status,
        telegramMessageId: draft.telegramMessageId,
      };
    }
    return {
      outcome: draft.status === input.decision ? "unchanged" : "conflict",
      draftId: draft.id,
      status: draft.status,
      telegramMessageId: draft.telegramMessageId,
    };
  }

  async getNewsCache(key: string, now: Date) {
    const hit = this.newsCache.get(key);
    return hit && hit.expiresAt > now ? hit.items : null;
  }

  async putNewsCache(key: string, _query: string, items: NewsItem[], expiresAt: Date) {
    this.newsCache.set(key, { items, expiresAt });
  }

  async ping() {
    this.maybeFail("ping");
  }

  note(id: string): MemNote {
    const note = this.notes.find((n) => n.id === id);
    if (!note) throw new Error(`note ${id} not found`);
    return note;
  }
}
