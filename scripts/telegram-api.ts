import { z } from "zod";

const response = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
});

export async function telegramCall(
  token: string,
  method: string,
  payload: Record<string, unknown> = {},
) {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Do not print the error: it can include the request URL, which contains the token.
    throw new Error(`Telegram ${method} request failed (network or timeout)`);
  }
  const parsed = response.safeParse(await res.json().catch(() => null));
  if (!parsed.success)
    throw new Error(`Telegram ${method} returned an unreadable response (HTTP ${res.status})`);
  if (!parsed.data.ok)
    throw new Error(`Telegram ${method} failed: ${parsed.data.description ?? "unknown error"}`);
  return parsed.data.result;
}

export const webhookInfoSchema = z.object({
  url: z.string(),
  has_custom_certificate: z.boolean().optional(),
  pending_update_count: z.number(),
  last_error_date: z.number().optional(),
  last_error_message: z.string().optional(),
  max_connections: z.number().optional(),
  allowed_updates: z.array(z.string()).optional(),
});
