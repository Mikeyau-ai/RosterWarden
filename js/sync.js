/**
 * End-to-end encrypted sync.
 *
 * Everything is encrypted on the device before it is sent, and the key never
 * leaves the device. The server stores an opaque blob under an opaque id and
 * cannot read a single name — including by whoever runs the server.
 *
 * How one secret produces two different things:
 *
 *   secret  (32 random bytes, shown to the user as the sync code)
 *     ├─ SHA-256("rosterwarden-id:"  + secret) ──▶ storage id   → SENT to the server
 *     └─ SHA-256("rosterwarden-key:" + secret) ──▶ AES-GCM key  → NEVER sent
 *
 * Both are derived from the same secret but neither can be worked back to the
 * other, so the server learns nothing about the key from the id it is given.
 *
 * The consequence, and it is not a small one: **lose the sync code and the
 * data cannot be recovered.** Not by the user, and not by whoever runs the
 * server, because nobody else has ever held the key. That is the price of the
 * server genuinely not being able to read it, and the UI says so plainly.
 *
 * AES-GCM with a fresh 12-byte nonce per write, via WebCrypto - no library.
 */
import { SYNC_URL } from './config.js';

/** localStorage key holding this device's sync secret. */
const SECRET_KEY = 'rosterwarden.sync.secret';

/** Set when the user has deliberately turned sync off on this device. */
const OFF_KEY = 'rosterwarden.sync.off';

/** Set once the user has confirmed they have written their code down. */
const ACK_KEY = 'rosterwarden.sync.ack';

/** Server timestamp this device last agreed with. */
const SYNCED_AT_KEY = 'rosterwarden.sync.at';

/** When this device last changed the data itself. */
const CHANGED_AT_KEY = 'rosterwarden.sync.changed';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Bytes → base64. */
function toBase64(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** base64 → bytes. */
function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Format a secret as a readable code: lower-case base32-ish in groups of four.
 *
 * People have to copy this between devices by hand, so it avoids characters
 * that look alike (0/O, 1/l/I) - a mistyped code is indistinguishable from a
 * wrong one, and there is no "forgot my code" to fall back on.
 */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/** Turn raw bytes into a typo-resistant code string. */
function encodeCode(bytes) {
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return (out.match(/.{1,4}/g) || []).join('-');
}

/** Strip formatting so a pasted code with spaces or capitals still works. */
export function normaliseCode(code) {
  return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Re-group a code into fours for display.
 *
 * Codes are stored stripped, because that is what the key derivation uses -
 * but an unbroken twenty-character string is exactly what someone copying it
 * onto a second phone will get wrong. Grouping is put back for the eye.
 */
export function formatCode(code) {
  return (normaliseCode(code).match(/.{1,4}/g) || []).join('-');
}

/** Generate a new random sync code. */
export function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return encodeCode(bytes);
}

/** SHA-256 of a string, as raw bytes. */
async function sha256(text) {
  return crypto.subtle.digest('SHA-256', encoder.encode(text));
}

/**
 * Derive the storage id and the encryption key from a sync code.
 * Distinct prefixes keep the two independent: the id can be public, the key
 * never is.
 */
export async function deriveKeys(code) {
  const secret = normaliseCode(code);
  const idBytes = await sha256(`rosterwarden-id:${secret}`);
  const keyBytes = await sha256(`rosterwarden-key:${secret}`);

  const storageId = [...new Uint8Array(idBytes)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
  );
  return { storageId, cryptoKey };
}

/** Encrypt a JS value, returning base64 ciphertext and nonce. */
export async function encrypt(value, cryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, cryptoKey, plaintext
  );
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv) };
}

/**
 * Decrypt back to the original value.
 * Throws if the code is wrong or the data was tampered with - AES-GCM
 * authenticates, so a bad key fails loudly rather than returning noise.
 */
export async function decrypt({ ciphertext, iv }, cryptoKey) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) }, cryptoKey, fromBase64(ciphertext)
  );
  return JSON.parse(decoder.decode(plaintext));
}

// ─── device state ────────────────────────────────────────────────────────

