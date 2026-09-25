# Component map

How a note becomes a reviewed LinkedIn draft. LinkedIn publication is deliberately outside the automation.

```mermaid
flowchart TD
    subgraph Trigger
        A["1. Meera posts a note in her private Telegram channel"]
    end

    subgraph Input
        B["2. Telegram sends a webhook to Vercel<br/>POST /api/telegram/webhook"]
        C{"3. Validate, deduplicate, store<br/>secret header (timing-safe) · allowed chat ·<br/>update_id dedupe · rate limit · concurrency guard"}
        DB1[("Supabase<br/>telegram_updates + notes<br/>(stored before any AI call)")]
    end

    subgraph AI_Scoring["AI: scoring"]
        D["4. Gemini scores the note<br/>strict JSON: score, reason, keywords<br/>(Zod-validated, 3 attempts, timeouts)"]
        E{"score ≥ 6?"}
        F["5. Stop. Save score + reason.<br/>Telegram: why no draft was created"]
    end

    subgraph Context
        G["6. Keywords from the scoring call"]
        H["7. Google News RSS<br/>(optional · cached 6h · recent + keyword-matched ·<br/>headline/summary only, article bodies never read)"]
        H2["Gemini relevance check<br/>(may discard all news)"]
    end

    subgraph Processing_AI["AI: drafting"]
        I["8. Gemini drafts in Meera's voice<br/>note + voice-skill.txt + optional verified source metadata"]
        V[("voice_skills<br/>content-addressed version")]
    end

    subgraph Output
        J[("9. Supabase: draft stored as pending<br/>references note + voice skill version")]
        K["10. Telegram returns the draft<br/>short ID · score · reason · text ·<br/>NEWS SOURCE block · Approve / Reject"]
    end

    subgraph Human_Review_Gate["Human review gate"]
        L{"11. Meera approves or rejects<br/>(button or APPROVE/REJECT id)"}
        M[("12. Supabase stores the decision<br/>draft_reviews: who, when, update_id<br/>idempotent · never deleted")]
    end

    N["13. LinkedIn publication stays manual.<br/>Meera copies the approved text herself."]

    A --> B --> C
    C -->|"stored"| DB1
    C -->|"accepted, 200 returned; work continues in after()"| D
    D --> E
    E -->|"no"| F
    E -->|"yes"| G --> H --> H2 --> I
    V --> I
    I --> J --> K --> L
    L --> M
    M -.->|"outside the system"| N

    classDef human fill:#fff4d6,stroke:#b8860b,color:#000;
    classDef store fill:#e8f1ff,stroke:#3b6fb6,color:#000;
    classDef stop fill:#fde8e8,stroke:#b33,color:#000;
    class L,N human;
    class DB1,J,M,V store;
    class F stop;
```

## Components

| Stage      | Code                                                           | Notes                                                                                                                    |
| ---------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Trigger    | Telegram channel                                               | The bot is an admin of Meera's private channel. Direct messages to the bot also work if that chat ID is the allowed one. |
| Input      | `app/api/telegram/webhook/route.ts`, `src/pipeline/webhook.ts` | Auth, allowed-chat check, dedupe, and note storage happen before the 200 response. AI work runs in Next's `after()`.     |
| Parsing    | `src/telegram/updates.ts`                                      | Zod-validated update parsing. Bot messages are ignored to prevent loops.                                                 |
| Storage    | `src/db/supabase.ts`, `supabase/migrations/*.sql`              | Multi-row writes are SQL functions, so each is one transaction.                                                          |
| Scoring    | `src/ai/prompts.ts`, `src/ai/schemas.ts`, `src/ai/gemini.ts`   | `@google/genai` with `responseJsonSchema`, Zod validation, bounded retries.                                              |
| Context    | `src/news/rss.ts`                                              | Google News RSS search only. Failures degrade to "no news".                                                              |
| Drafting   | `src/pipeline/processNote.ts`, `voice-skill.txt`               | The voice skill is sent on every drafting call. The model may only cite the exact news item it was given.                |
| Output     | `src/telegram/format.ts`, `src/telegram/client.ts`             | HTML-escaped, split under Telegram's 4096-character limit, buttons on the last message.                                  |
| Review     | `review_draft()` SQL function                                  | Row lock plus status check makes repeated clicks idempotent. Decisions are final.                                        |
| Operations | `app/api/health/route.ts`, `src/lib/logger.ts`                 | JSON logs with request and update IDs; secrets redacted. Failed updates are marked `dead_letter`.                        |
