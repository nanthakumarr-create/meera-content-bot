import { z } from "zod";

export const scoreSchema = z
  .object({
    score: z.number().int().min(0).max(10),
    reason: z.string().trim().min(1).max(400),
    keywords: z.array(z.string().trim().min(1).max(60)).min(3).max(5),
  })
  .strict();
export type ScoreResult = z.infer<typeof scoreSchema>;

export const newsRelevanceSchema = z
  .object({
    relevant: z.boolean(),
    /** 0-based index into the candidate list, or null when nothing is relevant. */
    index: z.number().int().min(0).nullable(),
    reason: z.string().trim().min(1).max(400),
  })
  .strict();
export type NewsRelevanceResult = z.infer<typeof newsRelevanceSchema>;

export const draftSchema = z
  .object({
    draft_text: z.string().trim().min(200).max(3000),
    news_used: z.boolean(),
    source: z
      .object({
        headline: z.string().min(1),
        publication: z.string().nullable(),
        published_date: z.string().nullable(),
        url: z.string().url(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type DraftResult = z.infer<typeof draftSchema>;

// Gemini's responseJsonSchema accepts a subset of JSON Schema. Strip anything else
// (Zod emits $schema, minLength, pattern, etc.). Zod still enforces the full rules
// on the way back in.
const SUPPORTED_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "enum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
  "properties",
  "additionalProperties",
  "required",
  "propertyOrdering",
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!SUPPORTED_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, sanitize(schema)]),
      );
    } else if (key === "format" && value === "uri") {
      continue;
    } else {
      out[key] = sanitize(value);
    }
  }
  return out;
}

export function toGeminiJsonSchema(schema: z.ZodType): unknown {
  return sanitize(z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" }));
}
