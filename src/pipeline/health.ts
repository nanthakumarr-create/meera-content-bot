import type { Repository } from "@/db/types";
import { describeError } from "@/lib/errors";
import type { VoiceSkill } from "@/voice/voiceSkill";

export interface HealthReport {
  status: "ok" | "degraded" | "error";
  checks: {
    config: "ok" | "error";
    database: "ok" | "error" | "skipped";
    voiceSkill: "ok" | "error" | "skipped";
  };
  voiceSkillVersion: string | null;
  time: string;
}

/** Health check that reports only pass/fail per dependency, never values or error details. */
export async function checkHealth(input: {
  getRepo: () => Repository;
  loadVoiceSkill: () => Promise<VoiceSkill>;
  onError?: (check: string, error: ReturnType<typeof describeError>) => void;
}): Promise<HealthReport> {
  const report: HealthReport = {
    status: "ok",
    checks: { config: "ok", database: "skipped", voiceSkill: "skipped" },
    voiceSkillVersion: null,
    time: new Date().toISOString(),
  };

  let repo: Repository;
  try {
    repo = input.getRepo();
  } catch (error) {
    input.onError?.("config", describeError(error));
    report.checks.config = "error";
    report.status = "error";
    return report;
  }

  const [db, voice] = await Promise.allSettled([
    Promise.race([
      repo.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("database ping timed out")), 5_000),
      ),
    ]),
    input.loadVoiceSkill(),
  ]);
  report.checks.database = db.status === "fulfilled" ? "ok" : "error";
  if (db.status === "rejected") input.onError?.("database", describeError(db.reason));
  if (voice.status === "fulfilled") {
    report.checks.voiceSkill = "ok";
    report.voiceSkillVersion = voice.value.version;
  } else {
    report.checks.voiceSkill = "error";
    input.onError?.("voiceSkill", describeError(voice.reason));
  }
  if (report.checks.database === "error" || report.checks.voiceSkill === "error")
    report.status = "degraded";
  return report;
}
