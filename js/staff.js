/**
 * The owner's side of staff links: make, send and replace a person's link,
 * pick up the dates they sent, and publish their name and upcoming shifts back
 * to their link page.
 *
 * What a staff member sends is their whole current list of dates they can't
 * work, not a change, so applying it is simple and repeatable: their dates
 * replace the away dates that came from their link before (tagged
 * `source: 'staff'`), and away dates the owner entered are never touched.
 *
 * The same mailboxes carry shift swaps (see "Shift swaps" at the end), and
 * each person's yes or no to their own shifts (see takeReplies).
 */
import { store } from './store.js';
import * as link from './staff-link.js';
import { todayISO, toDays, fromDays, formatDate, auditRoster, shiftOn } from './scheduler.js';
import { shiftTimes } from './export.js';
import { responseKey } from './sources/planning-center.js';

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

  // Swaps on days long gone are history nobody needs.
  const cutoff = fromDays(toDays(todayISO()) - 30);
  store.data.swaps = store.data.swaps.filter((w) => w.date >= cutoff);

  const changed = [];
  for (const p of people) {
    const box = boxes.get(keys.get(p.id).inId);
    if (!box || box.replaced) continue;
    if (p.staffLink.lastFromStaff && box.updatedAt <= p.staffLink.lastFromStaff) continue;
    takeSwaps(p, box.value);
    takeReplies(p, box.value);
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

/**
 * The date, shift name, times and role of a place, as a link page shows it.
 * `roster` is the roster the place belongs to, so a shift that runs differently
 * on that day is described as it runs then.
 */
function describePlace(place, roster) {
  const shift = shiftOn(roster, place.date, place.shiftId, store.data.shifts);
  const role = place.roleId != null ? store.data.roles.find((r) => r.id === place.roleId) : null;
  return {
    date: place.date,
    shift: shift?.name || 'Shift',
    times: shift ? shiftTimes(shift) : '',
    role: role ? role.name : null,
    note: shift?.note || '',
  };
}

/** 'yes', 'no' or null: the answer a roster holds for one place (from their link or Planning Center). */
function replyOf(roster, place) {
  const code = roster.responses?.[responseKey(place)];
  return code === 'C' ? 'yes' : code === 'D' ? 'no' : null;
}

/** A person's upcoming shifts from saved rosters, for their link page. */
function upcomingShifts(person) {
  const today = todayISO();
  return store.data.rosters
    .filter((r) => r.orgId === person.orgId && !r.draft)
    .flatMap((r) => r.assignments
      .filter((a) => a.personId === person.id && a.date >= today)
      .map((a) => ({ ...describePlace(a, r), ref: placeRef(r.id, a), reply: replyOf(r, a) })))
    .sort((x, y) => x.date.localeCompare(y.date))
    .slice(0, 60);
}

/**
 * Put each person's name, organisation, the dates they gave, and their
 * upcoming shifts on their link page. Only written when something changed.
 */
export async function publish(ids = null) {
  settleStale();
  for (const p of linked(ids)) {
    const org = store.data.orgs.find((o) => o.id === p.orgId);
    const content = {
      name: p.name, org: org?.name || '', awayDates: staffDates(p), shifts: upcomingShifts(p), swaps: swapPage(p),
    };
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

// ------------------------------------------------------------ shift swaps --
/*
 * A staff member can ask anyone else in the workplace to take one of their
 * upcoming shifts, available or not (they may want the extra shift), and that
 * colleague says yes or no on their own page. How far a yes goes is the
 * organisation's `swapMode`:
 *
 *   'off'      no swaps (the default)
 *   'self'     the colleague's yes hands the shift over
 *   'approval' the colleague's yes waits for the owner to approve it
 *
 * Staff have no channel to each other, so it all goes through the owner's
 * app: the ask arrives in the asker's mailbox and is published to the
 * colleague's page, whose answer comes back in their own mailbox. Like away
 * dates, a page always sends its whole list of asks and answers, so taking
 * them in is repeatable. A swap's status is one of: asked, accepted (waiting
 * for the owner), done, declined (by the colleague), rejected (by the owner),
 * or cancelled (withdrawn, swaps turned off, or the shift had changed).
 */

/** The choices for an organisation's `swapMode`. */
export const SWAP_MODES = ['off', 'self', 'approval'];

/** Statuses of a swap that is still going. */
const OPEN = ['asked', 'accepted'];

/** What a swap id from a staff page must look like. */
const SWAP_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Messages about swaps picked up since the app last asked, for a toast. */
let swapNews = [];

/** An organisation's swap setting, 'off' when it has none. */
export function swapMode(org) {
  return SWAP_MODES.includes(org?.swapMode) ? org.swapMode : 'off';
}

/**
 * Change an organisation's swap setting. Turning swaps off cancels the asks
 * no colleague has answered; ones already agreed still wait for the owner.
 */
export function setSwapMode(orgId, mode) {
  if (mode === 'off') {
    for (const w of store.data.swaps) if (w.orgId === orgId && w.status === 'asked') decide(w, 'cancelled');
  }
  store.updateOrg(orgId, { swapMode: mode });
}

/** Hand back, and forget, what happened with swaps since last asked. */
export function takeSwapNews() {
  const out = swapNews;
  swapNews = [];
  return out;
}

/** How a staff page refers to one place on a roster. */
function placeRef(rosterId, place) {
  return `${rosterId}:${place.date}:${place.shiftId}:${place.roleId ?? ''}`;
}

/** Whether `place` is the one a swap is for, still held by the asker. */
function isSwapPlace(swap, place) {
  return place.date === swap.date && place.shiftId === swap.shiftId
    && (place.roleId ?? null) === swap.roleId && place.personId === swap.fromId;
}

/** A person's name by id. */
function nameOf(id) {
  return store.data.people.find((p) => p.id === id)?.name || 'Someone';
}

/** Give a swap its next status. */
function decide(swap, status) {
  swap.status = status;
  swap.decidedAt = new Date().toISOString();
}

/**
 * Hand a swap's place to the colleague, locked so a rebuild keeps it, with the
 * roster's notes re-checked. False if the asker no longer has that place.
 */
function handOver(swap) {
  const roster = store.roster(swap.rosterId);
  const place = roster?.assignments.find((a) => isSwapPlace(swap, a));
  if (!place) return false;
  const next = roster.assignments.map((a) => (a === place ? { ...a, personId: swap.toId, locked: true } : a));
  // The roster's own organisation, which need not be the one open on screen.
  const ofOrg = (list) => list.filter((x) => x.orgId === roster.orgId).sort((a, b) => a.order - b.order || a.id - b.id);
  store.updateRoster(roster.id, {
    assignments: next,
    notes: auditRoster({ ...roster, assignments: next }, ofOrg(store.data.people), ofOrg(store.data.shifts), ofOrg(store.data.roles)),
  });
  return true;
}

/**
 * Cancel swaps still going whose asker no longer has the place, because the
 * owner changed or rebuilt the roster since, so nobody is left waiting on them.
 */
function settleStale() {
  let changed = false;
  for (const w of store.data.swaps) {
    if (!OPEN.includes(w.status)) continue;
    if (store.roster(w.rosterId)?.assignments.some((a) => isSwapPlace(w, a))) continue;
    decide(w, 'cancelled');
    changed = true;
  }
  if (changed) store.save();
}

/** "Sam's 1 Nov shift", for a toast. */
function swapLabel(swap) {
  return `${nameOf(swap.fromId).split(' ')[0]}'s ${formatDate(swap.date, { withWeekday: false })} shift`;
}

/** The upcoming saved-roster place a person's page means by `ref`, or null. */
function findPlace(person, ref) {
  const today = todayISO();
  for (const roster of store.data.rosters) {
    if (roster.draft || roster.orgId !== person.orgId) continue;
    const place = roster.assignments.find((a) => a.personId === person.id && a.date >= today && placeRef(roster.id, a) === ref);
    if (place) return { roster, place };
  }
  return null;
}

/** Take in the swap asks and answers in what a person last sent. */
function takeSwaps(person, value) {
  const mode = swapMode(store.data.orgs.find((o) => o.id === person.orgId));
  const asks = Array.isArray(value?.swapAsks) ? value.swapAsks.slice(0, 100) : null;
  const answers = Array.isArray(value?.swapAnswers) ? value.swapAnswers.slice(0, 100) : [];

  // A page from before swaps sends no list at all, which withdraws nothing.
  if (asks) {
    const sent = new Set();
    for (const ask of asks) {
      if (typeof ask?.id !== 'string' || !SWAP_ID.test(ask.id)) continue;
      sent.add(ask.id);
      if (mode === 'off' || store.data.swaps.some((w) => w.id === ask.id)) continue;
      // Anyone active in the same workplace, whatever their availability.
      const to = store.data.people.find((p) => p.id === ask.toId && p.orgId === person.orgId && p.id !== person.id && p.active && hasLink(p));
      const found = findPlace(person, String(ask.ref || ''));
      if (!to || !found) continue;
      const { roster, place } = found;
      // One ask at a time for any one place.
      if (store.data.swaps.some((w) => OPEN.includes(w.status) && w.rosterId === roster.id && isSwapPlace(w, place))) continue;
      store.data.swaps.push({
        id: ask.id, orgId: person.orgId, rosterId: roster.id,
        date: place.date, shiftId: place.shiftId, roleId: place.roleId ?? null,
        fromId: person.id, toId: to.id, status: 'asked', askedAt: new Date().toISOString(), decidedAt: null,
      });
      swapNews.push(`${person.name.split(' ')[0]} asked ${to.name.split(' ')[0]} to take their ${formatDate(place.date, { withWeekday: false })} shift`);
    }
    // An ask no longer in their list was withdrawn.
    for (const w of store.data.swaps) {
      if (w.fromId === person.id && OPEN.includes(w.status) && !sent.has(w.id)) decide(w, 'cancelled');
    }
  }

  for (const answer of answers) {
    const swap = store.data.swaps.find((w) => w.id === answer?.id && w.toId === person.id && w.status === 'asked');
    if (!swap || mode === 'off') continue;
    const taker = nameOf(swap.toId).split(' ')[0];
    if (answer.accept !== true) {
      decide(swap, 'declined');
    } else if (mode === 'approval') {
      decide(swap, 'accepted');
      swapNews.push(`${taker} agreed to take ${swapLabel(swap)}: approve it on Roster`);
    } else if (handOver(swap)) {
      decide(swap, 'done');
      swapNews.push(`${taker} took ${swapLabel(swap)}`);
    } else {
      decide(swap, 'cancelled');
    }
  }
  store.save();
}

/**
 * Take in a person's yes or no to their own upcoming shifts. Like everything
 * a page sends, it is their whole list, so taking it in again changes nothing.
 * Answers go in the roster's `responses` with the same codes Planning Center
 * replies use ('C' can do it, 'D' can't), so the roster shows ✓ or ✕ and a
 * "can't" lands in its declined list. A place that has since gone to someone
 * else no longer matches, so their answer simply drops.
 */
function takeReplies(person, value) {
  const replies = Array.isArray(value?.shiftReplies) ? value.shiftReplies.slice(0, 200) : [];
  for (const r of replies) {
    if (typeof r?.yes !== 'boolean') continue;
    const found = findPlace(person, String(r.ref || ''));
    if (!found) continue;
    const { roster, place } = found;
    const key = responseKey(place);
    const code = r.yes ? 'C' : 'D';
    if (roster.responses?.[key] === code) continue;
    store.updateRoster(roster.id, { responses: { ...roster.responses, [key]: code } });
    const { shift } = describePlace(place, roster);
    swapNews.push(`${person.name.split(' ')[0]} ${r.yes ? 'can do' : 'can\'t do'} ${formatDate(place.date, { withWeekday: false })} ${shift}`);
  }
}

/** What a person's link page needs for swaps: the setting, their colleagues, and the asks to and from them. */
function swapPage(person) {
  const mode = swapMode(store.data.orgs.find((o) => o.id === person.orgId));
  if (mode === 'off') return { mode };
  const today = todayISO();
  const upcoming = store.data.swaps.filter((w) => w.date >= today);
  return {
    mode,
    // Only people with a link of their own can see an ask and answer it.
    colleagues: store.data.people
      .filter((p) => p.orgId === person.orgId && p.active && p.id !== person.id && hasLink(p))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ id: p.id, name: p.name })),
    // Their own asks, so the page can say how each is going.
    out: upcoming.filter((w) => w.fromId === person.id).map((w) => ({
      id: w.id, ref: placeRef(w.rosterId, w), toId: w.toId, toName: nameOf(w.toId), status: w.status, ...describePlace(w, store.roster(w.rosterId)),
    })),
    // Asks waiting for their answer.
    in: upcoming.filter((w) => w.toId === person.id && w.status === 'asked').map((w) => ({
      id: w.id, fromName: nameOf(w.fromId), ...describePlace(w, store.roster(w.rosterId)),
    })),
  };
}

