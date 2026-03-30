create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_subscription_id text not null unique,
  status text not null default 'incomplete'
    check (status in (
      'active', 'past_due', 'canceled', 'incomplete',
      'incomplete_expired', 'trialing', 'unpaid', 'paused'
    )),
  price_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_user_id_idx
  on public.subscriptions(user_id);

create index if not exists subscriptions_stripe_customer_id_idx
  on public.subscriptions(stripe_customer_id);

create index if not exists subscriptions_stripe_subscription_id_idx
  on public.subscriptions(stripe_subscription_id);

drop trigger if exists set_subscriptions_updated_at on public.subscriptions;
create trigger set_subscriptions_updated_at
before update on public.subscriptions
for each row
execute function public.set_updated_at();

alter table public.subscriptions enable row level security;

-- Users can read their own subscription
drop policy if exists "users can read own subscriptions" on public.subscriptions;
create policy "users can read own subscriptions"
on public.subscriptions
for select
using (auth.uid() = user_id);

-- Only service_role can insert/update/delete (via webhooks)
