/**
 * RosterWarden sync worker.
 *
 * A deliberately dumb blob store: it takes an opaque lump of bytes under an
 * opaque id, and hands it back on request. It has no idea what a roster is,
 * and it cannot read anything it holds - the app encrypts everything before it
 * ever leaves the phone, and the key never comes near this server.
 *
 * That matters because it is the operator's own Cloudflare account. Hosting
 * other people's staff names and availability would make you responsible for
 * them; hosting ciphertext you cannot decrypt does not.
 *
 * Sync endpoints:
 *   GET  /db/:id  ->  { ciphertext, iv, updatedAt }   (404 if never written)
 *   PUT  /db/:id  <-  { ciphertext, iv, updatedAt }
 *
 * `:id` is a 64-character hex SHA-256 derived from the user's secret. It is
 * unguessable, and it is NOT the encryption key - see js/sync.js.
 *
 * Staff link mailboxes (see js/staff-link.js) - small encrypted boxes, one
 * each way per staff member, under ids derived from that person's link key:
 *   GET    /box/:id  ->  { ciphertext, iv, updatedAt }  (404 empty, 410 replaced)
 *   PUT    /box/:id  <-  { ciphertext, iv, updatedAt }  (410 once replaced)
 *   DELETE /box/:id  ->  { ok: true }  marks it replaced, so the old link stops working
 *   POST   /boxes    <-  { ids: [...] } -> { [id]: { ciphertext, iv, updatedAt } | { replaced: true } }
 *
 * Open-shift claims (see js/open-shifts.js) - one tiny encrypted record per
 * shift sent out to be taken, first come, first served, under an id derived
 * from that set's shared key. `token` is a secret only the claimer's link
 * gives; the worker keeps just its hash (`by`), so it can tell the holder
 * from everyone else without knowing who either is:
 *   PUT    /claim/:id  <-  { ciphertext, iv, token }  (409 if someone else holds it)
 *   DELETE /claim/:id  <-  { token }                  lets it go, only for its holder
 *   POST   /claims     <-  { ids: [...] } -> { [id]: { ciphertext, iv, by } }
 *
 * Planning Center sign-in endpoints (see js/sources/planning-center.js):
 *   POST /pco/token    <- { code, redirect_uri, code_verifier } -> Planning Center's token response
 *   POST /pco/refresh  <- { refresh_token }        -> Planning Center's token response
 *   POST /pco/revoke   <- { token }                -> { ok: true }  (on disconnect)
 *
 * These exist only because swapping a sign-in code for a token needs the app's
 * client secret, which cannot ship inside a web page. The worker adds the
 * secret, passes the request on, and hands the tokens straight back - it
 * stores nothing, and roster data never comes through here.
 */

/**
 * Sent on every request to Planning Center, which may refuse (403) requests
 * without an identifying User-Agent - and a Worker's fetch sends none.
 */
const USER_AGENT = 'RosterWarden (https://sixthdaystudios.com)';

/** Biggest blob accepted, in bytes. A large roster is a few tens of KB. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Biggest mailbox accepted, in bytes: a person's dates, a note and their shifts. */
const BOX_MAX_BYTES = 64 * 1024;

/** Most mailboxes read in one batch request. */
const BOX_BATCH_MAX = 200;

/**
 * The mailbox SQL, named so the tests can run the worker against a stand-in
 * database that answers exactly these statements.
 */
export const BOX_SQL = {
  read: 'SELECT ciphertext, iv, updated_at, revoked FROM mailboxes WHERE id = ?',
  write: 'INSERT INTO mailboxes (id, ciphertext, iv, updated_at, revoked) VALUES (?, ?, ?, ?, 0) '
    + 'ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, '
    + 'updated_at = excluded.updated_at WHERE mailboxes.revoked = 0',
  revoke: "INSERT INTO mailboxes (id, ciphertext, iv, updated_at, revoked) VALUES (?, '', '', ?, 1) "
    + "ON CONFLICT(id) DO UPDATE SET ciphertext = '', iv = '', updated_at = excluded.updated_at, revoked = 1",
};

