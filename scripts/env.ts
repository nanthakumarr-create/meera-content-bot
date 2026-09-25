import { existsSync } from "node:fs";

/** Load .env.local then .env (if present) without overriding variables already set. */
export function loadLocalEnv(): void {
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required environment variable ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

export function maskToken(token: string): string {
  const [id] = token.split(":");
  return `${id ?? "?"}:****`;
}
