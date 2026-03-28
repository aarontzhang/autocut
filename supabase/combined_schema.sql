-- ============================================================
-- migrations/202603100001_initial_app_schema.sql
-- ============================================================

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Untitled Project',
  video_path text,
  video_filename text,
  video_size bigint,
  edit_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_id_updated_at_idx
  on public.projects(user_id, updated_at desc);

drop trigger if exists set_projects_updated_at on public.projects;
create trigger set_projects_updated_at
before update on public.projects
for each row
execute function public.set_updated_at();

alter table public.projects enable row level security;

drop policy if exists "users can manage own projects" on public.projects;
create policy "users can manage own projects"
on public.projects
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('videos', 'videos', false)
on conflict (id) do nothing;

drop policy if exists "users can read own video objects" on storage.objects;
create policy "users can read own video objects"
on storage.objects
for select
using (
  bucket_id = 'videos'
  and split_part(name, '/', 1) = auth.uid()::text
);

drop policy if exists "users can upload own video objects" on storage.objects;
create policy "users can upload own video objects"
on storage.objects
for insert
with check (
  bucket_id = 'videos'
  and split_part(name, '/', 1) = auth.uid()::text
);

drop policy if exists "users can update own video objects" on storage.objects;
create policy "users can update own video objects"
on storage.objects
for update
using (
  bucket_id = 'videos'
  and split_part(name, '/', 1) = auth.uid()::text
)
with check (
  bucket_id = 'videos'
  and split_part(name, '/', 1) = auth.uid()::text
);

drop policy if exists "users can delete own video objects" on storage.objects;
create policy "users can delete own video objects"
on storage.objects
for delete
using (
  bucket_id = 'videos'
  and split_part(name, '/', 1) = auth.uid()::text
);


-- ============================================================
-- migrations/202603100002_beta_usage_limits.sql
-- ============================================================

create table if not exists public.beta_usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null default ((now() at time zone 'utc')::date),
  metric text not null check (metric in (
    'chat_requests',
    'transcribe_seconds',
    'frame_descriptions',
    'visual_searches'
  )),
  used_amount bigint not null default 0 check (used_amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date, metric)
);

create index if not exists beta_usage_daily_usage_date_metric_idx
  on public.beta_usage_daily(usage_date, metric);

drop trigger if exists set_beta_usage_daily_updated_at on public.beta_usage_daily;
create trigger set_beta_usage_daily_updated_at
before update on public.beta_usage_daily
for each row
execute function public.set_updated_at();

alter table public.beta_usage_daily enable row level security;

drop policy if exists "users can read own beta usage" on public.beta_usage_daily;
create policy "users can read own beta usage"
on public.beta_usage_daily
for select
using (auth.uid() = user_id);

create or replace function public.consume_beta_usage(
  p_user_id uuid,
  p_metric text,
  p_amount bigint,
  p_limit bigint
)
returns table (
  allowed boolean,
  used_amount bigint,
  limit_amount bigint,
  remaining_amount bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_used bigint;
begin
  if p_amount <= 0 then
    select coalesce(used_amount, 0)
    into v_used
    from public.beta_usage_daily
    where user_id = p_user_id
      and usage_date = v_today
      and metric = p_metric;

    return query
    select true, coalesce(v_used, 0), p_limit, greatest(p_limit - coalesce(v_used, 0), 0);
    return;
  end if;

  insert into public.beta_usage_daily (user_id, usage_date, metric, used_amount)
  values (p_user_id, v_today, p_metric, 0)
  on conflict (user_id, usage_date, metric) do nothing;

  update public.beta_usage_daily
  set used_amount = beta_usage_daily.used_amount + p_amount,
      updated_at = now()
  where user_id = p_user_id
    and usage_date = v_today
    and metric = p_metric
    and (p_limit <= 0 or beta_usage_daily.used_amount + p_amount <= p_limit)
  returning beta_usage_daily.used_amount
  into v_used;

  if found then
    return query
    select true, v_used, p_limit, case when p_limit <= 0 then null else greatest(p_limit - v_used, 0) end;
    return;
  end if;

  select coalesce(used_amount, 0)
  into v_used
  from public.beta_usage_daily
  where user_id = p_user_id
    and usage_date = v_today
    and metric = p_metric;

  return query
  select false, coalesce(v_used, 0), p_limit, case when p_limit <= 0 then null else greatest(p_limit - coalesce(v_used, 0), 0) end;
end;
$$;

grant execute on function public.consume_beta_usage(uuid, text, bigint, bigint) to authenticated, service_role;


-- ============================================================
-- migrations/20260310_source_anchored_visual_retrieval.sql
-- ============================================================

create extension if not exists pgcrypto;
create extension if not exists vector;

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  storage_path text not null,
  duration_seconds double precision,
  fps double precision,
  width integer,
  height integer,
  status text not null default 'pending' check (status in ('pending', 'indexing', 'ready', 'error')),
  created_at timestamptz not null default now(),
  indexed_at timestamptz,
  unique(project_id, storage_path)
);

