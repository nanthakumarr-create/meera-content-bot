import { z } from "zod";
import { AppError } from "./errors";

const chatId = z
  .string()
  .trim()
  .regex(/^-?\d{1,20}$/, "must be a numeric Telegram chat ID (channels start with -100)")
  .transform((value) => Number(value))
  .refine((value) => Number.isSafeInteger(value), "is outside the safe integer range");

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine(
    (value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return (
        url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1"
      );
    },
    { message: "must use https (http is only allowed for localhost)" },
  )
  .transform((value) => value.replace(/\/+$/, ""));

export const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: z
    .string()
    .trim()
    .regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, "must look like a BotFather token (<digits>:<secret>)"),
  // Telegram restricts secret_token to 1-256 chars of A-Z, a-z, 0-9, _ and -.
  // We require at least 32 so it cannot be guessed.
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{32,256}$/, "must be 32-256 characters of A-Z, a-z, 0-9, _ or -"),
  TELEGRAM_ALLOWED_CHAT_ID: chatId,
  GEMINI_API_KEY: z.string().trim().min(20, "looks too short to be a Gemini API key"),
  GEMINI_MODEL: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]{2,80}$/, "must be a Gemini model ID such as gemini-2.5-flash"),
  SUPABASE_URL: httpsUrl,
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(20, "looks too short to be a Supabase key"),
  APP_BASE_URL: httpsUrl,
});

export type AppConfig = z.infer<typeof configSchema>;

/** Parse and validate configuration. Error messages name variables but never echo values. */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      const value = env[key];
      const reason = value === undefined || value.trim() === "" ? "is missing" : issue.message;
      return `${key} ${reason}`;
    });
    throw new AppError("configuration", `Invalid configuration: ${problems.join("; ")}`);
  }
  return result.data;
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  cached ??= parseConfig(process.env);
  return cached;
}

/** Test hook. */
export function resetConfigCache(): void {
  cached = undefined;
}

/** Pipeline tuning. Not secrets, so they live in code rather than the environment. */
export const pipelineSettings = {
  scoreThreshold: 6,
  geminiAttempts: 3,
  geminiTimeoutMs: 25_000,
  geminiBaseDelayMs: 600,
  geminiMaxDelayMs: 5_000,
  /** Leave headroom under the function's maxDuration so failures are still reported. */
  pipelineBudgetMs: 100_000,
  rssTimeoutMs: 4_000,
  newsCacheTtlSeconds: 6 * 60 * 60,
  newsMaxAgeDays: 21,
  newsMaxCandidates: 5,
  rateLimitPerChat: 12,
  rateLimitWindowSeconds: 10 * 60,
  maxConcurrentPipelines: 3,
  staleProcessingSeconds: 5 * 60,
  maxNoteLength: 6_000,
  noveltyHistorySize: 10,
} as const;
