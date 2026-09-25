import { createLogger } from "@/lib/logger";
import { getPipelineDeps } from "@/pipeline/container";
import { checkHealth } from "@/pipeline/health";
import { loadVoiceSkill } from "@/voice/voiceSkill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const logger = createLogger({ service: "meera-content-bot", route: "health" });
  const report = await checkHealth({
    getRepo: () => getPipelineDeps().repo,
    loadVoiceSkill: () => loadVoiceSkill(),
    onError: (check, error) => logger.error("health.check_failed", { check, error }),
  });
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
