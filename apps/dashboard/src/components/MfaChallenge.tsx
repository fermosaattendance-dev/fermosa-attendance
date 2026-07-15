import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

/**
 * Shown after password sign-in when the user has a verified 2FA factor but the
 * session is still aal1. Verifying a code upgrades the session to aal2.
 */
export function MfaChallenge() {
  const { refreshAal, signOut } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors();
    if (listErr) {
      setError(listErr.message);
      setBusy(false);
      return;
    }
    const totp = factors?.totp?.[0];
    if (!totp) {
      setError('No authenticator is enrolled on this account.');
      setBusy(false);
      return;
    }
    const { error: verErr } = await supabase.auth.mfa.challengeAndVerify({
      factorId: totp.id,
      code: code.trim(),
    });
    if (verErr) {
      setError(verErr.message);
      setBusy(false);
      return;
    }
    await refreshAal();
    // On success the session is now aal2; RequireAuth will render the app.
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <form onSubmit={verify} className="w-full max-w-sm card p-6">
        <h1 className="text-lg font-semibold text-gray-900">Two-factor authentication</h1>
        <p className="mt-1 text-sm text-gray-500">
          Enter the 6-digit code from your authenticator app to finish signing in.
        </p>
        <input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          placeholder="123456"
          className="mt-4 w-full input text-center font-mono text-lg tracking-widest"
        />
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={busy || code.length !== 6}
          className="mt-4 w-full btn-primary"
        >
          {busy ? 'Verifying…' : 'Verify'}
        </button>
        <button
          type="button"
          onClick={signOut}
          className="mt-3 w-full text-center text-sm text-gray-500 hover:underline"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
