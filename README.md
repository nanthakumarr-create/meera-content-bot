# Meera content bot

A Telegram content assistant for Skinstinct, a fictional D2C skincare brand. Meera posts raw notes in a private Telegram channel. The bot scores each note with Gemini, optionally finds a current Google News angle, drafts a LinkedIn post in her voice, and sends it back to Telegram with **Approve** and **Reject** buttons. Every note, draft, and decision is stored in Supabase.

**It never publishes.** There is no LinkedIn integration. Meera reviews every draft and posts approved ones herself.

- How it fits together: [docs/component-map.md](docs/component-map.md)
- One-minute demo: [docs/demo-script.md](docs/demo-script.md)
- Security model: [SECURITY.md](SECURITY.md)

**Stack:** Next.js 16 App Router on Vercel · TypeScript (strict) · Telegram Bot API webhooks · Gemini via `@google/genai` · Supabase Postgres · Google News RSS · Zod · Vitest.

## How a note flows

1. Telegram calls `POST /api/telegram/webhook`. The server checks the secret header (constant-time) and the allowed chat, deduplicates the `update_id`, applies rate limits, and stores the note. It then returns `200` immediately.
2. In the background (Next's `after()`), Gemini scores the note 0–10 and returns strict JSON. Below 6, the pipeline stops and Meera gets the reason.
3. At 6 or above, the scoring keywords query Google News RSS. Gemini decides whether any recent result is genuinely relevant, and may ignore all of them.
4. Gemini drafts the post using the note, `voice-skill.txt`, and the optional source metadata. The draft is validated, stored as `pending`, and sent to Telegram.
5. Meera taps Approve or Reject, or replies `APPROVE <id>` / `REJECT <id>`. The decision is stored and is idempotent.

## Local setup

Requirements: Node.js 20.9+ (22 recommended), a Telegram account, a Supabase project, and a Gemini API key.

```bash
npm install
cp .env.example .env.local   # then fill in the values below
```

| Variable                    | Where to get it                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`        | BotFather → `/newbot`                                                                                                                                          |
| `TELEGRAM_WEBHOOK_SECRET`   | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`                                                                     |
| `TELEGRAM_ALLOWED_CHAT_ID`  | Your private channel's ID (starts with `-100`); see below                                                                                                      |
| `GEMINI_API_KEY`            | [Google AI Studio](https://aistudio.google.com/apikey)                                                                                                         |
| `GEMINI_MODEL`              | A current Gemini model ID from the [models list](https://ai.google.dev/gemini-api/docs/models). A Flash-tier model is fast and cheap enough for this workload. |
| `SUPABASE_URL`              | Supabase → Project Settings → API → Project URL                                                                                                                |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` / secret key (server only)                                                                                  |
| `APP_BASE_URL`              | Your production URL, e.g. `https://meera-content-bot.vercel.app`                                                                                               |

The app refuses to start if any value is missing or malformed, and the error names the variable.

Run it with `npm run dev`. Telegram cannot reach `localhost`, so exercise the pipeline through the tests, or expose the dev server with a tunnel and point the webhook at the tunnel's https URL.

## Supabase migration

The schema lives in [`supabase/migrations/`](supabase/migrations/). It is idempotent, so it is safe to re-run. It creates `telegram_updates`, `notes`, `drafts`, `draft_reviews`, `voice_skills`, `news_cache`, and `rate_limit_events`, plus the transactional SQL functions the app calls. RLS is enabled with no policies, so only the service role can access data.

Apply it in either of two ways:

- **SQL editor:** paste the migration file into Supabase → SQL Editor → Run.
- **From your machine:** set `SUPABASE_DB_URL` (Supabase → Connect → Session pooler connection string) in `.env.local` and run:

  ```bash
  npm run db:migrate      # applies migrations, prints the tables
  npm run db:seed-voice   # inserts voice-skill.txt once and marks it active
  ```

Seeding is optional, because the app also registers the voice skill on its first draft. The voice skill version is the SHA-256 of `voice-skill.txt`, so editing the file creates a new version automatically. Old drafts keep pointing at the version they were written with.

## Telegram bot and private channel

1. Create the bot with BotFather (`/newbot`) and copy the token.
2. Create a **private** Telegram channel for notes.
3. Add the bot to the channel as an **administrator** with permission to post messages. Bots only receive channel posts when they are admins.
4. Find the channel ID. Before setting the webhook, post any message in the channel, then run `npm run telegram:find-chat`. It lists recent chats and their IDs using only your local token. The channel ID looks like `-1001234567890`.
5. Put that ID in `TELEGRAM_ALLOWED_CHAT_ID`. The bot ignores every other chat.

A private one-to-one chat with the bot also works: use your own chat ID instead of the channel's.

## Webhook setup

After deploying (below):

```bash
npm run telegram:set-webhook      # sets the webhook with secret_token and verifies it via getWebhookInfo
npm run telegram:delete-webhook   # rollback: removes the webhook, keeps pending updates
```

`set-webhook` registers `${APP_BASE_URL}/api/telegram/webhook`, restricts updates to `message`, `channel_post`, and `callback_query`, and prints a sanitized summary. It never prints the token.

## Testing

```bash
npm run format:check
npm run lint
npm run typecheck
npm test                 # unit + integration; all external services are mocked
npm run build
npm run check            # all of the above in order
```

Tests never touch the network: a global guard fails any real `fetch`. The integration suite runs the real Gemini, RSS, and Telegram clients against mocked transports, with an in-memory repository in place of Supabase. It includes the brief's acceptance fixtures: the strong note produces a draft, and the weak note is rejected without a drafting call.

## Vercel deployment

```bash
npx vercel link                                   # create or link the project
# Add each variable for the Production environment (you will be prompted for the value):
npx vercel env add TELEGRAM_BOT_TOKEN production
npx vercel env add TELEGRAM_WEBHOOK_SECRET production
npx vercel env add TELEGRAM_ALLOWED_CHAT_ID production
npx vercel env add GEMINI_API_KEY production
npx vercel env add GEMINI_MODEL production
npx vercel env add SUPABASE_URL production
npx vercel env add SUPABASE_SERVICE_ROLE_KEY production
npx vercel env add APP_BASE_URL production
npx vercel --prod
curl https://<your-app>.vercel.app/api/health    # expect {"status":"ok",...}
npm run telegram:set-webhook
```

The webhook function sets `maxDuration = 120`. The pipeline keeps its own 100-second budget and reports failures inside it.

## Troubleshooting

| Symptom                                 | Check                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No reply at all                         | Run `npm run telegram:set-webhook` and read `last_error_message`. A 401 there means `TELEGRAM_WEBHOOK_SECRET` differs between Vercel and the value used to set the webhook. |
| Replies in DMs but not in the channel   | The bot must be a channel **admin**, and `TELEGRAM_ALLOWED_CHAT_ID` must be the channel's `-100…` ID.                                                                       |
| `/api/health` shows `database: error`   | Check `SUPABASE_URL` and the service-role key, and that the migration ran.                                                                                                  |
| Every function returns 500 after deploy | Configuration is invalid. Vercel logs show `startup.config_invalid` with the variable names.                                                                                |
| "Something went wrong" reply            | Find `pipeline.failed` in the logs by `updateId`. The note is kept with `status = failed` and a `failure_reason`, and the update is marked `dead_letter`.                   |
| "busy" or "rate limit" replies          | The global concurrency cap (3) or the per-chat limit (12 notes per 10 minutes) was hit. The note is saved; resend it later.                                                 |
| Gemini `404` / model errors             | `GEMINI_MODEL` is not a valid model ID for your key.                                                                                                                        |

## Rollback

1. Stop inbound traffic: `npm run telegram:delete-webhook`. Telegram holds pending updates for up to 24 hours.
2. Roll back the deployment: `npx vercel rollback` (or promote a previous deployment in the Vercel dashboard).
3. Re-enable: `npm run telegram:set-webhook`.

The schema migration only adds objects and never drops data, so there is no destructive database rollback. To disable the bot entirely, delete the webhook and leave the data in place.

## Known limitations

- Text notes only. Voice notes, photos, and files get a polite "text only" reply.
- News context comes from RSS headlines and summaries only. Article bodies are never fetched, and the prompts say so.
- A serverless instance that is killed mid-pipeline leaves its note in `scoring`/`drafting`. The concurrency guard stops counting it after 5 minutes, but the note is not retried automatically; Meera can resend it.
- Approve/reject decisions are final by design. A rejected draft cannot be re-approved; resend the note for a fresh draft.
