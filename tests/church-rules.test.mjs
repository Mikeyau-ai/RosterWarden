/**
 * Rules churches ask for: people who serve together, people who serve less
 * often, and people who only serve in certain weeks of the month.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoster, canWork } from '../js/scheduler.js';

/** A person available every day. */
const person = (id, name, extra = {}) => ({
  id, name, active: true, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], blackouts: [], maxShifts: null, ...extra,
});
const cafe = (headcount) => ({ id: 1, name: 'Cafe', start: '', end: '', headcount });
const build = (people, shifts, dates, extra = {}) => buildRoster({
  orgId: 1, name: 't', people, shifts, clashes: [], dates, ...extra,
});
const ids = (r, date) => r.assignments.filter((a) => a.date === date).map((a) => a.personId).sort();

test('a partner is put on the same shift as the person they serve with', () => {
  // Amy is first in the queue; her partner Dan would otherwise come last.
  const people = [person(1, 'Amy', { withIds: [4] }), person(2, 'Bob'), person(3, 'Cat'), person(4, 'Dan', { withIds: [1] })];
  assert.deepEqual(ids(build(people, [cafe(2)], ['2026-11-01']), '2026-11-01'), [1, 4]);
});

test('a partner who cannot come is not forced, and the shift is filled from the queue', () => {
  const people = [person(1, 'Amy', { withIds: [4] }), person(2, 'Bob'), person(4, 'Dan', { availableWeekdays: [0] })];
  // 2026-11-03 is a Tuesday: Dan is off, so Amy gets Bob as the second place.
  assert.deepEqual(ids(build(people, [cafe(2)], ['2026-11-03']), '2026-11-03'), [1, 2]);
});

test('a partner does not take a place on a role they cannot do', () => {
  const drums = { id: 9, name: 'Drums', anyone: false };
  const band = { id: 2, name: 'Band', start: '', end: '', headcount: 1, roles: [{ roleId: 9, count: 1 }] };
  const people = [person(1, 'Amy', { withIds: [2], roleIds: [9] }), person(2, 'Bob', { withIds: [1], roleIds: [] })];
  const r = build(people, [band], ['2026-11-01'], { roles: [drums] });
  assert.deepEqual(r.assignments.map((a) => a.personId), [1], 'Bob is not a drummer, so he stays off');
});

test('someone who serves less often goes behind others, but is used when nobody else is left', () => {
  const people = [person(1, 'Amy', { minGapWeeks: 4 }), person(2, 'Bob')];
  const dates = ['2026-11-01', '2026-11-08', '2026-11-15'];
  const r = build(people, [cafe(1)], dates);
  // Amy is first alphabetically and takes the first Sunday; her 4-week gap then keeps her off the next two.
  assert.deepEqual(dates.map((d) => ids(r, d)[0]), [1, 2, 2]);
  const alone = build([person(1, 'Amy', { minGapWeeks: 4 })], [cafe(1)], dates);
  assert.equal(alone.assignments.length, 3, 'with nobody else, her gap is ignored rather than leaving shifts empty');
});

test('week-of-month availability limits someone to those weeks', () => {
  const p = person(1, 'Amy', { weeksOfMonth: [1, 3] });
  assert.equal(canWork(p, '2026-11-01'), true, '1st Sunday');
  assert.equal(canWork(p, '2026-11-08'), false, '2nd Sunday');
  assert.equal(canWork(p, '2026-11-15'), true, '3rd Sunday');
  assert.equal(canWork(p, '2026-11-29'), false, '5th Sunday');
  assert.equal(canWork(person(2, 'Bob'), '2026-11-08'), true, 'no weeks set means any week');
});

test('a request for a date overrides the week-of-month limit', () => {
  const p = person(1, 'Amy', { weeksOfMonth: [1], requests: ['2026-11-08'] });
  assert.equal(canWork(p, '2026-11-08'), true);
});
