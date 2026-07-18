import type { Profile, PunchType } from '@fermosa/shared';
import { readRovingBranch } from './rovingBranch';
import { supabase } from './supabase';
import {
  insertPunch,
  markFailed,
  markSynced,
  markSyncing,
  setSelfieUploaded,
  unsyncedPunches,
  upsertSynced,
} from './webPunchDb';

export interface GpsFix {
  lat: number;
  lng: number;
  accuracy: number | null;
}

const GPS_TIMEOUT_MS = 6000;

/** UUID that also works in insecure contexts (crypto.randomUUID needs HTTPS/localhost). */
function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

/** Best-effort GPS: a punch must never hang or fail because of location. Works offline (device hardware). */
export async function tryGetLocation(): Promise<GpsFix | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation || !window.isSecureContext) {
    return null;
  }
  return new Promise<GpsFix | null>((resolve) => {
    let settled = false;
    const done = (v: GpsFix | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => done(null), GPS_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        done({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null });
      },
      () => {
        clearTimeout(timer);
        done(null);
      },
      { enableHighAccuracy: false, timeout: GPS_TIMEOUT_MS, maximumAge: 5 * 60 * 1000 },
    );
  });
}

export type LocationFailure = 'denied' | 'unavailable' | 'timeout' | 'insecure';
export type RequiredLocation =
  | { ok: true; fix: GpsFix }
  | { ok: false; error: LocationFailure };

/**
 * Required GPS for time in/out: unlike tryGetLocation there is no artificial
 * race — the browser's permission prompt can take as long as it needs (the
 * API's own timeout only counts once permission is resolved). Still a one-shot
 * read: the GPS engages for this fix only and releases by itself.
 */
export async function getRequiredLocation(): Promise<RequiredLocation> {
  if (typeof navigator === 'undefined' || !navigator.geolocation || !window.isSecureContext) {
    return { ok: false, error: 'insecure' };
  }
  return new Promise<RequiredLocation>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          ok: true,
          fix: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null },
        }),
      (err) =>
        resolve({ ok: false, error: err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 25_000, maximumAge: 60_000 },
    );
  });
}

function base64ToBlob(b64: string, type = 'image/jpeg'): Blob {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type });
}

/**
 * Record a punch: write to the local IndexedDB queue immediately (with GPS +
 * selfie), then kick off a sync. Never blocks or fails when offline — the punch
 * is safe on disk and uploads on reconnect. Returns the GPS fix for an instant
 * client-side geofence hint (the server recomputes the authoritative verdict).
 */
export async function recordPunch(args: {
  profile: Profile;
  branchId: string | null;
  type: PunchType;
  selfieB64: string | null;
  /** Pre-acquired fix (required-GPS flow). When omitted, best-effort lookup. */
  gps?: GpsFix | null;
  /** Shift picked at time-in for a 2-shift branch (null = branch Shift 1). */
  shift?: { start: string; end: string } | null;
}): Promise<{ gps: GpsFix | null }> {
  const clientUuid = uuid();
  const gps = args.gps !== undefined ? args.gps : await tryGetLocation();
  await insertPunch({
    client_uuid: clientUuid,
    employee_id: args.profile.id,
    type: args.type,
    happened_at: new Date().toISOString(),
    branch_id: args.branchId,
    shift_start: args.shift?.start ?? null,
    shift_end: args.shift?.end ?? null,
    lat: gps?.lat ?? null,
    lng: gps?.lng ?? null,
    gps_accuracy_m: gps?.accuracy ?? null,
    device_info: JSON.stringify({ web: true, ua: navigator.userAgent }),
    selfie_b64: args.selfieB64,
  });
  void syncPending(args.profile);
  return { gps };
}

let syncInFlight = false;

/** Upload all pending/failed punches. Idempotent server-side via client_uuid. Skips when offline. */
export async function syncPending(profile: Profile): Promise<{ synced: number; failed: number }> {
  if (syncInFlight || !navigator.onLine) return { synced: 0, failed: 0 };
  syncInFlight = true;
  let synced = 0;
  let failed = 0;
  try {
    const rows = await unsyncedPunches(profile.id);
    for (const row of rows) {
      await markSyncing(row.client_uuid);

      // Selfie first: upload once, then reference it from the punch.
      let selfiePath = row.selfie_path;
      if (!selfiePath && row.selfie_b64) {
        const path = `${profile.company_id}/${profile.id}/${row.client_uuid}.jpg`;
        const { error: upErr } = await supabase.storage
          .from('selfies')
          .upload(path, base64ToBlob(row.selfie_b64), { contentType: 'image/jpeg', upsert: true });
        if (upErr) {
          await markFailed(row.client_uuid, `selfie upload: ${upErr.message}`);
          failed++;
          continue; // retry the whole punch later
        }
        await setSelfieUploaded(row.client_uuid, path);
        selfiePath = path;
      }

      // A roving employee (no home branch) may have queued a branchless punch
      // on a stale app bundle; the server rejects those, so backfill their
      // remembered branch selection.
      const branchId =
        row.branch_id ?? (profile.branch_id ? null : (readRovingBranch(profile.id)?.id ?? null));

      const { data, error } = await supabase.rpc('ingest_punch', {
        p_client_uuid: row.client_uuid,
        p_type: row.type,
        p_happened_at: row.happened_at,
        p_branch_id: branchId,
        p_lat: row.lat,
        p_lng: row.lng,
        p_gps_accuracy_m: row.gps_accuracy_m,
        p_source: 'web',
        p_device_info: row.device_info ? JSON.parse(row.device_info) : null,
        p_selfie_path: selfiePath,
        p_shift_start: row.shift_start ?? null,
        p_shift_end: row.shift_end ?? null,
      });
      if (error) {
        await markFailed(row.client_uuid, error.message);
        failed++;
      } else {
        const r = data as { inside_geofence?: boolean | null; distance_m?: number | null };
        await markSynced(row.client_uuid, {
          inside_geofence: r?.inside_geofence ?? null,
          distance_m: r?.distance_m ?? null,
        });
        synced++;
      }
    }
  } finally {
    syncInFlight = false;
  }
  return { synced, failed };
}

interface ServerPunchRow {
  client_uuid: string;
  type: PunchType;
  happened_at: string;
  branch_id: string | null;
  inside_geofence: boolean | null;
  distance_from_branch_m: number | null;
  selfie_path: string | null;
}

/**
 * Pull the employee's recent server punches into the local store (as synced),
 * so the clock's status + recent list stay correct across sessions and devices
 * (e.g. a punch made on the kiosk shows here). No-op offline.
 */
export async function hydrateFromServer(profile: Profile, sinceIso: string): Promise<void> {
  if (!navigator.onLine) return;
  const { data } = await supabase
    .from('attendance_events')
    .select('client_uuid, type, happened_at, branch_id, inside_geofence, distance_from_branch_m, selfie_path')
    .eq('employee_id', profile.id)
    .gte('happened_at', sinceIso)
    .order('happened_at', { ascending: true });
  for (const e of (data as ServerPunchRow[] | null) ?? []) {
    await upsertSynced({
      client_uuid: e.client_uuid,
      employee_id: profile.id,
      type: e.type,
      happened_at: e.happened_at,
      branch_id: e.branch_id,
      inside_geofence: e.inside_geofence,
      distance_m: e.distance_from_branch_m,
      selfie_path: e.selfie_path,
    });
  }
}
