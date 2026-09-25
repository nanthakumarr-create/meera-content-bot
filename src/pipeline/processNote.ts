import {
  buildDraftPrompt,
  buildDraftSystem,
  buildNewsRelevancePrompt,
  buildScoringPrompt,
  NEWS_RELEVANCE_SYSTEM,
  SCORING_SYSTEM,
} from "@/ai/prompts";
import { draftSchema, newsRelevanceSchema, scoreSchema } from "@/ai/schemas";
import type { Repository, VoiceSkillRecord } from "@/db/types";
import { pipelineSettings } from "@/lib/config";
import { AppError, describeError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { generateShortId } from "@/lib/security";
import type { NewsItem } from "@/news/types";
import {
  formatDraftMessages,
  formatScoreRejection,
  MESSAGES,
  reviewButtons,
} from "@/telegram/format";
import type { VoiceSkill } from "@/voice/voiceSkill";
import type { PipelineDeps } from "./deps";
import { cleanDraftText } from "./draftText";

export interface NoteJob {
  noteId: string;
  updateId: number;
  chatId: number;
  messageId: number;
  text: string;
}

export type NoteOutcome =
  | { status: "throttled" }
  | { status: "rejected"; score: number }
  | { status: "drafted"; score: number; shortId: string; newsUsed: boolean }
  | { status: "failed"; category: string };

const voiceSkillIds = new Map<string, VoiceSkillRecord>();

async function resolveVoiceSkill(repo: Repository, skill: VoiceSkill): Promise<VoiceSkillRecord> {
  const hit = voiceSkillIds.get(skill.sha256);
  if (hit) return hit;
  const record = await repo.ensureVoiceSkill(skill.version, skill.sha256, skill.content);
  voiceSkillIds.set(skill.sha256, record);
  return record;
}

/** Test hook: the voice-skill id cache is per process. */
export function resetVoiceSkillCache(): void {
  voiceSkillIds.clear();
}

async function pickNews(
  deps: PipelineDeps,
  log: Logger,
  note: string,
  keywords: string[],
  deadline: number,
): Promise<NewsItem | null> {
  let candidates: NewsItem[] = [];
  try {
    candidates = await deps.news.findCandidates(keywords);
  } catch (error) {
    log.warn("news.unavailable", { error: describeError(error) });
    return null;
  }
  if (candidates.length === 0) return null;

  try {
    const verdict = await deps.model.generateJson({
      task: "news_relevance",
      systemInstruction: NEWS_RELEVANCE_SYSTEM,
      prompt: buildNewsRelevancePrompt(note, candidates),
      schema: newsRelevanceSchema,
      temperature: 0,
      deadline,
    });
    log.info("news.relevance", {
      relevant: verdict.relevant,
      index: verdict.index,
      candidates: candidates.length,
    });
    if (!verdict.relevant || verdict.index === null) return null;
    return candidates[verdict.index] ?? null;
  } catch (error) {
    // News is optional. A failed relevance check means "draft without news", not "fail".
    log.warn("news.relevance_failed", { error: describeError(error) });
    return null;
  }
}

async function insertDraftWithUniqueId(
  repo: Repository,
  input: Omit<Parameters<Repository["createDraft"]>[0], "shortId">,
): Promise<{ draftId: string; shortId: string }> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await repo.createDraft({ ...input, shortId: generateShortId() });
    } catch (error) {
      const collision = error instanceof Error && /short_id/.test(error.message);
      if (!collision || attempt >= 3) throw error;
    }
  }
}

