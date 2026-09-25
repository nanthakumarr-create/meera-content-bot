import { loadLocalEnv, maskToken, requireEnv } from "./env";
import { telegramCall, webhookInfoSchema } from "./telegram-api";

const ALLOWED_UPDATES = ["message", "channel_post", "callback_query"];

async function main() {
  loadLocalEnv();
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const secret = requireEnv("TELEGRAM_WEBHOOK_SECRET");
  const baseUrl = requireEnv("APP_BASE_URL").replace(/\/+$/, "");

  if (!/^https:\/\//.test(baseUrl)) {
    console.error("APP_BASE_URL must be an https URL; Telegram only delivers webhooks over TLS.");
    process.exit(1);
  }
  const webhookUrl = `${baseUrl}/api/telegram/webhook`;

  await telegramCall(token, "setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: false,
    max_connections: 10,
  });

  const info = webhookInfoSchema.parse(await telegramCall(token, "getWebhookInfo"));
  const allowed = [...(info.allowed_updates ?? [])].sort();
  const problems: string[] = [];
  if (info.url !== webhookUrl)
    problems.push(`url is ${info.url || "(empty)"}, expected ${webhookUrl}`);
  if (allowed.join(",") !== [...ALLOWED_UPDATES].sort().join(",")) {
    problems.push(`allowed_updates is [${allowed.join(", ")}]`);
  }

  if (problems.length) {
    console.error(
      `Webhook verification failed for bot ${maskToken(token)}: ${problems.join("; ")}`,
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        bot: maskToken(token),
        url: info.url,
        allowed_updates: info.allowed_updates,
        pending_update_count: info.pending_update_count,
        last_error_message: info.last_error_message ?? null,
        secret_token: "set (not shown)",
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
