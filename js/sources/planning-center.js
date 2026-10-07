/**
 * Planning Center connection: sign in, read a Services team and its blockout
 * dates, and send a built roster back into Planning Center plans.
 *
 * Only Planning Center's own API is called from here, straight from the
 * browser (it allows cross-origin requests). The one thing that needs a server
 * is turning a sign-in code into a token, because that step uses the app's
 * client secret - the sync worker does it (`/pco/token`, `/pco/refresh`) and
 * keeps the secret. The worker never sees roster data.
 *
 * Tokens are kept in this device's localStorage under their own key, outside
 * the synced/backed-up database: each device signs in for itself, so a token
 * is never copied into a backup file or onto another phone.
 *
 * Kept as a "source" module with a small surface (connect, teams, members,
 * blockouts, push) so a second system could sit beside it later without the
 * screens knowing which one they are talking to.
 */
import { PCO_CLIENT_ID, SYNC_URL } from '../config.js';

const API = 'https://api.planningcenteronline.com';
const TOKEN_KEY = 'rosterwarden.pco';
const STATE_KEY = 'rosterwarden.pco.state';
const VERIFIER_KEY = 'rosterwarden.pco.verifier';

/** Raised for anything the user should be told about, with a readable message. */
export class PCOError extends Error {}

/** Whether this build has Planning Center set up at all (client id + worker). */
export function isConfigured() {
  return Boolean(PCO_CLIENT_ID && SYNC_URL);
}

/** The saved token set for this device, or null. */
function readTokens() {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
  } catch {
    return null;
  }
}

/** Save (or with null, forget) this device's token set. */
function writeTokens(tokens) {
  if (tokens) localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  else localStorage.removeItem(TOKEN_KEY);
}

/** Whether this device is signed in to Planning Center. */
export function isConnected() {
  return Boolean(readTokens()?.refresh_token);
}

/**
 * Sign this device out of Planning Center. Rosters and people are untouched.
 *
 * The refresh token is revoked too (which also kills its access token), so a
 * copy left in this browser's storage is useless afterwards. That part is
 * best-effort: offline, the device still signs out.
 */
