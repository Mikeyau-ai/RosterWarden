/**
 * The sync worker's staff-link mailboxes, run against a stand-in database that
 * answers the worker's own mailbox SQL: write and read back, refuse a replaced
 * link for good, and read many at once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { BOX_SQL } from '../worker/src/index.js';

/** An in-memory D1 that understands exactly the mailbox statements. */
function fakeDB() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              assert.equal(sql, BOX_SQL.read);
              return rows.get(args[0]) || null;
            },
            async run() {
              const [id] = args;
              if (sql === BOX_SQL.write) {
                if (rows.get(id)?.revoked) return;
                rows.set(id, { ciphertext: args[1], iv: args[2], updated_at: args[3], revoked: 0 });
              } else if (sql === BOX_SQL.revoke) {
                rows.set(id, { ciphertext: '', iv: '', updated_at: args[1], revoked: 1 });
              } else {
                throw new Error(`unexpected SQL: ${sql}`);
              }
            },
          };
        },
      };
    },
  };
}

const ID = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
/** Call the worker. */
const call = (env, method, path, body) => worker.fetch(new Request(`https://w.test${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}), env);

test('a mailbox can be written and read back', async () => {
  const env = { DB: fakeDB() };
  assert.equal((await call(env, 'GET', `/box/${ID}`)).status, 404);
  assert.equal((await call(env, 'PUT', `/box/${ID}`, { ciphertext: 'x', iv: 'y', updatedAt: 't1' })).status, 200);
  const got = await (await call(env, 'GET', `/box/${ID}`)).json();
  assert.deepEqual(got, { ciphertext: 'x', iv: 'y', updatedAt: 't1' });
});

test('a replaced link can never read or write again', async () => {
  const env = { DB: fakeDB() };
  await call(env, 'PUT', `/box/${ID}`, { ciphertext: 'x', iv: 'y' });
  assert.equal((await call(env, 'DELETE', `/box/${ID}`)).status, 200);
  assert.equal((await call(env, 'GET', `/box/${ID}`)).status, 410);
  assert.equal((await call(env, 'PUT', `/box/${ID}`, { ciphertext: 'z', iv: 'y' })).status, 410);
  assert.equal(env.DB.rows.get(ID).ciphertext, '', 'its contents are gone');
});

test('many mailboxes are read in one request, replaced ones marked', async () => {
  const env = { DB: fakeDB() };
  await call(env, 'PUT', `/box/${ID}`, { ciphertext: 'x', iv: 'y', updatedAt: 't1' });
  await call(env, 'DELETE', `/box/${OTHER}`);
  const out = await (await call(env, 'POST', '/boxes', { ids: [ID, OTHER, 'c'.repeat(64)] })).json();
  assert.deepEqual(out, { [ID]: { ciphertext: 'x', iv: 'y', updatedAt: 't1' }, [OTHER]: { replaced: true } });
});

test('bad ids and oversized boxes are refused', async () => {
  const env = { DB: fakeDB() };
  assert.equal((await call(env, 'GET', '/box/not-hex')).status, 400);
  assert.equal((await call(env, 'POST', '/boxes', { ids: ['nope'] })).status, 400);
  const big = 'x'.repeat(64 * 1024 + 1);
  assert.equal((await call(env, 'PUT', `/box/${ID}`, { ciphertext: big, iv: 'y' })).status, 413);
});
