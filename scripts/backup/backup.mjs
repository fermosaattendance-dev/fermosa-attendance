// Automated database backup — exports every business table + the auth account
// roster to a single JSON snapshot and uploads it to a private Supabase Storage
// bucket. Runs one project per invocation (env-driven), so the same script backs
// up a single company today and any number of separate projects later (a GitHub
// Actions matrix calls it once per business).
//
// Captures ALL business data (recoverable). Does NOT capture login passwords
// (Supabase never exposes password hashes — restore needs a password reset, or
// use Supabase Pro's native backup) or selfie images (separate storage,
// auto-purged). See docs/BACKUP-RESTORE.md.
//
// Env:
//   SUPABASE_URL               (required)
//   SUPABASE_SERVICE_ROLE_KEY  (required — bypasses RLS; never ship in the app)
//   BACKUP_LABEL   business slug / folder name        (default 'fermosa')
//   BACKUP_BUCKET  private storage bucket              (default 'backups')
//   BACKUP_KIND    'daily' | 'manual'                  (default 'daily')
//   BACKUP_SLOT    'noon' | 'night' | ''  (daily runs) (default '')
//   RETENTION_DAYS delete snapshots older than this many days; 0 = keep forever
//                                                       (default 0 = forever)
//   BACKUP_OUT_DIR local dir for the artifact copy     (default 'backup-out')
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TABLES } from './tables.mjs';

const URL = requireEnv('SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const LABEL = (process.env.BACKUP_LABEL || 'fermosa').trim();
const BUCKET = (process.env.BACKUP_BUCKET || 'backups').trim();
const KIND = process.env.BACKUP_KIND === 'manual' ? 'manual' : 'daily';
const SLOT = (process.env.BACKUP_SLOT || '').trim();
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 0); // 0 = keep forever
const OUT_DIR = process.env.BACKUP_OUT_DIR || 'backup-out';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env ${name}`);
    process.exit(2);
  }
  return v;
}

const db = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

async function ensureBucket() {
  const { error } = await db.storage.createBucket(BUCKET, { public: false });
  if (error && !/exist|duplicate|already/i.test(error.message)) {
    throw new Error(`createBucket(${BUCKET}): ${error.message}`);
  }
}

async function dumpTable(t) {
  const rows = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await db.from(t).select('*').range(from, from + PAGE - 1);
    if (error) throw new Error(`select ${t}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function dumpAuthUsers() {
  const users = [];
  let page = 1;
  for (;;) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    // Password hashes are NOT exposed by the API — roster only.
    users.push(
      ...data.users.map((u) => ({
        id: u.id,
        email: u.email,
        phone: u.phone,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
      })),
    );
    if (data.users.length < 1000) break;
    page += 1;
  }
  return users;
}

// Delete snapshots older than RETENTION_DAYS. RETENTION_DAYS = 0 keeps every
// backup forever (default). Matches every naming pattern (YYYY-MM-DD.json,
// YYYY-MM-DD-noon/night.json, manual-YYYY-MM-DD...json) by the date in the name.
async function prune() {
  if (!RETENTION_DAYS || RETENTION_DAYS <= 0) return; // keep forever
  const { data, error } = await db.storage.from(BUCKET).list(LABEL, { limit: 1000 });
  if (error) return; // non-fatal — never fail a backup over cleanup
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const stale = (data ?? [])
    .map((o) => o.name)
    .filter((n) => {
      const m = n.match(/(\d{4}-\d{2}-\d{2})/);
      return m && Date.parse(m[1]) < cutoff;
    })
    .map((n) => `${LABEL}/${n}`);
  if (stale.length) await db.storage.from(BUCKET).remove(stale);
}

function humanBytes(bytes) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  await ensureBucket();

  const snapshot = { _meta: {}, tables: {}, auth_users: [] };
  const counts = {};
  for (const t of TABLES) {
    const rows = await dumpTable(t);
    snapshot.tables[t] = rows;
    counts[t] = rows.length;
  }
  snapshot.auth_users = await dumpAuthUsers();
  counts['auth_users (accounts, no passwords)'] = snapshot.auth_users.length;

  const now = new Date();
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const min = now.toISOString().slice(0, 16).replace(/[:]/g, '-'); // YYYY-MM-DDTHH-MM
  // manual -> timestamped; daily with a slot (noon/night) -> one file per slot,
  // so both daily snapshots are kept; daily without a slot -> one file per day.
  const objectName =
    KIND === 'manual'
      ? `${LABEL}/manual-${min}.json`
      : SLOT
        ? `${LABEL}/${day}-${SLOT}.json`
        : `${LABEL}/${day}.json`;

  snapshot._meta = {
    taken_at: now.toISOString(),
    label: LABEL,
    kind: KIND,
    slot: SLOT || null,
    project_url: URL,
    object: `${BUCKET}/${objectName}`,
    note: 'data-only snapshot; schema is in git (supabase/migrations); passwords + selfies not included',
    row_counts: counts,
  };

  const body = JSON.stringify(snapshot, null, 2);

  // Upload to the private bucket (the vault).
  const { error: upErr } = await db.storage
    .from(BUCKET)
    .upload(objectName, body, { contentType: 'application/json', upsert: true });
  if (upErr) throw new Error(`upload ${objectName}: ${upErr.message}`);

  // Local copy for the CI artifact (off-Supabase second copy).
  mkdirSync(OUT_DIR, { recursive: true });
  const localPath = join(OUT_DIR, objectName.replace(/\//g, '__'));
  writeFileSync(localPath, body, 'utf8');

  await prune();

  const bytes = statSync(localPath).size;
  console.log('BACKUP OK');
  console.log(`  vault:  ${BUCKET}/${objectName}`);
  console.log(`  local:  ${localPath}`);
  console.log(`  size:   ${humanBytes(bytes)} (${bytes} bytes)`);
  console.log('  rows:');
  for (const [t, n] of Object.entries(counts)) console.log(`    ${String(n).padStart(7)}  ${t}`);
}

main().catch((e) => {
  console.error(`BACKUP FAILED: ${e.message}`);
  process.exit(1);
});