/** Biggest claim accepted, in bytes: a person id, a short name and a time. */
const CLAIM_MAX_BYTES = 2 * 1024;

/** The claim SQL, named like BOX_SQL for the tests' stand-in database. */
export const CLAIM_SQL = {
  read: 'SELECT ciphertext, iv, by_hash FROM claims WHERE id = ?',
  // A new claim goes in; an existing one changes only for its own holder.
  take: 'INSERT INTO claims (id, ciphertext, iv, by_hash, claimed_at) VALUES (?, ?, ?, ?, ?) '
    + 'ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv '
    + 'WHERE claims.by_hash = excluded.by_hash',
  release: 'DELETE FROM claims WHERE id = ? AND by_hash = ?',
};

/** Ids are always a hex SHA-256; anything else is a bad request, not a lookup. */
const ID_PATTERN = /^[0-9a-f]{64}$/;

/** CORS headers. The app is served from a different origin to this worker. */
function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/** JSON response with CORS applied. */
function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

export default {
  /** Route one request. */
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    if (request.method === 'POST' && url.pathname === '/pco/token') {
      return pcoToken(request, env, origin, 'authorization_code');
    }
    if (request.method === 'POST' && url.pathname === '/pco/refresh') {
      return pcoToken(request, env, origin, 'refresh_token');
    }
    if (request.method === 'POST' && url.pathname === '/pco/revoke') {
      return pcoRevoke(request, env, origin);
    }

    if (request.method === 'POST' && url.pathname === '/boxes') return boxBatch(request, env, origin);
    if (request.method === 'POST' && url.pathname === '/claims') return claimBatch(request, env, origin);
    const claim = url.pathname.match(/^\/claim\/([^/]+)$/);
    if (claim) {
      if (!ID_PATTERN.test(claim[1])) return json({ error: 'Bad id' }, 400, origin);
      if (request.method === 'PUT') return claimTake(claim[1], request, env, origin);
      if (request.method === 'DELETE') return claimRelease(claim[1], request, env, origin);
      return json({ error: 'Method not allowed' }, 405, origin);
    }
    const box = url.pathname.match(/^\/box\/([^/]+)$/);
    if (box) {
      if (!ID_PATTERN.test(box[1])) return json({ error: 'Bad id' }, 400, origin);
      if (request.method === 'GET') return boxRead(box[1], env, origin);
      if (request.method === 'PUT') return boxWrite(box[1], request, env, origin);
      if (request.method === 'DELETE') return boxRevoke(box[1], env, origin);
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    const match = url.pathname.match(/^\/db\/([^/]+)$/);
    if (!match) return json({ error: 'Not found' }, 404, origin);

    const id = match[1];
    if (!ID_PATTERN.test(id)) return json({ error: 'Bad id' }, 400, origin);

    if (request.method === 'GET') return read(id, env, origin);
    if (request.method === 'PUT') return write(id, request, env, origin);
    return json({ error: 'Method not allowed' }, 405, origin);
  },
};

/** One mailbox: its contents, 404 if never written, 410 once its link was replaced. */
async function boxRead(id, env, origin) {
  const row = await env.DB.prepare(BOX_SQL.read).bind(id).first();
  if (!row) return json({ error: 'Nothing here yet' }, 404, origin);
  if (row.revoked) return json({ error: 'This link has been replaced' }, 410, origin);
  return json({ ciphertext: row.ciphertext, iv: row.iv, updatedAt: row.updated_at }, 200, origin);
}

/** Store a mailbox's contents - refused once its link has been replaced. */
async function boxWrite(id, request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400, origin);
  }
  const { ciphertext, iv, updatedAt } = body || {};
  if (typeof ciphertext !== 'string' || typeof iv !== 'string') {
    return json({ error: 'ciphertext and iv are required' }, 400, origin);
  }
  if (ciphertext.length > BOX_MAX_BYTES) return json({ error: 'Too large' }, 413, origin);

  const row = await env.DB.prepare(BOX_SQL.read).bind(id).first();
  if (row?.revoked) return json({ error: 'This link has been replaced' }, 410, origin);

  const stamp = typeof updatedAt === 'string' ? updatedAt : new Date().toISOString();
  await env.DB.prepare(BOX_SQL.write).bind(id, ciphertext, iv, stamp).run();
  return json({ ok: true, updatedAt: stamp }, 200, origin);
}