export async function processNote(job: NoteJob, deps: PipelineDeps): Promise<NoteOutcome> {
  const now = deps.now ?? Date.now;
  const deadline = now() + pipelineSettings.pipelineBudgetMs;
  const log = deps.logger.child({ updateId: job.updateId, noteId: job.noteId });
  const { repo, telegram, model } = deps;

  try {
    const started = await repo.tryBeginProcessing(
      job.noteId,
      pipelineSettings.maxConcurrentPipelines,
      pipelineSettings.staleProcessingSeconds,
    );
    if (!started) {
      log.warn("pipeline.throttled");
      await repo.updateNote(job.noteId, { status: "throttled" });
      await repo.setUpdateStatus(job.updateId, "completed");
      await telegram.sendMessage(job.chatId, MESSAGES.busy, { replyToMessageId: job.messageId });
      return { status: "throttled" };
    }

    // 1. Score.
    const prior = await repo.recentReviewedDrafts(job.chatId, pipelineSettings.noveltyHistorySize);
    const score = await model.generateJson({
      task: "score",
      systemInstruction: SCORING_SYSTEM,
      prompt: buildScoringPrompt(job.text, prior),
      schema: scoreSchema,
      temperature: 0,
      deadline,
    });
    log.info("pipeline.scored", { score: score.score, keywords: score.keywords });
    await repo.updateNote(job.noteId, {
      score: score.score,
      scoreReason: score.reason,
      keywords: score.keywords,
    });

    if (score.score < pipelineSettings.scoreThreshold) {
      await repo.updateNote(job.noteId, { status: "rejected" });
      await telegram.sendMessage(job.chatId, formatScoreRejection(score.score, score.reason), {
        replyToMessageId: job.messageId,
      });
      await repo.setUpdateStatus(job.updateId, "completed");
      return { status: "rejected", score: score.score };
    }

    // 2. Optional news angle.
    await repo.updateNote(job.noteId, { status: "finding_news" });
    const news = await pickNews(deps, log, job.text, score.keywords, deadline);

    // 3. Draft in Meera's voice.
    await repo.updateNote(job.noteId, { status: "drafting" });
    const voice = await deps.loadVoiceSkill();
    const voiceRecord = await resolveVoiceSkill(repo, voice);
    const draft = await model.generateJson({
      task: "draft",
      systemInstruction: buildDraftSystem(voice.content),
      prompt: buildDraftPrompt(job.text, news),
      schema: draftSchema,
      temperature: 0.4,
      deadline,
    });

    // The model may only cite the exact item we gave it.
    if (draft.news_used && (!news || !draft.source || draft.source.url !== news.url)) {
      throw new AppError("validation", "Draft cited a news source that was not provided");
    }
    const usedNews = draft.news_used ? news : null;
    const cleaned = cleanDraftText(draft.draft_text, job.text);
    if (cleaned.changed.length) log.warn("draft.cleaned", { changes: cleaned.changed });

    const { draftId, shortId } = await insertDraftWithUniqueId(repo, {
      noteId: job.noteId,
      voiceSkillId: voiceRecord.id,
      model: model.model,
      draftText: cleaned.text,
      news: usedNews,
    });
    log.info("pipeline.drafted", {
      draftId,
      shortId,
      newsUsed: usedNews !== null,
      voice: voiceRecord.version,
    });

    // 4. Human review gate: send to Telegram with Approve / Reject.
    const chunks = formatDraftMessages({
      shortId,
      score: score.score,
      scoreReason: score.reason,
      draftText: cleaned.text,
      news: usedNews,
    });
    let lastMessageId = 0;
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      const sent = await telegram.sendMessage(job.chatId, chunk, {
        replyToMessageId: index === 0 ? job.messageId : undefined,
        buttons: isLast ? reviewButtons(shortId) : undefined,
      });
      lastMessageId = sent.messageId;
    }
    await repo.setDraftTelegramMessage(draftId, lastMessageId);
    await repo.setUpdateStatus(job.updateId, "completed");
    return { status: "drafted", score: score.score, shortId, newsUsed: usedNews !== null };
  } catch (error) {
    const described = describeError(error);
    log.error("pipeline.failed", { error: described });
    await safely(log, "note.mark_failed", () =>
      repo.updateNote(job.noteId, {
        status: "failed",
        failureReason: `${described.category}: ${described.message}`,
      }),
    );
    await safely(log, "update.dead_letter", () =>
      repo.setUpdateStatus(job.updateId, "dead_letter", described),
    );
    await safely(log, "telegram.failure_notice", () =>
      telegram.sendMessage(job.chatId, MESSAGES.failure, { replyToMessageId: job.messageId }),
    );
    return { status: "failed", category: described.category };
  }
}

export async function safely(
  log: Logger,
  label: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    log.error(`${label}_failed`, { error: describeError(error) });
  }
}
