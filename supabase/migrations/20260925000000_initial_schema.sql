-- Meera content bot: initial schema.
-- Idempotent: safe to run more than once. All timestamps are timestamptz (stored as UTC).
-- Nothing here ever deletes notes, drafts, or reviews.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Shared trigger: maintain updated_at
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- telegram_updates: one row per Telegram update_id, used for deduplication,
-- request correlation, and dead-lettering.
-- ---------------------------------------------------------------------------
create table if not exists public.telegram_updates (
  update_id      bigint primary key,
  chat_id        bigint,
  update_type    text not null,
  status         text not null default 'received',
  error_category text,
  error_message  text,
  request_id     text,
  received_at    timestamptz not null default now(),
  processed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint telegram_updates_type_check
    check (update_type in ('message', 'channel_post', 'callback_query', 'unknown')),
  constraint telegram_updates_status_check
    check (status in ('received', 'processing', 'completed', 'ignored', 'dead_letter'))
);

create index if not exists telegram_updates_status_idx
  on public.telegram_updates (status, received_at desc);

-- ---------------------------------------------------------------------------
-- voice_skills: versioned copies of voice-skill.txt. Exactly one is active.
-- ---------------------------------------------------------------------------
create table if not exists public.voice_skills (
  id             uuid primary key default gen_random_uuid(),
  version        text not null unique,
  content_sha256 text not null unique,
  content        text not null,
  is_active      boolean not null default false,
  created_at     timestamptz not null default now(),
  constraint voice_skills_content_check check (length(content) >= 200),
  constraint voice_skills_sha_check check (content_sha256 ~ '^[0-9a-f]{64}$')
);

create unique index if not exists voice_skills_single_active_idx
  on public.voice_skills (is_active) where is_active;

-- ---------------------------------------------------------------------------
-- notes: every incoming text note, stored before any AI call. Never deleted.
-- ---------------------------------------------------------------------------
create table if not exists public.notes (
  id                    uuid primary key default gen_random_uuid(),
  telegram_update_id    bigint not null unique
                          references public.telegram_updates (update_id) on delete restrict,
  chat_id               bigint not null,
  message_id            bigint not null,
  raw_text              text not null,
  received_at           timestamptz not null,
  status                text not null default 'received',
  score                 smallint,
  score_reason          text,
  keywords              text[],
  failure_reason        text,
  processing_started_at timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint notes_chat_message_unique unique (chat_id, message_id),
  constraint notes_text_check check (length(raw_text) > 0),
  constraint notes_score_check check (score is null or score between 0 and 10),
  constraint notes_status_check check (status in (
    'received', 'rate_limited', 'throttled', 'scoring', 'rejected',
    'finding_news', 'drafting', 'drafted', 'failed'
  ))
);

create index if not exists notes_status_idx on public.notes (status, processing_started_at);
create index if not exists notes_chat_received_idx on public.notes (chat_id, received_at desc);