/** Mark a mailbox replaced: its contents go, and its link can never write again. */
async function boxRevoke(id, env, origin) {
  await env.DB.prepare(BOX_SQL.revoke).bind(id, new Date().toISOString()).run();
  return json({ ok: true }, 200, origin);
}

/** Several mailboxes at once, so the owner's app checks every staff link in one request. */
async function boxBatch(request, env, origin) {
  let ids;
  try {
    ({ ids } = await request.json());
  } catch {
    return json({ error: 'Body must be JSON' }, 400, origin);
  }
  if (!Array.isArray(ids) || ids.length > BOX_BATCH_MAX || !ids.every((id) => ID_PATTERN.test(id))) {
    return json({ error: 'ids must be up to 200 hex ids' }, 400, origin);
  }
  const out = {};
  for (const id of ids) {
    const row = await env.DB.prepare(BOX_SQL.read).bind(id).first();
    if (!row) continue;
    out[id] = row.revoked
      ? { replaced: true }
      : { ciphertext: row.ciphertext, iv: row.iv, updatedAt: row.updated_at };
  }
  return json(out, 200, origin);
}

/** Hex SHA-256 of a claimer's token: what the worker keeps instead of the token. */
async function tokenHash(token) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The JSON body of a request, or null if it isn't JSON. */
async function bodyOf(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Take a shift for whoever holds `token`, unless someone else already has it.
 * The insert is one statement, so of two people tapping at once only the
 * first gets it; reading the row back says who that was.
 */
async function claimTake(id, request, env, origin) {
  const body = await bodyOf(request);
  const { ciphertext, iv, token } = body || {};
  if (typeof ciphertext !== 'string' || typeof iv !== 'string' || !ID_PATTERN.test(token || '')) {
    return json({ error: 'ciphertext, iv and token are required' }, 400, origin);
  }
  if (ciphertext.length > CLAIM_MAX_BYTES) return json({ error: 'Too large' }, 413, origin);
  const by = await tokenHash(token);
  await env.DB.prepare(CLAIM_SQL.take).bind(id, ciphertext, iv, by, new Date().toISOString()).run();
  const row = await env.DB.prepare(CLAIM_SQL.read).bind(id).first();
  if (row?.by_hash !== by) return json({ error: 'Someone else took it first' }, 409, origin);
  return json({ ok: true, by }, 200, origin);
}

/** Let a shift go: only the token that took it can. */
async function claimRelease(id, request, env, origin) {
  const body = await bodyOf(request);
  if (!ID_PATTERN.test(body?.token || '')) return json({ error: 'token is required' }, 400, origin);
  await env.DB.prepare(CLAIM_SQL.release).bind(id, await tokenHash(body.token)).run();
  return json({ ok: true }, 200, origin);
}

/** Several claims at once: each one's sealed contents and its holder's hash. Free shifts are left out. */
async function claimBatch(request, env, origin) {
  const ids = (await bodyOf(request))?.ids;
  if (!Array.isArray(ids) || ids.length > BOX_BATCH_MAX || !ids.every((id) => ID_PATTERN.test(id))) {
    return json({ error: 'ids must be up to 200 hex ids' }, 400, origin);
  }
  const out = {};
  for (const id of ids) {
    const row = await env.DB.prepare(CLAIM_SQL.read).bind(id).first();
    if (row) out[id] = { ciphertext: row.ciphertext, iv: row.iv, by: row.by_hash };
  }
  return json(out, 200, origin);
}

/** Return the stored blob for `id`, or 404 if there has never been one. */
async function read(id, env, origin) {
  const row = await env.DB
    .prepare('SELECT ciphertext, iv, updated_at FROM blobs WHERE id = ?')
    .bind(id)
    .first();

  if (!row) return json({ error: 'No data for that code' }, 404, origin);
  return json({ ciphertext: row.ciphertext, iv: row.iv, updatedAt: row.updated_at }, 200, origin);
}

/** Store the blob for `id`, replacing whatever was there. */
async function write(id, request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400, origin);
  }

  const { ciphertext, iv, updatedAt } = body || {};
  if (typeof ciphertext !== 'string' || typeof iv !== 'string') {
    return json({ error: 'ciphertext and iv are required' }, 400, origin);
  }
  if (ciphertext.length > MAX_BYTES) {
    return json({ error: 'Too large' }, 413, origin);
  }

  // Last write wins. Two devices editing the same data offline will clobber
  // each other; `updatedAt` is stored so the app can at least notice and warn.
  const stamp = typeof updatedAt === 'string' ? updatedAt : new Date().toISOString();
  await env.DB
    .prepare(
      'INSERT INTO blobs (id, ciphertext, iv, updated_at) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, '
      + 'iv = excluded.iv, updated_at = excluded.updated_at'
    )
    .bind(id, ciphertext, iv, stamp)
    .run();

  return json({ ok: true, updatedAt: stamp }, 200, origin);
}

