-- Sleep Score Review onboarding schema.
--
-- WHY THIS FILE EXISTS. These objects were created live through the Supabase
-- management API on 27 Sept 2026, which left the schema with no durable record
-- anywhere. The `draft_id` column in particular was added last, and without it
-- the `submit` action of the sleep-intake Edge Function returns a 500. This file
-- is read back out of the live database, not written from memory, so it matches
-- what is actually deployed. Re-read it from live if you change anything.
--
-- These tables live in the exec-performance-os project because the Supabase org
-- is on the free plan and is already at its two-project limit. A dedicated
-- project would have been the better isolation and could not be created.
--
-- ⛔ The anon role must never gain SELECT on any of these. The page holds no key
-- at all and talks only to the Edge Function, but the project's publishable key
-- is public elsewhere in this estate, so the grants below are what actually
-- stands between a stranger and a named person's sleep data. Both layers matter:
-- Supabase grants ALL on new public tables to anon by default, so the revoke is
-- not optional and RLS alone would not save you.

-- ============================================================
-- One row per person who completes the form
-- ============================================================
create table if not exists public.sleep_submissions (
  id            uuid        primary key default gen_random_uuid(),
  ref           text        not null unique,          -- SSR-XXXXXX, the human-facing reference
  created_at    timestamptz not null default now(),
  name          text        not null,
  email         text        not null,
  device        text        not null,                 -- 'oura' or 'whoop'
  answers       jsonb       not null default '{}'::jsonb,
  consent       jsonb       not null default '{}'::jsonb,
  safety_flag   boolean     not null default false,   -- they ticked snoring, apnoea or daytime sleep
  upload_token  text        unique,                   -- 32 random bytes, hex. NEVER derived from the email
  upload_path   text,
  uploaded_at   timestamptz,                          -- ⭐ the 90-day clock starts HERE, Rachel's ruling
  delete_after  timestamptz,                          -- maintained by the trigger below
  notified_at   timestamptz,                          -- stamped once Rachel's copy has actually sent
  deleted_at    timestamptz,
  draft_id      uuid        unique                    -- idempotency, so a lost response is not a second person
);

-- ============================================================
-- Save-as-you-type drafts
-- ============================================================
-- ⚠ These carry the same named health record as a submission and have the least
-- consent behind them, because the person never pressed send. The purge job
-- deletes them 30 days after the LAST keystroke, computed from updated_at rather
-- than from this default, which is evaluated at insert and so would delete a
-- long-running draft mid-edit.
create table if not exists public.sleep_partials (
  draft_id     uuid        primary key,
  updated_at   timestamptz not null default now(),
  payload      jsonb       not null default '{}'::jsonb,
  delete_after timestamptz not null default (now() + interval '30 days')
);

-- ============================================================
-- Proof the purge ran, including the runs that deleted nothing
-- ============================================================
create table if not exists public.sleep_delete_log (
  id             bigserial   primary key,
  ran_at         timestamptz not null default now(),
  rows_deleted   integer     not null default 0,
  files_deleted  integer     not null default 0,
  detail         jsonb,
  drafts_deleted integer
);

-- ============================================================
-- The 90 days run from the upload. "That's the promise." Rachel, 27 Sept 2026.
-- ============================================================
-- A trigger rather than application code, because the promise is in writing on
-- a public page and it must not depend on any particular caller remembering.
-- It fires on UPDATE OF uploaded_at as well as INSERT, so re-setting the upload
-- time recomputes the deletion date rather than leaving a stale one behind.
create or replace function public.sleep_set_delete_after()
returns trigger language plpgsql as $$
begin
  if new.uploaded_at is not null then
    new.delete_after := new.uploaded_at + interval '90 days';
  end if;
  return new;
end $$;

drop trigger if exists sleep_submissions_delete_after on public.sleep_submissions;
create trigger sleep_submissions_delete_after
  before insert or update of uploaded_at on public.sleep_submissions
  for each row execute function public.sleep_set_delete_after();

-- ============================================================
-- Grants and RLS. Both layers, deliberately.
-- ============================================================
alter table public.sleep_submissions enable row level security;
alter table public.sleep_submissions force row level security;
alter table public.sleep_partials    enable row level security;
alter table public.sleep_partials    force row level security;
alter table public.sleep_delete_log  enable row level security;
alter table public.sleep_delete_log  force row level security;

revoke all on public.sleep_submissions from anon, authenticated;
revoke all on public.sleep_partials    from anon, authenticated;
revoke all on public.sleep_delete_log  from anon, authenticated;

-- anon may insert and nothing else. No SELECT grant and no SELECT policy exists,
-- so upload_token is unreachable by any REST route.
grant insert on public.sleep_submissions to anon;
grant insert on public.sleep_partials to anon;
grant update (payload, updated_at) on public.sleep_partials to anon;
-- sleep_delete_log gets nothing at all, and carries zero policies.

drop policy if exists sleep_submissions_anon_insert on public.sleep_submissions;
create policy sleep_submissions_anon_insert on public.sleep_submissions
  for insert to anon with check (true);

drop policy if exists sleep_partials_anon_insert on public.sleep_partials;
create policy sleep_partials_anon_insert on public.sleep_partials
  for insert to anon with check (true);

drop policy if exists sleep_partials_anon_update on public.sleep_partials;
create policy sleep_partials_anon_update on public.sleep_partials
  for update to anon using (true) with check (true);

-- ============================================================
-- Storage
-- ============================================================
-- Bucket `sleep-exports`, public false, file_size_limit 52428800.
-- ⛔ It has NO policies and needs none. Uploads use a signed URL minted by the
-- Edge Function with the service key, so anon never touches storage.objects
-- directly. RLS being on with no policy is the only thing denying access, which
-- is Supabase's default and holds under test, but it means any future permissive
-- policy on storage.objects written without a bucket_id filter would expose this
-- bucket too.
--
-- ⛔ The Storage API rejects the new-style sb_secret_ key with
-- {"statusCode":"403","message":"Invalid Compact JWS"} while PostgREST accepts
-- it. Anything deleting files must use the legacy service_role JWT, which is
-- SUPABASE_SERVICE_JWT in ~/hex/.env.
