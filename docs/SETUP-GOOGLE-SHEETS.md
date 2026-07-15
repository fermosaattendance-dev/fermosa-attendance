# Payroll → Google Sheets sync (M9)

The `payroll-sync` Edge Function pushes a pay period's **approved** payroll
summary to a Google Sheet — one tab per period, overwritten on re-sync.

Until the Google credentials below are set, the function runs in **dry-run** mode:
it computes the exact dataset and returns a preview (and logs a `dry_run` row in
`public.payroll_syncs`) but does **not** write to any sheet. The dashboard's
"Sync period" button works in dry-run immediately; wire the credentials when
you're ready for the real push.

## One-time Google setup (~15 min)

1. **Google Cloud project** — go to <https://console.cloud.google.com>, create a
   project (or reuse the Fermosa AI one).
2. **Enable the Sheets API** — APIs & Services → Library → search "Google Sheets
   API" → Enable.
3. **Create a service account** — IAM & Admin → Service Accounts → Create. Give
   it any name (e.g. `payroll-sync`). No project roles are needed.
4. **Create a JSON key** — open the service account → Keys → Add key → JSON.
   A file downloads. Keep it private; it is git-ignored
   (`**/google-service-account*.json`) and must **never** be committed.
   From it you need two values: `client_email` and `private_key`.
5. **Create the payroll spreadsheet** in Google Sheets and copy its ID from the
   URL: `https://docs.google.com/spreadsheets/d/`**`<SHEET_ID>`**`/edit`.
6. **Share the sheet** with the service account's `client_email` as an **Editor**
   (the service account can only touch sheets shared with it).

## Set the Edge Function secrets

Never paste these into the repo. Set them on the project (re-paste your Supabase
access token when prompted, as with other function deploys):

```bash
npx supabase@latest secrets set \
  PAYROLL_SHEET_ID="<SHEET_ID>" \
  GOOGLE_SA_EMAIL="<client_email>" \
  GOOGLE_SA_PRIVATE_KEY="<private_key>" \
  --project-ref lvoqvkbydbkyyaxonzmp
```

The `private_key` contains newlines. If your shell mangles them, keep the
literal `\n` escape sequences from the JSON file — the function converts `\n`
back to real newlines before importing the key.

## Deploy

```bash
npx supabase@latest functions deploy payroll-sync --project-ref lvoqvkbydbkyyaxonzmp
```

(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically by the platform.)

## Verify

1. Dashboard → Reports → Payroll summary → **Sync period** (dry-run toggle on):
   returns the period tab name + row count + preview; a `dry_run` row appears in
   the recent-syncs list.
2. Turn the dry-run toggle off and sync again: the rows land in the period tab
   (e.g. `2026-07 (1–15)`). Re-syncing the same period overwrites that tab — no
   duplicate rows. The log row shows `synced`.
