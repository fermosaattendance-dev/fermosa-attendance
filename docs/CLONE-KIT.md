# Clone kit — stand up a branded clone

Each business (GATP, Suteki, Newbliss, …) runs an independent clone of this
codebase: its own repo, Supabase project, and Vercel app — no shared runtime
infra. The kit in `scripts/` rewrites the Fermosa brand strings:

- `scripts/rebrand.ps1` — master copy; rewrites brand strings in a fixed file
  list and regenerates `supabase/all-migrations.sql`. Refuses to run here
  (no `brand.tokens.psd1` in the source repo).
- `scripts/brand.tokens.example.psd1` — template for the clone's tokens.
- `scripts/sync-from-fermosa.ps1` — run *inside a clone* to pull later Fermosa
  fixes and re-apply branding.

## New clone

1. Copy the working tree to `D:\Attendance <Name>` (drop `.git` and
   `node_modules`), then `git init` a fresh repo under the business's own
   GitHub account.
2. `copy scripts\brand.tokens.example.psd1 scripts\brand.tokens.psd1` and fill
   in the values.
3. `pwsh scripts\rebrand.ps1` — review with `git diff`, then commit.
4. Replace the brand art in `apps/dashboard/public/`: `logo-mark.jpg`,
   `logo-wordmark.jpg`, `pwa-192.png`, `pwa-512.png`.
5. Follow [ROLLOUT-RUNBOOK.md](ROLLOUT-RUNBOOK.md) against the clone's own
   Supabase + Vercel accounts. Mind the `purge-selfies --no-verify-jwt` note.

## Pulling upstream fixes into an existing clone

Inside the clone: `pwsh scripts\sync-from-fermosa.ps1`. It copies the shared
code (apps, packages, migrations, functions, backup + bulk-import scripts),
refreshes the clone's `rebrand.ps1` from this repo, re-runs the rebrand, and
preserves the clone's `.env`, tokens, brand art, and filled CSVs. Review
`git diff` before committing. If a synced Edge Function changed, redeploy it to
the clone's Supabase project (again: `purge-selfies` with `--no-verify-jwt`).

Clones created before this kit landed carry their own older
`rebrand.ps1`/`sync-from-fermosa.ps1`: at their next sync, overwrite both with
the copies from this repo (keep the clone's `brand.tokens.psd1`) before running.

## Keeping the kit correct

Any new file that hard-codes a brand string — the display name,
`fermosa.local`, the bundle id — **must** be added to `$files` in
`scripts/rebrand.ps1`. A missed file ships Fermosa branding to every clone:
omitting `supabase/functions/admin-users/index.ts` is how every clone's
deployed function minted `<username>@fermosa.local` logins while the clone's
login page appended its own domain, so accounts created by bare username could
never sign in.
