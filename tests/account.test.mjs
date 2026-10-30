/**
 * The owner's account (js/account.js) against a stand-in for the Sixth Day
 * account server: sign in with a code approved elsewhere, keep the sync code,
 * and line a device's code up with the account's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

// A tiny account server: one approved person, one kept code, bearer-token checked.
const server = { approved: false, kept: null, calls: [] };
globalThis.fetch = async (url, opts) => {
  const path = new URL(url).pathname;
  const body = opts.body ? JSON.parse(opts.body) : null;
  server.calls.push([opts.method, path, body]);
  const reply = (data, status = 200) => ({ status, json: async () => data });
  if (path === '/api/rw/start') return reply({ user_code: 'AB12-CD34', poll: 'secret', url: 'https://x/link', interval: 0, expires_in: 5 });
  if (path === '/api/rw/poll') {
    return server.approved ? reply({ token: 'tok-1', email: 'boss@example.com', name: 'Boss' }) : reply({ pending: true });
  }
  if (path === '/api/rw/refresh') return body.token === 'tok-1' ? reply({ token: 'tok-2' }) : reply({ error: 'no' }, 401);
  if (opts.headers.Authorization !== `Bearer ${server.token}`) return reply({ error: 'Not signed in.' }, 401);
  if (path === '/api/rw/key' && opts.method === 'GET') return server.kept ? reply({ code: server.kept }) : reply({ error: 'none' }, 404);
  if (path === '/api/rw/key' && opts.method === 'PUT') {
    if (server.kept && server.kept !== body.code && !body.replace) return reply({ error: 'exists' }, 409);
    server.kept = body.code;
    return reply({ ok: true });
  }
  return reply({ error: 'Not found' }, 404);
};

const account = await import('../js/account.js');
const sync = await import('../js/sync.js');

/** Start over: signed out, no kept code, a device code of its own. */
function setUp(deviceCode = 'abcd2345efgh6789jkmn') {
  mem.clear();
  Object.assign(server, { approved: false, kept: null, calls: [], token: 'tok-1' });
  sync.setCode(deviceCode);
}

test('signing in waits for approval, then keeps the token and who it is for', async () => {
  setUp();
  const started = await account.start();
  assert.equal(started.user_code, 'AB12-CD34');
  assert.equal(account.current(), null);
  server.approved = true;
  assert.deepEqual(await account.waitForApproval(started), { email: 'boss@example.com', name: 'Boss' });
  assert.equal(account.current().email, 'boss@example.com');
  account.signOut();
  assert.equal(account.current(), null);
});

test('cancelling stops the wait without signing in', async () => {
  setUp();
  const started = await account.start();
  assert.equal(await account.waitForApproval(started, () => true), null);
  assert.equal(account.current(), null);
});

test('an account with no code yet keeps this device\'s, and one with the same code is left alone', async () => {
  setUp();
  const started = await account.start();
  server.approved = true;
  await account.waitForApproval(started);
  assert.deepEqual(await account.matchCode(), { mode: 'uploaded' });
  assert.equal(server.kept, 'abcd2345efgh6789jkmn');
  assert.deepEqual(await account.matchCode(), { mode: 'same' });
});

test('an account that keeps another code reports it, and the device\'s can replace it on purpose', async () => {
  setUp();
  server.kept = 'zzzz2345efgh6789jkmn';
  const started = await account.start();
  server.approved = true;
  await account.waitForApproval(started);
  assert.deepEqual(await account.matchCode(), { mode: 'differs', code: 'zzzz2345efgh6789jkmn' });
  await assert.rejects(account.keepCode('abcd2345efgh6789jkmn'), /exists/);
  await account.keepCode('abcd2345efgh6789jkmn', true);
  assert.equal(server.kept, 'abcd2345efgh6789jkmn');
});

test('a token is refreshed in place, and dropped when the account says no', async () => {
  setUp();
  const started = await account.start();
  server.approved = true;
  await account.waitForApproval(started);
  await account.keepFresh();
  assert.equal(JSON.parse(mem.get('rosterwarden.account')).token, 'tok-2');
  await account.keepFresh();               // tok-2 is refused by the stand-in
  assert.equal(account.current(), null);
});
