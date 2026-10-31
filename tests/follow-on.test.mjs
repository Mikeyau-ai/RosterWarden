/**
 * Tests for the dates New Roster starts with: the weeks after the latest
 * roster, and the month an empty calendar opens on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { followOnDates, rollOn, openingMonthDate } from '../js/scheduler.js';

/** A saved roster covering these dates. */
const roster = (days, extra = {}) => ({ days, assignments: [], ...extra });

test('rollOn moves a fortnight on by two weeks, keeping the weekdays', () => {
  assert.deepEqual(rollOn(['2026-10-03', '2026-10-04', '2026-10-10', '2026-10-11']),
    ['2026-10-17', '2026-10-18', '2026-10-24', '2026-10-25']);
});

test('followOnDates rolls on the roster with the latest last date, not the newest saved', () => {
  const rosters = [
    roster(['2026-10-03', '2026-10-10']),                 // saved most recently, but earlier dates
    roster(['2026-10-24', '2026-10-31']),
  ];
  assert.deepEqual(followOnDates(rosters, '2026-10-24'), ['2026-11-07', '2026-11-14']);
});

test('followOnDates skips forward past weeks already gone', () => {
  // A one-Saturday roster from August, looked at in late October.
  assert.deepEqual(followOnDates([roster(['2026-08-01'])], '2026-10-24'), ['2026-10-24']);
});

test('followOnDates ignores drafts and returns nothing with no rosters', () => {
  assert.deepEqual(followOnDates([], '2026-10-24'), []);
  assert.deepEqual(followOnDates([roster(['2026-11-07'], { draft: true })], '2026-10-24'), []);
});

test('followOnDates falls back to the dates an older roster has places on', () => {
  const old = { assignments: [{ date: '2026-10-25' }, { date: '2026-10-24' }] };
  assert.deepEqual(followOnDates([old], '2026-10-24'), ['2026-10-31', '2026-11-01']);
});

test('followOnDates leaves out a one-off day the workplace is normally shut', () => {
  // Weekends only, plus a special Thursday opening on 29 Oct.
  const rosters = [roster(['2026-10-24', '2026-10-25', '2026-10-29', '2026-10-31'])];
  assert.deepEqual(followOnDates(rosters, '2026-10-24', [5, 6]), ['2026-11-07', '2026-11-08', '2026-11-14']);
});

test('openingMonthDate stays on this month until its last 10 days', () => {
  assert.equal(openingMonthDate('2026-10-21'), '2026-10-21');
  assert.equal(openingMonthDate('2026-10-22'), '2026-11-01');
  assert.equal(openingMonthDate('2026-12-31'), '2027-01-01');
  assert.equal(openingMonthDate('2026-02-19'), '2026-03-01');   // 28-day month
});

test('a month roster rolls on to the same weekdays across the whole next month', () => {
  const novWeekends = ['2026-11-01', '2026-11-07', '2026-11-08', '2026-11-14', '2026-11-15',
    '2026-11-21', '2026-11-22', '2026-11-28', '2026-11-29'];
  assert.deepEqual(rollOn(novWeekends), ['2026-12-05', '2026-12-06', '2026-12-12', '2026-12-13',
    '2026-12-19', '2026-12-20', '2026-12-26', '2026-12-27']);
  // December rolls into January of the next year.
  assert.deepEqual(rollOn(['2026-12-05', '2026-12-26']), ['2027-01-02', '2027-01-09', '2027-01-16',
    '2027-01-23', '2027-01-30']);
});
