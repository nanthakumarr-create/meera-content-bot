import { after } from "next/server";
import { describeError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { getPipelineDeps } from "@/pipeline/container";
import { handleWebhook } from "@/pipeline/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Three Gemini calls plus retries fit well inside this; the pipeline enforces its own budget.
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  let deps;
  try {
    deps = getPipelineDeps();
  } catch (error) {
    createLogger({ service: "meera-content-bot" }).error("webhook.config_error", {
      error: describeError(error),
    });
    return Response.json({ ok: false }, { status: 500 });
  }
  return handleWebhook(request, deps, (task) => after(task));
}
