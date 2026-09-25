const EMOJI = /\p{Extended_Pictographic}️?|️/gu;
const HASHTAG = /(^|[\s(])#[\p{L}\p{N}_]+/gu;

/**
 * Deterministic safety net for rules the model occasionally breaks: strip emojis,
 * strip hashtags unless the note itself used them, and drop Markdown emphasis
 * (Telegram and LinkedIn both show it literally).
 */
export function cleanDraftText(draft: string, note: string): { text: string; changed: string[] } {
  const changed: string[] = [];
  let text = draft.replace(/\r\n/g, "\n");

  if (EMOJI.test(text)) {
    text = text.replace(EMOJI, "");
    changed.push("emojis_removed");
  }
  EMOJI.lastIndex = 0;

  const noteHasHashtags = /(^|\s)#[\p{L}\p{N}_]+/u.test(note);
  if (!noteHasHashtags && HASHTAG.test(text)) {
    text = text.replace(HASHTAG, "$1");
    changed.push("hashtags_removed");
  }
  HASHTAG.lastIndex = 0;

  if (/\*\*|__/.test(text)) {
    text = text.replace(/\*\*|__/g, "");
    changed.push("markdown_removed");
  }

  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, changed };
}
