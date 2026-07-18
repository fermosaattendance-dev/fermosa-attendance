import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PunchType } from '@fermosa/shared';

/**
 * Local punch queue (IndexedDB). Every punch is written here FIRST — even when
 * online — and a sync worker uploads rows to Supabase. The clock UI reads from
 * this store, so clock-in works with no signal and syncs on reconnect. This is
 * the browser twin of the mobile SQLite queue (apps/mobile/src/lib/db.ts).
 */

export type LocalSyncStatus = 'pending_sync' | 'syncing' | 'synced' | 'failed';

export interface LocalPunch {
  client_uuid: string;
  employee_id: string; // owner — shared devices can hold several users' queues
  type: PunchType;
  happened_at: string; // ISO, device time — the official punch time
  branch_id: string | null;
  shift_start: string | null; // shift picked at time-in (null = branch Shift 1)
  shift_end: string | null;
  lat: number | null;
  lng: number | null;
  gps_accuracy_m: number | null;
  device_info: string | null; // JSON string
  sync_status: LocalSyncStatus;
  attempts: number;
  last_error: string | null;
  inside_geofence: boolean | null; // server verdict after sync
  distance_m: number | null;
  selfie_b64: string | null; // compressed jpeg awaiting upload; cleared once uploaded
  selfie_path: string | null; // storage path after upload
}

interface PunchDb extends DBSchema {
  punches: {
    key: string; // client_uuid
    value: LocalPunch;
    indexes: { by_happened: string };
  };
}

let dbp: Promise<IDBPDatabase<PunchDb>> | null = null;
function db(): Promise<IDBPDatabase<PunchDb>> {
  if (!dbp) {
    dbp = openDB<PunchDb>('fermosa-attendance', 1, {
      upgrade(d) {
        const store = d.createObjectStore('punches', { keyPath: 'client_uuid' });
        store.createIndex('by_happened', 'happened_at');
      },
    });
  }
  return dbp;
}

export async function insertPunch(p: {
  client_uuid: string;
  employee_id: string;
  type: PunchType;
  happened_at: string;
  branch_id: string | null;
  shift_start?: string | null;
  shift_end?: string | null;
  lat: number | null;
  lng: number | null;
  gps_accuracy_m: number | null;
  device_info: string | null;
  selfie_b64: string | null;
}): Promise<void> {
  const d = await db();
  await d.put('punches', {
    ...p,
    shift_start: p.shift_start ?? null,
    shift_end: p.shift_end ?? null,
    sync_status: 'pending_sync',
    attempts: 0,
    last_error: null,
    inside_geofence: null,
    distance_m: null,
    selfie_path: null,
  });
}

/** This employee's punches at or after the ISO cutoff, oldest first (rolling window for clock state). */
export async function punchesSince(employeeId: string, iso: string): Promise<LocalPunch[]> {
  const d = await db();
  const all = await d.getAllFromIndex('punches', 'by_happened');
  return all.filter((p) => p.employee_id === employeeId && p.happened_at >= iso);
}

/**
 * This employee's rows still needing upload. Only the punch owner's session can
 * sync them (ingest_punch records auth.uid()), so other users' queued punches
 * wait until that person signs back in. Includes 'syncing' so a row stranded by
 * a closed tab mid-sync self-heals (uploads are idempotent via client_uuid).
 */
export async function unsyncedPunches(employeeId: string): Promise<LocalPunch[]> {
  const d = await db();
  const all = await d.getAllFromIndex('punches', 'by_happened');
  return all.filter((p) => p.employee_id === employeeId && p.sync_status !== 'synced');
}

export async function pendingCount(employeeId: string): Promise<number> {
  const d = await db();
  const all = await d.getAll('punches');
  return all.filter((p) => p.employee_id === employeeId && p.sync_status !== 'synced').length;
}

async function patch(clientUuid: string, changes: Partial<LocalPunch>): Promise<void> {
  const d = await db();
  const row = await d.get('punches', clientUuid);
  if (!row) return;
  await d.put('punches', { ...row, ...changes });
}

export const markSyncing = (u: string) => patch(u, { sync_status: 'syncing' });

export const markSynced = (
  u: string,
  server: { inside_geofence: boolean | null; distance_m: number | null },
) => patch(u, { sync_status: 'synced', last_error: null, ...server });

export async function markFailed(u: string, error: string): Promise<void> {
  const d = await db();
  const row = await d.get('punches', u);
  if (!row) return;
  await d.put('punches', {
    ...row,
    sync_status: 'failed',
    attempts: row.attempts + 1,
    last_error: error.slice(0, 300),
  });
}

/** Selfie uploaded: remember the storage path, drop the heavy base64 payload. */
export const setSelfieUploaded = (u: string, path: string) =>
  patch(u, { selfie_path: path, selfie_b64: null });

/**
 * Merge a server punch into the local store as already-synced (hydration on
 * load), so the clock's status/recent list stay correct across sessions and
 * devices (e.g. a kiosk punch shows on web). Never clobbers a locally-pending
 * row — that one still needs to upload.
 */
export async function upsertSynced(p: {
  client_uuid: string;
  employee_id: string;
  type: PunchType;
  happened_at: string;
  branch_id: string | null;
  inside_geofence: boolean | null;
  distance_m: number | null;
  selfie_path: string | null;
}): Promise<void> {
  const d = await db();
  const existing = await d.get('punches', p.client_uuid);
  if (existing && existing.sync_status !== 'synced') return;
  await d.put('punches', {
    client_uuid: p.client_uuid,
    employee_id: p.employee_id,
    type: p.type,
    happened_at: p.happened_at,
    branch_id: p.branch_id,
    shift_start: null,
    shift_end: null,
    lat: null,
    lng: null,
    gps_accuracy_m: null,
    device_info: null,
    sync_status: 'synced',
    attempts: 0,
    last_error: null,
    inside_geofence: p.inside_geofence,
    distance_m: p.distance_m,
    selfie_b64: null,
    selfie_path: p.selfie_path,
  });
}
