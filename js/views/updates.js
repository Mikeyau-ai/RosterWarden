/**
 * The Updates sheet: a log of what staff sent through their links (yes or no
 * to shifts, dates they can't work, notes, swaps, changed details), newest
 * first and grouped by day, with the unseen ones marked. It exists because the
 * toast that announces them is gone in a couple of seconds.
 */
import { store } from '../store.js';
import { el, fill, toast, openSheet } from '../ui.js';
import { formatDate, auditRoster, todayISO } from '../scheduler.js';
import { responseKey } from '../sources/planning-center.js';
import * as staff from '../staff.js';
import { pickReplacement } from './roster-parts.js';

/** "Today", "Yesterday" or "Sun 1 Nov" for the local day an entry happened. */
function dayLabel(at) {
  const day = new Date(at).toLocaleDateString('en-CA');   // YYYY-MM-DD, in local time
  if (day === todayISO()) return 'Today';
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA');
  return day === yesterday ? 'Yesterday' : formatDate(day);
}

/**
 * The place a "can't do" entry is about, if the person is still on it and it
 * is still declined; null once the roster has moved on.
 */
function declinedPlace(entry) {
  if (entry.kind !== 'reply' || entry.yes !== false) return null;
  const roster = store.roster(entry.rosterId);
  const place = roster?.assignments.find((a) => a.personId === entry.personId && a.date === entry.date
    && a.shiftId === entry.shiftId && (a.roleId ?? null) === (entry.roleId ?? null));
  return place && roster.responses?.[responseKey(place)] === 'D' ? { roster, place } : null;
}

/**
 * Open the sheet. `openRoster(id)` takes the owner to a roster; `onClose`
 * runs when the sheet closes so the screen beneath can refresh its count.
 */
export function openUpdates({ openRoster, onClose = () => {} }) {
  openSheet('Updates from staff', (body) => draw(body, openRoster), onClose);
}

/** Draw the log into `body`. */
function draw(body, openRoster) {
  const redraw = () => draw(body, openRoster);
  const entries = staff.activityLog();
  const unseen = entries.filter((e) => !e.seen).length;

  const rows = [];
  let lastDay = null;
  for (const e of entries) {
    const day = dayLabel(e.at);
    if (day !== lastDay) { rows.push(el('div', { className: 'label', textContent: day })); lastDay = day; }
    const roster = e.rosterId ? store.roster(e.rosterId) : null;
    const declined = declinedPlace(e);
    rows.push(el('div', { className: e.seen ? 'card' : 'card notice' }, [
      el('div', { textContent: e.text }),
      el('div', { className: 'faint', textContent: new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }),
      roster || declined ? el('div', { className: 'row-tight' }, [
        roster ? el('button', {
          className: 'btn btn-sm', textContent: 'Open roster',
          onclick: () => { staff.markSeen([e.id]); openRoster(roster.id); },
        }) : null,
        declined ? el('button', {
          className: 'btn btn-sm btn-primary', textContent: 'Replace',
          onclick: () => {
            const { roster: r, place } = declined;
            const roleById = new Map(store.roles().map((x) => [x.id, x]));
            // Same change the roster screen makes: save the new places and re-check the notes.
            pickReplacement(r, store.people(), store.shifts(), place, roleById, (next) => {
              store.updateRoster(r.id, {
                assignments: next, notes: auditRoster({ ...r, assignments: next }, store.people(), store.shifts(), store.roles()),
              });
              staff.markSeen([e.id]);
              redraw();
            });
          },
        }) : null,
      ]) : null,
    ]));
  }

  fill(body, [
    el('div', { className: 'spread' }, [
      el('div', { className: 'muted', textContent: unseen ? `${unseen} new` : 'All seen' }),
      unseen ? el('button', {
        className: 'btn btn-sm', textContent: 'Mark all seen',
        onclick: () => { staff.markSeen(); toast('Marked as seen'); redraw(); },
      }) : null,
    ]),
    ...(rows.length ? rows : [el('div', { className: 'muted', textContent: 'Nothing yet. Replies and dates from staff links will be listed here.' })]),
  ]);
}
