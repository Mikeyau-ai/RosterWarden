/**
 * Open shifts: shifts sent out before a roster is built, for staff to take
 * first come, first served through their links (see "Open shifts" in
 * js/staff.js for the owner's side and js/views/staff.js for the staff page).
 *
 * An open set is `{ id, orgId, key, days, dayShifts, sentAt, closedAt, claims }`:
 * the dates and each date's shifts as they were sent, a random key shared with
 * every staff page (it names and encrypts the claims on the server), and
 * `claims`, which slot each person took, as last read from the server.
 *
 * Every place to fill is a "slot", named by a ref "date:shiftId:roleId:n",
 * where n counts the places for that role (or for the shift, with no roles).
 *
 * This file is plain logic with no storage or network, so it can be tested.
 */
import { slotsOf, canDoRole } from './scheduler.js';

/** Every slot in an open set, in date then shift order: `{ ref, date, shift, shiftId, roleId, n }`. */
export function slotsFor(open) {
  const out = [];
  for (const date of [...open.days].sort()) {
    for (const shift of open.dayShifts?.[date] || []) {
      for (const { roleId, count } of slotsOf(shift)) {
        for (let n = 0; n < count; n++) {
          out.push({ ref: `${date}:${shift.id}:${roleId ?? ''}:${n}`, date, shift, shiftId: shift.id, roleId, n });
        }
      }
    }
  }
  return out;
}

/** The slots one person could take: those for a role they can do. `roleById` maps role ids to roles. */
export function slotsForPerson(open, person, roleById) {
  return slotsFor(open).filter((s) => canDoRole(person, s.roleId, roleById));
}

/**
 * "Sam T." for "Sam Taylor": first name and last initial, the name a taken
 * shift shows. When someone in `others` (everyone else's full names) would
 * look the same, more of the last name is used until they don't ("Sam Ta."
 * and "Sam Tu."). A single name stays as it is.
 */
export function shortName(name, others = []) {
  const split = (n) => String(n || '').trim().split(/\s+/).filter(Boolean);
  const parts = split(name);
  if (parts.length === 0) return 'Someone';
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const last = parts.at(-1);
  // Others with the same first name, by last name, to tell apart from.
  const rivals = others.map(split)
    .filter((o) => o.length > 1 && o[0].toLowerCase() === first.toLowerCase())
    .map((o) => o.at(-1).toLowerCase());
  let k = 1;
  while (k < last.length && rivals.some((r) => r.startsWith(last.slice(0, k).toLowerCase()))) k++;
  const cut = last[0].toUpperCase() + last.slice(1, k);
  return `${first} ${cut}${k < last.length ? '.' : ''}`;
}

/**
 * Settle the claims read from the server into `{ ref: { personId, name, at } }`.
 * Each slot already has one holder (the server lets only the first take it);
 * this keeps one slot per person per day, the earliest taken, in case two
 * were taken at once from two phones.
 */
export function settleClaims(claims) {
  const out = {};
  const held = new Set();
  const sorted = [...claims].sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.ref.localeCompare(b.ref));
  for (const c of sorted) {
    const day = `${c.personId}@${c.ref.slice(0, 10)}`;
    if (held.has(day)) continue;
    held.add(day);
    out[c.ref] = { personId: c.personId, name: c.name, at: c.at };
  }
  return out;
}

/**
 * The places taken in an open set, as locked assignments for building on
 * `dates`. `dayListFor(date)` gives the shifts that date will run now: a slot
 * whose shift (or role place) is no longer there is dropped, and so is anyone
 * `keep(personId)` turns down (someone since deleted or made inactive).
 */
export function lockedFrom(open, dates, dayListFor, keep = () => true) {
  const want = new Set(dates);
  const out = [];
  for (const slot of slotsFor(open)) {
    const claim = open.claims?.[slot.ref];
    if (!claim || !want.has(slot.date) || !keep(claim.personId)) continue;
    const now = dayListFor(slot.date).find((s) => s.id === slot.shiftId);
    const places = now ? slotsOf(now).find((x) => (x.roleId ?? null) === (slot.roleId ?? null)) : null;
    if (!places || slot.n >= places.count) continue;
    out.push({
      date: slot.date, shiftId: slot.shiftId, personId: claim.personId, locked: true,
      ...(slot.roleId != null ? { roleId: slot.roleId } : {}),
    });
  }
  return out;
}

/**
 * Who has answered an open set and who hasn't, among `people` (those with a
 * link). Taking a shift, or saying "can't" to a day, from their page counts.
 */
export function answered(open, people) {
  const took = new Set(Object.values(open.claims || {}).map((c) => c.personId));
  const yes = [];
  const no = [];
  for (const p of people) (took.has(p.id) || p.staffLink?.openReplied === open.id ? yes : no).push(p);
  return { answered: yes, waiting: no };
}
