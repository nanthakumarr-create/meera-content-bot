import { isAppError } from "./errors";

export interface RetryOptions {
  /** Total attempts including the first. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Absolute epoch-ms deadline; no retry is started that would overrun it. */
  deadline?: number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Full-jitter exponential backoff: delay is uniform in [0, min(max, base * 2^n)]. */
export function backoffDelay(
  retryNumber: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** retryNumber);
  return Math.round(cap * random());
}

const defaultIsRetryable = (error: unknown) => isAppError(error) && error.retryable;

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;

  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= options.attempts || !isRetryable(error)) throw error;
      const delayMs = backoffDelay(attempt - 1, options.baseDelayMs, options.maxDelayMs, random);
      if (options.deadline !== undefined && now() + delayMs >= options.deadline) throw error;
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
