import { escapeHtml } from "@/lib/escape";
import type { NewsItem } from "@/news/types";
import type { InlineButton } from "./client";
import { callbackData } from "./updates";

export const TELEGRAM_MESSAGE_LIMIT = 4096;
const SAFE_LIMIT = 3900;

export function formatNewsDate(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) return "date unknown";
  return date.toISOString().slice(0, 10);
}

/** The exact review block the brief requires when a news item is used. Plain text, unescaped. */
export function newsReviewBlock(
  item: Pick<NewsItem, "headline" | "publication" | "publishedAt" | "url">,
): string {
  return [
    `NEWS SOURCE: ${item.headline}`,
    `FROM: ${item.publication ?? "unknown publication"} | ${formatNewsDate(item.publishedAt)}`,
    `LINK: ${item.url}`,
    "CHECK BEFORE PUBLISHING: You are the author of this claim.",
  ].join("\n");
}

export interface DraftMessageInput {
  shortId: string;
  score: number;
  scoreReason: string;
  draftText: string;
  news: Pick<NewsItem, "headline" | "publication" | "publishedAt" | "url"> | null;
}

/**
 * Build the review message(s). Returns one or more HTML chunks, each under
 * Telegram's 4096-character limit, split on paragraph boundaries. Buttons go
 * on the final chunk.
 */
export function formatDraftMessages(input: DraftMessageInput): string[] {
  const header =
    `<b>Draft ${escapeHtml(input.shortId)}</b> · pending your review\n` +
    `Score: ${input.score}/10 · ${escapeHtml(input.scoreReason)}`;
  const footer =
    `Nothing has been published. Tap a button or reply ` +
    `<code>APPROVE ${escapeHtml(input.shortId)}</code> / <code>REJECT ${escapeHtml(input.shortId)}</code>.`;

  const sections: string[] = [header];
  for (const paragraph of input.draftText.split(/\n{2,}/)) {
    if (paragraph.trim()) sections.push(escapeHtml(paragraph.trim()));
  }
  if (input.news) sections.push(`<pre>${escapeHtml(newsReviewBlock(input.news))}</pre>`);
  sections.push(footer);

  return packSections(sections);
}

function packSections(sections: string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const section of sections.flatMap(splitOversized)) {
    const candidate = current ? `${current}\n\n${section}` : section;
    if (candidate.length > SAFE_LIMIT && current) {
      chunks.push(current);
      current = section;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Hard-split a section that alone exceeds the limit, avoiding cuts inside an HTML entity. */
function splitOversized(section: string): string[] {
  if (section.length <= SAFE_LIMIT) return [section];
  const parts: string[] = [];
  let rest = section;
  while (rest.length > SAFE_LIMIT) {
    let cut = rest.lastIndexOf(" ", SAFE_LIMIT);
    if (cut < SAFE_LIMIT / 2) cut = SAFE_LIMIT;
    const amp = rest.lastIndexOf("&", cut);
    if (amp !== -1 && rest.indexOf(";", amp) >= cut) cut = amp;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function reviewButtons(shortId: string): InlineButton[][] {
  return [
    [
      { text: "Approve", callback_data: callbackData("approved", shortId) },
      { text: "Reject", callback_data: callbackData("rejected", shortId) },
    ],
  ];
}

export function formatScoreRejection(score: number, reason: string): string {
  return `<b>No draft created</b> · score ${score}/10 (needs 6)\n${escapeHtml(reason)}\n\nThe note is saved. Add a specific observation, number, or mechanism and send it again if you want a draft.`;
}

export const MESSAGES = {
  textOnly:
    "This version accepts text notes only. Please type the note as a message; photos, voice notes, and files are not processed.",
  rateLimited:
    "You have sent a lot of notes in the last few minutes. This one is saved but was not processed. Please resend it in about 10 minutes.",
  busy: "The drafting service is busy right now. Your note is saved but was not processed. Please resend it in a minute.",
  failure:
    "Something went wrong while processing this note, so no draft was created. The note is saved and has been logged for review. You can resend it later.",
  noteTooLong: "This note is longer than 6,000 characters. Please split it into shorter notes.",
} as const;

export function formatReviewOutcome(
  outcome: "updated" | "unchanged" | "conflict" | "not_found",
  shortId: string,
  status: string | null,
): string {
  switch (outcome) {
    case "updated":
      return status === "approved"
        ? `Draft ${shortId} approved. It has not been published; copy it to LinkedIn when you are ready.`
        : `Draft ${shortId} rejected. It is kept on record and will not be sent again.`;
    case "unchanged":
      return `Draft ${shortId} is already ${status}. Nothing changed.`;
    case "conflict":
      return `Draft ${shortId} was already ${status}. Decisions are final, so nothing changed.`;
    case "not_found":
      return `No draft ${shortId} found in this chat.`;
  }
}
