# Database backup & restore

Automated daily snapshots of the production database, plus a one-click
pre-payroll backup, stored in a private Supabase Storage bucket — with an
independent copy kept on GitHub.

## What it does

- **`scripts/backup/backup.mjs`** exports every business table + the auth account
  roster to one JSON snapshot and uploads it to the private **`backups`** bucket
  at `‹label›/‹date›.json`. It creates the bucket on first run and prunes daily
  snapshots older than `RETENTION_DAYS` (default `0` = **keep forever**; set a
  positive number of days to auto-delete older snapshots).
- **`.github/workflows/backup.yml`** runs it **twice daily — 12:00 noon and
  11:00 PM Manila** (kept as separate `‹date›-noon.json` / `‹date›-night.json`
  files, so both recovery points survive) — and on the **"Run workflow"** button
  (a fresh, timestamped snapshot — use it before every payroll cutoff). Each run
  also uploads the snapshot as a GitHub **artifact** (90-day retention) — a copy
  that lives off Supabase.
- **`scripts/backup/restore.mjs`** loads a snapshot back into a project.

## What's captured (and what isn't)

**Captured — fully recoverable:** all punches (`attendance_events`), payroll days
+ HR corrections (`attendance_records`), salaries (`employee_compensation`),
leave, balances, staff profiles, branches, settings, holidays, audit logs, and
the auth **account roster** (id/email/phone/timestamps).

**Not captured (by design):**
- **Login passwords** — Supabase never exposes password hashes. Restoring from a
  snapshot alone means each user needs a password reset. To also back up
  passwords, use **Supabase Pro's** native daily backup.
- **Selfie images** — separate storage, auto-purged. The punch record is saved;
  the photo isn't.

## One-time setup

Add two repo secrets in **GitHub → Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the project's **service role** key (Supabase → Project Settings → API) |

The service role key bypasses RLS — it only ever lives in GitHub secrets and is
never committed. If you rotate it, update this secret.

Then open **Actions → Database backup → Run workflow** once to confirm a green run
(the snapshot appears in the `backups` bucket and as a run artifact). The daily
schedule then runs unattended.

## Run a backup manually (before payroll)

GitHub → **Actions → Database backup → Run workflow**. Produces a timestamped
`‹label›/manual-‹time›.json` so it never overwrites the daily snapshot.

Locally (from the repo root):

```bash
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
BACKUP_KIND=manual \
node scripts/backup/backup.mjs
```

## Restore

Writes are gated — without `--yes` the script only previews.

```bash
# See available snapshots
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/backup/restore.mjs --list --label=fermosa

# Surgical recovery — someone deleted a day of punches/payroll in a LIVE project.
# Parents (profiles, branches) still exist, so restore just those tables:
… node scripts/backup/restore.mjs --object=fermosa/2026-07-18-night.json \
    --tables=attendance_records,attendance_events --yes

# Full preview (all tables), then apply:
… node scripts/backup/restore.mjs --object=fermosa/2026-07-18-night.json          # dry-run
… node scripts/backup/restore.mjs --object=fermosa/2026-07-18-night.json --yes    # writes
```

Snapshot filenames: scheduled runs are `‹date›-noon.json` / `‹date›-night.json`;
manual runs are `manual-‹date›T‹time›.json`. Use `--list` to see what's there.

- The **target** project is whatever `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
  point at — set them to a fresh project for a disaster restore.
- Every table **upserts on its primary key** (safe to re-run) except
  `audit_logs`, whose id is auto-generated, so it inserts fresh (may duplicate on
  re-run — restore it only in a clean disaster recovery).
- **Disaster recovery into an empty project:** recreate the login accounts first
  (or restore from Supabase Pro's native backup, which includes passwords) —
  `profiles` reference `auth.users`, which this script does not recreate.

## Honest limitations

- **On-platform vault.** The `backups` bucket lives in Supabase, so it protects
  against data-level incidents (deletion, corruption, a bad change) but not a
  total Supabase-account loss. The GitHub artifact copy covers that for free; for
  a stronger off-site vault, add a second upload target (Google Drive / Cloudflare
  R2) to `backup.mjs` — the export step is unchanged.
- **Recovery is to the last snapshot's time.** Daily + a manual backup right
  before payroll keeps the worst-case loss small.

## Scaling to multiple businesses

The script backs up **one project per run** (env-driven), so when you run several
separate projects, either:

- convert the workflow's `backup` job to a **matrix** over businesses — each with
  its own `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` secret pair and a distinct
  `BACKUP_LABEL` — or
- store one JSON secret listing the projects and loop over it.

No code change to `backup.mjs` / `restore.mjs` is needed; each business's
snapshots land under its own `‹label›/` folder.
