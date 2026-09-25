import { readFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { sha256Hex } from "@/lib/security";

export interface VoiceSkill {
  /** Content-addressed version, e.g. "sha256:3f2a9c1b7d4e". Changes whenever the file changes. */
  version: string;
  sha256: string;
  content: string;
}

export const VOICE_SKILL_FILE = "voice-skill.txt";

export function voiceSkillFromContent(content: string): VoiceSkill {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (normalized.length < 200) {
    throw new AppError("configuration", `${VOICE_SKILL_FILE} is missing or too short`);
  }
  const sha256 = sha256Hex(normalized);
  return { version: `sha256:${sha256.slice(0, 12)}`, sha256, content: normalized };
}

let cached: Promise<VoiceSkill> | undefined;

export function loadVoiceSkill(root: string = process.cwd()): Promise<VoiceSkill> {
  cached ??= readFile(path.join(root, VOICE_SKILL_FILE), "utf8")
    .then(voiceSkillFromContent)
    .catch((error) => {
      cached = undefined;
      if (error instanceof AppError) throw error;
      throw new AppError("configuration", `Could not read ${VOICE_SKILL_FILE}`, { cause: error });
    });
  return cached;
}
