import { supabase } from './supabase';

/**
 * Signed-URL cache for selfie thumbnails.
 *
 * Selfies live in a private bucket, so every thumbnail needs a signed URL.
 * Minting a fresh URL on each render breaks the browser's image cache (the
 * signature makes every URL unique), which made the auto-refreshing Punches
 * page re-download all visible photos every 10 s. Reusing a photo's URL for
 * its full lifetime means the <img> src never changes, so each photo is
 * downloaded exactly once per ~9 minutes.
 */

const SIGN_TTL_S = 600; // signed-URL lifetime
const REUSE_MARGIN_MS = 60_000; // stop reusing this long before expiry

const cache = new Map<string, { url: string; expiresAt: number }>();

/** Signed URLs for the given storage paths, reusing still-fresh ones. */
export async function getSelfieUrls(paths: string[]): Promise<Record<string, string>> {
  const now = Date.now();
  for (const [path, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(path);
  }

  const wanted = [...new Set(paths)];
  const missing = wanted.filter((p) => {
    const entry = cache.get(p);
    return !entry || entry.expiresAt <= now + REUSE_MARGIN_MS;
  });

  if (missing.length > 0) {
    const { data: signed } = await supabase.storage.from('selfies').createSignedUrls(missing, SIGN_TTL_S);
    signed?.forEach((s) => {
      if (s.signedUrl && s.path) cache.set(s.path, { url: s.signedUrl, expiresAt: now + SIGN_TTL_S * 1000 });
    });
  }

  const out: Record<string, string> = {};
  for (const p of wanted) {
    const entry = cache.get(p);
    if (entry) out[p] = entry.url;
  }
  return out;
}
