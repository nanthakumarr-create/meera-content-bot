import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { createLogger, redact } from "@/lib/logger";
import { backoffDelay, withRetry } from "@/lib/retry";
import { generateShortId, SHORT_ID_PATTERN } from "@/lib/security";
import { cleanDraftText } from "@/pipeline/draftText";
import { voiceSkillFromContent } from "@/voice/voiceSkill";

describe("retry", () => {
  it("backoff grows exponentially and is capped", () => {
    expect(backoffDelay(0, 100, 1000, () => 1)).toBe(100);
    expect(backoffDelay(3, 100, 1000, () => 1)).toBe(800);
    expect(backoffDelay(10, 100, 1000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 100, 1000, () => 0)).toBe(0);
  });

  it("never retries validation, configuration, or authorization errors", async () => {
    for (const category of ["validation", "configuration", "authorization"] as const) {
      let calls = 0;
      await expect(
        withRetry(
          async () => {
            calls += 1;
            throw new AppError(category, "x", { retryable: true });
          },
          { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} },
        ),
      ).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });

  it("does not start a retry past the deadline", async () => {
    let calls = 0;
    const now = 1_000;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new AppError("gemini", "x", { retryable: true });
        },
        {
          attempts: 3,
          baseDelayMs: 500,
          maxDelayMs: 500,
          deadline: now + 100,
          now: () => now,
          random: () => 1,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("logger redaction", () => {
  it("redacts tokens, keys, and sensitive fields", () => {
    const lines: string[] = [];
    const log = createLogger({ service: "t" }, (line) => lines.push(line));
    log.info(
      "calling https://api.telegram.org/bot123456789:AAEexampleexampleexampleexample1234/sendMessage",
      {
        apiKey: "AIzaexampleexampleexampleexample123",
        nested: {
          note: "key AIzaSyDexampleexampleexampleexample12 leaked",
          other: "AQ.Abexampleexampleexampleexampleexample",
        },
        TELEGRAM_BOT_TOKEN: "anything",
      },
    );
    const out = lines.join("\n");
    expect(out).not.toContain("AAEexample");
    expect(out).not.toContain("AIza");
    expect(out).not.toContain("AQ.Ab");
    expect(out).toContain("[REDACTED_TELEGRAM_TOKEN]");
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "info",
      service: "t",
      apiKey: "[REDACTED]",
    });
  });

  it("redacts JWT-shaped service keys", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnop";
    expect(redact({ message: `key=${jwt}` })).toEqual({ message: "key=[REDACTED_JWT]" });
  });
});

describe("short ids", () => {
  it("are six unambiguous characters", () => {
    for (let i = 0; i < 200; i += 1) expect(generateShortId()).toMatch(SHORT_ID_PATTERN);
  });
});

describe("draft cleaning", () => {
  it("keeps hashtags when the note asked for them", () => {
    expect(cleanDraftText("Post body #CoA", "please add #CoA").text).toBe("Post body #CoA");
  });
  it("removes markdown emphasis", () => {
    expect(cleanDraftText("This is **important**.", "note").text).toBe("This is important.");
  });
});

describe("voice skill versioning", () => {
  it("derives a stable content-addressed version", () => {
    const content = "x".repeat(250);
    const a = voiceSkillFromContent(content);
    const b = voiceSkillFromContent(`${content}\r\n`);
    expect(a.version).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(a).toEqual(b);
    expect(voiceSkillFromContent("y".repeat(250)).version).not.toBe(a.version);
  });
  it("rejects an empty voice skill", () => {
    expect(() => voiceSkillFromContent("short")).toThrow(/voice-skill.txt/);
  });
});
