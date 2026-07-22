import {
  PUNCH_LABELS,
  SELFIE_PUNCH_TYPES,
  branchShifts,
  checkGeofence,
  isLeaveEligible,
  nextAllowedPunchTypes,
  workStatusFromLastPunch,
  type PunchType,
} from '@fermosa/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CutoffSummary } from '../components/CutoffSummary';
import { InAppBrowserBanner } from '../components/InAppBrowserBanner';
import { PageHeader } from '../components/PageHeader';
import { WebcamCapture } from '../components/WebcamCapture';
import { useAuth } from '../lib/auth';
import { detectInAppBrowser } from '../lib/inAppBrowser';
import { readRovingBranch, writeRovingBranch } from '../lib/rovingBranch';
import { supabase } from '../lib/supabase';
import {
  getRequiredLocation,
  hydrateFromServer,
  recordPunch,
  syncPending,
  type GpsFix,
  type LocationFailure,
  type RequiredLocation,
} from '../lib/webPunch';
import { pendingCount, punchesSince, type LocalPunch, type LocalSyncStatus } from '../lib/webPunchDb';

interface BranchInfo {
  id: string;
  name: string;
  lat: number;
  lng: number;
  geofence_radius_m: number;
  shift_start: string;
  shift_end: string;
  shift2_start: string | null;
  shift2_end: string | null;
  shift3_start: string | null;
  shift3_end: string | null;
}

const STATUS_STYLE = {
  clocked_out: 'bg-gray-100 text-gray-600',
  working: 'bg-green-100 text-green-700',
  on_break: 'bg-amber-100 text-amber-700',
} as const;

const STATUS_LABEL = {
  clocked_out: 'Timed out',
  working: 'Working',
  on_break: 'On break',
} as const;

const LOCATION_HELP: Record<LocationFailure, string> = {
  denied:
    "Allow location for this site (tap the lock or settings icon in your browser's address bar → Location → Allow), then try again.",
  unavailable:
    'Couldn’t get your location — turn on Location on your device, move near a window, and try again.',
  timeout:
    'Couldn’t get your location — turn on Location on your device, move near a window, and try again.',
  insecure:
    'Open the app over its secure (https) address to use location.',
};

const SYNC_BADGE: Record<LocalSyncStatus, { label: string; cls: string }> = {
  pending_sync: { label: '📱 Pending sync', cls: 'bg-amber-100 text-amber-700' },
  syncing: { label: '⏳ Syncing…', cls: 'bg-sky-100 text-sky-700' },
  synced: { label: '✅ Synced', cls: 'bg-green-100 text-green-700' },
  failed: { label: '⚠️ Will retry', cls: 'bg-red-100 text-red-600' },
};

const clockFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});
const dateFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});
const punchTimeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});
const hireDateFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
// Manila calendar day as ISO 'YYYY-MM-DD' — used to compare against a birthday.
const manilaYmdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });

/** Rolling window (not the calendar day) so an overnight shift keeps its state across midnight. */
function recentWindowStartIso(hours = 18): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

// Company-wide switch (attendance_settings.self_punch_enabled): when off, staff
// punch only on the branch kiosk and the Time In/Out buttons are hidden here.
// Cached so the decision holds on first paint and offline; default true.
const SELF_PUNCH_KEY = 'fermosa.self_punch_enabled';
function readSelfPunchCached(): boolean {
  return localStorage.getItem(SELF_PUNCH_KEY) !== 'false';
}

// Company-wide switch (attendance_settings.break_punch_enabled): when on, the
// Start Break / End Break buttons appear here; when off, staff only Time In/Out
// and the engine auto-deducts the minimum break on long days. Cached so the
// decision holds on first paint and offline; default false (breaks hidden).
const BREAK_PUNCH_KEY = 'fermosa.break_punch_enabled';
function readBreakPunchCached(): boolean {
  return localStorage.getItem(BREAK_PUNCH_KEY) === 'true';
}

