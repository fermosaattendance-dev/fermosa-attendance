// Detect embedded "in-app" browsers (Messenger, Facebook, Instagram, …). These
// WebViews commonly block geolocation and camera and don't persist the PWA, so a
// staff member who opens the clock link from a chat app can't time in. We steer
// them to open the page in Chrome (a real browser) instead.

/** Returns a friendly app name when running inside a known in-app browser, else null. */
export function detectInAppBrowser(): string | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent || '';
  // Facebook family: FB_IAB / FBAN / FBAV = the in-app browser; "Messenger"/Orca = Messenger.
  if (/FB_IAB|FBAN|FBAV|FB4A|FBIOS|Messenger|Orca-Android/i.test(ua)) return 'Facebook / Messenger';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/\bLine\//i.test(ua)) return 'LINE';
  if (/TikTok|BytedanceWebview|musical_ly/i.test(ua)) return 'TikTok';
  if (/GSA\//i.test(ua) && /Version\//i.test(ua)) return 'Google app'; // in-app browser of the Google app
  return null;
}
