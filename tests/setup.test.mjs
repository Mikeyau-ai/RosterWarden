/**
 * The setup wizard's commit step: a draft becomes one organisation with its
 * opening days, shifts, shared roles and people, ticked for the right roles.
 * Runs against an in-memory stand-in for localStorage.
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
}

const { store } = await import('../js/store.js');
const { applySetup, templateShifts, skilledRoleNames, shiftSize, TEMPLATES } = await import('../js/setup.js');

/** A fresh, empty store. */
function fresh() {
  installStorage();
  store.reset();
  store.load();
}

test('a draft becomes one selected workplace with its hours, shifts and people', () => {
  fresh();
  const org = applySetup({
    name: '  Church Cafe ',
    openDays: [5, 6], openTime: '08:00', closeTime: '13:00',
    shifts: [
      { name: 'Morning', start: '08:00', end: '10:30', headcount: 2, roles: [] },
      { name: '  ', start: '', end: '', headcount: 1, roles: [] },   // blank row: skipped
    ],
    people: [
      { name: 'Amy', weekdays: [5], roleNames: [] },
      { name: 'Ben', weekdays: null, roleNames: [] },
      { name: '', weekdays: null, roleNames: [] },                  // blank row: skipped
    ],
  });

  assert.equal(store.currentOrg().id, org.id);
  assert.equal(org.name, 'Church Cafe');
  assert.deepEqual(store.openDays(), [5, 6]);
  assert.equal(store.currentOrg().closeTime, '13:00');
  assert.deepEqual(store.shifts().map((s) => [s.name, s.headcount]), [['Morning', 2]]);
  const people = store.people();
  assert.deepEqual(people.map((p) => p.name), ['Amy', 'Ben']);
  assert.deepEqual(people[0].availableWeekdays, [5]);
  assert.deepEqual(people[1].availableWeekdays, [0, 1, 2, 3, 4, 5, 6]);
});

test('roles are shared by name across shifts and people are ticked for them', () => {
  fresh();
  applySetup({
    name: 'Band',
    shifts: [
      { name: '9am', headcount: 1, roles: [{ name: 'Drums', count: 1 }, { name: 'Setup', count: 2, anyone: true }] },
      { name: '11am', headcount: 1, roles: [{ name: 'drums', count: 1 }] },
    ],
    people: [{ name: 'Sam', weekdays: null, roleNames: ['DRUMS', 'Nonexistent'] }],
  });

  const roles = store.roles();
  assert.deepEqual(roles.map((r) => [r.name, r.anyone]), [['Drums', false], ['Setup', true]]);
  const [nine, eleven] = store.shifts();
  assert.equal(nine.headcount, 3);                    // follows its roles
  assert.equal(eleven.roles[0].roleId, roles[0].id);  // same role, not a second "drums"
  assert.deepEqual(store.people()[0].roleIds, [roles[0].id]);
});

test('templates hand out copies, so editing a draft never changes the template', () => {
  const draft = templateShifts('band');
  draft[0].roles[0].name = 'Changed';
  assert.equal(TEMPLATES.band.shifts[0].roles[0].name, 'Lead singer');
  assert.deepEqual(templateShifts('nonsense'), templateShifts('cafe'));
});

test('skilled roles skip "anyone" roles and repeats; size follows roles', () => {
  const shifts = [
    { name: 'A', headcount: 4, roles: [{ name: 'Keys', count: 1 }, { name: 'Usher', count: 2, anyone: true }] },
    { name: 'B', headcount: 3, roles: [{ name: 'keys', count: 1 }] },
    { name: 'C', headcount: 3, roles: [] },
  ];
  assert.deepEqual(skilledRoleNames(shifts), ['Keys']);
  assert.deepEqual(shifts.map(shiftSize), [3, 1, 3]);
});
