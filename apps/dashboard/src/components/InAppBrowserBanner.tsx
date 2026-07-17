import { useState } from 'react';
import { detectInAppBrowser } from '../lib/inAppBrowser';

/**
 * Warns staff who opened the app inside a chat app's in-app browser (Messenger,
 * Facebook, …) that they must switch to Chrome to time in — those browsers block
 * location and camera. Renders nothing in a normal browser.
 */
export function InAppBrowserBanner() {
  const app = detectInAppBrowser();
  const [copied, setCopied] = useState(false);
  if (!app) return null;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-semibold">⚠️ Open in Chrome to time in</p>
      <p className="mt-1">
        You’re viewing this inside the <strong>{app}</strong> browser, which blocks your
        location and camera — so timing in won’t work here.
      </p>
      <p className="mt-2">
        Tap the <strong>⋮</strong> (or <strong>⋯</strong>) menu at the top-right and choose{' '}
        <strong>“Open in Chrome”</strong> (or “Open in browser”). Then log in and use{' '}
        <strong>“Add to Home Screen”</strong> so it opens correctly next time.
      </p>
      <button
        onClick={copyLink}
        className="mt-3 rounded-lg border border-amber-400 bg-white px-3 py-1.5 font-medium text-amber-900"
      >
        {copied ? 'Link copied ✓' : 'Copy link'}
      </button>
    </div>
  );
}