/**
 * Employee self-service time clock — the browser equivalent of the mobile home
 * screen. Offline-first: status + recent list come from the local IndexedDB
 * queue, punches always save locally and sync in the background.
 */
export function TimeClock() {
  const { profile, session } = useAuth();
  const [now, setNow] = useState(() => new Date());
  const [branch, setBranch] = useState<BranchInfo | null>(null);
  const [punches, setPunches] = useState<LocalPunch[]>([]);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selfieFor, setSelfieFor] = useState<PunchType | null>(null);
  // Required GPS: the fix is acquired in parallel with the selfie; a punch is
  // blocked (with guidance) when no fix can be obtained.
  const [locationBlocked, setLocationBlocked] = useState<LocationFailure | null>(null);
  const locationReq = useRef<Promise<RequiredLocation> | null>(null);
  const pendingPunch = useRef<{ type: PunchType; selfieB64: string | null } | null>(null);
  const geoPerm = useRef<PermissionState | null>(null);
  // Roving employees (no home branch) pick which branch they're at.
  const [branchOptions, setBranchOptions] = useState<{ id: string; name: string }[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  // Two-shift branch: the employee picks which shift they're timing in for.
  const [selectedShift, setSelectedShift] = useState<{ start: string; end: string } | null>(null);
  // Company-wide self-punch switch (kiosk-only mode hides the buttons here).
  const [selfPunchEnabled, setSelfPunchEnabled] = useState<boolean>(() => readSelfPunchCached());
  // Company-wide break-punch switch (when on, Start Break / End Break show).
  const [breakPunchEnabled, setBreakPunchEnabled] = useState<boolean>(() => readBreakPunchCached());

  const isRoving = !!profile && profile.branch_id === null;
  const effectiveBranchId = profile?.branch_id ?? selectedBranchId;

  // Birthday greeting — pops once per day when today (Manila) matches the birthday.
  const [showBirthday, setShowBirthday] = useState(false);
  useEffect(() => {
    if (!profile?.birthday) return;
    const todayYmd = manilaYmdFmt.format(new Date());
    if (profile.birthday.slice(5) !== todayYmd.slice(5)) return; // compare MM-DD
    if (localStorage.getItem(`fermosa.bday_seen.${profile.id}`) === todayYmd) return;
    setShowBirthday(true);
  }, [profile?.id, profile?.birthday]);
  const dismissBirthday = () => {
    if (profile) localStorage.setItem(`fermosa.bday_seen.${profile.id}`, manilaYmdFmt.format(new Date()));
    setShowBirthday(false);
  };

  // Live clock.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Online/offline banner state.
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  // Reload the list + pending badge from the local queue (works offline).
  const refreshLocal = useCallback(async () => {
    if (!profile) return;
    setPunches(await punchesSince(profile.id, recentWindowStartIso()));
    setPending(await pendingCount(profile.id));
  }, [profile]);

  // Full refresh: pull server punches in, push queued ones out, then re-read.
  const refresh = useCallback(async () => {
    if (!profile) return;
    if (navigator.onLine) {
      await hydrateFromServer(profile, recentWindowStartIso()).catch(() => {});
      await syncPending(profile).catch(() => {});
    }
    await refreshLocal();
  }, [profile, refreshLocal]);

  // Sync triggers, mirroring mobile: mount, back-online, tab focus.
  useEffect(() => {
    void refresh();
    const run = () => void refresh();
    const onVis = () => {
      if (!document.hidden) run();
    };
    window.addEventListener('online', run);
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('online', run);
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh]);

  // While anything is queued, retry every 30 s.
  useEffect(() => {
    if (pending === 0) return;
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [pending, refresh]);

  // Surface the browser's location permission prompt when the clock opens (not
  // mid-punch), and track the permission state. One-shot request; GPS releases
  // itself after the fix.
  useEffect(() => {
    if (!profile || !navigator.geolocation) return;
    const prime = () =>
      navigator.geolocation.getCurrentPosition(() => {}, () => {}, {
        enableHighAccuracy: false,
        timeout: 20_000,
        maximumAge: 5 * 60_000,
      });
    if (navigator.permissions?.query) {
      navigator.permissions
        .query({ name: 'geolocation' })
        .then((s) => {
          geoPerm.current = s.state;
          s.onchange = () => {
            geoPerm.current = s.state;
          };
          if (s.state === 'prompt') prime();
        })
        .catch(prime);
    } else {
      prime();
    }
  }, [profile]);

  // Roving: restore the remembered branch choice (renders even offline).
  useEffect(() => {
    if (!profile || profile.branch_id !== null) return;
    const remembered = readRovingBranch(profile.id);
    if (remembered) {
      setSelectedBranchId(remembered.id);
      setBranchOptions((opts) => (opts.length ? opts : [remembered]));
    }
  }, [profile]);

  // Roving: load the active branch list to pick from (any company member may
  // read branches under RLS). A remembered branch that was deactivated is cleared.
  useEffect(() => {
    if (!isRoving || !profile || !navigator.onLine) return;
    supabase
      .from('branches')
      .select('id, name')
      .eq('is_active', true)
      .order('name')
      .then(({ data }) => {
        const opts = (data as { id: string; name: string }[] | null) ?? [];
        if (!opts.length) return;
        setBranchOptions(opts);
        setSelectedBranchId((sel) => {
          if (sel && !opts.some((o) => o.id === sel)) {
            writeRovingBranch(profile.id, null);
            return null;
          }
          return sel;
        });
      });
  }, [isRoving, profile]);

  const pickBranch = (id: string | null) => {
    if (!profile) return;
    setSelectedBranchId(id);
    if (id) {
      const opt = branchOptions.find((o) => o.id === id);
      writeRovingBranch(profile.id, opt ? { id: opt.id, name: opt.name } : null);
    } else {
      writeRovingBranch(profile.id, null);
    }
  };

  // Branch coordinates for the instant geofence hint (server stays authoritative).
  useEffect(() => {
    if (!effectiveBranchId) {
      setBranch(null);
      return;
    }
    if (!navigator.onLine) return;
    supabase
      .from('branches')
      .select('id, name, lat, lng, geofence_radius_m, shift_start, shift_end, shift2_start, shift2_end, shift3_start, shift3_end')
      .eq('id', effectiveBranchId)
      .maybeSingle()
      .then(({ data }) => setBranch((data as BranchInfo | null) ?? null));
  }, [effectiveBranchId]);

  // Read the company-wide self-punch switch (any member may read
  // attendance_settings under RLS). Cache it so it holds offline.
  useEffect(() => {
    if (!profile || !navigator.onLine) return;
    supabase
      .from('attendance_settings')
      .select('self_punch_enabled, break_punch_enabled')
      .maybeSingle()
      .then(({ data }) => {
        const row = data as { self_punch_enabled?: boolean; break_punch_enabled?: boolean } | null;
        const selfOn = row?.self_punch_enabled ?? true;
        setSelfPunchEnabled(selfOn);
        localStorage.setItem(SELF_PUNCH_KEY, selfOn ? 'true' : 'false');
        const breakOn = row?.break_punch_enabled ?? false;
        setBreakPunchEnabled(breakOn);
        localStorage.setItem(BREAK_PUNCH_KEY, breakOn ? 'true' : 'false');
      });
  }, [profile]);

  // Multi-shift branch (2 or 3 shifts): the employee picks which shift they're
  // timing in for, remembered per day so time-out doesn't re-ask.
  const shiftOptions = branch ? branchShifts(branch) : [];
  const branchHasMultipleShifts = shiftOptions.length > 1;
  const manilaToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(now);
  const shiftKey = profile ? `fermosa.shift.${profile.id}.${manilaToday}` : null;
  useEffect(() => {
    if (!branchHasMultipleShifts || !shiftKey) {
      setSelectedShift(null);
      return;
    }
    try {
      const raw = localStorage.getItem(shiftKey);
      const s = raw ? (JSON.parse(raw) as { start?: string; end?: string }) : null;
      if (s?.start && s?.end) setSelectedShift({ start: s.start, end: s.end });
    } catch {
      /* ignore */
    }
  }, [branchHasMultipleShifts, shiftKey]);
  const pickShift = (opt: { start: string; end: string }) => {
    setSelectedShift(opt);
    if (shiftKey) localStorage.setItem(shiftKey, JSON.stringify(opt));
  };

  const lastType: PunchType | null = punches.at(-1)?.type ?? null;
  const workStatus = workStatusFromLastPunch(lastType);
  // Breaks are a company-wide toggle (attendance_settings.break_punch_enabled).
  // When off, staff only Time In/Out and the engine deducts the minimum break
  // automatically on days over 5 h.
  const allowed: PunchType[] = breakPunchEnabled
    ? nextAllowedPunchTypes(lastType)
    : workStatus === 'clocked_out'
      ? ['clock_in']
      : ['clock_out'];

  const doPunch = useCallback(
    async (type: PunchType, selfieB64: string | null) => {
      if (!profile) return;
      const branchId = profile.branch_id ?? selectedBranchId;
      if (!branchId) {
        setError('Pick the branch you are working at first.');
        return;
      }
      // A branch with a Shift 2 (and optionally Shift 3) runs multiple shifts —
      // the employee must pick which one they're timing in for.
      const multiShift = !!branch?.shift2_start;
      const shift = multiShift ? selectedShift : null;
      if (multiShift && !shift) {
        setError('Pick which shift you are timing in for first.');
        return;
      }
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        // Time in/out require a GPS fix — the read started when the button was
        // tapped and usually resolved while the selfie was taken.
        let requiredGps: { gps?: GpsFix } = {};
        if (SELFIE_PUNCH_TYPES.includes(type)) {
          const req = locationReq.current ?? getRequiredLocation();
          locationReq.current = null;
          setNote('📍 Getting your location…');
          const res = await req;
          setNote(null);
          if (!res.ok) {
            pendingPunch.current = { type, selfieB64 };
            setLocationBlocked(res.error);
            setBusy(false);
            return;
          }
          requiredGps = { gps: res.fix };
        }
        const { gps } = await recordPunch({ profile, branchId, type, selfieB64, ...requiredGps, shift });
        if (!navigator.onLine) {
          setNote(
            `${PUNCH_LABELS[type]} saved on this device — it will sync automatically when you're back online.`,
          );
        } else if (gps && branch) {
          const f = checkGeofence(gps.lat, gps.lng, branch.lat, branch.lng, branch.geofence_radius_m);
          setNote(
            f.inside
              ? `${PUNCH_LABELS[type]} recorded · inside ${branch.name} (${Math.round(f.distanceM)} m from center)`
              : `${PUNCH_LABELS[type]} recorded · ${Math.round(f.distanceM)} m from ${branch.name} — outside geofence, HR will review`,
          );
        } else {
          setNote(`${PUNCH_LABELS[type]} recorded · no GPS fix, HR will review location`);
        }
        await refreshLocal();
        // Give the fire-and-forget sync a moment, then refresh the badges.
        window.setTimeout(() => void refreshLocal(), 2500);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Punch failed — please try again.');
      }
      setBusy(false);
    },
    [profile, branch, selectedBranchId, selectedShift, refreshLocal],
  );

  const onAction = (type: PunchType) => {
    if (busy) return;
    // Clock in/out require a selfie AND a GPS fix. The location read starts
    // now so it resolves while the selfie is taken; if the browser already
    // reports location as blocked, skip the camera and show the guidance.
    if (SELFIE_PUNCH_TYPES.includes(type)) {
      if (geoPerm.current === 'denied') {
        pendingPunch.current = { type, selfieB64: null };
        setLocationBlocked('denied');
        return;
      }
      locationReq.current = getRequiredLocation();
      setSelfieFor(type);
    } else {
      void doPunch(type, null);
    }
  };

  // Try again on the location-blocked card: re-read location; a selfie taken
  // before the block is kept, otherwise the camera opens after.
  const retryLocation = () => {
    const pending = pendingPunch.current;
    pendingPunch.current = null;
    setLocationBlocked(null);
    if (!pending) return;
    locationReq.current = getRequiredLocation();
    if (pending.selfieB64) void doPunch(pending.type, pending.selfieB64);
    else setSelfieFor(pending.type);
  };

  const cancelLocation = () => {
    pendingPunch.current = null;
    locationReq.current = null;
    setLocationBlocked(null);
  };

  const timeLabel = useMemo(() => clockFmt.format(now), [now]);
  const dateLabel = useMemo(() => dateFmt.format(now), [now]);

  if (!profile) return null;

  // Kiosk-only mode hides the punch UI, but ONLY for the plain employee role —
  // managers / HR / ops / super-admin keep timing in on their own account.
  const showPunch = selfPunchEnabled || profile.role !== 'employee';

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="My time clock" crumb="My time clock" subtitle={branch?.name} />

      <InAppBrowserBanner />

      {!online && (
        <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
          📡 You're offline — punches are saved on this device and will sync when you reconnect.
        </p>
      )}

      {online && !session && pending > 0 && (
        <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
          You're back online —{' '}
          <Link to="/login" className="underline">
            sign in again
          </Link>{' '}
          to send your saved punches.
        </p>
      )}

      <div className="card flex flex-col items-center py-8">
        <div className="text-5xl font-bold tabular-nums text-ink">{timeLabel}</div>
        <div className="mt-1 text-sm text-muted">{dateLabel}</div>
        <span className={`pill mt-4 ${STATUS_STYLE[workStatus]}`}>{STATUS_LABEL[workStatus]}</span>
        {profile.date_hired && (
          <p className="mt-3 text-xs text-muted">Hired {hireDateFmt.format(new Date(profile.date_hired))}</p>
        )}
      </div>

      {showPunch && isRoving && (
        <div className="card mt-4 px-4 py-4">
          <label className="text-sm">
            <span className="block text-xs font-medium text-gray-500">Which branch are you at today?</span>
            <select
              value={selectedBranchId ?? ''}
              onChange={(e) => pickBranch(e.target.value || null)}
              className="mt-1 input w-full"
            >
              <option value="">— select a branch —</option>
              {branchOptions.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          {!selectedBranchId && (
            <p className="mt-2 text-xs text-amber-700">
              Pick the branch you're working at to enable Time in / Time out.
            </p>
          )}
        </div>
      )}

      {showPunch && branchHasMultipleShifts && (
        <div className="card mt-4 px-4 py-4">
          <span className="block text-xs font-medium text-gray-500">
            Which shift are you timing in for today?
          </span>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {shiftOptions.map((s) => {
              const active = selectedShift?.start === s.start && selectedShift?.end === s.end;
              return (
                <button
                  key={`${s.start}-${s.end}`}
                  onClick={() => pickShift({ start: s.start, end: s.end })}
                  className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                    active
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-line bg-white text-ink hover:bg-ground'
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          {!selectedShift && (
            <p className="mt-2 text-xs text-amber-700">
              Pick your shift so late is measured against the right start time.
            </p>
          )}
        </div>
      )}

      {showPunch ? (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {allowed.map((type) => (
            <button
              key={type}
              onClick={() => onAction(type)}
              disabled={busy || (isRoving && !selectedBranchId) || (branchHasMultipleShifts && !selectedShift)}
              className={`rounded-2xl py-5 text-lg font-bold text-white transition disabled:opacity-50 ${
                type === 'clock_in'
                  ? 'bg-green-600 hover:bg-green-700'
                  : type === 'clock_out'
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-amber-600 hover:bg-amber-700'
              }`}
            >
              {busy ? '…' : PUNCH_LABELS[type]}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-4 rounded-xl bg-ground px-4 py-3 text-center text-sm text-muted">
          ⏱ Time in and out are done at the branch kiosk.
        </p>
      )}

      {note && <p className="mt-4 rounded-xl bg-ground px-4 py-3 text-sm text-ink">{note}</p>}
      {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}

      {pending > 0 && (
        <div className="mt-4 flex items-center justify-between rounded-xl bg-sky-50 px-4 py-3">
          <span className="text-sm text-sky-800">
            {pending} punch{pending > 1 ? 'es' : ''} waiting to sync
          </span>
          <button onClick={() => void refresh()} disabled={!online} className="btn text-sm disabled:opacity-50">
            Sync now
          </button>
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        {isLeaveEligible(profile.employment_status) && (
          <Link to="/my/leave" className="btn">
            Leave &amp; balances
          </Link>
        )}
        <Link to="/my/payslip" className="btn">
          My payslip
        </Link>
        <Link to="/my/password" className="btn">
          Change password
        </Link>
        <Link to="/my/pin" className="btn">
          Kiosk PIN
        </Link>
      </div>

      <CutoffSummary profile={profile} />

      <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted">Recent punches</h3>
      <div className="mt-2 space-y-2">
        {punches.length === 0 && <p className="text-sm text-muted">No recent punches.</p>}
        {[...punches].reverse().map((p) => (
          <div key={p.client_uuid} className="card flex items-center justify-between px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-ink">{PUNCH_LABELS[p.type]}</div>
              <div className="text-xs text-muted">{punchTimeFmt.format(new Date(p.happened_at))}</div>
            </div>
            <div className="flex items-center gap-2">
              {p.sync_status === 'synced' && p.inside_geofence !== null && (
                <span className="text-xs text-muted">
                  {p.inside_geofence ? '📍 In branch' : `📍 ${Math.round(p.distance_m ?? 0)} m away`}
                </span>
              )}
              <span className={`pill text-xs ${SYNC_BADGE[p.sync_status].cls}`}>
                {SYNC_BADGE[p.sync_status].label}
              </span>
            </div>
          </div>
        ))}
      </div>

      {selfieFor && (
        <WebcamCapture
          title={`${PUNCH_LABELS[selfieFor]} — look at the camera`}
          onCapture={(b64) => {
            const t = selfieFor;
            setSelfieFor(null);
            void doPunch(t, b64);
          }}
          onCancel={() => {
            locationReq.current = null;
            setSelfieFor(null);
          }}
        />
      )}

      {locationBlocked && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-6">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center">
            <p className="text-sm font-semibold text-ink">Your location is required to time in</p>
            <p className="mt-2 text-sm text-muted">
              {detectInAppBrowser()
                ? `You’re in the ${detectInAppBrowser()} browser, which can’t share your location. Open this page in Chrome — tap the ⋮ menu at the top-right → “Open in Chrome” (or “Open in browser”) — then log in and time in there.`
                : LOCATION_HELP[locationBlocked]}
            </p>
            <button onClick={retryLocation} className="btn-primary mt-4 w-full">
              Try again
            </button>
            <button onClick={cancelLocation} className="btn mt-2 w-full">
              Cancel
            </button>
          </div>
        </div>
      )}

      {showBirthday && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-6">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center">
            <div className="text-5xl">🎂</div>
            <p className="mt-3 text-lg font-bold text-ink">
              Happy Birthday, {profile.full_name.split(' ')[0]}! 🎉
            </p>
            <p className="mt-2 text-sm text-muted">
              Wishing you a wonderful year ahead from the whole Fermosa team.
              {isLeaveEligible(profile.employment_status)
                ? ' Enjoy your day — don’t forget your birthday leave this month 🎁'
                : ' Enjoy your day! 🎁'}
            </p>
            <button onClick={dismissBirthday} className="btn-primary mt-4 w-full">
              Thanks! 🎉
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
