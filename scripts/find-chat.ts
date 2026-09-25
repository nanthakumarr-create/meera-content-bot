import { z } from "zod";
import { loadLocalEnv, requireEnv } from "./env";
import { telegramCall, webhookInfoSchema } from "./telegram-api";

// Setup helper: lists chats that recently sent updates to the bot so you can copy
// TELEGRAM_ALLOWED_CHAT_ID. Works only while no webhook is set (Telegram disallows
// getUpdates alongside a webhook). Post something in the channel first.
const updates = z.array(
  z
    .object({
      message: z
        .object({
          chat: z.object({ id: z.number(), type: z.string(), title: z.string().optional() }),
        })
        .optional(),
      channel_post: z
        .object({
          chat: z.object({ id: z.number(), type: z.string(), title: z.string().optional() }),
        })
        .optional(),
    })
    .passthrough(),
);

async function main() {
  loadLocalEnv();
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const info = webhookInfoSchema.parse(await telegramCall(token, "getWebhookInfo"));
  if (info.url) {
    console.error(
      "A webhook is set, so getUpdates is unavailable. Run npm run telegram:delete-webhook first.",
    );
    process.exit(1);
  }
  const result = updates.parse(
    await telegramCall(token, "getUpdates", {
      timeout: 0,
      allowed_updates: ["message", "channel_post"],
    }),
  );
  const chats = new Map<number, string>();
  for (const u of result) {
    const chat = u.channel_post?.chat ?? u.message?.chat;
    if (chat) chats.set(chat.id, `${chat.type}${chat.title ? `: ${chat.title}` : ""}`);
  }
  if (!chats.size) {
    console.log(
      "No recent updates. Post a message in the channel (bot must be an admin) and run this again.",
    );
    return;
  }
  for (const [id, label] of chats) console.log(`${id}\t${label}`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