/** This device's sync code, or null when sync has never been switched on. */
export function currentCode() {
  try {
    return localStorage.getItem(SECRET_KEY);
  } catch {
    return null;
  }
}

/** Store (or, given null, forget) this device's sync code. */
export function setCode(code) {
  try {
    if (code) localStorage.setItem(SECRET_KEY, normaliseCode(code));
    else localStorage.removeItem(SECRET_KEY);
    return true;
  } catch {
    return false;
  }
}

/** True when the user has switched sync off here and meant it. */
export function isDisabled() {
  try {
    return localStorage.getItem(OFF_KEY) === '1';
  } catch {
    return false;
  }
}

/** Record (or clear) a deliberate decision to keep sync off on this device. */
export function setDisabled(off) {
  try {
    if (off) localStorage.setItem(OFF_KEY, '1');
    else localStorage.removeItem(OFF_KEY);
  } catch { /* storage unavailable; sync simply stays off for this session */ }
}

/** True once the user has confirmed they have a copy of their sync code. */
export function codeAcknowledged() {
  try {
    return localStorage.getItem(ACK_KEY) === '1';
  } catch {
    return false;
  }
}

/** Record that the user has saved their code, so we stop asking. */
export function acknowledgeCode() {
  try {
    localStorage.setItem(ACK_KEY, '1');
  } catch { /* nothing to do; we will simply ask again next time */ }
}

/** Read a stored timestamp, or '' when there isn't one. */
function stamp(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

/** Write a stored timestamp. */
function setStamp(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* storage unavailable; reconciliation just re-runs next launch */ }
}

/** Note that this device has changed the data. Called on every save. */
export function markChanged() {
  setStamp(CHANGED_AT_KEY, new Date().toISOString());
}

/**
 * Bring this device and the server into agreement, once, at startup.
 *
 * The server holds the authoritative copy; the device keeps its own so the app
 * still opens and works with no signal. This decides which of the two moved on
 * since they last agreed:
 *
 *   server newer, device unchanged  ->  take the server's copy
 *   device newer, server unchanged  ->  upload
 *   both changed                    ->  keep the device's, and say so
 *
 * The last case is the one that matters. Silently picking a winner is how
 * somebody's afternoon of edits disappears without anyone noticing, so it
 * keeps what is in front of the user and reports the clash instead.
 *
 * `apply(data)` is called with the server's copy when that is the one to keep.
 */
export async function reconcile(localData, apply) {
  if (!isEnabled()) return { action: 'off' };

  const syncedAt = stamp(SYNCED_AT_KEY);
  const changedAt = stamp(CHANGED_AT_KEY);
  const deviceMovedOn = Boolean(changedAt) && changedAt > syncedAt;

  let remote;
  try {
    remote = await pull();
  } catch (err) {
    setStatus('error', err.message);
    return { action: 'failed', message: err.message };
  }

  // Nothing stored yet: this device seeds it.
  if (!remote) {
    try {
      const at = await push(localData);
      setStamp(SYNCED_AT_KEY, at);
      setStatus('synced');
      return { action: 'uploaded' };
    } catch (err) {
      setStatus('error', err.message);
      return { action: 'failed', message: err.message };
    }
  }

  const serverMovedOn = Boolean(remote.updatedAt) && remote.updatedAt > syncedAt;

  if (serverMovedOn && deviceMovedOn) {
    setStatus('conflict', 'This device and another both changed things since they last agreed.');
    return { action: 'conflict', at: remote.updatedAt };
  }

  if (serverMovedOn) {
    apply(remote.data);
    setStamp(SYNCED_AT_KEY, remote.updatedAt);
    setStamp(CHANGED_AT_KEY, remote.updatedAt);
    setStatus('synced');
    return { action: 'downloaded' };
  }

  if (deviceMovedOn) {
    try {
      const at = await push(localData);
      setStamp(SYNCED_AT_KEY, at);
      setStatus('synced');
      return { action: 'uploaded' };
    } catch (err) {
      setStatus('error', err.message);
      return { action: 'failed', message: err.message };
    }
  }

  setStatus('synced');
  return { action: 'in-sync' };
}

