import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { PriorDraft } from "@/ai/prompts";
import { AppError } from "@/lib/errors";
import type { NewsItem } from "@/news/types";
import type { Repository, ReviewResult } from "./types";

interface PgError {
  message: string;
  code?: string;
}

function dbError(operation: string, error: PgError): AppError {
  // PostgREST/connection errors are transient; constraint violations (23xxx) are not.
  const retryable = !error.code || /^(08|40|53|57|PGRST0)/.test(error.code);
  return new AppError("supabase", `Supabase ${operation} failed: ${error.message}`, { retryable });
}

async function rpc<T>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw dbError(fn, error);
  return data as T;
}

const newsItemJson = z.object({
  headline: z.string(),
  publication: z.string().nullable(),
  publishedAt: z.string().nullable(),
  url: z.string(),
  description: z.string(),
});

const reviewRow = z.object({
  outcome: z.enum(["updated", "unchanged", "conflict", "not_found"]),
  draft_id: z.string().nullable(),
  status: z.enum(["pending", "approved", "rejected"]).nullable(),
  telegram_message_id: z.number().nullable(),
});

export function createSupabaseRepository(url: string, serviceRoleKey: string): Repository {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(8_000) }),
    },
  });

  return {
    async ingestNote(note) {
      const id = await rpc<string | null>(client, "ingest_note", {
        p_update_id: note.updateId,
        p_update_type: note.updateType,
        p_chat_id: note.chatId,
        p_message_id: note.messageId,
        p_raw_text: note.rawText,
        p_received_at: note.receivedAt.toISOString(),
        p_request_id: note.requestId,
      });
      return id ? { noteId: id } : null;
    },

    async recordUpdate(input) {
      return rpc<boolean>(client, "record_update", {
        p_update_id: input.updateId,
        p_update_type: input.updateType,
        p_chat_id: input.chatId,
        p_request_id: input.requestId,
        p_status: input.status,
      });
    },

    async setUpdateStatus(updateId, status, error) {
      const { error: pgError } = await client
        .from("telegram_updates")
        .update({
          status,
          processed_at:
            status === "completed" || status === "dead_letter" || status === "ignored"
              ? new Date().toISOString()
              : null,
          error_category: error?.category ?? null,
          error_message: error?.message ?? null,
        })
        .eq("update_id", updateId);
      if (pgError) throw dbError("setUpdateStatus", pgError);
    },

    async hitRateLimit(chatId, bucket, limit, windowSeconds) {
      return rpc<boolean>(client, "hit_rate_limit", {
        p_chat_id: chatId,
        p_bucket: bucket,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
    },

    async tryBeginProcessing(noteId, maxConcurrent, staleSeconds) {
      return rpc<boolean>(client, "try_begin_processing", {
        p_note_id: noteId,
        p_max_concurrent: maxConcurrent,
        p_stale_seconds: staleSeconds,
      });
    },

    async updateNote(noteId, patch) {
      const row: Record<string, unknown> = {};
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.score !== undefined) row.score = patch.score;
      if (patch.scoreReason !== undefined) row.score_reason = patch.scoreReason;
      if (patch.keywords !== undefined) row.keywords = patch.keywords;
      if (patch.failureReason !== undefined) row.failure_reason = patch.failureReason;
      const { error } = await client.from("notes").update(row).eq("id", noteId);
      if (error) throw dbError("updateNote", error);
    },

    async recentReviewedDrafts(chatId, limit) {
      const { data, error } = await client
        .from("drafts")
        .select("status, draft_text, notes!inner(chat_id)")
        .in("status", ["approved", "rejected"])
        .eq("notes.chat_id", chatId)
        .order("reviewed_at", { ascending: false })
        .limit(limit);
      if (error) throw dbError("recentReviewedDrafts", error);
      return (data ?? []).map((row): PriorDraft => ({
        status: row.status as PriorDraft["status"],
        excerpt: String(row.draft_text).replace(/\s+/g, " ").slice(0, 280),
      }));
    },

    async ensureVoiceSkill(version, sha256, content) {
      const id = await rpc<string>(client, "ensure_voice_skill", {
        p_version: version,
        p_sha256: sha256,
        p_content: content,
      });
      return { id, version };
    },

    async createDraft(draft) {
      const draftId = await rpc<string>(client, "create_draft", {
        p_note_id: draft.noteId,
        p_short_id: draft.shortId,
        p_voice_skill_id: draft.voiceSkillId,
        p_model: draft.model,
        p_draft_text: draft.draftText,
        p_news_used: draft.news !== null,
        p_news_headline: draft.news?.headline ?? null,
        p_news_publication: draft.news?.publication ?? null,
        p_news_published_at: draft.news?.publishedAt?.toISOString() ?? null,
        p_news_url: draft.news?.url ?? null,
        p_news_description: draft.news?.description ?? null,
      });
      return { draftId, shortId: draft.shortId };
    },

    async setDraftTelegramMessage(draftId, messageId) {
      const { error } = await client
        .from("drafts")
        .update({ telegram_message_id: messageId })
        .eq("id", draftId);
      if (error) throw dbError("setDraftTelegramMessage", error);
    },

    async reviewDraft(input): Promise<ReviewResult> {
      const rows = await rpc<unknown[]>(client, "review_draft", {
        p_short_id: input.shortId,
        p_chat_id: input.chatId,
        p_decision: input.decision,
        p_source: input.source,
        p_actor_id: input.actor.id,
        p_actor_name: input.actor.name,
        p_update_id: input.updateId,
      });
      const parsed = reviewRow.safeParse(rows?.[0]);
      if (!parsed.success)
        throw new AppError("validation", "review_draft returned an unexpected shape");
      return {
        outcome: parsed.data.outcome,
        draftId: parsed.data.draft_id,
        status: parsed.data.status,
        telegramMessageId: parsed.data.telegram_message_id,
      };
    },

    async getNewsCache(key, now) {
      const { data, error } = await client
        .from("news_cache")
        .select("results")
        .eq("cache_key", key)
        .gt("expires_at", now.toISOString())
        .maybeSingle();
      if (error) throw dbError("getNewsCache", error);
      if (!data) return null;
      const items = z.array(newsItemJson).safeParse(data.results);
      if (!items.success) return null;
      return items.data.map((item): NewsItem => ({
        ...item,
        publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
      }));
    },

    async putNewsCache(key, query, items, expiresAt) {
      const { error } = await client.from("news_cache").upsert({
        cache_key: key,
        query,
        results: items.map((item) => ({
          ...item,
          publishedAt: item.publishedAt?.toISOString() ?? null,
        })),
        fetched_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString(),
      });
      if (error) throw dbError("putNewsCache", error);
    },

    async ping() {
      const { error } = await client
        .from("voice_skills")
        .select("id", { head: true, count: "exact" })
        .limit(1);
      if (error) throw dbError("ping", error);
    },
  };
}
