# Security

This service handles one founder's unpublished business notes. It is deliberately small: one webhook, one health check, no public dashboard, and no path to publish anything.

## Secret handling

- Secrets live only in environment variables: Vercel project settings in production and `.env.local` on a developer machine. `.env`, `.env.*` (except `.env.example`), key files, and `.vercel/` are git-ignored.
- `.env.example` contains names only, never values.
- Configuration is validated at startup (`instrumentation.ts`, `src/lib/config.ts`). Error messages name the bad variable but never echo its value.
- All secrets are server-side. No `NEXT_PUBLIC_` variables exist, and the Supabase and pipeline modules import `server-only`, so bundling them into browser code fails the build.
- Logs are structured JSON passed through a redactor (`src/lib/logger.ts`) that masks Telegram bot tokens (including inside `api.telegram.org/bot…` URLs), Google API keys, JWT-shaped keys, Supabase secret keys, and any field whose name looks sensitive. Telegram client errors never include the request URL.
- Scripts print the bot token only as `<bot-id>:****`.
- `SUPABASE_DB_URL` is used only by `npm run db:migrate` on a developer machine. It is not needed, and should not be set, in Vercel.

## Webhook validation

- Telegram is registered with a `secret_token` (32–256 characters). Every request must carry it in `X-Telegram-Bot-Api-Secret-Token`. The check is constant-time: both values are SHA-256 hashed and compared with `crypto.timingSafeEqual`, so neither content nor length leaks through timing. Anything else gets `401` and no processing.
- Bodies are parsed with Zod. Malformed updates are acknowledged and ignored so Telegram does not retry them forever.
- Every `update_id` is inserted into `telegram_updates` (primary key) before any expensive work, so replays and redeliveries are processed once.
- Messages sent by bots, including this bot's own drafts, are ignored to prevent loops.
- Per-chat rate limits and a global concurrency cap (both enforced in Postgres with advisory locks) bound cost if the channel is flooded.

## Allowed-chat restriction

- `TELEGRAM_ALLOWED_CHAT_ID` is the only chat the bot will act for. Updates from any other chat are dropped before any database write, AI call, or reply.
- Review actions (buttons and `APPROVE`/`REJECT` commands) are also limited to that chat, and the `review_draft` SQL function only matches drafts whose note came from the same chat.
- Keep the channel private and limit its admins. Anyone who can post in the allowed chat can submit notes and approve or reject drafts.

## Prompt injection and model output

- Note text and news metadata are wrapped in tags and the model is told to treat them as data.
- All model output is validated against strict Zod schemas. Invalid output is not retried and is not sent.
- A draft may cite only the exact news item the server supplied (URL must match). Emojis and unrequested hashtags are stripped deterministically.
- The system has no LinkedIn credentials or integration of any kind, so a manipulated model cannot publish anything.

## Database access

- Row Level Security is enabled on every table with no policies, so the Supabase anon and authenticated keys can read or write nothing.
- The server uses the service-role key. Workflow SQL functions are `REVOKE`d from `public`, `anon`, and `authenticated`, and granted only to `service_role`.
- Multi-row writes (ingest, draft creation, review) are single SQL functions, so each runs in one transaction.

## Data retention

- Notes, drafts (including rejected ones), and review decisions are never deleted by the application. Foreign keys use `ON DELETE RESTRICT` to prevent accidental cascades.
- `news_cache` rows expire after 6 hours; expired rows are ignored and overwritten. `rate_limit_events` older than one day are pruned automatically. Neither table contains note content.
- To honour a deletion request, delete manually in Supabase in dependency order: `draft_reviews`, then `drafts`, then `notes`, then the related `telegram_updates`.
- Vercel function logs contain IDs, statuses, scores, and keywords, but not full note text or draft text.

## Incident response

1. **Contain.** Run `npm run telegram:delete-webhook` to stop all inbound processing immediately. Pending updates are kept by Telegram (`drop_pending_updates: false`), so no notes are lost.
2. **Rotate whatever may be exposed.**
   - Telegram token: BotFather → `/revoke`, then update `TELEGRAM_BOT_TOKEN` in Vercel.
   - Webhook secret: generate a new one (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`) and update `TELEGRAM_WEBHOOK_SECRET`.
   - Gemini key: revoke and recreate in Google AI Studio.
   - Supabase service-role key: rotate in the Supabase dashboard (API settings).
3. **Redeploy** (`vercel --prod`), then `npm run telegram:set-webhook` and confirm `getWebhookInfo` is clean.
4. **Investigate.** Filter Vercel logs by `requestId`/`updateId`. Check `telegram_updates` for `dead_letter` rows and unexpected `chat_id` values, and `draft_reviews` for unexpected actors.
5. **If a secret reached Git**, rotate it first, then rewrite history (`git filter-repo`) and force-push. Treat the old value as public regardless.

## Reporting

Report suspected vulnerabilities privately to the repository owner rather than in a public issue.
