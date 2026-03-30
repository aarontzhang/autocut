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
    'frame_descriptions'
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