/**
 * Switch sync on by itself the first time the app runs on a device.
 *
 * On by default because the whole point is that a lost or wiped phone should
 * not mean a lost roster, and something you have to go and find in Settings
 * gets switched on after the data is already gone.
 *
 * It does not override a deliberate choice: once someone turns sync off, it
 * stays off until they turn it back on. Returns true if it just enabled it.
 */
export function autoEnable() {
  if (!isConfigured() || isDisabled() || currentCode()) return false;
  return setCode(generateCode());
}

/** True when a server has been configured and this device has a code. */
export function isEnabled() {
  return Boolean(SYNC_URL) && Boolean(currentCode());
}

/** True when the app was built without a sync server configured. */
export function isConfigured() {
  return Boolean(SYNC_URL);
}

// ─── transport ───────────────────────────────────────────────────────────

/** Raised for anything the user should see rather than a stack trace. */
export class SyncError extends Error {}

// ─── background pushing ──────────────────────────────────────────────────

/** Pending debounce timer for an automatic push. */
let pushTimer = null;

/** Most recent automatic-sync outcome, for Settings to display. */
export const status = { state: 'idle', at: null, message: '' };

/** Listeners notified whenever `status` changes. */
const watchers = new Set();

/** Subscribe to sync status changes; returns an unsubscribe function. */
export function watchStatus(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

/** Update the shared status and tell anyone watching. */
function setStatus(state, message = '') {
  status.state = state;
  status.message = message;
  status.at = new Date().toISOString();
  for (const fn of watchers) {
    try { fn(status); } catch { /* a broken watcher must not break syncing */ }
  }
}

/**
 * Queue an encrypted upload a few seconds from now.
 *
 * Debounced because the store saves on every keystroke-sized change, and each
 * push is a network round trip and a write against a daily quota. Failure is
 * deliberately quiet: the device still holds the data, so a dropped connection
 * is not something to interrupt someone mid-roster about - it shows in
 * Settings instead.
 */
export function schedulePush(data, delay = 3000) {
  if (!isEnabled()) return;
  clearTimeout(pushTimer);
  setStatus('pending');
  pushTimer = setTimeout(async () => {
    try {
      const at = await push(data);
      // Record agreement, so the next launch knows this device is not ahead.
      setStamp(SYNCED_AT_KEY, at);
      setStatus('synced');
    } catch (err) {
      setStatus('error', err.message);
    }
  }, delay);
}

/** Upload the encrypted database. Returns the timestamp the server recorded. */
export async function push(data, code = currentCode()) {
  if (!SYNC_URL) throw new SyncError('No sync server is configured for this app.');
  if (!code) throw new SyncError('Sync is not switched on for this device.');

  const { storageId, cryptoKey } = await deriveKeys(code);
  const payload = await encrypt(data, cryptoKey);
  const updatedAt = new Date().toISOString();

  let res;
  try {
    res = await fetch(`${SYNC_URL}/db/${storageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, updatedAt }),
    });
  } catch {
    throw new SyncError('Could not reach the sync server. Your data is still safe on this device.');
  }
  if (!res.ok) throw new SyncError(`Sync server returned ${res.status}.`);
  return updatedAt;
}

/**
 * Download and decrypt the database for a code.
 * Returns null when the server has nothing stored for it yet.
 */
export async function pull(code = currentCode()) {
  if (!SYNC_URL) throw new SyncError('No sync server is configured for this app.');
  if (!code) throw new SyncError('Sync is not switched on for this device.');

  const { storageId, cryptoKey } = await deriveKeys(code);

  let res;
  try {
    res = await fetch(`${SYNC_URL}/db/${storageId}`);
  } catch {
    throw new SyncError('Could not reach the sync server.');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new SyncError(`Sync server returned ${res.status}.`);

  const body = await res.json();
  try {
    return { data: await decrypt(body, cryptoKey), updatedAt: body.updatedAt };
  } catch {
    // A wrong code lands here: the id happened to exist but the key does not
    // decrypt it. Far more likely is a typo than corruption, so say that.
    throw new SyncError('That code did not unlock the data — check it and try again.');
  }
}
