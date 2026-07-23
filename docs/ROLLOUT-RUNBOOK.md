# Rollout runbook (M10)

How to take the system from the dev project to a **pilot branch running in
production**, and then to a wider rollout. Work top to bottom; each section ends
with a check.

The dev project (`lvoqvkbydbkyyaxonzmp`) stays your staging environment. Production
gets its **own** Supabase project so a mistake in testing can never touch live
payroll data.

---

## 0. Prerequisites (accounts you need)

| Thing | Why | Cost |
|---|---|---|
| Supabase account (Pro recommended for prod) | Database, auth, storage, functions | Free tier works; Pro ≈ $25/mo adds daily backups + no auto-pause |
| Expo (EAS) account | Build the mobile app / kiosk APK | Free tier fine for internal builds |
| A static host (Vercel / Netlify / Cloudflare Pages) | Serve the dashboard | Free tier fine |
| Google Cloud project + service account | Payroll → Sheets (optional) | Free — see [SETUP-GOOGLE-SHEETS.md](SETUP-GOOGLE-SHEETS.md) |
| Apple Developer account | iOS build / TestFlight (deferred) | $99/yr — only if you want iOS; kiosks are Android |

Have the repo checked out with Node on PATH and `npx supabase@latest` working
(see [SETUP-SUPABASE.md](SETUP-SUPABASE.md)).

---

## 1. Stand up the production Supabase project

1. **Create the project** at <https://supabase.com/dashboard> → New project.
   - Region: `ap-southeast-1` (Singapore) or `ap-south-1` (Mumbai) — pick the
     closer one for the Philippines. Note the **project ref** (e.g. `abcd…`).
   - Set a strong DB password and store it in your password manager. This is a
     *new, separate* password from dev.
2. **Push all migrations** (they apply in order, exactly as on dev):
   ```bash
   npx supabase@latest db push \
     --db-url "postgresql://postgres.<PROD_REF>:<PROD_DB_PASSWORD>@aws-1-<region>.pooler.supabase.com:5432/postgres" \
     --yes
   ```
   (Use the **session pooler** host, as on dev — the direct host is IPv6-only.)
   A Docker warning about the migrations catalog cache is harmless; look for
   `Finished supabase db push`.
3. **Do NOT run `supabase/seed.sql`** against production — it contains dev test
   users. Instead, seed real data (below).
4. **Create the private `selfies` storage bucket** — the migrations create the
   storage RLS policies, but confirm the bucket exists (Storage → the migration
   creates it; if not, create a **private** bucket named `selfies`).

**Check:** `select count(*) from public.attendance_settings;` returns the seeded
company row after step 5.

---

## 2. Seed the real company + pilot branch

You need one company, the pilot branch with real GPS coordinates, and one
super_admin login. The cleanest path is the dashboard once it's deployed
(section 4), but you can bootstrap the first super_admin now:

1. In the Supabase dashboard → Authentication → Add user → create the owner's
   login (email + password, "Auto confirm").
2. SQL editor: insert the company, the branch (real `lat`/`lng`/`geofence_radius_m`,
   `shift_start`/`shift_end`/`work_days`), and the owner's `profiles` row with
   `role = 'super_admin'` pointing at that company. (Mirror the shape in
   `supabase/seed.sql`, but with real values and no test users.)
3. Set `attendance_settings` for the company (grace / OT / min-break) — the
   Settings page can edit these later.

**Check:** sign in to the dashboard as the owner and land on the Overview board.

---

## 3. Configure Edge Function secrets + deploy

The four functions (`admin-users`, `kiosk-punch`, `payroll-sync`,
`purge-selfies`) deploy to the prod project. `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

```bash
export SUPABASE_ACCESS_TOKEN=<your token from supabase.com → Account → Access Tokens>
npx supabase@latest functions deploy admin-users   --project-ref <PROD_REF>
npx supabase@latest functions deploy kiosk-punch    --project-ref <PROD_REF>
npx supabase@latest functions deploy payroll-sync   --project-ref <PROD_REF>
npx supabase@latest functions deploy purge-selfies  --project-ref <PROD_REF> --no-verify-jwt
```

`purge-selfies` **must** be deployed with `--no-verify-jwt`. The pg_cron job
calls it via pg_net with only the `x-purge-secret` header — no `Authorization`
— so with JWT verification on, the platform rejects every cron call
(`401 UNAUTHORIZED_NO_AUTH_HEADER`) before the function's own secret check ever
runs: selfies are never purged and storage grows unbounded. The shared
`PURGE_SECRET` is the real auth (the function itself returns 401 without it).
The other three functions keep JWT verification.

**Selfie retention (7-day auto-delete).** The `selfie_retention` migration
schedules a daily pg_cron job that calls `purge-selfies`. Wire its secret (once):

```bash
supabase secrets set PURGE_SECRET=<random-strong-secret> --project-ref <PROD_REF>
```
then in the SQL editor set the Vault entries the cron reads (URL + same secret):
```sql
select vault.create_secret('https://<PROD_REF>.supabase.co/functions/v1/purge-selfies', 'purge_selfies_url');
select vault.create_secret('<same-random-strong-secret>', 'purge_selfies_secret');
```
Until these are set the job no-ops safely. Selfies are already compressed to
~40–80 KB on capture; with 7-day purge, storage stays ≈ 84 MB for 100 staff.

For payroll → Sheets, set the Google secrets per
[SETUP-GOOGLE-SHEETS.md](SETUP-GOOGLE-SHEETS.md) (otherwise payroll-sync stays in
safe dry-run).

**Check:** `curl -s -X POST https://<PROD_REF>.supabase.co/functions/v1/admin-users -H "Authorization: Bearer <prod anon key>" -H "apikey: <prod anon key>" -d '{}'`
returns `{"ok":false,"error":"not authenticated"}` (alive, not 404).

