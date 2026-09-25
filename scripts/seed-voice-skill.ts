import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { voiceSkillFromContent, VOICE_SKILL_FILE } from "../src/voice/voiceSkill";
import { loadLocalEnv, requireEnv } from "./env";

// Inserts voice-skill.txt into voice_skills once (keyed by content hash) and marks it
// active. Safe to re-run: an unchanged file is a no-op. The app also does this
// automatically on the first draft, so this script is for setup and verification.
async function main() {
  loadLocalEnv();
  const client = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const skill = voiceSkillFromContent(readFileSync(VOICE_SKILL_FILE, "utf8"));
  const { data, error } = await client.rpc("ensure_voice_skill", {
    p_version: skill.version,
    p_sha256: skill.sha256,
    p_content: skill.content,
  });
  if (error) {
    console.error(`Seeding voice skill failed: ${error.message}`);
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      { ok: true, voice_skill_id: data, version: skill.version, active: true },
      null,
      2,
    ),
  );
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