-- ---------------------------------------------------------------------------
-- drafts: one per qualifying note. Never deleted; rejection is a status.
-- ---------------------------------------------------------------------------
create table if not exists public.drafts (
  id                  uuid primary key default gen_random_uuid(),
  short_id            text not null unique,
  note_id             uuid not null unique references public.notes (id) on delete restrict,
  voice_skill_id      uuid not null references public.voice_skills (id) on delete restrict,
  model               text not null,
  draft_text          text not null,
  news_used           boolean not null default false,
  news_headline       text,
  news_publication    text,
  news_published_at   timestamptz,
  news_url            text,
  news_description    text,
  status              text not null default 'pending',
  telegram_message_id bigint,
  reviewed_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint drafts_short_id_check check (short_id ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$'),
  constraint drafts_status_check check (status in ('pending', 'approved', 'rejected')),
  constraint drafts_text_check check (length(draft_text) > 0),
  constraint drafts_news_check check (
    news_used = false or (news_headline is not null and news_url is not null)
  ),
  constraint drafts_reviewed_check check (
    (status = 'pending' and reviewed_at is null) or (status <> 'pending' and reviewed_at is not null)
  )
);

create index if not exists drafts_status_idx on public.drafts (status, created_at desc);
create index if not exists drafts_voice_skill_idx on public.drafts (voice_skill_id);

-- ---------------------------------------------------------------------------
-- draft_reviews: who approved/rejected, when, and from which Telegram update.
-- One decision per draft.
-- ---------------------------------------------------------------------------
create table if not exists public.draft_reviews (
  id                 uuid primary key default gen_random_uuid(),
  draft_id           uuid not null unique references public.drafts (id) on delete restrict,
  decision           text not null,
  source             text not null,
  actor_telegram_id  bigint,
  actor_name         text,
  chat_id            bigint not null,
  telegram_update_id bigint not null unique
                       references public.telegram_updates (update_id) on delete restrict,
  created_at         timestamptz not null default now(),
  constraint draft_reviews_decision_check check (decision in ('approved', 'rejected')),
  constraint draft_reviews_source_check check (source in ('button', 'command'))
);

-- ---------------------------------------------------------------------------
-- news_cache: cached Google News RSS results keyed by normalized query hash.
-- ---------------------------------------------------------------------------
create table if not exists public.news_cache (
  cache_key  text primary key,
  query      text not null,
  results    jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint news_cache_results_check check (jsonb_typeof(results) = 'array')
);

create index if not exists news_cache_expires_idx on public.news_cache (expires_at);

-- ---------------------------------------------------------------------------
-- rate_limit_events: sliding-window per-chat rate limiting.
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limit_events (
  id         bigint generated always as identity primary key,
  chat_id    bigint not null,
  bucket     text not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_events_lookup_idx
  on public.rate_limit_events (chat_id, bucket, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
drop trigger if exists telegram_updates_updated_at on public.telegram_updates;
create trigger telegram_updates_updated_at before update on public.telegram_updates
  for each row execute function public.set_updated_at();

drop trigger if exists notes_updated_at on public.notes;
create trigger notes_updated_at before update on public.notes
  for each row execute function public.set_updated_at();

drop trigger if exists drafts_updated_at on public.drafts;
create trigger drafts_updated_at before update on public.drafts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security: enabled with no policies, so anon/authenticated keys can
-- read or write nothing. Only the server's service role (which bypasses RLS)
-- has access.
-- ---------------------------------------------------------------------------
alter table public.telegram_updates  enable row level security;
alter table public.voice_skills      enable row level security;
alter table public.notes             enable row level security;
alter table public.drafts            enable row level security;
alter table public.draft_reviews     enable row level security;
alter table public.news_cache        enable row level security;
alter table public.rate_limit_events enable row level security;

-- ---------------------------------------------------------------------------
-- Atomic workflow functions (each call runs in a single transaction).
-- ---------------------------------------------------------------------------

-- Store the update and the note together, or neither. Returns null on duplicate update_id.
create or replace function public.ingest_note(
  p_update_id   bigint,
  p_update_type text,
  p_chat_id     bigint,
  p_message_id  bigint,
  p_raw_text    text,
  p_received_at timestamptz,
  p_request_id  text
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_note_id uuid;
begin
  insert into telegram_updates (update_id, chat_id, update_type, status, request_id)
  values (p_update_id, p_chat_id, p_update_type, 'processing', p_request_id)
  on conflict (update_id) do nothing;

  if not found then
    return null;
  end if;

  insert into notes (telegram_update_id, chat_id, message_id, raw_text, received_at)
  values (p_update_id, p_chat_id, p_message_id, p_raw_text, p_received_at)
  on conflict (chat_id, message_id) do nothing
  returning id into v_note_id;

  if v_note_id is null then
    -- Same message delivered under a new update_id: keep the update row, mark it ignored.
    update telegram_updates set status = 'ignored', error_message = 'duplicate message_id'
    where update_id = p_update_id;
  end if;

  return v_note_id;
end;
$$;

-- Returns false on duplicate update_id.
create or replace function public.record_update(
  p_update_id   bigint,
  p_update_type text,
  p_chat_id     bigint,
  p_request_id  text,
  p_status      text
)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  insert into telegram_updates (update_id, chat_id, update_type, status, request_id,
                                processed_at)
  values (p_update_id, p_chat_id, p_update_type, p_status, p_request_id,
          case when p_status in ('completed', 'ignored') then now() end)
  on conflict (update_id) do nothing;
  return found;
end;
$$;

-- Sliding-window limiter, serialized per chat+bucket with an advisory lock.
create or replace function public.hit_rate_limit(
  p_chat_id        bigint,
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('rate:' || p_chat_id || ':' || p_bucket, 0));

  select count(*) into v_count
  from rate_limit_events
  where chat_id = p_chat_id
    and bucket = p_bucket
    and created_at > now() - make_interval(secs => p_window_seconds);

  if v_count >= p_limit then
    return false;
  end if;

  insert into rate_limit_events (chat_id, bucket) values (p_chat_id, p_bucket);

  -- Housekeeping: rate-limit events are operational data, not workflow records.
  delete from rate_limit_events
  where chat_id = p_chat_id and bucket = p_bucket and created_at < now() - interval '1 day';

  return true;
end;
$$;

-- Global concurrency guard across all serverless instances.
create or replace function public.try_begin_processing(
  p_note_id        uuid,
  p_max_concurrent integer,
  p_stale_seconds  integer
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_active integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('pipeline-concurrency', 0));

  select count(*) into v_active
  from notes
  where status in ('scoring', 'finding_news', 'drafting')
    and processing_started_at > now() - make_interval(secs => p_stale_seconds);

  if v_active >= p_max_concurrent then
    return false;
  end if;

  update notes
  set status = 'scoring', processing_started_at = now()
  where id = p_note_id and status = 'received';

  return found;
end;
$$;

-- Insert the draft and advance the note in one transaction.
create or replace function public.create_draft(
  p_note_id           uuid,
  p_short_id          text,
  p_voice_skill_id    uuid,
  p_model             text,
  p_draft_text        text,
  p_news_used         boolean,
  p_news_headline     text,
  p_news_publication  text,
  p_news_published_at timestamptz,
  p_news_url          text,
  p_news_description  text
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_draft_id uuid;
begin
  insert into drafts (note_id, short_id, voice_skill_id, model, draft_text, news_used,
                      news_headline, news_publication, news_published_at, news_url,
                      news_description)
  values (p_note_id, p_short_id, p_voice_skill_id, p_model, p_draft_text, p_news_used,
          p_news_headline, p_news_publication, p_news_published_at, p_news_url,
          p_news_description)
  returning id into v_draft_id;

  update notes set status = 'drafted', failure_reason = null where id = p_note_id;

  return v_draft_id;
end;
$$;

-- Idempotent review. Row lock prevents two concurrent clicks both "winning".
create or replace function public.review_draft(
  p_short_id   text,
  p_chat_id    bigint,
  p_decision   text,
  p_source     text,
  p_actor_id   bigint,
  p_actor_name text,
  p_update_id  bigint
)
returns table (outcome text, draft_id uuid, status text, telegram_message_id bigint)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
declare
  v_draft drafts%rowtype;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid decision %', p_decision using errcode = '22023';
  end if;

  select d.* into v_draft
  from drafts d
  join notes n on n.id = d.note_id
  where d.short_id = upper(p_short_id) and n.chat_id = p_chat_id
  for update of d;

  if not found then
    return query select 'not_found'::text, null::uuid, null::text, null::bigint;
    return;
  end if;

  if v_draft.status = 'pending' then
    update drafts set status = p_decision, reviewed_at = now() where id = v_draft.id;
    insert into draft_reviews (draft_id, decision, source, actor_telegram_id, actor_name,
                               chat_id, telegram_update_id)
    values (v_draft.id, p_decision, p_source, p_actor_id, p_actor_name, p_chat_id, p_update_id);
    return query select 'updated'::text, v_draft.id, p_decision, v_draft.telegram_message_id;
  elsif v_draft.status = p_decision then
    return query select 'unchanged'::text, v_draft.id, v_draft.status, v_draft.telegram_message_id;
  else
    return query select 'conflict'::text, v_draft.id, v_draft.status, v_draft.telegram_message_id;
  end if;
end;
$$;

-- Insert a voice skill version once; activate it; return its id.
create or replace function public.ensure_voice_skill(
  p_version text,
  p_sha256  text,
  p_content text
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('voice-skill', 0));

  select id into v_id from voice_skills where content_sha256 = p_sha256;
  if v_id is null then
    insert into voice_skills (version, content_sha256, content, is_active)
    values (p_version, p_sha256, p_content, false)
    returning id into v_id;
  end if;

  if not exists (select 1 from voice_skills where id = v_id and is_active) then
    update voice_skills set is_active = false where is_active;
    update voice_skills set is_active = true where id = v_id;
  end if;

  return v_id;
end;
$$;

-- Only the server-side service role may call workflow functions.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'ingest_note(bigint,text,bigint,bigint,text,timestamptz,text)',
    'record_update(bigint,text,bigint,text,text)',
    'hit_rate_limit(bigint,text,integer,integer)',
    'try_begin_processing(uuid,integer,integer)',
    'create_draft(uuid,text,uuid,text,text,boolean,text,text,timestamptz,text,text)',
    'review_draft(text,bigint,text,text,bigint,text,bigint)',
    'ensure_voice_skill(text,text,text)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s from anon', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function public.%s from authenticated', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function public.%s to service_role', fn);
    end if;
  end loop;
end;
$$;
