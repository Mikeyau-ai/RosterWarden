/**
 * Rosters with their own shifts per date (`roster.dayShifts`).
 *
 *   node --test tests/day-shifts.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRoster, auditRoster, shiftsOn, shiftOn, rosterShiftList, formatTable, runsOn,
} from '../js/scheduler.js';
import { rosterLines, formatMessage, hoursByPerson, messageFor } from '../js/export.js';

const D1 = '2026-06-01';
const D2 = '2026-06-02';
const D3 = '2026-06-03';

/** Build a test person, available every day. */
function person(id, name) {
  return { id, name, active: true, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], blackouts: [], maxShifts: null };
}
const people = [1, 2, 3, 4, 5].map((i) => person(i, `P${i}`));

const usual = [{ id: 10, name: 'Cafe', start: '08:00', end: '12:00', headcount: 1 }];
const oneOff = { id: 900, name: 'Gala', start: '18:00', end: '22:00', headcount: 3, note: 'Black tie' };

/** Build with the usual shifts plus the given per-day lists. */
function build(dayShifts, extra = {}) {
  return buildRoster({
    orgId: 1, name: 't', people, shifts: usual, clashes: [], dates: [D1, D2], dayShifts, ...extra,
  });
}

test('shiftsOn / rosterShiftList fall back to the usual shifts', () => {
  assert.equal(shiftsOn({}, D1, usual), usual);
  assert.equal(shiftsOn({ dayShifts: { [D2]: [] } }, D1, usual), usual);
  assert.deepEqual(shiftsOn({ dayShifts: { [D2]: [] } }, D2, usual), []);
  assert.equal(rosterShiftList({}, usual), usual);
  assert.equal(shiftOn({ dayShifts: { [D1]: [oneOff] } }, D1, 10, usual).name, 'Cafe');
});

test('rosterShiftList is the distinct shifts across the days, first seen first', () => {
  const r = { days: [D1, D2], dayShifts: { [D2]: [usual[0], oneOff], [D1]: [usual[0]] } };
  assert.deepEqual(rosterShiftList(r, usual).map((s) => s.id), [10, 900]);
});

test('rosterShiftList includes the usual shifts of a day with no list of its own', () => {
  const r = { days: [D1, D2], dayShifts: { [D1]: [oneOff] } };
  assert.deepEqual(rosterShiftList(r, usual).map((s) => s.id), [900, 10]);
});

test('buildRoster uses each day\'s own shifts and keeps only the roster\'s days', () => {
  const r = build({ [D1]: usual, [D2]: [oneOff], [D3]: [oneOff] });
  assert.deepEqual(Object.keys(r.dayShifts).sort(), [D1, D2]);
  assert.deepEqual(r.assignments.filter((a) => a.date === D1).map((a) => a.shiftId), [10]);
  assert.deepEqual(r.assignments.filter((a) => a.date === D2).map((a) => a.shiftId), [900, 900, 900]);
});

test('a roster built without dayShifts keeps its own copy of the usual shifts', () => {
  const r = build(undefined);
  assert.deepEqual(r.dayShifts[D1], [{ id: 10, name: 'Cafe', start: '08:00', end: '12:00', headcount: 1, roles: [] }]);
  assert.notEqual(r.dayShifts[D1], usual[0]);
});

test('a usual shift with days set only runs on those weekdays', () => {
  // 2026-06-01 is a Monday (0), 2026-06-02 a Tuesday (1).
  const mondays = [{ ...usual[0], days: [0] }];
  assert.equal(runsOn(mondays[0], D1), true);
  assert.equal(runsOn(mondays[0], D2), false);
  assert.equal(runsOn(usual[0], D2), true);
  const r = buildRoster({ orgId: 1, name: 't', people, shifts: mondays, clashes: [], dates: [D1, D2] });
  assert.deepEqual(r.dayShifts[D2], []);
  assert.deepEqual(r.assignments.map((a) => a.date), [D1]);
});

test('no usual shift running on any date picked says so', () => {
  const r = buildRoster({ orgId: 1, name: 't', people, shifts: [{ ...usual[0], days: [5] }], clashes: [], dates: [D1, D2] });
  assert.deepEqual(r.notes, ['None of your shifts run on the dates picked.']);
});

test('a day with an empty list gets nothing and no understaffed note', () => {
  const r = build({ [D1]: usual, [D2]: [] });
  assert.equal(r.assignments.filter((a) => a.date === D2).length, 0);
  assert.deepEqual(r.notes.filter((n) => n.includes('02 Jun')), []);
});

test('every day empty reports no shifts set up', () => {
  const r = build({ [D1]: [], [D2]: [] });
  assert.deepEqual(r.notes, ['None of your shifts run on the dates picked.']);
  assert.equal(r.assignments.length, 0);
});

test('auditRoster flags a short one-off shift by its own name and headcount', () => {
  const r = build({ [D1]: usual, [D2]: [oneOff] });
  const firstGala = r.assignments.find((a) => a.shiftId === 900);
  const short = { ...r, assignments: r.assignments.filter((a) => a.shiftId !== 900 || a === firstGala) };
  const notes = auditRoster(short, people, usual);
  assert.ok(notes.some((n) => n.includes('Gala: only 1 of 3 filled.')));
});

test('rosterLines and formatMessage show a one-off on its day only', () => {
  const r = build({ [D1]: usual, [D2]: [oneOff] });
  const lines = rosterLines(r, people, usual);
  assert.deepEqual(lines[0].shifts.map((s) => s.shift.name), ['Cafe']);
  assert.deepEqual(lines[1].shifts.map((s) => s.shift.name), ['Gala']);
  const text = formatMessage(r, people, usual);
  assert.ok(text.includes('Gala 18:00–22:00'));
  assert.equal(text.split('Gala').length, 2);
  assert.ok(formatTable(r, people, usual).split('\n')[0].includes('Gala (18:00-22:00)'));
});

test('hours and messages use the shift as it runs that day', () => {
  const longer = { ...usual[0], end: '14:00' };
  const r = { name: 'R', dayShifts: { [D2]: [longer] }, assignments: [
    { date: D1, shiftId: 10, personId: 1 }, { date: D2, shiftId: 10, personId: 1 },
  ] };
  assert.equal(hoursByPerson(r, usual).get(1), 4 + 6);
  assert.ok(messageFor(r, people[0], usual).includes('8:00–14:00'));
});

test('locked places on a one-off shift survive a rebuild', () => {
  const dayShifts = { [D1]: usual, [D2]: [oneOff] };
  const locked = [{ date: D2, shiftId: 900, personId: 5 }];
  const r = build(dayShifts, { locked });
  const kept = r.assignments.filter((a) => a.shiftId === 900);
  assert.equal(kept.length, 3);
  assert.ok(kept.some((a) => a.personId === 5 && a.locked));
});
