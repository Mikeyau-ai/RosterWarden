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
 * Planning Center sign-in endpoints (see js/sources/planning-center.js):
 *   POST /pco/token    <- { code, redirect_uri }   -> Planning Center's token response
 *   POST /pco/refresh  <- { refresh_token }        -> Planning Center's token response
 *
 * These exist only because swapping a sign-in code for a token needs the app's
 * client secret, which cannot ship inside a web page. The worker adds the
 * secret, passes the request on, and hands the tokens straight back - it
 * stores nothing, and roster data never comes through here.
 */

/** Biggest blob accepted, in bytes. A large roster is a few tens of KB. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Ids are always a hex SHA-256; anything else is a bad request, not a lookup. */
const ID_PATTERN = /^[0-9a-f]{64}$/;

/** CORS headers. The app is served from a different origin to this worker. */
function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
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

    const match = url.pathname.match(/^\/db\/([^/]+)$/);
    if (!match) return json({ error: 'Not found' }, 404, origin);

    const id = match[1];
    if (!ID_PATTERN.test(id)) return json({ error: 'Bad id' }, 400, origin);

    if (request.method === 'GET') return read(id, env, origin);
    if (request.method === 'PUT') return write(id, request, env, origin);
    return json({ error: 'Method not allowed' }, 405, origin);
  },
};

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
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
