# Pull the latest shared code from the Fermosa repo into this clone, then
# re-apply this business's branding on top. Use after a fix lands in Fermosa.
#   pwsh scripts\sync-from-fermosa.ps1 [-Src "D:\Attedance apps"]
# Preserves this clone's .env, brand logos, PWA icons, filled CSVs, and
# scripts/brand.tokens.psd1. Review 'git diff' before committing — commit
# auto-deploys (Vercel).
param([string]$Src = 'D:\Attedance apps')
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $Src)) { throw "Fermosa source not found: $Src" }
if ((Resolve-Path -LiteralPath $Src).Path -eq (Resolve-Path -LiteralPath $Root).Path) {
  throw 'This is the Fermosa source repo itself - run the sync from inside a clone.'
}
Write-Host "Syncing shared code from $Src ..."

function Sync-Dir($rel, $extraXF) {
  $s = Join-Path $Src $rel
  $d = Join-Path $Root $rel
  if (-not (Test-Path -LiteralPath $s)) { Write-Warning "source missing: $rel"; return }
  $xf = @('*.tsbuildinfo') + $extraXF
  robocopy $s $d /E /XD node_modules /XF $xf /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $rel ($LASTEXITCODE)" }
}

# Keep this clone's env, brand art, PWA icons, and any filled staff CSVs.
Sync-Dir 'apps'                  @('.env','logo-mark.jpg','logo-wordmark.jpg','fermosa-mark.jpg','fermosa-wordmark.jpg','pwa-192.png','pwa-512.png')
Sync-Dir 'packages'             @()
Sync-Dir 'supabase\migrations'  @()
Sync-Dir 'supabase\functions'   @()
Sync-Dir 'scripts\backup'       @()
Sync-Dir 'scripts\bulk-import'  @('branches.csv','employees.csv','holidays.csv','credentials.csv')

# Refresh the rebrand script itself so upstream clone-kit fixes (new entries in
# its $files list) reach this clone. brand.tokens.psd1 is never copied.
# This script is not auto-copied (it is the one running) — if it changed
# upstream, diff it against the Fermosa copy and update by hand.
Copy-Item (Join-Path $Src 'scripts\rebrand.ps1') (Join-Path $PSScriptRoot 'rebrand.ps1') -Force

# Re-apply branding + regenerate all-migrations.sql
& (Join-Path $PSScriptRoot 'rebrand.ps1')
Write-Host "Sync complete. Review 'git diff', then commit & push to deploy."
