-- Backfill actual subscription records for grandfathered users.
-- Every user with manually_subscribed = true who does NOT already have
-- a row in public.subscriptions gets a real active subscription record.
INSERT INTO public.subscriptions (
  user_id,
  stripe_customer_id,
  stripe_subscription_id,
  status,
  cancel_at_period_end
)
SELECT
  u.id,
  'grandfathered',
  'grandfathered_' || u.id::text,
  'active',
  false
FROM auth.users u
WHERE (u.raw_app_meta_data ->> 'manually_subscribed') = 'true'
  AND NOT EXISTS (
    SELECT 1 FROM public.subscriptions s WHERE s.user_id = u.id
  );
