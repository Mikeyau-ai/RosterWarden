/**
 * The owner's RosterWarden account: a Sixth Day account (password, Google or
 * Microsoft) that keeps this workplace's sync code, so a new phone gets its
 * rosters back by signing in instead of typing a code.
 *
 * Signing in uses a short code approved on sixthdaystudios.com, so the app
 * never sees a password: `start()` asks for a code, the person approves it on
 * the site, and `waitForApproval()` collects a token. The token is kept here
 * and used to read and keep the sync code (see sixthdaystudios's
 * src/rwaccount.js). The rosters themselves stay encrypted with that code.
 */
import { ACCOUNT_URL } from './config.js';
import * as sync from './sync.js';

/** localStorage keys: the signed-in account, and this device's id for sign-in requests. */
const ACCOUNT_KEY = 'rosterwarden.account';
const DEVICE_KEY = 'rosterwarden.account.device';

/** Raised for anything the person should read, such as an expired code. */
export class AccountError extends Error {}

/** The signed-in account `{ token, email, name }`, or null. */
function stored() {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null');
  } catch {
    return null;
  }
}

/** Remember (or, given null, forget) the signed-in account. */
function store(account) {
  try {
    if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch { /* private mode: they will be asked to sign in again next time */ }
}

/** Who is signed in as `{ email, name }`, or null. */
export function current() {
  const a = stored();
  return a ? { email: a.email, name: a.name } : null;
}

/** Whether the app was built with an account server to sign in to. */
export function isConfigured() {
  return Boolean(ACCOUNT_URL);
}

/** A random id for this device's sign-in requests, kept so they can be told apart. */
function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

/** Call the account server and return `{ status, data }`; a network failure becomes an AccountError. */
async function call(method, path, body, token = null) {
  let res;
  try {
    res = await fetch(`${ACCOUNT_URL}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new AccountError('Could not reach the account server. Check your connection.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* an empty body */ }
  return { status: res.status, data };
}

/** Ask for a sign-in code: `{ user_code, poll, url, interval, expires_in }`. */
export async function start() {
  const { status, data } = await call('POST', '/api/rw/start', { device: deviceId() });
  if (status !== 200) throw new AccountError(data.error || 'Could not start signing in.');
  return data;
}

/**
 * Wait for the code from `start()` to be approved on the site, then keep the
 * token and return `{ email, name }`. `cancelled()` is checked between polls.
 */
export async function waitForApproval(started, cancelled = () => false) {
  const deadline = Date.now() + started.expires_in * 1000;
  while (Date.now() < deadline && !cancelled()) {
    await new Promise((r) => setTimeout(r, started.interval * 1000));
    if (cancelled()) break;
    const { status, data } = await call('POST', '/api/rw/poll', { poll: started.poll });
    if (data.token) {
      store({ token: data.token, email: data.email, name: data.name });
      return { email: data.email, name: data.name };
    }
    if (status !== 200) throw new AccountError(data.error || 'That sign-in did not work.');
  }
  return null;
}

/** Sign out of this device (the sync code stays, so sync keeps working). */
export function signOut() {
  store(null);
}

/**
 * Swap the token for a fresh one so use of the app keeps the person signed in.
 * Signed out for good if the server says the account is no longer valid.
 */
export async function keepFresh() {
  const a = stored();
  if (!a) return;
  try {
    const { status, data } = await call('POST', '/api/rw/refresh', { token: a.token });
    if (data.token) store({ ...a, token: data.token });
    else if (status === 401) store(null);
  } catch { /* offline: the old token still has weeks left */ }
}

/**
 * Line this device's sync code up with the account's, after signing in:
 *
 *   'uploaded'  the account kept nothing yet, so this device's code is now kept
 *   'same'      the account already keeps this device's code
 *   'differs'   the account keeps another code, returned as `code`; the caller
 *               chooses between `adopt` (take the account's) and `replace`
 */
export async function matchCode() {
  const a = stored();
  if (!a) throw new AccountError('Sign in first.');
  const { status, data } = await call('GET', '/api/rw/key', null, a.token);
  if (status === 404) {
    const code = sync.currentCode();
    if (!code) return { mode: 'uploaded' };
    await keepCode(code);
    return { mode: 'uploaded' };
  }
  if (status !== 200) throw new AccountError(data.error || 'Could not read your account.');
  return sync.normaliseCode(data.code) === sync.currentCode() ? { mode: 'same' } : { mode: 'differs', code: data.code };
}

/** Keep `code` on the account, replacing a different one already there only when `replace` is true. */
export async function keepCode(code, replace = false) {
  const a = stored();
  if (!a) return;
  const { status, data } = await call('PUT', '/api/rw/key', { code: sync.normaliseCode(code), replace }, a.token);
  if (status !== 200) throw new AccountError(data.error || 'Could not save your sync code to your account.');
}
