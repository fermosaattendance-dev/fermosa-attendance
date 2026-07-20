import {
  COMPANY_WIDE_ROLES,
  PUNCH_LABELS,
  usernameToEmail,
  type PunchType,
  type Role,
} from '@fermosa/shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WebcamCapture } from '../components/WebcamCapture';
import {
  clearKioskConfig,
  kioskPunch,
  readKioskConfig,
  type KioskConfig,
} from '../lib/kioskWeb';
import { supabase } from '../lib/supabase';
import { getRequiredLocation, uuid, type GpsFix, type LocationFailure } from '../lib/webPunch';

const LOCATION_HELP: Record<LocationFailure, string> = {
  denied:
    "Allow location for this site (tap the lock or settings icon in the browser's address bar → Location → Allow), then try again.",
  unavailable:
    'Couldn’t get a location — turn on Location on this device, move near a window, and try again.',
  timeout:
    'Couldn’t get a location — turn on Location on this device, move near a window, and try again.',
  insecure: 'Open the kiosk over its secure (https) address to use location.',
};

type Step =
  | { name: 'idle' }
  | { name: 'credentials'; type: PunchType }
  | { name: 'locating'; code: string; pin: string; type: PunchType }
  | { name: 'blocked'; code: string; pin: string; type: PunchType; error: LocationFailure }
  | { name: 'selfie'; code: string; pin: string; type: PunchType; gps: GpsFix }
  | { name: 'submitting' }
  | { name: 'result'; ok: boolean; message: string }
  | { name: 'exit' };

/**
 * Web kiosk terminal — a shared branch device where staff punch with an
 * employee code + PIN + selfie, no personal login. Standalone full-screen page
 * at /kiosk (outside the authenticated Layout). GPS is required, matching the
 * personal web clock. Browser port of apps/mobile/src/app/kiosk.tsx.
 */
