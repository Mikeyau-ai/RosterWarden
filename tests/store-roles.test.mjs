/**
 * The store's side of roles: data saved before roles existed upgrades in place,
 * roles are unique by name, a shift's headcount follows its roles, and deleting
 * a role cleans up everything that pointed at it. Runs against an in-memory
 * stand-in for localStorage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** A minimal localStorage, installed before the store is used. */
function installStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
  return map;
}

const { store } = await import('../js/store.js');

/** A fresh store with one organisation. */
function fresh() {
  installStorage();
  store.reset();
  store.load();
  store.addOrg('Church');
  return store;
}

test('data saved before roles existed upgrades in place and keeps working', () => {
  const map = installStorage();
  const v2 = {
    version: 2,
    orgs: [{ id: 1, name: 'Cafe', openDays: [0, 1, 2, 3, 4, 5, 6], openTime: '', closeTime: '' }],
    currentOrgId: 1,
    shifts: [{ id: 2, orgId: 1, name: 'Cafe', start: '08:00', end: '12:00', headcount: 2, order: 0 }],
    people: [{ id: 3, orgId: 1, name: 'Amy', active: true, availableWeekdays: [5], blackouts: [], requests: [], maxShifts: null, notes: '' }],
    clashes: [],
    rosters: [{ id: 4, orgId: 1, name: 'Old', assignments: [{ date: '2026-10-10', shiftId: 2, personId: 3 }], notes: [] }],
    settings: {},
  };
  map.set('rosterwarden.v1', JSON.stringify(v2));
  store.load();
  assert.equal(store.data.version, 3);
  assert.deepEqual(store.data.roles, []);
  assert.deepEqual(store.shifts()[0].roles, []);
  assert.deepEqual(store.people()[0].roleIds, []);
  assert.equal(store.shifts()[0].headcount, 2, 'a shift with no roles still means "2 people"');
  assert.deepEqual(store.rosters()[0].assignments, v2.rosters[0].assignments, 'old rosters are untouched');
  // Written back, so the upgrade does not run again.
  assert.equal(JSON.parse(map.get('rosterwarden.v1')).version, 3);
});

test('a backup file from before roles restores and upgrades', () => {
  installStorage();
  store.reset();
  const v2 = {
    version: 2, orgs: [{ id: 1, name: 'Cafe' }], currentOrgId: 1, shifts: [{ id: 2, orgId: 1, name: 'A', headcount: 1, order: 0 }],
    people: [{ id: 3, orgId: 1, name: 'Amy', active: true, availableWeekdays: [], blackouts: [], requests: [] }],
    clashes: [], rosters: [], settings: {},
  };
  store.importJSON(JSON.stringify(v2));
  assert.equal(store.data.version, 3);
  assert.deepEqual(store.people()[0].roleIds, []);
  assert.deepEqual(store.shifts()[0].roles, []);
});

test('a role is unique by name whatever the capitals, and a blank name makes none', () => {
  const s = fresh();
  const drums = s.addRole('  Drums ');
  assert.equal(drums.name, 'Drums');
  assert.equal(s.addRole('drums').id, drums.id);
  assert.equal(s.addRole('   '), null);
  assert.equal(s.roles().length, 1);
  const bass = s.addRole('Bass');
  assert.equal(s.updateRole(bass.id, { name: 'DRUMS' }), false, 'renaming onto another role is refused');
  assert.equal(s.updateRole(bass.id, { name: 'Bass guitar' }), true);
  assert.equal(s.roles().find((r) => r.id === bass.id).name, 'Bass guitar');
});

test('roles belong to their organisation', () => {
  const s = fresh();
  s.addRole('Drums');
  s.addOrg('Cafe');
  assert.deepEqual(s.roles(), [], 'the new organisation starts with none');
  s.addRole('Drums');
  assert.equal(s.roles().length, 1, 'the same name can exist in another organisation');
  const cafe = s.currentOrg().id;
  s.deleteOrg(cafe);
  assert.equal(s.data.roles.filter((r) => r.orgId === cafe).length, 0);
  assert.equal(s.data.roles.length, 1);
});

