import "server-only";
import { createGeminiModel, sdkGenerate } from "@/ai/gemini";
import { createSupabaseRepository } from "@/db/supabase";
import { getConfig } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import { createGoogleNewsService } from "@/news/rss";
import { createTelegramClient } from "@/telegram/client";
import { loadVoiceSkill } from "@/voice/voiceSkill";
import type { PipelineDeps } from "./deps";

let deps: PipelineDeps | undefined;

/** Build production dependencies once per server instance. Throws on invalid config. */
export function getPipelineDeps(): PipelineDeps {
  if (deps) return deps;
  const config = getConfig();
  const logger = createLogger({ service: "meera-content-bot" });
  const repo = createSupabaseRepository(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
  deps = {
    repo,
    telegram: createTelegramClient({ token: config.TELEGRAM_BOT_TOKEN, logger }),
    model: createGeminiModel({
      model: config.GEMINI_MODEL,
      generate: sdkGenerate(config.GEMINI_API_KEY),
      logger,
    }),
    news: createGoogleNewsService({ cache: repo, logger }),
    loadVoiceSkill: () => loadVoiceSkill(),
    logger,
    allowedChatId: config.TELEGRAM_ALLOWED_CHAT_ID,
    webhookSecret: config.TELEGRAM_WEBHOOK_SECRET,
  };
  return deps;
}
