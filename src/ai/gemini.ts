import { ApiError, GoogleGenAI } from "@google/genai";
import type { z } from "zod";
import { pipelineSettings } from "@/lib/config";
import { AppError, isAbortOrTimeout, isNetworkError, isTransientStatus } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { silentLogger } from "@/lib/logger";
import { withRetry } from "@/lib/retry";
import { toGeminiJsonSchema } from "./schemas";

export interface JsonRequest<T> {
  /** Short label for logs, e.g. "score" or "draft". */
  task: string;
  systemInstruction: string;
  prompt: string;
  schema: z.ZodType<T>;
  temperature: number;
  /** Absolute epoch-ms deadline for this call including retries. */
  deadline?: number;
}

export interface JsonModel {
  readonly model: string;
  generateJson<T>(request: JsonRequest<T>): Promise<T>;
}

export interface GenerateParams {
  model: string;
  contents: string;
  config: {
    systemInstruction: string;
    temperature: number;
    responseMimeType: "application/json";
    responseJsonSchema: unknown;
    abortSignal: AbortSignal;
    httpOptions: { timeout: number; retryOptions: { attempts: number } };
  };
}

/** The one SDK call we depend on, injectable so tests never touch the network. */
export type GenerateFn = (params: GenerateParams) => Promise<{ text: string | undefined }>;

export function sdkGenerate(apiKey: string): GenerateFn {
  const ai = new GoogleGenAI({ apiKey });
  return async (params) => {
    const response = await ai.models.generateContent(params);
    return { text: response.text };
  };
}

export function classifyGeminiError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ApiError || typeof (error as { status?: unknown })?.status === "number") {
    const status = (error as { status: number }).status;
    if (status === 401 || status === 403) {
      return new AppError("authorization", `Gemini rejected the API key (${status})`, { status });
    }
    return new AppError("gemini", `Gemini API error ${status}`, {
      retryable: isTransientStatus(status),
      status,
      cause: error,
    });
  }
  if (isAbortOrTimeout(error))
    return new AppError("gemini", "Gemini request timed out", { retryable: true });
  if (isNetworkError(error))
    return new AppError("gemini", "Gemini network error", { retryable: true });
  return new AppError("gemini", `Gemini call failed: ${(error as Error)?.message ?? "unknown"}`);
}

export interface GeminiOptions {
  model: string;
  generate: GenerateFn;
  logger?: Logger;
  timeoutMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function createGeminiModel(options: GeminiOptions): JsonModel {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? pipelineSettings.geminiTimeoutMs;

  return {
    model: options.model,
    async generateJson<T>(request: JsonRequest<T>): Promise<T> {
      const responseJsonSchema = toGeminiJsonSchema(request.schema);

      const raw = await withRetry(
        async (attempt) => {
          const remaining = request.deadline ? request.deadline - now() : timeoutMs;
          if (remaining < 2_000) {
            throw new AppError(
              "gemini",
              `Gemini ${request.task} skipped: pipeline time budget exhausted`,
            );
          }
          const perCallTimeout = Math.min(timeoutMs, remaining);
          const started = now();
          try {
            const result = await options.generate({
              model: options.model,
              contents: request.prompt,
              config: {
                systemInstruction: request.systemInstruction,
                temperature: request.temperature,
                responseMimeType: "application/json",
                responseJsonSchema,
                abortSignal: AbortSignal.timeout(perCallTimeout),
                // We own retries; disable the SDK's so attempts are bounded at three.
                httpOptions: { timeout: perCallTimeout, retryOptions: { attempts: 1 } },
              },
            });
            logger.info("gemini.call", { task: request.task, attempt, ms: now() - started });
            if (!result.text) {
              throw new AppError(
                "gemini",
                `Gemini ${request.task} returned an empty response (possibly blocked)`,
              );
            }
            return result.text;
          } catch (error) {
            throw classifyGeminiError(error);
          }
        },
        {
          attempts: options.attempts ?? pipelineSettings.geminiAttempts,
          baseDelayMs: pipelineSettings.geminiBaseDelayMs,
          maxDelayMs: pipelineSettings.geminiMaxDelayMs,
          deadline: request.deadline,
          sleep: options.sleep,
          now,
          onRetry: ({ attempt, delayMs, error }) =>
            logger.warn("gemini.retry", {
              task: request.task,
              attempt,
              delayMs,
              error: (error as Error).message,
            }),
        },
      );

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new AppError("validation", `Gemini ${request.task} returned invalid JSON`);
      }
      const parsed = request.schema.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
          .join("; ");
        throw new AppError(
          "validation",
          `Gemini ${request.task} output failed validation: ${issues}`,
        );
      }
      return parsed.data;
    },
  };
}
