import { describe, expect, it, vi } from "vitest";
import { classifyGeminiError, createGeminiModel, type GenerateFn } from "@/ai/gemini";
import { draftSchema, scoreSchema, toGeminiJsonSchema } from "@/ai/schemas";
import { AppError } from "@/lib/errors";

const request = {
  task: "score",
  systemInstruction: "sys",
  prompt: "prompt",
  schema: scoreSchema,
  temperature: 0,
};

function model(generate: GenerateFn) {
  return createGeminiModel({ model: "gemini-test", generate, sleep: async () => {} });
}

const valid = JSON.stringify({
  score: 7,
  reason: "Clear point with evidence.",
  keywords: ["ph", "preservative", "coa"],
});

describe("Gemini score schema", () => {
  it("accepts a valid score", () => {
    expect(scoreSchema.parse(JSON.parse(valid))).toEqual(JSON.parse(valid));
  });

  it.each([
    [{ score: 11, reason: "x", keywords: ["a", "b", "c"] }, "score above 10"],
    [{ score: -1, reason: "x", keywords: ["a", "b", "c"] }, "negative score"],
    [{ score: 6.5, reason: "x", keywords: ["a", "b", "c"] }, "non-integer score"],
    [{ score: "7", reason: "x", keywords: ["a", "b", "c"] }, "string score"],
    [{ score: 7, reason: "", keywords: ["a", "b", "c"] }, "empty reason"],
    [{ score: 7, reason: "x", keywords: ["a", "b"] }, "too few keywords"],
    [{ score: 7, reason: "x", keywords: ["a", "b", "c", "d", "e", "f"] }, "too many keywords"],
    [{ score: 7, reason: "x", keywords: ["a", "b", "c"], extra: true }, "unknown property"],
  ])("rejects %j (%s)", (value: unknown, _label: string) => {
    expect(scoreSchema.safeParse(value).success).toBe(false);
  });

  it("produces a Gemini-compatible JSON schema without unsupported keywords", () => {
    const schema = JSON.stringify(toGeminiJsonSchema(scoreSchema));
    expect(schema).not.toContain("$schema");
    expect(schema).not.toContain("minLength");
    expect(schema).toContain('"required"');
    expect(JSON.stringify(toGeminiJsonSchema(draftSchema))).not.toContain('"format":"uri"');
  });
});

describe("Gemini client retries", () => {
  it("returns validated output on the first success", async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue({ text: valid });
    await expect(model(generate).generateJson(request)).resolves.toMatchObject({ score: 7 });
    expect(generate).toHaveBeenCalledTimes(1);
    const params = generate.mock.calls[0]![0];
    expect(params.config.responseMimeType).toBe("application/json");
    expect(params.config.httpOptions.timeout).toBeGreaterThan(0);
    expect(params.config.httpOptions.retryOptions.attempts).toBe(1);
  });

  it("retries transient failures (503, 429, timeout) and succeeds", async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockRejectedValueOnce(Object.assign(new Error("unavailable"), { status: 503 }))
      .mockRejectedValueOnce(
        Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        }),
      )
      .mockResolvedValue({ text: valid });
    await expect(model(generate).generateJson(request)).resolves.toMatchObject({ score: 7 });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("stops after three attempts", async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));
    await expect(model(generate).generateJson(request)).rejects.toMatchObject({
      category: "gemini",
      status: 429,
    });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("does not retry client errors", async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockRejectedValue(Object.assign(new Error("bad request"), { status: 400 }));
    await expect(model(generate).generateJson(request)).rejects.toMatchObject({
      category: "gemini",
      retryable: false,
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does not retry authorization failures", async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockRejectedValue(Object.assign(new Error("denied"), { status: 403 }));
    await expect(model(generate).generateJson(request)).rejects.toMatchObject({
      category: "authorization",
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does not retry invalid JSON or schema failures", async () => {
    const badJson = vi.fn<GenerateFn>().mockResolvedValue({ text: "{nope" });
    await expect(model(badJson).generateJson(request)).rejects.toMatchObject({
      category: "validation",
    });
    expect(badJson).toHaveBeenCalledTimes(1);

    const badShape = vi.fn<GenerateFn>().mockResolvedValue({ text: JSON.stringify({ score: 99 }) });
    await expect(model(badShape).generateJson(request)).rejects.toMatchObject({
      category: "validation",
    });
    expect(badShape).toHaveBeenCalledTimes(1);
  });

  it("treats an empty (blocked) response as a non-retryable Gemini error", async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue({ text: undefined });
    await expect(model(generate).generateJson(request)).rejects.toMatchObject({
      category: "gemini",
      retryable: false,
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("uses exponential backoff with jitter between attempts", async () => {
    const delays: number[] = [];
    const generate = vi
      .fn<GenerateFn>()
      .mockRejectedValue(Object.assign(new Error("x"), { status: 500 }));
    const m = createGeminiModel({
      model: "gemini-test",
      generate,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await expect(m.generateJson(request)).rejects.toBeInstanceOf(AppError);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeLessThanOrEqual(600);
    expect(delays[1]).toBeLessThanOrEqual(1200);
  });

  it("refuses to start a call when the pipeline budget is exhausted", async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue({ text: valid });
    await expect(
      model(generate).generateJson({ ...request, deadline: Date.now() + 500 }),
    ).rejects.toThrow(/budget/);
    expect(generate).not.toHaveBeenCalled();
  });

  it("classifies unknown errors as non-retryable", () => {
    expect(classifyGeminiError(new Error("weird")).retryable).toBe(false);
    expect(classifyGeminiError(Object.assign(new TypeError("fetch failed"))).retryable).toBe(true);
  });
});