**Check (purge-selfies):** simulate the cron call — secret header only, no
`Authorization` — and probe that the secret is still required:

```bash
# cron simulation → 200 {"ok":true,...}. A platform 401 here means the function
# was deployed with JWT verification on — redeploy with --no-verify-jwt.
curl -s -X POST https://<PROD_REF>.supabase.co/functions/v1/purge-selfies \
  -H "x-purge-secret: <PURGE_SECRET>" -H "Content-Type: application/json" -d '{}'
# negative probe (no secret) → 401 {"ok":false,"error":"unauthorized"}
curl -s -X POST https://<PROD_REF>.supabase.co/functions/v1/purge-selfies -d '{}'
```

---

## 4. Deploy the dashboard (Vercel)

`vercel.json` (repo root) already sets the monorepo build (install at root, build
the dashboard workspace → `apps/dashboard/dist`) and the SPA rewrite, so the
build needs no manual config.

1. At <https://vercel.com> → Add New → Project → import the GitHub repo
   (`fermosaattendance-dev/fermosa-attendance`). Leave **Root Directory = repo root**
   (vercel.json drives the build); Framework preset = Other.
2. Project → Settings → Environment Variables → add for **Production**:
   ```
   VITE_SUPABASE_URL=https://<PROD_REF>.supabase.co
   VITE_SUPABASE_ANON_KEY=<prod anon key>
   ```
   (The anon key is safe to expose — RLS protects the data; the DB password and
   service-role key are never used here.)
3. Deploy. Every push to `main` auto-deploys (pairs with the post-commit
   auto-push). You get an HTTPS URL like `https://fermosa-attendance.vercel.app`
   — HTTPS is required for the camera/GPS on web clock-in.

**Check:** open the deployed URL, sign in as the owner, all pages load; on a
phone the camera starts on clock-in.

---

## 5. Enroll admin 2FA

2FA is optional but recommended for every admin (hr / operations / super_admin):

1. Each admin: Settings → **Two-factor authentication** → Set up 2FA → scan the
   QR with an authenticator app → enter the code → Enable.
2. From then on, that admin enters a 6-digit code at sign-in. Their privileged
   Edge Function calls (create/reset user, payroll sync) require the stepped-up
   session.
3. **Lost device:** a super_admin can clear another admin's 2FA on the employee's
   edit page → **Reset 2FA**.

> **Break-glass — last super_admin locked out.** If the only super_admin loses
> their 2FA device, clear it directly with the service role (Supabase SQL editor):
> ```sql
> delete from auth.mfa_factors
>  where user_id = (select id from auth.users where email = '<owner email>');
> ```
> They can then sign in with just their password and re-enroll. Guard access to
> the SQL editor accordingly.

**Check:** sign out and back in as an enrolled admin — the code prompt appears
and accepts a valid code.

---

## 6. Build + distribute the mobile app

See [BUILD-MOBILE.md](BUILD-MOBILE.md) for the exact commands. Summary:

- **Kiosk tablets (Android APK):** `eas build --profile preview --platform android`
  → download the APK → sideload on each tablet (see
  [KIOSK-PROVISIONING.md](KIOSK-PROVISIONING.md)).
- **Staff phones (personal mode):** distribute the same APK internally, or ship
  an AAB to Google Play (`--profile production`) for a managed rollout.
- **iOS:** deferred until an Apple Developer account exists; `eas.json` already
  has the identifiers configured.

Point the app at production by setting the prod Supabase URL/anon key in
`apps/mobile` env before building.

**Check:** install the APK on a test phone, sign in as a real employee, clock in
inside the branch geofence, see the punch land in the dashboard `/punches`.

---

## 7. Go-live checklist (pilot branch)

- [ ] Prod project created; **all** migrations pushed; **no** dev seed applied.
- [ ] Real company + pilot branch (correct GPS, radius, shift) + super_admin exist.
- [ ] `attendance_settings` set; PH holidays added for the current year.
- [ ] Three Edge Functions deployed to prod; alive-check passes.
- [ ] Dashboard deployed with prod env; owner can sign in.
- [ ] Admin accounts created for pilot HR/managers; 2FA enrolled.
- [ ] Kiosk tablet provisioned + registered to the branch; test PIN punch works.
- [ ] Staff phones have the app; one real clock-in/out verified end-to-end.
- [ ] A full day dry-run: punches → review/approve → report export → payroll-sync
      dry-run preview matches.
- [ ] pg_cron nightly sweep confirmed active: `select * from cron.job;`
- [ ] Backups: on Supabase **Pro**, daily backups are on; otherwise schedule a
      manual `pg_dump` before payroll cutoffs.

---

## 8. Monitoring & operations

- **Edge Function logs:** Supabase dashboard → Edge Functions → Logs (watch for
  401/403/500 during the first week).
- **Punch health:** `/punches` shows out-of-geofence and late-synced flags.
- **Audit log:** dashboard → **Audit log** — review privileged actions (account
  changes, corrections, 2FA events) weekly.
- **Payroll cutover:** approve the period on `/reviews`, export on `/reports`,
  then run payroll-sync (dry-run first, then live).

---

## 9. Rollback

- **Bad migration:** migrations are forward-only. Restore from the most recent
  Supabase backup (Pro) or your pre-cutoff `pg_dump`. Never hand-edit payroll
  numbers in prod — correct via the dashboard so it's audited.
- **Bad dashboard deploy:** redeploy the previous build (or use the host's
  instant rollback).
- **Bad mobile build:** the previous APK keeps working; distribute it again.
  Punches are offline-queued, so a brief app outage doesn't lose attendance.
- **Widen rollout only after** the pilot branch runs a clean full pay period.
