-- Selfie retention — delete attendance selfies older than 30 days to cap storage.
--
-- Physical deletion must go through the storage API, so a daily pg_cron job
-- calls the `purge-selfies` Edge Function via pg_net. The function URL and the
-- shared secret are read from Supabase Vault at run time, so NO secret lives in
-- this committed migration. Set them at deploy (see the deploy note below).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Daily at 19:30 UTC = 03:30 Asia/Manila (off-peak, after the 02:00 sweep).
-- cron.schedule upserts by name, so re-running this migration is safe.
--
-- DEPLOY (run once against the prod project; values are NOT committed):
--   select vault.create_secret(
--     'https://<PROD_REF>.supabase.co/functions/v1/purge-selfies', 'purge_selfies_url');
--   select vault.create_secret('<random-strong-secret>', 'purge_selfies_secret');
--   -- and: supabase secrets set PURGE_SECRET=<same-random-strong-secret>
--   -- and: deploy purge-selfies with --no-verify-jwt — this call sends no
--   -- Authorization header, so with JWT verification on the platform 401s
--   -- every cron run before the x-purge-secret check (selfies never purged).
select cron.schedule(
  'purge-selfies-daily',
  '30 19 * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'purge_selfies_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-purge-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'purge_selfies_secret')
    ),
    body := '{}'::jsonb
  )
  where exists (select 1 from vault.decrypted_secrets where name = 'purge_selfies_url');
  $cron$
);
