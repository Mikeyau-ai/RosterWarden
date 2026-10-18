/**
 * Roles inside shifts: a shift made of roles ("Lead singer", "Drums") is filled
 * role by role, a person is only put on a role they can do, the hardest role to
 * cover is filled first, and what couldn't be filled is reported per role.
 * Run with:  node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRoster, auditRoster, formatTable, canDoRole, counts } from '../js/scheduler.js';

const SUNDAY = ['2026-10-11'];

/** A person who can work any day and does the given roles. */
function person(id, name, roleIds = [], extra = {}) {
  return { id, name, active: true, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], blackouts: [], maxShifts: null, roleIds, ...extra };
}
/** A role. */
function role(id, name, anyone = false) {
  return { id, name, anyone };
}
/** A shift of roles: [[roleId, count], ...]. Its headcount is their total, as the store keeps it. */
function band(id, name, rolesNeeded) {
  return {
    id, name, start: '09:00', end: '11:00', roles: rolesNeeded.map(([roleId, count]) => ({ roleId, count })),
    headcount: rolesNeeded.reduce((sum, [, count]) => sum + count, 0),
  };
}
const build = (people, shifts, roles, dates = SUNDAY) =>
  buildRoster({ orgId: 1, name: 't', people, shifts, clashes: [], dates, roles });

const LEAD = 11, BACKUP = 12, GUITAR = 13, DRUMS = 14;
const ROLES = [role(LEAD, 'Lead singer'), role(BACKUP, 'Backup singer'), role(GUITAR, 'Guitar'), role(DRUMS, 'Drums')];

/** Who is on a role, by name, sorted. */
function onRole(roster, people, roleId) {
  const name = new Map(people.map((p) => [p.id, p.name]));
  return roster.assignments.filter((a) => a.roleId === roleId).map((a) => name.get(a.personId)).sort();
}

test('a shift of roles puts each person on a role they can do, and records it', () => {
  const people = [
    person(1, 'Anna', [LEAD, BACKUP]), person(2, 'Ben', [GUITAR]),
    person(3, 'Cat', [DRUMS]), person(4, 'Dan', [BACKUP]),
  ];
  const shifts = [band(1, 'Worship', [[LEAD, 1], [BACKUP, 1], [GUITAR, 1], [DRUMS, 1]])];
  const r = build(people, shifts, ROLES);
  assert.equal(r.assignments.length, 4);
  assert.deepEqual(onRole(r, people, LEAD), ['Anna']);
  assert.deepEqual(onRole(r, people, GUITAR), ['Ben']);
  assert.deepEqual(onRole(r, people, DRUMS), ['Cat']);
  assert.deepEqual(onRole(r, people, BACKUP), ['Dan'], 'Anna is used on lead, so Dan takes backup');
  assert.deepEqual(r.notes, []);
});

test('nobody is put on a role they are not ticked for: it is left empty and reported', () => {
  const people = [person(1, 'Anna', [LEAD]), person(2, 'Ben', [GUITAR])];
  const shifts = [band(1, 'Worship', [[LEAD, 1], [DRUMS, 1]])];
  const r = build(people, shifts, ROLES);
  assert.deepEqual(onRole(r, people, LEAD), ['Anna']);
  assert.deepEqual(onRole(r, people, DRUMS), [], 'Ben plays guitar, not drums, so drums stays empty');
  assert.ok(r.notes.some((n) => /Worship, Drums: only 0 of 1 filled/.test(n)), r.notes.join(' | '));
});

test('the role with the fewest spare people is filled first, so the only drummer is not used up elsewhere', () => {
  // Cat is the only drummer but can also sing backup; Dan can only sing backup. With backup listed
  // first, a plain fill would put Cat (alphabetically first) on backup and leave the drums empty.
  const people = [person(3, 'Cat', [BACKUP, DRUMS]), person(4, 'Dan', [BACKUP])];
  const shifts = [band(1, 'Worship', [[BACKUP, 1], [DRUMS, 1]])];
  const r = build(people, shifts, ROLES);
  assert.deepEqual(onRole(r, people, DRUMS), ['Cat']);
  assert.deepEqual(onRole(r, people, BACKUP), ['Dan']);
  assert.deepEqual(r.notes, []);
});

