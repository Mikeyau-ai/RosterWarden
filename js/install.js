/**
 * "Add to Home Screen" support.
 *
 * RosterWarden is meant to live on a phone's home screen, where it opens full
 * screen and works offline - but that only happens if someone installs it, and
 * the browser's own prompt is easy to miss. This captures the install event so
 * Settings can offer a button instead.
 *
 * The two platforms differ:
 *  - Chrome (Android and desktop) fires `beforeinstallprompt`, which we hold on
 *    to and replay when the user asks.
 *  - iOS Safari has no such API at all. Nothing can trigger its Share sheet
 *    programmatically, so there the only honest thing to do is show the steps.
 */

/** The deferred Chrome install event, or null if it hasn't fired. */
let deferred = null;

window.addEventListener('beforeinstallprompt', (event) => {
  // Suppress Chrome's own mini-infobar so the button in Settings is the single
  // place this is offered.
  event.preventDefault();
  deferred = event;
});

// Once installed the saved event is spent and must not be offered again.
window.addEventListener('appinstalled', () => { deferred = null; });

/** True when the browser has given us an install prompt we can replay. */
export function canInstall() {
  return deferred !== null;
}

/** True when already running as an installed app rather than a browser tab. */
export function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

/** True on iPhone/iPad, where installing is a manual Share-sheet step. */
export function isIOS() {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac, so the touch-point check catches it.
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Show the browser's install prompt.
 * Resolves to true only if the user actually accepted.
 */
export async function promptInstall() {
  if (!deferred) return false;
  const event = deferred;
  deferred = null;                 // a prompt event can only be used once
  try {
    event.prompt();
    const { outcome } = await event.userChoice;
    return outcome === 'accepted';
  } catch {
    return false;
  }
}