/** Swaps in the current organisation still going, optionally on one roster, as `{ swap, label }`. */
export function openSwaps(rosterId = null) {
  settleStale();
  const today = todayISO();
  return store.data.swaps
    .filter((w) => w.orgId === store.data.currentOrgId && OPEN.includes(w.status) && w.date >= today)
    .filter((w) => rosterId == null || w.rosterId === rosterId)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((swap) => {
      const place = describePlace(swap, store.roster(swap.rosterId));
      return {
        swap,
        label: `${nameOf(swap.fromId)} → ${nameOf(swap.toId)} · ${formatDate(swap.date, { withWeekday: false })} · ${place.shift}${place.role ? `, ${place.role}` : ''}`,
      };
    });
}

/**
 * The owner's answer to a swap both staff agreed. Approving hands the shift
 * over; it returns false when it couldn't, because the roster has changed and
 * the asker no longer has that place (the swap is then cancelled).
 */
export function decideSwap(id, approve) {
  const swap = store.data.swaps.find((w) => w.id === id && w.status === 'accepted');
  if (!swap) return false;
  if (!approve) {
    decide(swap, 'rejected');
    store.save();
    return true;
  }
  const ok = handOver(swap);
  decide(swap, ok ? 'done' : 'cancelled');
  store.save();
  return ok;
}
