/**
 * Staff links end to end, with the real worker code behind a stand-in
 * database: the owner makes a link, the staff member sends dates, the owner's
 * app applies them without touching dates the owner entered, and a replaced
 * link can never write again while the dates carry over.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { BOX_SQL } from '../worker/src/index.js';

// ── a browser-ish environment: localStorage, and fetch routed into the worker ──
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const rows = new Map();
const DB = {
  prepare(sql) {
    return {
      bind(...a) {
        return {
          first: async () => rows.get(a[0]) || null,
          run: async () => {
            if (sql === BOX_SQL.write && !rows.get(a[0])?.revoked) {
              rows.set(a[0], { ciphertext: a[1], iv: a[2], updated_at: a[3], revoked: 0 });
            } else if (sql === BOX_SQL.revoke) {
              rows.set(a[0], { ciphertext: '', iv: '', updated_at: a[1], revoked: 1 });
            }
          },
        };
      },
    };
  },
};
globalThis.fetch = (url, opts) => worker.fetch(new Request(url, opts), { DB });

const { store } = await import('../js/store.js');
const staff = await import('../js/staff.js');
const link = await import('../js/staff-link.js');

/** A fresh store with one person. */
function setUp() {
  mem.clear(); rows.clear();
  store.reset(); store.load(); store.addOrg('Catering');
  return store.addPerson('Sam Jones');
}
/** What the staff member's page does: send their dates through their link. */
async function staffSends(key, awayDates, note = '') {
  const { inId, cryptoKey } = await link.boxesFor(key);
  // Distinct timestamps, so each send is newer than the last.
  await new Promise((r) => setTimeout(r, 5));
  return link.writeBox(inId, cryptoKey, { awayDates, note });
}

test('a new link publishes their name for their page, and nothing on the server is readable', async () => {
  const sam = setUp();
  await staff.createLink(sam.id);
  const key = store.people()[0].staffLink.key;
  const { outId, cryptoKey } = await link.boxesFor(key);
  const page = await link.readBox(outId, cryptoKey);
  assert.equal(page.value.name, 'Sam Jones');
  assert.equal(page.value.org, 'Catering');
  assert.ok(![...rows.values()].some((r) => r.ciphertext.includes('Sam')), 'names never reach the server');
});

test('dates sent through the link become away dates, and leave the owner\'s own alone', async () => {
  const sam = setUp();
  store.addBlackout(sam.id, '2026-12-25', '2026-12-25', 'Christmas');
  await staff.createLink(sam.id);
  const key = store.people()[0].staffLink.key;

  await staffSends(key, ['2026-11-08', '2026-11-15'], 'wedding');
  const changed = await staff.syncStaff();
  assert.equal(changed.length, 1);
  let p = store.people()[0];
  assert.deepEqual(staff.staffDates(p), ['2026-11-08', '2026-11-15']);
  assert.equal(p.staffLink.note, 'wedding');
  assert.ok(p.blackouts.some((b) => b.start === '2026-12-25' && !b.source), 'owner-entered date kept');

  // A second send replaces the first; nothing new means nothing changes.
  await staffSends(key, ['2026-11-22']);
  await staff.syncStaff();
  p = store.people()[0];
  assert.deepEqual(staff.staffDates(p), ['2026-11-22']);
  assert.equal((await staff.syncStaff()).length, 0);
});

test('a replaced link can never send again, and the dates carry over to the new one', async () => {
  const sam = setUp();
  await staff.createLink(sam.id);
  const oldKey = store.people()[0].staffLink.key;
  await staffSends(oldKey, ['2026-11-08']);

  await staff.replaceLink(sam.id);   // picks up the waiting send first
  const p = store.people()[0];
  assert.notEqual(p.staffLink.key, oldKey);
  assert.deepEqual(staff.staffDates(p), ['2026-11-08']);
  await assert.rejects(staffSends(oldKey, ['2026-11-29']), link.LinkReplaced);

  const { outId, cryptoKey } = await link.boxesFor(p.staffLink.key);
  assert.deepEqual((await link.readBox(outId, cryptoKey)).value.awayDates, ['2026-11-08'], 'new link starts with their dates');
});

test('clearing takes away only the dates from their link', async () => {
  const sam = setUp();
  store.addBlackout(sam.id, '2026-12-25', '2026-12-25', 'Christmas');
  await staff.createLink(sam.id);
  await staffSends(store.people()[0].staffLink.key, ['2026-11-08']);
  await staff.syncStaff();
  staff.clearStaffDates(sam.id);
  assert.deepEqual(store.people()[0].blackouts.map((b) => b.start), ['2026-12-25']);
});

test('a new away date that clashes with a saved roster is found', async () => {
  const sam = setUp();
  const shift = store.addShift({ name: 'Wedding', start: '10:00', end: '16:00', headcount: 1 });
  store.saveRoster({ orgId: store.currentOrg().id, name: 'Nov', days: ['2099-11-08'], notes: [],
    assignments: [{ date: '2099-11-08', shiftId: shift.id, personId: sam.id }] });
  await staff.createLink(sam.id);
  await staffSends(store.people()[0].staffLink.key, ['2099-11-08']);
  const changed = await staff.syncStaff();
  assert.deepEqual(staff.clashes(changed).map((c) => [c.date, c.roster]), [['2099-11-08', 'Nov']]);
});
