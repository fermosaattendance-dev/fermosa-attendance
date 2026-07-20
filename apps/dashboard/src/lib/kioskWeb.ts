import type { PunchType } from '@fermosa/shared';
import { supabaseAnonKey, supabaseUrl } from './supabase';

/**
 * Web kiosk mode: this browser is a shared branch terminal. The registration
 * key lives only on this device (localStorage); every punch is verified
 * server-side by the kiosk-punch Edge Function (device key + employee PIN).
 * The browser equivalent of apps/mobile/src/lib/kiosk.tsx.
 */

export interface KioskConfig {
  device_id: string;
  device_key: string;
  branch_id: string;
  branch_name: string;
  device_name: string;
}

const KIOSK_KEY = 'fermosa.kiosk.config';

export function readKioskConfig(): KioskConfig | null {
  try {
    const raw = localStorage.getItem(KIOSK_KEY);
    return raw ? (JSON.parse(raw) as KioskConfig) : null;
  } catch {
    return null;
  }
}

export function writeKioskConfig(config: KioskConfig): void {
  localStorage.setItem(KIOSK_KEY, JSON.stringify(config));
}

export function clearKioskConfig(): void {
  localStorage.removeItem(KIOSK_KEY);
}

export interface KioskPunchResult {
  ok: boolean;
  error?: string;
  employee_name?: string;
  duplicate?: boolean;
  inside_geofence?: boolean | null;
  distance_m?: number | null;
}

/**
 * Punch through the kiosk Edge Function. Requires connectivity (no offline
 * queue — a shared terminal is online-only). Uses the anon key only, never a
 * personal session, and reads the JSON body on any status so a bad code/PIN or
 * lockout surfaces its message. Mirrors the mobile kioskPunch.
 */
export async function kioskPunch(args: {
  kiosk: KioskConfig;
  employeeCode: string;
  pin: string;
  type: PunchType;
  clientUuid: string;
  selfieB64: string | null;
  lat: number | null;
  lng: number | null;
  gpsAccuracyM: number | null;
}): Promise<KioskPunchResult> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/kiosk-punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({
        device_id: args.kiosk.device_id,
        device_key: args.kiosk.device_key,
        employee_code: args.employeeCode,
        pin: args.pin,
        type: args.type,
        client_uuid: args.clientUuid,
        happened_at: new Date().toISOString(),
        selfie_base64: args.selfieB64,
        lat: args.lat,
        lng: args.lng,
        gps_accuracy_m: args.gpsAccuracyM,
      }),
    });
    return (await res.json()) as KioskPunchResult;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
}
