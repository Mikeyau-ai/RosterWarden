/**
 * Fairness across rosters, and pinned (locked) places: someone who served in a
 * recent saved roster waits behind someone who didn't, and a locked place is
 * kept exactly while the scheduler fills around it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoster } from '../js/scheduler.js';

/** A person available every day. */
const person = (id, name, extra = {}) => ({
  id, name, active: true, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], blackouts: [], maxShifts: null, ...extra,
});
const cafe = { id: 1, name: 'Cafe', start: '', end: '', headcount: 1 };
const build = (extra) => buildRoster({
  orgId: 1, name: 't', people: [person(1, 'Amy'), person(2, 'Bob'), person(3, 'Cat')],
  shifts: [cafe], clashes: [], dates: ['2026-11-01'], ...extra,
});

test('with no history the first name alphabetically goes first', () => {
  assert.equal(build({}).assignments[0].personId, 1);
});

test('someone who served recently waits behind someone who did not', () => {
  const history = [{ date: '2026-10-25', shiftId: 1, personId: 1 }];
  assert.equal(build({ history }).assignments[0].personId, 2, 'Amy served last week, so Bob is next');
});

test('turns from long ago, or from after the roster starts, do not count', () => {
  const old = [{ date: '2026-06-01', shiftId: 1, personId: 1 }];
  assert.equal(build({ history: old }).assignments[0].personId, 1, 'five months ago is forgotten');
  const later = [{ date: '2026-11-08', shiftId: 1, personId: 1 }];
  assert.equal(build({ history: later }).assignments[0].personId, 1, 'a later roster is not history');
});

test('history does not count against a max-shifts limit', () => {
  const people = [person(1, 'Amy', { maxShifts: 1 }), person(2, 'Bob')];
  const history = [{ date: '2026-10-25', shiftId: 1, personId: 1 }, { date: '2026-10-18', shiftId: 1, personId: 1 }];
  const r = buildRoster({ orgId: 1, name: 't', people, shifts: [{ ...cafe, headcount: 2 }], clashes: [], dates: ['2026-11-01'], history });
  assert.equal(r.assignments.length, 2, 'Amy can still work her one shift in this roster');
});

test('a locked place is kept, and the scheduler fills only what is left', () => {
  const locked = [{ date: '2026-11-01', shiftId: 1, personId: 3 }];
  const r = build({ locked, shifts: [{ ...cafe, headcount: 2 }] });
  const ids = r.assignments.map((a) => a.personId).sort();
  assert.deepEqual(ids, [1, 3], 'Cat is pinned; Amy fills the other place');
  assert.equal(r.assignments.find((a) => a.personId === 3).locked, true);
  assert.equal(r.assignments.find((a) => a.personId === 1).locked, undefined);
});

test('a locked place counts toward a role, so the role is not filled twice', () => {
  const drums = { id: 9, name: 'Drums', anyone: true };
  const band = { id: 2, name: 'Band', start: '', end: '', headcount: 1, roles: [{ roleId: 9, count: 1 }] };
  const locked = [{ date: '2026-11-01', shiftId: 2, personId: 2, roleId: 9 }];
  const r = build({ shifts: [band], roles: [drums], locked });
  assert.equal(r.assignments.length, 1);
  assert.equal(r.assignments[0].personId, 2);
});
