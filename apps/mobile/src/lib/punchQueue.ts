import type { PunchType } from '@fermosa/shared';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import {
  insertPunch,
  markFailed,
  markSynced,
  markSyncing,
  setSelfieUploaded,
  unsyncedPunches,
  type LocalPunch,
} from './db';
import { supabase } from './supabase';

const GPS_TIMEOUT_MS = 6000;

export interface GpsFix {
  lat: number;
  lng: number;
  accuracy: number | null;
}

export type LocationFailure = 'denied' | 'unavailable';
export type RequiredLocation =
  | { ok: true; fix: GpsFix }
  | { ok: false; error: LocationFailure };

/**
 * Required GPS for time in/out: permission must be granted and a fix obtained,
 * otherwise the punch is blocked with guidance. Longer window than the
 * best-effort path, plus a fresh last-known fallback. One-shot read — GPS
 * releases itself after the fix.
 */
export async function getRequiredLocation(): Promise<RequiredLocation> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return { ok: false, error: 'denied' };

    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
    ]);
    if (fix) {
      return {
        ok: true,
        fix: { lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy: fix.coords.accuracy },
      };
    }
    const last = await Location.getLastKnownPositionAsync({ maxAge: 2 * 60 * 1000 });
    if (last) {
      return {
        ok: true,
        fix: { lat: last.coords.latitude, lng: last.coords.longitude, accuracy: last.coords.accuracy },
      };
    }
    return { ok: false, error: 'unavailable' };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

/** Best-effort GPS: a punch must NEVER fail or hang because of location. */
export async function tryGetLocation(): Promise<GpsFix | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;

    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), GPS_TIMEOUT_MS)),
    ]);
    if (fix) {
      return { lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy: fix.coords.accuracy };
    }
    // Timed out — fall back to the OS's last known position if it's fresh-ish.
    const last = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60 * 1000 });
    if (last) {
      return { lat: last.coords.latitude, lng: last.coords.longitude, accuracy: last.coords.accuracy };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Record a punch: write to local SQLite immediately, then kick off a sync.
 * The selfie (base64 jpeg, already compressed) rides along and is uploaded
 * during sync — a punch never fails because of the camera.
 */
export async function recordPunch(
  type: PunchType,
  branchId: string | null,
  selfieB64: string | null = null,
  /** Pre-acquired fix (required-GPS flow). When omitted, best-effort lookup. */
  gpsArg?: GpsFix | null,
): Promise<{
  clientUuid: string;
  gps: GpsFix | null;
}> {
  const clientUuid = Crypto.randomUUID();
  const gps = gpsArg !== undefined ? gpsArg : await tryGetLocation();

  insertPunch({
    client_uuid: clientUuid,
    type,
    happened_at: new Date().toISOString(),
    branch_id: branchId,
    lat: gps?.lat ?? null,
    lng: gps?.lng ?? null,
    gps_accuracy_m: gps?.accuracy ?? null,
    device_info: JSON.stringify({
      model: Device.modelName,
      os: Device.osName,
      os_version: Device.osVersion,
    }),
    selfie_b64: selfieB64,
  });

  // Fire-and-forget: the punch is already safe on disk.
  void syncPending();

  return { clientUuid, gps };
}

let syncInFlight = false;
let uploadPrefix: string | null = null; // "{company_id}/{user_id}", cached per session

async function getUploadPrefix(): Promise<string | null> {
  if (uploadPrefix) return uploadPrefix;
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  const { data: profile } = await supabase
    .from('profiles')
    .select('company_id')
    .eq('id', data.user.id)
    .maybeSingle();
  if (!profile) return null;
  uploadPrefix = `${profile.company_id}/${data.user.id}`;
  return uploadPrefix;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Upload all pending/failed punches. Idempotent server-side via client_uuid. */
export async function syncPending(): Promise<{ synced: number; failed: number }> {
  if (syncInFlight) return { synced: 0, failed: 0 };
  syncInFlight = true;
  let synced = 0;
  let failed = 0;
  try {
    const rows: LocalPunch[] = unsyncedPunches();
    for (const row of rows) {
      markSyncing(row.client_uuid);

      // Selfie first: upload once, then reference it from the punch row.
      let selfiePath = row.selfie_path;
      if (!selfiePath && row.selfie_b64) {
        const prefix = await getUploadPrefix();
        if (prefix) {
          const path = `${prefix}/${row.client_uuid}.jpg`;
          const { error: upErr } = await supabase.storage
            .from('selfies')
            .upload(path, base64ToBytes(row.selfie_b64).buffer as ArrayBuffer, {
              contentType: 'image/jpeg',
              upsert: true,
            });
          if (upErr) {
            markFailed(row.client_uuid, `selfie upload: ${upErr.message}`);
            failed++;
            continue; // retry the whole punch later
          }
          setSelfieUploaded(row.client_uuid, path);
          selfiePath = path;
        }
      }

      const { data, error } = await supabase.rpc('ingest_punch', {
        p_client_uuid: row.client_uuid,
        p_type: row.type,
        p_happened_at: row.happened_at,
        p_branch_id: row.branch_id,
        p_lat: row.lat,
        p_lng: row.lng,
        p_gps_accuracy_m: row.gps_accuracy_m,
        p_source: 'mobile',
        p_device_info: row.device_info ? JSON.parse(row.device_info) : null,
        p_selfie_path: selfiePath,
      });
      if (error) {
        markFailed(row.client_uuid, error.message);
        failed++;
      } else {
        const result = data as { inside_geofence?: boolean | null; distance_m?: number | null };
        markSynced(row.client_uuid, {
          inside_geofence: result?.inside_geofence ?? null,
          distance_m: result?.distance_m ?? null,
        });
        synced++;
      }
    }
  } finally {
    syncInFlight = false;
  }
  return { synced, failed };
}