test('a role open to anyone needs no ticks; a role needing a tick does', () => {
  const SERVE = 21, COFFEE = 22;
  const roles = [role(SERVE, 'Serving', true), role(COFFEE, 'Making coffee')];
  const people = [person(1, 'Amy'), person(2, 'Bo'), person(3, 'Cy', [COFFEE])];
  const shifts = [band(1, 'Cafe', [[SERVE, 2], [COFFEE, 1]])];
  const r = build(people, shifts, roles);
  assert.deepEqual(onRole(r, people, COFFEE), ['Cy']);
  assert.deepEqual(onRole(r, people, SERVE), ['Amy', 'Bo']);
  const byId = new Map(roles.map((x) => [x.id, x]));
  assert.equal(canDoRole(person(9, 'Zed'), SERVE, byId), true);
  assert.equal(canDoRole(person(9, 'Zed'), COFFEE, byId), false);
});

test('a shift without roles still fills by headcount and records no role', () => {
  const people = [person(1, 'Amy'), person(2, 'Bo'), person(3, 'Cy')];
  const r = build(people, [{ id: 1, name: 'Cafe', start: '', end: '', headcount: 2 }], []);
  assert.equal(r.assignments.length, 2);
  assert.ok(r.assignments.every((a) => !('roleId' in a)));
});

test('a person is on one shift a day, and a shift with no roles is left short when everyone is already on', () => {
  const people = [person(1, 'Anna', [LEAD, GUITAR]), person(2, 'Ben', [GUITAR])];
  const shifts = [band(1, 'Worship', [[LEAD, 1], [GUITAR, 1]]), { id: 2, name: 'Pack up', start: '', end: '', headcount: 1 }];
  const r = build(people, shifts, ROLES);
  const byPerson = counts(r);
  assert.equal(byPerson.get(1), 1);
  assert.equal(byPerson.get(2), 1);
  assert.equal(r.assignments.filter((a) => a.shiftId === 2).length, 0, 'both are already on today, so Pack up is short');
  assert.ok(r.notes.some((n) => /Pack up: only 0 of 1 filled/.test(n)));
});

test('fairness still applies within a role: the person with the fewest shifts takes it', () => {
  const people = [person(1, 'Anna', [DRUMS]), person(2, 'Ben', [DRUMS])];
  const r = build(people, [band(1, 'Worship', [[DRUMS, 1]])], ROLES, ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25']);
  assert.deepEqual([...counts(r).values()].sort(), [2, 2]);
});

test('people with no roles ticked are reported when every shift is made of roles', () => {
  const people = [person(1, 'Anna', [LEAD]), person(2, 'Ben', []), person(3, 'Cat', [DRUMS])];
  const r = build(people, [band(1, 'Worship', [[LEAD, 1]])], ROLES);
  assert.ok(r.notes.includes('Ben was not rostered at all - no roles ticked.'), r.notes.join(' | '));
  assert.ok(r.notes.includes('Cat was not rostered at all - none of their roles are needed on these shifts.'));
});

test('audit after a manual edit counts per role, and a removed role is named as such', () => {
  const people = [person(1, 'Anna', [LEAD])];
  const shifts = [band(1, 'Worship', [[LEAD, 1], [DRUMS, 1]])];
  const roster = { days: SUNDAY, assignments: [{ date: SUNDAY[0], shiftId: 1, personId: 1, roleId: LEAD }] };
  assert.deepEqual(
    auditRoster(roster, people, shifts, ROLES).filter((n) => /only/.test(n)),
    ['Sun 11 Oct 2026 - Worship, Drums: only 0 of 1 filled.'],
  );
  assert.ok(auditRoster(roster, people, shifts, [ROLES[0]]).some((n) => /\(removed role\): only 0 of 1/.test(n)));
});

test('the text table says which role each person has', () => {
  const people = [person(1, 'Anna', [LEAD]), person(2, 'Cat', [DRUMS])];
  const shifts = [band(1, 'Worship', [[LEAD, 1], [DRUMS, 1]])];
  const r = build(people, shifts, ROLES);
  const text = formatTable(r, people, shifts, ROLES);
  assert.match(text, /Anna \(Lead singer\)/);
  assert.match(text, /Cat \(Drums\)/);
});

test('the same input gives the same roster', () => {
  const people = [person(1, 'Anna', [LEAD, BACKUP]), person(2, 'Ben', [BACKUP, GUITAR]), person(3, 'Cat', [DRUMS, GUITAR])];
  const shifts = [band(1, 'Worship', [[LEAD, 1], [BACKUP, 1], [GUITAR, 1], [DRUMS, 1]])];
  const a = build(people, shifts, ROLES, ['2026-10-04', '2026-10-11']);
  const b = build(people, shifts, ROLES, ['2026-10-04', '2026-10-11']);
  assert.deepEqual(a, b);
});
