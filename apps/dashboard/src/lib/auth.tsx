import type { Session } from '@supabase/supabase-js';
import type { Profile } from '@fermosa/shared';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from './supabase';

/** Authenticator Assurance Level for the current session (Supabase MFA). */
export interface Aal {
  currentLevel: string | null; // 'aal1' = password only, 'aal2' = passed 2FA
  nextLevel: string | null; // 'aal2' here means the user has a verified factor
}

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  aal: Aal | null;
  aalLoading: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshAal: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  session: null,
  profile: null,
  aal: null,
  aalLoading: false,
  loading: true,
  signOut: async () => {},
  refreshAal: async () => {},
});

/**
 * Locally cached profile so the time clock survives an offline cold start:
 * after a browser restart in airplane mode the stored access token can't be
 * refreshed (session comes back null) and the profiles fetch can't run — the
 * cache keeps the employee "signed in offline". Cleared on real sign-out;
 * refreshed on every successful fetch.
 */
const PROFILE_CACHE_KEY = 'fermosa.cached_profile';

function readCachedProfile(): Profile | null {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Profile;
    return p && typeof p.id === 'string' ? p : null;
  } catch {
    return null;
  }
}

function writeCachedProfile(p: Profile | null): void {
  try {
    if (p) localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(p));
    else localStorage.removeItem(PROFILE_CACHE_KEY);
  } catch {
    // Storage unavailable — offline restarts just won't be covered.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(() => readCachedProfile());
  // undefined = not yet determined; null = no session / not applicable.
  const [aal, setAal] = useState<Aal | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) {
        setLoading(false);
        setAal(null);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      if (event === 'SIGNED_OUT') {
        writeCachedProfile(null);
        setProfile(null);
        setAal(null);
        setLoading(false);
      } else if (!newSession) {
        // Null session without an explicit sign-out (e.g. a token refresh that
        // failed while offline): keep the cached profile so the clock stays
        // usable — the session restores itself on reconnect.
        setAal(null);
        setLoading(false);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // When connectivity returns, nudge supabase to restore/refresh the stored
  // session (an offline cold boot leaves it unrefreshed).
  useEffect(() => {
    const onOnline = () => {
      void supabase.auth.getSession().then(({ data }) => {
        if (data.session) setSession(data.session);
      });
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // Profile — keyed on user id (stable across token refreshes).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const cached = readCachedProfile();
    if (!cached || cached.id !== session.user.id) {
      // No usable cache for this user — show the loading state while fetching.
      setProfile(null);
      setLoading(true);
    }
    supabase
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (data) {
          const p = data as Profile;
          setProfile(p);
          writeCachedProfile(p);
        } else if (error?.code === 'PGRST116') {
          // Definitive answer: this account has no profile row.
          setProfile(null);
          writeCachedProfile(null);
        }
        // Any other error (offline/network): keep the cached profile.
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user.id]);

  // AAL — keyed on the access token, so an aal1→aal2 upgrade is picked up.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    supabase.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data }) => {
      if (!cancelled) {
        setAal(data ? { currentLevel: data.currentLevel, nextLevel: data.nextLevel } : null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  const refreshAal = async () => {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    setAal(data ? { currentLevel: data.currentLevel, nextLevel: data.nextLevel } : null);
  };

  const signOut = async () => {
    // Clear the offline cache up front — signOut's network call can fail
    // offline, and a signed-out device must not keep the clock usable.
    writeCachedProfile(null);
    setProfile(null);
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        profile,
        aal: aal ?? null,
        aalLoading: session != null && aal === undefined,
        loading,
        signOut,
        refreshAal,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

/** True when the user has a verified 2FA factor but this session is still aal1. */
export function needsMfaChallenge(aal: Aal | null): boolean {
  return !!aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2';
}
