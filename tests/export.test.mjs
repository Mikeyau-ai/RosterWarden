/**
 * Roster export formats: message, per-person, CSV and calendar.
 *
 *   node --test tests/export.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMessage, formatPerPerson, toCSV, toICS, shiftTimes, fileBase, rosterDays,
} from '../js/export.js';

const people = [
  { id: 1, name: 'Sarah' }, { id: 2, name: 'Tom' }, { id: 3, name: 'Rachel' },
];
const shifts = [
  { id: 10, name: 'Cafe', start: '08:00', end: '12:00', headcount: 2 },
  { id: 11, name: 'Setup', start: '', end: '', headcount: 1 },
];
const roster = {
  id: 99,
  name: 'Roster 11 Oct 2026',
  days: ['2026-10-18', '2026-10-11'],
  assignments: [
    { date: '2026-10-11', shiftId: 10, personId: 1 },
    { date: '2026-10-11', shiftId: 10, personId: 2 },
    { date: '2026-10-11', shiftId: 11, personId: 3 },
    { date: '2026-10-18', shiftId: 10, personId: 3 },   // one short; Setup unfilled
  ],
  notes: [],
};

test('rosterDays keeps recorded days in order, including empty ones', () => {
  assert.deepEqual(rosterDays(roster), ['2026-10-11', '2026-10-18']);
});

test('shiftTimes drops leading zeros and is blank without times', () => {
  assert.equal(shiftTimes(shifts[0]), '8:00–12:00');
  assert.equal(shiftTimes(shifts[1]), '');
});

test('the message groups by day and calls out gaps', () => {
  assert.equal(formatMessage(roster, people, shifts), [
    'Roster 11 Oct 2026 (11 Oct – 18 Oct 2026)',
    '',
    'Sun 11 Oct',
    '• Cafe 8:00–12:00: Sarah, Tom',
    '• Setup: Rachel',
    '',
    'Sun 18 Oct',
    '• Cafe 8:00–12:00: Rachel (needs 1 more)',
    '• Setup: nobody yet',
  ].join('\n'));
});

test('per person lists each day, naming the shift when there are several', () => {
  assert.equal(formatPerPerson(roster, people, shifts), [
    "Roster 11 Oct 2026: who's on when",
    '',
    'Rachel: Sun 11 Oct (Setup), Sun 18 Oct (Cafe)',
    'Sarah: Sun 11 Oct (Cafe)',
    'Tom: Sun 11 Oct (Cafe)',
  ].join('\n'));
});

test('per person leaves the shift name out when there is only one', () => {
  const one = { ...roster, assignments: roster.assignments.filter((a) => a.shiftId === 10) };
  assert.match(formatPerPerson(one, people, shifts), /^Rachel: Sun 18 Oct$/m);
});

test('CSV has a row per person, a row per unfilled place, and quotes when needed', () => {
  const tricky = [...people, { id: 4, name: 'Lee, "Jr"' }];
  const r = { ...roster, assignments: [...roster.assignments, { date: '2026-10-18', shiftId: 11, personId: 4 }] };
  const csv = toCSV(r, tricky, shifts);
  assert.ok(csv.startsWith('﻿'));
  assert.deepEqual(csv.slice(1).trim().split('\r\n'), [
    'Date,Day,Shift,Start,End,Person',
    '2026-10-11,Sun,Cafe,08:00,12:00,Sarah',
    '2026-10-11,Sun,Cafe,08:00,12:00,Tom',
    '2026-10-11,Sun,Setup,,,Rachel',
    '2026-10-18,Sun,Cafe,08:00,12:00,Rachel',
    '2026-10-18,Sun,Cafe,08:00,12:00,(unfilled)',
    '2026-10-18,Sun,Setup,,,"Lee, ""Jr"""',
  ]);
});

test('calendar: timed and all-day events, escaping, no event for an empty shift', () => {
  const ics = toICS(roster, people, shifts, new Date('2026-10-07T01:02:03Z'));
  assert.ok(ics.includes('\r\n'));
  const events = ics.split('BEGIN:VEVENT').slice(1);
  assert.equal(events.length, 3);   // 11th Cafe, 11th Setup, 18th Cafe (18th Setup is empty)
  assert.match(events[0], /DTSTART:20261011T080000\r\nDTEND:20261011T120000/);
  assert.match(events[0], /SUMMARY:Cafe: Sarah\\, Tom/);
  assert.match(events[0], /DTSTAMP:20261007T010203Z/);
  assert.match(events[1], /DTSTART;VALUE=DATE:20261011\r\nDTEND;VALUE=DATE:20261012/);
  assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2\.0/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
});

test('calendar: a shift ending after midnight ends the next day', () => {
  const night = [{ id: 10, name: 'Night', start: '22:00', end: '02:00', headcount: 1 }];
  const r = { ...roster, days: ['2026-10-31'], assignments: [{ date: '2026-10-31', shiftId: 10, personId: 1 }] };
  assert.match(toICS(r, people, night), /DTSTART:20261031T220000\r\nDTEND:20261101T020000/);
});

test('fileBase makes a safe file name', () => {
  assert.equal(fileBase({ name: 'Christmas: 24/25 Dec!' }), 'Christmas-24-25-Dec');
  assert.equal(fileBase({ name: '' }), 'roster');
});
