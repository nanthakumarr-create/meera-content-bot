export type ErrorCategory =
  "telegram" | "gemini" | "supabase" | "rss" | "validation" | "configuration" | "authorization";

/**
 * Every failure the pipeline can hit is classified so logs, retries, and the
 * dead-letter record all agree on what went wrong.
 *
 * `retryable` is only ever true for transient external failures (timeouts,
 * 429s, 5xx, network resets). Validation, configuration, and authorization
 * failures are never retried.
 */
export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(
    category: ErrorCategory,
    message: string,
    options: { retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.category = category;
    this.retryable =
      category === "validation" || category === "configuration" || category === "authorization"
        ? false
        : (options.retryable ?? false);
    this.status = options.status;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** HTTP statuses that indicate a transient upstream problem worth retrying. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function isAbortOrTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    /timed? ?out|aborted/i.test(error.message)
  );
}

export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    (error.name === "TypeError" && /fetch failed|network/i.test(error.message)) ||
    (typeof code === "string" &&
      ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code))
  );
}

/** Short, non-sensitive description suitable for storing as a failure reason. */
export function describeError(error: unknown): {
  category: ErrorCategory | "unknown";
  message: string;
} {
  if (isAppError(error)) {
    return { category: error.category, message: error.message.slice(0, 500) };
  }
  if (error instanceof Error) {
    return { category: "unknown", message: error.message.slice(0, 500) };
  }
  return { category: "unknown", message: "Unknown error" };
}