/**
 * Exchange a Planning Center sign-in code (or refresh token) for tokens.
 *
 * `PCO_CLIENT_ID` is a plain var in wrangler.toml; `PCO_CLIENT_SECRET` is a
 * Worker secret (`npx wrangler secret put PCO_CLIENT_SECRET`). Planning Center
 * itself checks `redirect_uri` against the app's registered list, so a code
 * cannot be redeemed for some other site.
 */
async function pcoToken(request, env, origin, grantType) {
  if (!env.PCO_CLIENT_ID || !env.PCO_CLIENT_SECRET) {
    return json({ error: 'Planning Center is not set up on this server yet.' }, 501, origin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400, origin);
  }

  const form = { grant_type: grantType, client_id: env.PCO_CLIENT_ID, client_secret: env.PCO_CLIENT_SECRET };
  if (grantType === 'authorization_code') {
    if (typeof body?.code !== 'string' || typeof body?.redirect_uri !== 'string') {
      return json({ error: 'code and redirect_uri are required' }, 400, origin);
    }
    form.code = body.code;
    form.redirect_uri = body.redirect_uri;
    // PKCE: the verifier proves this is the same app that started the sign-in.
    if (typeof body.code_verifier === 'string') form.code_verifier = body.code_verifier;
  } else {
    if (typeof body?.refresh_token !== 'string') {
      return json({ error: 'refresh_token is required' }, 400, origin);
    }
    form.refresh_token = body.refresh_token;
  }

  let res;
  try {
    res = await fetch('https://api.planningcenteronline.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams(form),
    });
  } catch {
    return json({ error: 'Could not reach Planning Center. Try again in a moment.' }, 502, origin);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Pass Planning Center's own reason on; it is the useful part of the error.
    const reason = data.error_description || data.error || `HTTP ${res.status}`;
    return json({ error: `Planning Center refused the sign-in: ${reason}` }, 400, origin);
  }
  return json({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  }, 200, origin);
}

/**
 * Revoke a refresh token when a device disconnects, so a copy left in that
 * browser's storage stops working. Revoking the refresh token also kills its
 * access token. Planning Center answers 200 even for a token already dead, so
 * failures here are not worth reporting back.
 */
async function pcoRevoke(request, env, origin) {
  if (!env.PCO_CLIENT_ID || !env.PCO_CLIENT_SECRET) {
    return json({ error: 'Planning Center is not set up on this server yet.' }, 501, origin);
  }
  const body = await request.json().catch(() => null);
  if (typeof body?.token !== 'string') return json({ error: 'token is required' }, 400, origin);

  try {
    await fetch('https://api.planningcenteronline.com/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({
        token: body.token,
        token_type_hint: 'refresh_token',
        client_id: env.PCO_CLIENT_ID,
        client_secret: env.PCO_CLIENT_SECRET,
      }),
    });
  } catch {
    return json({ error: 'Could not reach Planning Center.' }, 502, origin);
  }
  return json({ ok: true }, 200, origin);
}
