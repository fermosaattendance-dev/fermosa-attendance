import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

interface EnrollState {
  factorId: string;
  qrCode: string;
  secret: string;
}

/**
 * Account-security card: enroll or disable a TOTP authenticator. 2FA is optional
 * for admins (product decision 2026-07-15) — this is where they opt in. Enroll and
 * disable are recorded in the audit trail via the log_audit RPC.
 */
export function TwoFactorCard() {
  const { refreshAal } = useAuth();
  const [enabled, setEnabled] = useState<boolean | null>(null); // null = loading
  const [factorId, setFactorId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'enroll' | 'disable'>('view');
  const [enroll, setEnroll] = useState<EnrollState | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.auth.mfa.listFactors();
    const verified = data?.totp?.[0] ?? null;
    setEnabled(!!verified);
    setFactorId(verified?.id ?? null);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reset = () => {
    setMode('view');
    setEnroll(null);
    setCode('');
    setError(null);
  };

  const startEnroll = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    // Clear any leftover unverified factors so enroll doesn't collide.
    const { data: all } = await supabase.auth.mfa.listFactors();
    for (const f of all?.all ?? []) {
      if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error: err } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
    setBusy(false);
    if (err || !data) {
      setError(err?.message ?? 'Could not start enrollment.');
      return;
    }
    setEnroll({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    setCode('');
    setMode('enroll');
  };

  const confirmEnroll = async () => {
    if (!enroll) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.mfa.challengeAndVerify({
      factorId: enroll.factorId,
      code: code.trim(),
    });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    await supabase.rpc('log_audit', { p_action: 'mfa_enrolled', p_details: null });
    await refreshAal();
    await load();
    reset();
    setNotice('Two-factor authentication is now enabled.');
  };

  const confirmDisable = async () => {
    if (!factorId) return;
    setBusy(true);
    setError(null);
    // Require a current code to disable (proves possession).
    const { error: verErr } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code: code.trim(),
    });
    if (verErr) {
      setBusy(false);
      setError(verErr.message);
      return;
    }
    const { error: unErr } = await supabase.auth.mfa.unenroll({ factorId });
    setBusy(false);
    if (unErr) {
      setError(unErr.message);
      return;
    }
    await supabase.rpc('log_audit', { p_action: 'mfa_disabled', p_details: null });
    await refreshAal();
    await load();
    reset();
    setNotice('Two-factor authentication has been disabled.');
  };

  return (
    <div className="mt-8">
      <h3 className="text-base font-semibold text-gray-900">Two-factor authentication (2FA)</h3>
      <p className="text-sm text-gray-500">
        Protect your account with a one-time code from an authenticator app (Google Authenticator, Authy,
        1Password, …). Optional, but recommended for admin accounts.
      </p>

      <div className="mt-3 card p-5">
        {enabled === null && <p className="text-sm text-gray-400">Loading…</p>}

        {enabled === false && mode === 'view' && (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">2FA is off</p>
              <p className="text-xs text-gray-500">Your account is protected by password only.</p>
            </div>
            <button
              onClick={startEnroll}
              disabled={busy}
              className="btn-primary"
            >
              {busy ? 'Starting…' : 'Set up 2FA'}
            </button>
          </div>
        )}

        {enabled === true && mode === 'view' && (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-green-700">2FA is on</p>
              <p className="text-xs text-gray-500">You’ll enter a code from your authenticator app when you sign in.</p>
            </div>
            <button
              onClick={() => {
                setMode('disable');
                setCode('');
                setError(null);
                setNotice(null);
              }}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
            >
              Disable
            </button>
          </div>
        )}

        {mode === 'enroll' && enroll && (
          <div>
            <p className="text-sm text-gray-700">
              Scan this QR code with your authenticator app, then enter the 6-digit code it shows.
            </p>
            <div className="mt-3 flex flex-wrap items-start gap-5">
              <div className="rounded-lg border border-gray-200 p-2">
                {enroll.qrCode.startsWith('<svg') ? (
                  <div className="h-44 w-44" dangerouslySetInnerHTML={{ __html: enroll.qrCode }} />
                ) : (
                  <img src={enroll.qrCode} alt="2FA QR code" className="h-44 w-44" />
                )}
              </div>
              <div className="flex-1">
                <p className="text-xs text-gray-500">Can’t scan? Enter this key manually:</p>
                <code className="mt-1 block break-all rounded bg-gray-100 px-2 py-1 font-mono text-xs text-gray-800">
                  {enroll.secret}
                </code>
                <label className="mt-4 block text-sm font-medium text-gray-700">Verification code</label>
                <input
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  placeholder="123456"
                  className="mt-1 w-40 input text-center font-mono tracking-widest"
                />
              </div>
            </div>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <div className="mt-4 flex gap-2">
              <button
                onClick={confirmEnroll}
                disabled={busy || code.length !== 6}
                className="btn-primary"
              >
                {busy ? 'Verifying…' : 'Enable 2FA'}
              </button>
              <button onClick={reset} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">
                Cancel
              </button>
            </div>
          </div>
        )}

        {mode === 'disable' && (
          <div>
            <p className="text-sm text-gray-700">Enter a current code from your authenticator app to turn off 2FA.</p>
            <input
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              placeholder="123456"
              className="mt-3 w-40 input text-center font-mono tracking-widest"
            />
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <div className="mt-4 flex gap-2">
              <button
                onClick={confirmDisable}
                disabled={busy || code.length !== 6}
                className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
              >
                {busy ? 'Disabling…' : 'Disable 2FA'}
              </button>
              <button onClick={reset} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">
                Cancel
              </button>
            </div>
          </div>
        )}

        {notice && mode === 'view' && <p className="mt-3 text-sm text-green-700">{notice}</p>}
        {error && mode === 'view' && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
