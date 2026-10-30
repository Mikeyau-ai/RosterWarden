/**
 * Tests for the pasted-people-list parser.
 *
 * The parser feeds bulk person creation, so the properties that matter are:
 * names come through untouched, day specs map to the right weekday indices,
 * and an unrecognised day spec is reported as "unknown" (null) rather than
 * quietly becoming "no days".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePeopleList } from '../js/people-import.js';

test('a plain name has no days', () => {
  assert.deepEqual(parsePeopleList('Rachel'), [{ name: 'Rachel', weekdays: null }]);
});

test('blank lines are skipped', () => {
  assert.deepEqual(
    parsePeopleList('Rachel\n\n  \nTom'),
    [{ name: 'Rachel', weekdays: null }, { name: 'Tom', weekdays: null }]
  );
});

test('order is preserved', () => {
  assert.deepEqual(
    parsePeopleList('Charlie\nAlice\nBob').map((p) => p.name),
    ['Charlie', 'Alice', 'Bob']
  );
});

test('day names after a dash become sorted indices', () => {
  assert.deepEqual(parsePeopleList('Sarah - Sat, Sun'), [{ name: 'Sarah', weekdays: [5, 6] }]);
  assert.deepEqual(parsePeopleList('Sarah - sun sat'), [{ name: 'Sarah', weekdays: [5, 6] }]);
});

test('long and short day names both work', () => {
  assert.deepEqual(
    parsePeopleList('Tom - Monday, Wednesday, Friday'),
    [{ name: 'Tom', weekdays: [0, 2, 4] }]
  );
});

test('group words expand', () => {
  assert.equal(parsePeopleList('A - weekdays')[0].weekdays.join(','), '0,1,2,3,4');
  assert.equal(parsePeopleList('B - weekends')[0].weekdays.join(','), '5,6');
  assert.equal(parsePeopleList('C - every day')[0].weekdays.join(','), '0,1,2,3,4,5,6');
  assert.equal(parsePeopleList('D - all')[0].weekdays.join(','), '0,1,2,3,4,5,6');
});

test('explicit "none" is an empty list, not unknown', () => {
  assert.deepEqual(parsePeopleList('Kate - none'), [{ name: 'Kate', weekdays: [] }]);
});

test('an unrecognised day spec is null, not empty', () => {
  assert.deepEqual(parsePeopleList('Kate - whenever'), [{ name: 'Kate', weekdays: null }]);
});

test('en dash, em dash, colon and tab all separate', () => {
  assert.deepEqual(parsePeopleList('Sarah – Sat')[0], { name: 'Sarah', weekdays: [5] });
  assert.deepEqual(parsePeopleList('Sarah — Sat')[0], { name: 'Sarah', weekdays: [5] });
  assert.deepEqual(parsePeopleList('Sarah: Sat')[0], { name: 'Sarah', weekdays: [5] });
  assert.deepEqual(parsePeopleList('Sarah\tSat')[0], { name: 'Sarah', weekdays: [5] });
});

test('a hyphenated name with no spaces is left whole', () => {
  assert.deepEqual(parsePeopleList('Mary-Jane'), [{ name: 'Mary-Jane', weekdays: null }]);
});

test('a pasted bullet list has its bullets stripped', () => {
  assert.deepEqual(
    parsePeopleList('- Sarah\n- Tom - weekends\n* Rachel'),
    [
      { name: 'Sarah', weekdays: null },
      { name: 'Tom', weekdays: [5, 6] },
      { name: 'Rachel', weekdays: null },
    ]
  );
});

test('unknown tokens mixed with real days keep the real ones', () => {
  assert.deepEqual(parsePeopleList('Sam - Sat and Sun please'), [{ name: 'Sam', weekdays: [5, 6] }]);
});

test('a mobile and an email after the name are taken out, with days kept', () => {
  assert.deepEqual(
    parsePeopleList('Sarah Lee, 0400 123 456, sarah@example.com, Sat, Sun'),
    [{ name: 'Sarah Lee', weekdays: [5, 6], email: 'sarah@example.com', mobile: '0400 123 456' }]
  );
  assert.deepEqual(
    parsePeopleList('Tom - sam@example.com'),
    [{ name: 'Tom', weekdays: null, email: 'sam@example.com' }]
  );
});

test('numbers that are not phone numbers are left alone', () => {
  assert.deepEqual(parsePeopleList('Rachel - 12 Nov'), [{ name: 'Rachel', weekdays: null }]);
});
