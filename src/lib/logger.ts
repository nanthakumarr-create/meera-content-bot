type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

// Telegram bot tokens look like `123456789:AA...`. Redact them wherever they appear,
// including inside URLs such as https://api.telegram.org/bot<token>/sendMessage.
const TELEGRAM_TOKEN_PATTERN = /\d{5,}:[A-Za-z0-9_-]{30,}/g;
// Google API keys (classic "AIza..." and newer "AQ.xxxx" formats) and JWT-shaped
// strings (Supabase service keys).
const GOOGLE_KEY_PATTERN = /AIza[0-9A-Za-z_-]{30,}|AQ\.[0-9A-Za-z_-]{30,}/g;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const SUPABASE_SECRET_PATTERN = /sb_secret_[A-Za-z0-9_-]{10,}/g;
const SENSITIVE_KEY = /token|secret|password|api[_-]?key|authorization|service[_-]?role|cookie/i;

export function redactString(value: string): string {
  return value
    .replace(TELEGRAM_TOKEN_PATTERN, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(GOOGLE_KEY_PATTERN, "[REDACTED_API_KEY]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(SUPABASE_SECRET_PATTERN, "[REDACTED_SUPABASE_KEY]");
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

type Sink = (line: string, level: Level) => void;

const defaultSink: Sink = (line, level) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export function createLogger(base: Fields = {}, sink: Sink = defaultSink): Logger {
  const write = (level: Level, message: string, fields?: Fields) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: redactString(message),
      ...(redact(base) as Fields),
      ...(fields ? (redact(fields) as Fields) : {}),
    };
    sink(JSON.stringify(entry), level);
  };
  return {
    debug: (m, f) => {
      if (process.env.LOG_LEVEL === "debug") write("debug", m, f);
    },
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger({ ...base, ...fields }, sink),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
