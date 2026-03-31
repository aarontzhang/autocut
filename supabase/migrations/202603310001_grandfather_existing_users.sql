-- Grandfather all existing users by setting manually_subscribed = true
-- This ensures current users (who have already paid) retain editor access
-- without needing a Stripe subscription record.
UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data || '{"manually_subscribed": true}'::jsonb
WHERE raw_app_meta_data IS NOT NULL
  AND (raw_app_meta_data ->> 'manually_subscribed') IS DISTINCT FROM 'true';
