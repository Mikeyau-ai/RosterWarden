/**
 * Staff links: a private link per staff member for entering the dates they
 * can't work, with nothing readable on the server.
 *
 * Each link carries a random key after the `#`, which browsers never send to
 * a server. The owner's app keeps a copy of the key inside its own encrypted
 * data. From the key come two mailbox ids and one encryption key:
 *
 *   link key
 *     ├─ SHA-256("rosterwarden-staff-in:"  + key) ──▶ "in" box id   (staff → owner)
 *     ├─ SHA-256("rosterwarden-staff-out:" + key) ──▶ "out" box id  (owner → staff)
 *     └─ SHA-256("rosterwarden-staff-key:" + key) ──▶ AES-GCM key   NEVER sent
 *
 * So the sync worker holds two small encrypted boxes per person and can read
 * neither, and the key cannot be worked back from the ids it does see.
 * Replacing a link marks its boxes replaced on the worker, so an old or leaked
 * link can never write again.
 */
import { SYNC_URL } from './config.js';
import { encrypt, decrypt } from './sync.js';

const encoder = new TextEncoder();

/** A link key's shape: 32 random bytes as unpadded base64url. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Raised when a link has been replaced by a newer one. */
export class LinkReplaced extends Error {}

/** Raised for anything else the user should be told about. */
export class LinkError extends Error {}

/** A fresh, unguessable link key. */
export function newLinkKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The key in a `#staff=…` address, or null if it doesn't hold a valid one. */
export function keyFromHash(hash) {
  const m = /^#?staff=([A-Za-z0-9_-]+)$/.exec(hash || '');
  return m && KEY_PATTERN.test(m[1]) ? m[1] : null;
}

/** The address of the app itself (no file name, query or hash), for building links. */
export function appBase() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

/** The link to send a staff member. */
export function linkUrl(key, base = appBase()) {
  return `${base}#staff=${key}`;
}

/** Hex SHA-256 of a string. */
async function hexHash(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The two mailbox ids and the encryption key that a link key gives. */
export async function boxesFor(key) {
  const keyBytes = await crypto.subtle.digest('SHA-256', encoder.encode(`rosterwarden-staff-key:${key}`));
  return {
    inId: await hexHash(`rosterwarden-staff-in:${key}`),
    outId: await hexHash(`rosterwarden-staff-out:${key}`),
    cryptoKey: await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
  };
}

/** Make a request to the worker, turning network failure into a readable error. */
async function request(path, options = {}) {
  if (!SYNC_URL) throw new LinkError('Staff links need sync to be set up.');
  try {
    return await fetch(`${SYNC_URL}${path}`, {
      ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  } catch {
    throw new LinkError('Could not reach the server. Check your connection.');
  }
}

/** Encrypt `value` into a mailbox. Throws LinkReplaced if the link has been replaced. */
export async function writeBox(id, cryptoKey, value) {
  const updatedAt = new Date().toISOString();
  const res = await request(`/box/${id}`, {
    method: 'PUT', body: JSON.stringify({ ...(await encrypt(value, cryptoKey)), updatedAt }),
  });
  if (res.status === 410) throw new LinkReplaced('This link has been replaced.');
  if (!res.ok) throw new LinkError('Saving failed. Try again in a moment.');
  return updatedAt;
}

/** A mailbox's contents as `{ value, updatedAt }`, null if empty; LinkReplaced if replaced. */
export async function readBox(id, cryptoKey) {
  const res = await request(`/box/${id}`);
  if (res.status === 404) return null;
  if (res.status === 410) throw new LinkReplaced('This link has been replaced.');
  if (!res.ok) throw new LinkError('Loading failed. Try again in a moment.');
  const body = await res.json();
  return { value: await decrypt(body, cryptoKey), updatedAt: body.updatedAt };
}

/**
 * Several mailboxes in one request: `entries` is `[{ id, cryptoKey }]`.
 * Returns a Map of id to `{ value, updatedAt }` or `{ replaced: true }`; empty
 * boxes, and any that will not decrypt, are left out.
 */
export async function readBoxes(entries) {
  const out = new Map();
  for (let i = 0; i < entries.length; i += 200) {
    const batch = entries.slice(i, i + 200);
    const res = await request('/boxes', { method: 'POST', body: JSON.stringify({ ids: batch.map((e) => e.id) }) });
    if (!res.ok) throw new LinkError('Checking staff links failed.');
    const found = await res.json();
    for (const { id, cryptoKey } of batch) {
      const box = found[id];
      if (!box) continue;
      if (box.replaced) { out.set(id, { replaced: true }); continue; }
      try {
        out.set(id, { value: await decrypt(box, cryptoKey), updatedAt: box.updatedAt });
      } catch {
        // Not decryptable with this key: not ours to read, so treated as empty.
      }
    }
  }
  return out;
}

/** Mark a mailbox replaced, so the link it came from stops working for good. */
export async function replaceBox(id) {
  const res = await request(`/box/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new LinkError('Could not cancel the old link. Try again in a moment.');
}
