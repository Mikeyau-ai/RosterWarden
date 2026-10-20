/**
 * The owner's side of staff links: make, send and replace a person's link,
 * pick up the dates they sent, and publish their name and upcoming shifts back
 * to their link page.
 *
 * What a staff member sends is their whole current list of dates they can't
 * work, not a change, so applying it is simple and repeatable: their dates
 * replace the away dates that came from their link before (tagged
 * `source: 'staff'`), and away dates the owner entered are never touched.
 */
import { store } from './store.js';
import * as link from './staff-link.js';
import { todayISO } from './scheduler.js';
import { shiftTimes } from './export.js';

/** Tag on away dates that came from a person's own link. */
export const SOURCE = 'staff';

/** Longest note a staff member can leave, in characters. */
const NOTE_MAX = 500;

/** Whether a person has a staff link. */
export function hasLink(person) {
  return Boolean(person?.staffLink?.key);
}

/** Everyone, across all organisations, who has a link. */
function linked(ids = null) {
  return store.data.people.filter((p) => hasLink(p) && (!ids || ids.includes(p.id)));
}

/** Patch a person's link record. */
function patchLink(personId, patch) {
  const person = store.data.people.find((p) => p.id === personId);
  if (person) store.updatePerson(personId, { staffLink: { ...person.staffLink, ...patch } });
}

/** The dates a person entered through their link, sorted. */
export function staffDates(person) {
  const out = [];
  for (const b of person.blackouts || []) {
    if (b.source !== SOURCE) continue;
    for (let d = b.start; d <= b.end; d = nextDay(d)) out.push(d);
  }
  return [...new Set(out)].sort();
}

/** The ISO date after `iso`. */
function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Give a person a link and put their name and shifts on it. */
export async function createLink(personId) {
  store.updatePerson(personId, {
    staffLink: { key: link.newLinkKey(), sentAt: null, sentVia: null, lastFromStaff: null, note: '', outHash: null },
  });
  try { await publish([personId]); } catch { /* published on the next sync instead */ }
}

/** Record that the link was sent, and how (email, text, share, copy). */
export function markSent(personId, via) {
  patchLink(personId, { sentAt: new Date().toISOString(), sentVia: via });
}

/**
 * Replace a person's link: pick up anything waiting on the old one, cancel it
 * on the server so it can never write again, and give them a new one that
 * starts with the same dates.
 */
export async function replaceLink(personId) {
  await collect([personId]);
  const person = store.data.people.find((p) => p.id === personId);
  const { inId, outId } = await link.boxesFor(person.staffLink.key);
  await link.replaceBox(inId);
  await link.replaceBox(outId);
  patchLink(personId, { key: link.newLinkKey(), sentAt: null, sentVia: null, outHash: null });
  try { await publish([personId]); } catch { /* published on the next sync instead */ }
}

/** Take away every date a person entered through their link. */
export function clearStaffDates(personId) {
  store.replaceSourcedBlackouts(personId, SOURCE, []);
}

/** Only well-formed ISO dates, de-duplicated and sorted, at most 400. */
function cleanDates(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))]
    .sort().slice(0, 400);
}

/**
 * Pick up what staff have sent since last time and apply it. Returns the
 * people whose dates changed.
 */
export async function collect(ids = null) {
  const people = linked(ids);
  if (people.length === 0) return [];
  const keys = new Map();
  for (const p of people) keys.set(p.id, await link.boxesFor(p.staffLink.key));
  const boxes = await link.readBoxes(people.map((p) => ({ id: keys.get(p.id).inId, cryptoKey: keys.get(p.id).cryptoKey })));

  const changed = [];
  for (const p of people) {
    const box = boxes.get(keys.get(p.id).inId);
    if (!box || box.replaced) continue;
    if (p.staffLink.lastFromStaff && box.updatedAt <= p.staffLink.lastFromStaff) continue;
    const dates = cleanDates(box.value?.awayDates);
    store.replaceSourcedBlackouts(p.id, SOURCE, dates.map((d) => ({ start: d, end: d, reason: 'from their link' })));
    patchLink(p.id, { lastFromStaff: box.updatedAt, note: String(box.value?.note || '').slice(0, NOTE_MAX) });
    changed.push(store.data.people.find((x) => x.id === p.id));
  }
  return changed;
}

/** A short fingerprint of some text (FNV-1a), to tell whether a link page needs rewriting. */
function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** A person's upcoming shifts from saved rosters, for their link page. */
function upcomingShifts(person) {
  const today = todayISO();
  const shiftOf = new Map(store.data.shifts.map((s) => [s.id, s]));
  const roleOf = new Map(store.data.roles.map((r) => [r.id, r.name]));
  return store.data.rosters
    .filter((r) => r.orgId === person.orgId && !r.draft)
    .flatMap((r) => r.assignments.filter((a) => a.personId === person.id && a.date >= today))
    .sort((x, y) => x.date.localeCompare(y.date))
    .slice(0, 60)
    .map((a) => {
      const shift = shiftOf.get(a.shiftId);
      return {
        date: a.date,
        shift: shift?.name || 'Shift',
        times: shift ? shiftTimes(shift) : '',
        role: a.roleId != null ? roleOf.get(a.roleId) || null : null,
      };
    });
}

/**
 * Put each person's name, organisation, the dates they gave, and their
 * upcoming shifts on their link page. Only written when something changed.
 */
export async function publish(ids = null) {
  for (const p of linked(ids)) {
    const org = store.data.orgs.find((o) => o.id === p.orgId);
    const content = { name: p.name, org: org?.name || '', awayDates: staffDates(p), shifts: upcomingShifts(p) };
    const fingerprint = shortHash(JSON.stringify(content));
    if (fingerprint === p.staffLink.outHash) continue;
    const { outId, cryptoKey } = await link.boxesFor(p.staffLink.key);
    try {
      await link.writeBox(outId, cryptoKey, content);
      patchLink(p.id, { outHash: fingerprint });
    } catch (e) {
      if (!(e instanceof link.LinkReplaced)) throw e;
    }
  }
}

/**
 * Places on saved rosters from today on where someone is now away - what a
 * new date from their link (or anywhere) has just clashed with.
 */
export function clashes(people) {
  const today = todayISO();
  const out = [];
  for (const p of people) {
    const away = (d) => (p.blackouts || []).some((b) => b.start <= d && d <= b.end);
    for (const r of store.data.rosters) {
      if (r.draft || r.orgId !== p.orgId) continue;
      for (const a of r.assignments) {
        if (a.personId === p.id && a.date >= today && away(a.date)) out.push({ person: p, date: a.date, roster: r.name });
      }
    }
  }
  return out;
}

/** Collect what staff sent, then refresh everyone's link page. Returns who changed. */
export async function syncStaff() {
  if (linked().length === 0) return [];
  const changed = await collect();
  await publish();
  return changed;
}