export function KioskMode() {
  const navigate = useNavigate();
  const [kiosk] = useState<KioskConfig | null>(() => readKioskConfig());
  const [step, setStep] = useState<Step>({ name: 'idle' });
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [exitId, setExitId] = useState('');
  const [exitPassword, setExitPassword] = useState('');
  const [exitError, setExitError] = useState<string | null>(null);
  const [exitBusy, setExitBusy] = useState(false);

  // A kiosk terminal never keeps a personal session.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) void supabase.auth.signOut();
    });
  }, []);

  const beginPunch = (type: PunchType) => {
    setCode('');
    setPin('');
    setStep({ name: 'credentials', type });
  };

  const goLocate = async (c: string, p: string, type: PunchType) => {
    setStep({ name: 'locating', code: c, pin: p, type });
    const res = await getRequiredLocation();
    if (!res.ok) {
      setStep({ name: 'blocked', code: c, pin: p, type, error: res.error });
      return;
    }
    setStep({ name: 'selfie', code: c, pin: p, type, gps: res.fix });
  };

  const submit = async (c: string, p: string, type: PunchType, gps: GpsFix, selfieB64: string) => {
    setStep({ name: 'submitting' });
    const result = await kioskPunch({
      kiosk: kiosk!,
      employeeCode: c,
      pin: p,
      type,
      clientUuid: uuid(),
      selfieB64,
      lat: gps.lat,
      lng: gps.lng,
      gpsAccuracyM: gps.accuracy,
    });
    setCode('');
    setPin('');
    if (result.ok) {
      const fence =
        result.inside_geofence === false ? ' (outside branch geofence — HR will review)' : '';
      setStep({
        name: 'result',
        ok: true,
        message: `${result.employee_name}: ${PUNCH_LABELS[type]} recorded${fence}`,
      });
    } else {
      setStep({ name: 'result', ok: false, message: result.error ?? 'Punch failed — please try again' });
    }
    setTimeout(() => setStep({ name: 'idle' }), 3500);
  };

  const tryExit = async () => {
    setExitBusy(true);
    setExitError(null);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(exitId.trim()),
      password: exitPassword,
    });
    if (error || !data.user) {
      setExitBusy(false);
      setExitError(error?.message ?? 'Sign-in failed');
      return;
    }
    const { data: prof } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', data.user.id)
      .maybeSingle();
    setExitBusy(false);
    if (!prof || !COMPANY_WIDE_ROLES.includes(prof.role as Role)) {
      await supabase.auth.signOut();
      setExitError('Only HR, operations, or super admin can exit kiosk mode.');
      return;
    }
    clearKioskConfig();
    navigate('/'); // the admin stays signed in and lands on the dashboard
  };

  if (!kiosk) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-ground p-6">
        <div className="card max-w-sm p-6 text-center">
          <p className="text-sm font-semibold text-ink">This device isn't set up as a kiosk yet</p>
          <p className="mt-2 text-sm text-muted">
            An admin can set it up from the dashboard → Kiosks → “Set up this device as a kiosk”.
          </p>
          <button onClick={() => navigate('/login')} className="btn-primary mt-4 w-full">
            Admin sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-ground">
      {/* Gold brand header with branch + device name. */}
      <div className="fm-bar relative flex items-center justify-between px-5 py-4">
        <div className="fm-bar-shine pointer-events-none absolute inset-0" />
        <div className="relative flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-white shadow-[0_2px_6px_rgba(120,84,0,0.28)]">
            <img src="/fermosa-mark.jpg" alt="Fermosa" className="h-8 w-8 rounded-lg object-contain" />
          </span>
          <div className="relative leading-tight text-white">
            <div className="text-lg font-bold [text-shadow:0_1px_1px_rgba(140,96,0,0.35)]">
              {kiosk.branch_name}
            </div>
            <div className="text-[11px] text-white/90">{kiosk.device_name} · Attendance kiosk</div>
          </div>
        </div>
        <button
          onClick={() => {
            setExitId('');
            setExitPassword('');
            setExitError(null);
            setStep({ name: 'exit' });
          }}
          className="relative text-xs font-medium text-white/80 hover:text-white"
        >
          Exit
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-5 p-6">
        {step.name === 'idle' && (
          <>
            <p className="text-2xl font-bold text-ink">Tap to punch</p>
            <div className="grid w-full max-w-md grid-cols-1 gap-4 sm:grid-cols-2">
              <button
                onClick={() => beginPunch('clock_in')}
                className="rounded-2xl bg-green-600 py-10 text-2xl font-bold text-white transition hover:bg-green-700"
              >
                {PUNCH_LABELS['clock_in']}
              </button>
              <button
                onClick={() => beginPunch('clock_out')}
                className="rounded-2xl bg-red-600 py-10 text-2xl font-bold text-white transition hover:bg-red-700"
              >
                {PUNCH_LABELS['clock_out']}
              </button>
            </div>
          </>
        )}

        {step.name === 'credentials' && (
          <div className="card w-full max-w-sm space-y-3 p-6">
            <p className="text-center text-lg font-semibold text-ink">
              {PUNCH_LABELS[step.type]} — enter your details
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Employee code (e.g. FSC-0005)"
              autoCapitalize="characters"
              className="input w-full"
            />
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="PIN"
              inputMode="numeric"
              type="password"
              className="input w-full"
            />
            <button
              onClick={() => void goLocate(code.trim(), pin, step.type)}
              disabled={!code.trim() || pin.length < 4}
              className="btn-primary w-full disabled:opacity-50"
            >
              Next
            </button>
            <button onClick={() => setStep({ name: 'idle' })} className="btn w-full">
              Cancel
            </button>
          </div>
        )}

        {step.name === 'locating' && (
          <div className="card w-full max-w-sm p-8 text-center">
            <p className="text-sm text-muted">📍 Getting your location…</p>
          </div>
        )}

        {step.name === 'blocked' && (
          <div className="card w-full max-w-sm p-6 text-center">
            <p className="text-sm font-semibold text-ink">Location is required to punch</p>
            <p className="mt-2 text-sm text-muted">{LOCATION_HELP[step.error]}</p>
            <button
              onClick={() => void goLocate(step.code, step.pin, step.type)}
              className="btn-primary mt-4 w-full"
            >
              Try again
            </button>
            <button onClick={() => setStep({ name: 'idle' })} className="btn mt-2 w-full">
              Cancel
            </button>
          </div>
        )}

        {step.name === 'submitting' && (
          <div className="card w-full max-w-sm p-8 text-center">
            <p className="text-sm text-muted">Recording punch…</p>
          </div>
        )}

        {step.name === 'result' && (
          <div
            className={`w-full max-w-sm rounded-2xl p-8 text-center ${
              step.ok ? 'bg-green-100' : 'bg-red-100'
            }`}
          >
            <div className="text-5xl">{step.ok ? '✅' : '❌'}</div>
            <p className="mt-3 text-lg font-semibold text-ink">{step.message}</p>
          </div>
        )}

        {step.name === 'exit' && (
          <div className="card w-full max-w-sm space-y-3 p-6">
            <p className="text-center text-lg font-semibold text-ink">Admin sign-in to exit kiosk</p>
            <input
              value={exitId}
              onChange={(e) => setExitId(e.target.value)}
              placeholder="Admin username or email"
              autoCapitalize="none"
              className="input w-full"
            />
            <input
              value={exitPassword}
              onChange={(e) => setExitPassword(e.target.value)}
              placeholder="Password"
              type="password"
              className="input w-full"
            />
            {exitError && <p className="text-sm text-red-600">{exitError}</p>}
            <button
              onClick={() => void tryExit()}
              disabled={exitBusy}
              className="btn-primary w-full disabled:opacity-50"
            >
              {exitBusy ? 'Signing in…' : 'Exit kiosk mode'}
            </button>
            <button onClick={() => setStep({ name: 'idle' })} className="btn w-full">
              Back
            </button>
          </div>
        )}
      </div>

      {step.name === 'selfie' && (
        <WebcamCapture
          title={`${PUNCH_LABELS[step.type]} — look at the camera`}
          onCapture={(b64) => void submit(step.code, step.pin, step.type, step.gps, b64)}
          onCancel={() => setStep({ name: 'idle' })}
        />
      )}
    </div>
  );
}