test('a shift with roles has a headcount equal to their total; zero removes a role; order is kept', () => {
  const s = fresh();
  const shift = s.addShift({ name: 'Worship', headcount: 9 });
  const lead = s.addRole('Lead singer');
  const backup = s.addRole('Backup singer');
  const drums = s.addRole('Drums');
  s.setShiftRole(shift.id, lead.id, 1);
  s.setShiftRole(shift.id, backup.id, 2);
  s.setShiftRole(shift.id, drums.id, 1);
  assert.equal(s.shifts()[0].headcount, 4);
  s.setShiftRole(shift.id, backup.id, 3);
  assert.deepEqual(s.shifts()[0].roles.map((r) => r.roleId), [lead.id, backup.id, drums.id], 'a changed count keeps its place');
  assert.equal(s.shifts()[0].headcount, 5);
  s.setShiftRole(shift.id, lead.id, 0);
  assert.deepEqual(s.shifts()[0].roles.map((r) => r.roleId), [backup.id, drums.id]);
  assert.equal(s.shifts()[0].headcount, 4);
  s.setShiftRole(shift.id, 9999, 'abc');   // a nonsense count adds nothing
  assert.equal(s.shifts()[0].roles.length, 2);
});

test('deleting a role takes it off shifts and people, and leaves saved rosters readable', () => {
  const s = fresh();
  const shift = s.addShift({ name: 'Worship' });
  const drums = s.addRole('Drums');
  const lead = s.addRole('Lead singer');
  s.setShiftRole(shift.id, drums.id, 1);
  s.setShiftRole(shift.id, lead.id, 1);
  const sam = s.addPerson('Sam', [6]);
  s.updatePerson(sam.id, { roleIds: [drums.id, lead.id] });
  s.saveRoster({
    orgId: s.currentOrg().id, name: 'Oct', startDate: '2026-10-11', endDate: '2026-10-11', days: ['2026-10-11'], notes: [],
    assignments: [{ date: '2026-10-11', shiftId: shift.id, personId: sam.id, roleId: drums.id }],
  });
  s.deleteRole(drums.id);
  assert.deepEqual(s.shifts()[0].roles.map((r) => r.roleId), [lead.id]);
  assert.deepEqual(s.people()[0].roleIds, [lead.id]);
  assert.equal(s.rosters()[0].assignments[0].roleId, drums.id, 'the roster still says Drums');
  assert.deepEqual(s.roles().map((r) => r.order), [0]);
});

test('new shifts and people start with no roles, and a role does not default to "anyone"', () => {
  const s = fresh();
  assert.deepEqual(s.addShift({ name: 'A' }).roles, []);
  assert.deepEqual(s.addPerson('Amy').roleIds, []);
  assert.equal(s.addRole('Drums').anyone, false);
});

test('copying a shift copies its roles and times, and puts the copy right after it', () => {
  const s = fresh();
  const nine = s.addShift({ name: '9am', start: '09:00', end: '10:30', headcount: 1 });
  const last = s.addShift({ name: 'Pack up', headcount: 1 });
  const drums = s.addRole('Drums');
  s.setShiftRole(nine.id, drums.id, 2);

  const copy = s.duplicateShift(nine.id);
  assert.equal(copy.name, '9am (copy)');
  assert.deepEqual([copy.start, copy.end, copy.headcount], ['09:00', '10:30', 2]);
  assert.deepEqual(copy.roles, [{ roleId: drums.id, count: 2 }]);
  assert.deepEqual(s.shifts().map((x) => x.name), ['9am', '9am (copy)', 'Pack up']);

  copy.roles[0].count = 5;
  assert.equal(nine.roles[0].count, 2, 'changing the copy leaves the original alone');
  assert.equal(last.name, 'Pack up');
});

test('a new person is available on the days the organisation is open, unless told otherwise', () => {
  const s = fresh();
  s.updateOrg(s.currentOrg().id, { openDays: [6] });
  assert.deepEqual(s.addPerson('Amy').availableWeekdays, [6]);
  assert.deepEqual(s.addPerson('Bo', [0, 1]).availableWeekdays, [0, 1], 'stated days win');
  assert.deepEqual(s.addPerson('Cy', []).availableWeekdays, [], 'an explicit none stays none');
});
