import { describe, expect, it } from "vitest";
import { parseConfig } from "@/lib/config";

const valid = {
  TELEGRAM_BOT_TOKEN: "123456789:AAEexampleexampleexampleexample1234",
  TELEGRAM_WEBHOOK_SECRET: "s".repeat(40),
  TELEGRAM_ALLOWED_CHAT_ID: "-1001234567890",
  GEMINI_API_KEY: "AIzaexampleexampleexampleexample123",
  GEMINI_MODEL: "gemini-2.5-flash",
  SUPABASE_URL: "https://abcdefgh.supabase.co/",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-example-value-1234567890",
  APP_BASE_URL: "https://meera-bot.vercel.app/",
};

describe("environment validation", () => {
  it("parses a valid environment and normalizes values", () => {
    const config = parseConfig(valid);
    expect(config.TELEGRAM_ALLOWED_CHAT_ID).toBe(-1001234567890);
    expect(config.SUPABASE_URL).toBe("https://abcdefgh.supabase.co");
    expect(config.APP_BASE_URL).toBe("https://meera-bot.vercel.app");
  });

  it("fails fast listing every missing variable", () => {
    expect(() => parseConfig({})).toThrow(/TELEGRAM_BOT_TOKEN is missing.*APP_BASE_URL is missing/);
  });

  it.each([
    ["TELEGRAM_BOT_TOKEN", "not-a-token"],
    ["TELEGRAM_WEBHOOK_SECRET", "short"],
    ["TELEGRAM_WEBHOOK_SECRET", `${"a".repeat(40)}!`],
    ["TELEGRAM_ALLOWED_CHAT_ID", "my-channel"],
    ["GEMINI_MODEL", "Gemini Flash!"],
    ["SUPABASE_URL", "not a url"],
    ["APP_BASE_URL", "http://meera-bot.vercel.app"],
  ])("rejects malformed %s", (key, value) => {
    expect(() => parseConfig({ ...valid, [key]: value })).toThrow(new RegExp(key));
  });

  it("never echoes secret values in the error", () => {
    const secret = "123456789:THIS_IS_SECRET";
    try {
      parseConfig({ ...valid, TELEGRAM_BOT_TOKEN: secret, GEMINI_API_KEY: "tiny" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain("tiny");
      expect((error as { category?: string }).category).toBe("configuration");
    }
  });

  it("allows http only for localhost", () => {
    expect(parseConfig({ ...valid, APP_BASE_URL: "http://localhost:3000" }).APP_BASE_URL).toBe(
      "http://localhost:3000",
    );
  });
});
