import type { JsonModel } from "@/ai/gemini";
import type { Repository } from "@/db/types";
import type { Logger } from "@/lib/logger";
import type { NewsService } from "@/news/types";
import type { TelegramClient } from "@/telegram/client";
import type { VoiceSkill } from "@/voice/voiceSkill";

export interface PipelineDeps {
  repo: Repository;
  telegram: TelegramClient;
  model: JsonModel;
  news: NewsService;
  loadVoiceSkill: () => Promise<VoiceSkill>;
  logger: Logger;
  allowedChatId: number;
  webhookSecret: string;
  now?: () => number;
}

/** Run background work after the HTTP response. In production this is Next's `after()`. */
export type Scheduler = (task: () => Promise<void>) => void;
