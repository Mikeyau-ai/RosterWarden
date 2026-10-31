/**
 * Tests for the sync encryption.
 *
 * The claim this code makes is a strong one - that whoever runs the server
 * cannot read what it holds - so the properties that claim rests on are worth
 * proving rather than assuming.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// The module reads localStorage at call time, not import time; a stub keeps
// the device-state helpers usable under Node.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

const {
  generateCode, normaliseCode, deriveKeys, encrypt, decrypt,
} = await import('../js/sync.js');

const SAMPLE = {
  orgs: [{ id: 1, name: 'Church Cafe' }],
  people: [{ id: 2, name: 'Sarah', availableWeekdays: [5, 6] }],
};

test('a generated code is readable and avoids look-alike characters', () => {
  const code = generateCode();
  assert.match(code, /^[a-z0-9-]+$/);
  assert.ok(code.includes('-'), 'grouped for copying by hand');
  // 0/O and 1/l/I are the classic mis-transcriptions.
  assert.ok(!/[01loi]/.test(code.replace(/-/g, '')), `unexpected look-alike in ${code}`);
});

test('codes are not predictable', () => {
  const codes = new Set(Array.from({ length: 50 }, generateCode));
  assert.equal(codes.size, 50, 'every generated code should differ');
});

test('formatting a code does not change what it means', async () => {
  const a = await deriveKeys('abcd-efgh-jkmn');
  const b = await deriveKeys('  ABCD EFGH JKMN  ');
  assert.equal(a.storageId, b.storageId);
  assert.equal(normaliseCode('AB-cd EF'), 'abcdef');
});

test('a value survives a round trip', async () => {
  const code = generateCode();
  const { cryptoKey } = await deriveKeys(code);
  const restored = await decrypt(await encrypt(SAMPLE, cryptoKey), cryptoKey);
  assert.deepEqual(restored, SAMPLE);
});

test('the storage id leaks nothing about the contents', async () => {
  const code = generateCode();
  const { storageId, cryptoKey } = await deriveKeys(code);
  const { ciphertext } = await encrypt(SAMPLE, cryptoKey);

  assert.match(storageId, /^[0-9a-f]{64}$/);
  // The id is what the server sees. It must not be the secret itself, and the
  // stored bytes must not contain anything readable.
  assert.ok(!storageId.includes(normaliseCode(code)));
  const decoded = Buffer.from(ciphertext, 'base64').toString('binary');
  for (const secret of ['Church Cafe', 'Sarah']) {
    assert.ok(!decoded.includes(secret), `"${secret}" should not be readable in the blob`);
  }
});

test('the wrong code cannot decrypt the data', async () => {
  const { cryptoKey } = await deriveKeys(generateCode());
  const payload = await encrypt(SAMPLE, cryptoKey);
  const { cryptoKey: otherKey } = await deriveKeys(generateCode());

  await assert.rejects(() => decrypt(payload, otherKey));
});

test('tampered data is rejected rather than silently accepted', async () => {
  const { cryptoKey } = await deriveKeys(generateCode());
  const payload = await encrypt(SAMPLE, cryptoKey);

  // Flip a byte in the middle of the ciphertext. AES-GCM authenticates, so
  // this must fail loudly - a store that returned altered rosters without
  // complaint would be worse than one that returned nothing.
  const bytes = Buffer.from(payload.ciphertext, 'base64');
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  await assert.rejects(
    () => decrypt({ ...payload, ciphertext: bytes.toString('base64') }, cryptoKey)
  );
});

test('every write uses a fresh nonce', async () => {
  const { cryptoKey } = await deriveKeys(generateCode());
  const first = await encrypt(SAMPLE, cryptoKey);
  const second = await encrypt(SAMPLE, cryptoKey);

  // Same key and same plaintext must still produce different bytes, otherwise
  // an observer could tell that nothing had changed between two writes.
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test('two different codes never collide', async () => {
  const ids = new Set();
  for (let i = 0; i < 25; i++) {
    ids.add((await deriveKeys(generateCode())).storageId);
  }
  assert.equal(ids.size, 25);
});

test('sync switches itself on the first time, once only', async () => {
  mem.clear();
  const { autoEnable, currentCode, setCode, isConfigured } = await import('../js/sync.js');

  if (!isConfigured()) {
    // No server built in: there is nothing to switch on, and that is correct.
    assert.equal(autoEnable(), false);
    return;
  }

  assert.equal(autoEnable(), true, 'switches itself on for a new device');
  const first = currentCode();
  assert.ok(first, 'and leaves a code behind');

  // The second launch must not mint a new code - that would orphan the data
  // uploaded under the first one.
  assert.equal(autoEnable(), false, 'does not run again');
  assert.equal(currentCode(), first, 'and keeps the same code');
  setCode(null);
});

test('a deliberate "off" is not undone by the next launch', async () => {
  mem.clear();
  const { setDisabled, isDisabled, autoEnable } = await import('../js/sync.js');

  setDisabled(true);
  assert.equal(isDisabled(), true);
  assert.equal(autoEnable(), false, 'must respect the user turning it off');

  setDisabled(false);
  assert.equal(isDisabled(), false);
});