create table if not exists public.asset_scenes (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.media_assets(id) on delete cascade,
  scene_index integer not null,
  source_start double precision not null,
  source_end double precision not null,
  representative_thumbnail_path text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.asset_visual_index (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.media_assets(id) on delete cascade,
  source_time double precision not null,
  window_duration double precision not null default 0.25,
  sample_kind text not null check (sample_kind in ('scene_rep', 'window_250ms')),
  thumbnail_path text,
  ocr_text text,
  embedding vector(1536),
  brightness double precision,
  contrast double precision,
  edge_density double precision,
  motion_score double precision,
  fog_score double precision,
  darkness_score double precision,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.asset_transcript_words (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.media_assets(id) on delete cascade,
  start_time double precision not null,
  end_time double precision not null,
  text text not null,
  confidence double precision
);

create table if not exists public.analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  asset_id uuid references public.media_assets(id) on delete cascade,
  job_type text not null check (job_type in ('index_asset', 'verify_visual_candidates', 'repeat_detect_from_seed')),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  priority integer not null default 100,
  attempt_count integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error text,
  locked_at timestamptz,
  locked_by text,
  progress jsonb not null default '{"completed":0,"total":1,"stage":"queued"}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists media_assets_project_id_idx on public.media_assets(project_id);
create index if not exists asset_scenes_asset_id_idx on public.asset_scenes(asset_id, scene_index);
create index if not exists asset_visual_index_asset_id_time_idx on public.asset_visual_index(asset_id, source_time);
create index if not exists asset_transcript_words_asset_id_time_idx on public.asset_transcript_words(asset_id, start_time);
create index if not exists analysis_jobs_queue_idx on public.analysis_jobs(status, priority, created_at);

alter table public.media_assets enable row level security;
alter table public.asset_scenes enable row level security;
alter table public.asset_visual_index enable row level security;
alter table public.asset_transcript_words enable row level security;
alter table public.analysis_jobs enable row level security;

drop policy if exists "users can access media assets for own projects" on public.media_assets;
create policy "users can access media assets for own projects"
on public.media_assets
for all
using (exists (
  select 1 from public.projects
  where projects.id = media_assets.project_id
    and projects.user_id = auth.uid()
))
with check (exists (
  select 1 from public.projects
  where projects.id = media_assets.project_id
    and projects.user_id = auth.uid()
));

drop policy if exists "users can access asset scenes for own projects" on public.asset_scenes;
create policy "users can access asset scenes for own projects"
on public.asset_scenes
for all
using (exists (
  select 1 from public.media_assets
  join public.projects on projects.id = media_assets.project_id
  where media_assets.id = asset_scenes.asset_id
    and projects.user_id = auth.uid()
))
with check (exists (
  select 1 from public.media_assets
  join public.projects on projects.id = media_assets.project_id
  where media_assets.id = asset_scenes.asset_id
    and projects.user_id = auth.uid()
));

drop policy if exists "users can access visual samples for own projects" on public.asset_visual_index;
create policy "users can access visual samples for own projects"
on public.asset_visual_index
for all
using (exists (
  select 1 from public.media_assets
  join public.projects on projects.id = media_assets.project_id
  where media_assets.id = asset_visual_index.asset_id
    and projects.user_id = auth.uid()
))
with check (exists (
  select 1 from public.media_assets
  join public.projects on projects.id = media_assets.project_id
  where media_assets.id = asset_visual_index.asset_id
    and projects.user_id = auth.uid()
));

drop policy if exists "users can access asset transcripts for own projects" on public.asset_transcript_words;
create policy "users can access asset transcripts for own projects"
on public.asset_transcript_words
for all
using (exists (
  select 1 from public.media_assets
  join public.projects on projects.id = media_assets.project_id
  where media_assets.id = asset_transcript_words.asset_id
    and projects.user_id = auth.uid()
))
with check (exists (
  select 1 from public.media_assets
  join public.projects on projects.id = media_assets.project_id
  where media_assets.id = asset_transcript_words.asset_id
    and projects.user_id = auth.uid()
));

drop policy if exists "users can access analysis jobs for own projects" on public.analysis_jobs;
create policy "users can access analysis jobs for own projects"
on public.analysis_jobs
for all
using (exists (
  select 1 from public.projects
  where projects.id = analysis_jobs.project_id
    and projects.user_id = auth.uid()
))
with check (exists (
  select 1 from public.projects
  where projects.id = analysis_jobs.project_id
    and projects.user_id = auth.uid()
));


-- ============================================================
-- migrations/202603120001_storage_upload_tracking.sql
-- ============================================================

create table if not exists public.storage_uploads (
  storage_path text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  upload_kind text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint storage_uploads_kind_check check (upload_kind in ('project-main', 'main', 'sources', 'tracks'))
);

create index if not exists storage_uploads_user_id_idx
  on public.storage_uploads(user_id, updated_at desc);

create index if not exists storage_uploads_project_id_idx
  on public.storage_uploads(project_id);

drop trigger if exists set_storage_uploads_updated_at on public.storage_uploads;
create trigger set_storage_uploads_updated_at
before update on public.storage_uploads
for each row
execute function public.set_updated_at();

alter table public.storage_uploads enable row level security;

drop policy if exists "users can read own storage uploads" on public.storage_uploads;
create policy "users can read own storage uploads"
on public.storage_uploads
for select
using (auth.uid() = user_id);


-- ============================================================
-- migrations/202603170001_waitlist.sql
-- ============================================================

create table if not exists waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now(),
  constraint waitlist_email_unique unique (email)
);

alter table waitlist enable row level security;

-- Only service role can read; inserts are open (handled via service role in API)


-- ============================================================
-- migrations/20260320_adaptive_representative_frames.sql
-- ============================================================

alter table public.asset_visual_index
  drop constraint if exists asset_visual_index_sample_kind_check;

alter table public.asset_visual_index
  add constraint asset_visual_index_sample_kind_check
  check (sample_kind in ('scene_rep', 'coarse_window_rep', 'window_250ms'));


-- ============================================================
-- migrations/202603220001_analysis_job_pause_support.sql
-- ============================================================

alter table public.analysis_jobs
  drop constraint if exists analysis_jobs_status_check;

alter table public.analysis_jobs
  add constraint analysis_jobs_status_check
  check (status in ('queued', 'running', 'paused', 'completed', 'failed'));

alter table public.analysis_jobs
  add column if not exists pause_requested boolean not null default false;

create index if not exists analysis_jobs_asset_status_idx
  on public.analysis_jobs(asset_id, status, created_at desc);


-- ============================================================
-- migrations/202603230001_prevent_duplicate_active_analysis_jobs.sql
-- ============================================================

create unique index if not exists analysis_jobs_active_asset_job_type_uidx
  on public.analysis_jobs(asset_id, job_type)
  where status in ('queued', 'running', 'paused');


