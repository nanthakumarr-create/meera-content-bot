import { loadLocalEnv, maskToken, requireEnv } from "./env";
import { telegramCall, webhookInfoSchema } from "./telegram-api";

// Rollback: stop Telegram from calling the deployment. Pending updates are kept
// (drop_pending_updates: false) so no notes are lost; they are delivered when a
// webhook is set again.
async function main() {
  loadLocalEnv();
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  await telegramCall(token, "deleteWebhook", { drop_pending_updates: false });
  const info = webhookInfoSchema.parse(await telegramCall(token, "getWebhookInfo"));
  if (info.url) {
    console.error(`Webhook still set for bot ${maskToken(token)}: ${info.url}`);
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        bot: maskToken(token),
        webhook: "deleted",
        pending_update_count: info.pending_update_count,
      },
      null,
      2,
    ),
  );
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