export async function disconnect() {
  const token = readTokens()?.refresh_token;
  writeTokens(null);
  if (!token) return;
  try {
    await fetch(`${SYNC_URL}/pco/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    // Nothing to tell the user: they are signed out on this device either way.
  }
}

/**
 * The address Planning Center sends people back to: this page's folder, minus
 * any query and any "index.html", so it always matches the callback URL
 * registered with Planning Center (which has to match exactly).
 */
function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

/** Bytes as unpadded base64url, the encoding PKCE uses. */
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Send the browser to Planning Center's sign-in page.
 *
 * Two random values are kept for the return trip: `state`, so a sign-in this
 * device did not start is refused, and a PKCE verifier (Planning Center
 * recommends PKCE even with the secret kept on a server), so a stolen code is
 * useless to anyone who lacks it.
 */
export async function startSignIn() {
  const state = crypto.randomUUID();
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));   // 43 chars
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const params = new URLSearchParams({
    client_id: PCO_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'services',
    state,
    code_challenge: base64url(new Uint8Array(digest)),
    code_challenge_method: 'S256',
  });
  location.assign(`${API}/oauth/authorize?${params}`);
}

/**
 * Finish a sign-in if this page load is the return trip from Planning Center.
 *
 * Returns 'connected', 'cancelled' (they declined), or null when the URL holds
 * no sign-in at all. The code is stripped from the address bar either way, so
 * a reload or a bookmark never replays it.
 */
export async function finishSignIn() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return null;

  const expected = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  history.replaceState(null, '', redirectUri() + location.hash);

  if (error) return 'cancelled';
  if (!expected || !verifier || params.get('state') !== expected) {
    throw new PCOError('That Planning Center sign-in did not start here. Try connecting again.');
  }
  writeTokens(stamp(await worker('/pco/token', {
    code, redirect_uri: redirectUri(), code_verifier: verifier,
  })));
  return 'connected';
}

/** Add an absolute expiry time to a token response, with a minute's margin. */
function stamp(tokens) {
  return { ...tokens, expires_at: Date.now() + ((tokens.expires_in || 7200) - 60) * 1000 };
}

/** POST to the sync worker's token endpoints, turning failures into PCOError. */
async function worker(path, body) {
  let res;
  try {
    res = await fetch(SYNC_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PCOError('Could not reach the sign-in service. Check your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new PCOError(data.error || 'Planning Center sign-in failed. Try connecting again.');
    // A 4xx is Planning Center saying no; a 5xx is the service having a bad moment.
    err.refused = res.status >= 400 && res.status < 500;
    throw err;
  }
  return data;
}

/**
 * A usable access token, refreshing it first when it has expired.
 *
 * A refresh that is refused (revoked access, or a refresh token unused for too
 * long) signs the device out, so the screen offers "Connect" again instead of
 * failing the same way on every tap.
 */
async function accessToken(force = false) {
  const tokens = readTokens();
  if (!tokens?.refresh_token) throw new PCOError('Not connected to Planning Center.');
  if (!force && tokens.access_token && Date.now() < tokens.expires_at) return tokens.access_token;
  try {
    const fresh = stamp(await worker('/pco/refresh', { refresh_token: tokens.refresh_token }));
    writeTokens(fresh);
    return fresh.access_token;
  } catch (err) {
    // Only a refusal ends the session. A dropped connection or a worker
    // hiccup keeps the tokens, so the next tap simply tries again.
    if (!err.refused) throw err;
    writeTokens(null);
    throw new PCOError('Planning Center signed you out. Connect again to carry on.');
  }
}

/** Wait `ms` milliseconds. */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Most times a rate-limited request is retried before giving up. */
const MAX_RATE_RETRIES = 5;

/**
 * One request to the Planning Center API, as parsed JSON.
 *
 * Retries once with a fresh token on 401. On 429 it waits as long as
 * `Retry-After` says and tries again (safe for a POST too: a rate-limited
 * request was never carried out). Following Planning Center's guidance, it
 * reads the rate headers on every reply and pauses when close to the limit,
 * rather than assuming a fixed "100 per 20 seconds".
 */
async function call(path, { method = 'GET', body } = {}, { refreshed = false, waits = 0 } = {}) {
  const token = await accessToken(refreshed);
  let res;
  try {
    res = await fetch(path.startsWith('http') ? path : API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new PCOError('Could not reach Planning Center. Check your connection.');
  }

  if (res.status === 401 && !refreshed) return call(path, { method, body }, { refreshed: true, waits });
  if (res.status === 429 && waits < MAX_RATE_RETRIES) {
    await sleep((Number(res.headers.get('Retry-After')) || 1) * 1000);
    return call(path, { method, body }, { refreshed, waits: waits + 1 });
  }
  if (res.status === 403) {
    throw new PCOError('Your Planning Center login is not allowed to do that. Ask an admin for Services access.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const detail = data.errors?.[0]?.detail || data.errors?.[0]?.title;
    throw new PCOError(`Planning Center said: ${detail || `error ${res.status}`}`);
  }

  // Nearly out of requests for this window: ease off for a second.
  const limit = Number(res.headers.get('X-PCO-API-Request-Rate-Limit'));
  const count = Number(res.headers.get('X-PCO-API-Request-Rate-Count'));
  if (limit && count >= limit * 0.8) await sleep(1000);

  return res.status === 204 ? null : res.json();
}

/**
 * Every record from a list endpoint, following `links.next` page by page.
 * Returns `{ data, included }` with both arrays concatenated across pages.
 */
async function all(path) {
  const data = [];
  const included = [];
  let next = path + (path.includes('?') ? '&' : '?') + 'per_page=100';
  while (next) {
    const page = await call(next);
    data.push(...(page.data || []));
    included.push(...(page.included || []));
    next = page.links?.next || null;
  }
  return { data, included };
}

// ------------------------------------------------------------------- reading --

/**
 * Every Services team the user can see, with the service type it belongs to.
 * Sorted "Service type · Team" so a church with several services reads clearly.
 */
export async function listTeams() {
  const { data, included } = await all('/services/v2/teams?include=service_type&order=name');
  const typeName = new Map(
    included.filter((i) => i.type === 'ServiceType').map((i) => [i.id, i.attributes.name])
  );
  return data
    .filter((t) => !t.attributes.archived_at && !t.attributes.deleted_at)
    .map((t) => {
      const serviceTypeId = t.relationships?.service_type?.data?.id || null;
      return {
        id: t.id,
        name: t.attributes.name,
        serviceTypeId,
        serviceTypeName: typeName.get(serviceTypeId) || '',
      };
    })
    .sort((a, b) => `${a.serviceTypeName} ${a.name}`.localeCompare(`${b.serviceTypeName} ${b.name}`));
}

/** The team's members as `{ id, name }`, archived people left out. */
export async function teamMembers(teamId) {
  const { data } = await all(`/services/v2/teams/${teamId}/people`);
  return data
    .filter((p) => !p.attributes.archived)
    .map((p) => ({ id: p.id, name: personName(p.attributes) }))
    .filter((p) => p.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The name a church actually uses: nickname over first name, then surname. */
function personName(a) {
  const first = (a.nickname || a.first_name || '').trim();
  const name = [first, (a.last_name || '').trim()].filter(Boolean).join(' ');
  return name || (a.full_name || '').trim();
}

/** The team's positions (e.g. "Barista", "Register"), in Planning Center's order. */
export async function teamPositions(teamId) {
  const { data } = await all(`/services/v2/teams/${teamId}/team_positions`);
  return data
    .sort((a, b) => (a.attributes.sequence ?? 0) - (b.attributes.sequence ?? 0))
    .map((p) => p.attributes.name)
    .filter(Boolean);
}

/**
 * "YYYY-MM-DD" for a Planning Center timestamp in a given time zone.
 *
 * Blockouts carry their own `time_zone`; converting in it (rather than the
 * device's zone) keeps an all-day blockout on the day it was entered for.
 */
export function dateIn(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * One blockout (or one repeat of one) as an inclusive `{ start, end }` date pair.
 *
 * The end is taken a second before `ends_at`, so a blockout that runs to
 * midnight does not also block the following day.
 */
export function blockoutRange({ starts_at: startsAt, ends_at: endsAt, time_zone: tz }) {
  const start = dateIn(startsAt, tz);
  const end = dateIn(new Date(Date.parse(endsAt) - 1000).toISOString(), tz);
  return { start, end: end < start ? start : end };
}

/**
 * A person's upcoming blockouts as date ranges, from `from` (ISO date) on.
 *
 * A repeating blockout ("every Sunday in March") is expanded through its own
 * blockout_dates list, one extra request each - which is why the caller goes
 * person by person rather than all at once.
 */
export async function blockoutsFor(personId, from) {
  const { data } = await all(`/services/v2/people/${personId}/blockouts?filter=future`);
  const ranges = [];
  for (const b of data) {
    const a = b.attributes;
    const repeats = a.repeat_frequency && a.repeat_frequency !== 'no_repeat';
    if (!repeats) {
      ranges.push({ ...blockoutRange(a), reason: a.reason || '' });
      continue;
    }
    const dates = await all(`/services/v2/people/${personId}/blockouts/${b.id}/blockout_dates`);
    for (const d of dates.data) {
      ranges.push({ ...blockoutRange(d.attributes), reason: a.reason || '' });
    }
  }
  return ranges.filter((r) => r.end >= from);
}

// ------------------------------------------------------------------- writing --

/**
 * The plans of a service type that fall between two dates, keyed by date.
 *
 * A plan's `sort_date` is its first service time in UTC, so a Sunday 9:30am
 * service in Sydney is Saturday evening UTC. The search window is padded by a
 * day each side so such a plan is not cut off, and each plan is keyed by its
 * date on this device's clock - the church's own day.
 */
export async function plansBetween(serviceTypeId, first, last) {
  const pad = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000)
    .toISOString().slice(0, 10);
  const after = `${pad(first, -1)}T00:00:00Z`;
  const before = `${pad(last, 2)}T00:00:00Z`;
  const { data } = await all(
    `/services/v2/service_types/${serviceTypeId}/plans?filter=after,before`
    + `&after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}&order=sort_date`
  );
  const byDate = new Map();
  for (const plan of data) {
    const sort = plan.attributes.sort_date;
    if (!sort) continue;
    const day = dateIn(sort);
    if (day >= first && day <= last && !byDate.has(day)) byDate.set(day, plan);
  }
  return byDate;
}

/**
 * Put a roster's people into the matching Planning Center plans.
 *
 * Each assignment becomes a plan team member for the org's team, in the
 * position its shift is mapped to, marked Unconfirmed with a *prepared*
 * notification. Nothing reaches a volunteer until someone presses Send in
 * Planning Center - this only fills the schedule in.
 *
 * Anything already on the plan in that position is left as it is, so sending
 * the same roster twice does not double anyone up. Returns a summary of what
 * happened, including what could not be sent and why.
 *
 * `lookup` is `{ teamId, serviceTypeId, personPcoId(personId), positionFor(shiftId) }`.
 */
export async function sendRoster(assignments, lookup, onProgress = () => {}) {
  const result = { added: 0, already: 0, noPlan: new Set(), unlinked: new Set(), unmapped: new Set() };
  const sendable = [];
  for (const a of assignments) {
    const pcoId = lookup.personPcoId(a.personId);
    const position = lookup.positionFor(a.shiftId);
    if (!pcoId) result.unlinked.add(a.personId);
    else if (!position) result.unmapped.add(a.shiftId);
    else sendable.push({ ...a, pcoId, position });
  }
  if (sendable.length === 0) return result;

  const dates = [...new Set(sendable.map((a) => a.date))].sort();
  const plans = await plansBetween(lookup.serviceTypeId, dates[0], dates[dates.length - 1]);

  let done = 0;
  for (const date of dates) {
    const plan = plans.get(date);
    const todays = sendable.filter((a) => a.date === date);
    if (!plan) {
      result.noPlan.add(date);
      done += todays.length;
      onProgress(done, sendable.length);
      continue;
    }

    // Who is already on this plan for the team, so a re-send skips them.
    const base = `/services/v2/service_types/${lookup.serviceTypeId}/plans/${plan.id}/team_members`;
    const { data: existing } = await all(`${base}?where[team_id]=${lookup.teamId}&include=person`);
    const onPlan = new Set(existing.map((m) => (
      `${m.relationships?.person?.data?.id}|${m.attributes.team_position_name}`
    )));

    for (const a of todays) {
      const key = `${a.pcoId}|${a.position}`;
      if (onPlan.has(key)) {
        result.already += 1;
      } else {
        await call(base, {
          method: 'POST',
          body: {
            data: {
              type: 'PlanPerson',
              attributes: {
                person_id: Number(a.pcoId),
                team_id: Number(lookup.teamId),
                team_position_name: a.position,
                status: 'U',
                prepare_notification: true,
              },
            },
          },
        });
        onPlan.add(key);
        result.added += 1;
      }
      done += 1;
      onProgress(done, sendable.length);
    }
  }
  return result;
}
