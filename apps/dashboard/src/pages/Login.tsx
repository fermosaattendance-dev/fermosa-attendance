import { usernameToEmail } from '@fermosa/shared';
import { useState, type FormEvent } from 'react';
import { InAppBrowserBanner } from '../components/InAppBrowserBanner';
import { supabase } from '../lib/supabase';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username),
      password,
    });
    if (signInError) setError(signInError.message);
    setSubmitting(false);
  };

  return (
    <div className="grid min-h-screen md:grid-cols-2">
      {/* Brand panel */}
      <div className="fm-bar relative flex flex-col justify-between overflow-hidden px-8 py-12 md:px-12 md:py-16">
        <div className="fm-bar-shine pointer-events-none absolute inset-0" />
        <div className="relative">
          <div className="inline-flex rounded-2xl bg-white px-6 py-5 shadow-[0_8px_28px_rgba(120,84,0,0.3)]">
            <img
              src="/fermosa-wordmark.jpg"
              alt="Fermosa Skin Care Clinic"
              className="h-16 w-auto object-contain md:h-24"
            />
          </div>
        </div>
        <div className="relative mt-10">
          <h2 className="text-2xl font-bold text-white [text-shadow:0_1px_2px_rgba(140,96,0,0.35)] md:text-3xl">
            Attendance &amp; HR
          </h2>
          <p className="mt-3 max-w-sm text-sm font-medium text-on-gold/85">
            Clock-ins, reviews, leave and payroll — across all 22 branches, in one place.
          </p>
        </div>
      </div>

      {/* Form */}
      <div className="flex items-center justify-center bg-white px-6 py-12">
        <div className="w-full max-w-sm">
          <InAppBrowserBanner />
          <h1 className="text-2xl font-bold tracking-tight text-ink">Welcome back</h1>
          <p className="mt-1 text-sm text-muted">Sign in to the manager &amp; HR dashboard.</p>

          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            <div>
              <label htmlFor="username" className="block text-sm font-semibold text-ink">
                Username
              </label>
              <input
                id="username"
                type="text"
                required
                autoComplete="username"
                autoCapitalize="none"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="input mt-1.5"
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-semibold text-ink">
                Password
              </label>
              <input
                id="password"
                type="text"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input mt-1.5"
              />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button type="submit" disabled={submitting} className="btn-primary w-full py-2.5">
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
