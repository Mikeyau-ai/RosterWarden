/**
 * Roster screen: browse the rosters you have saved, and open one to review,
 * copy, share, or delete it. Follows the same list-then-detail pattern as
 * the People screen - there is no side-by-side layout on a phone.
 */
import { store } from '../store.js';
import { formatDate, auditRoster } from '../scheduler.js';
import { el, fill, toast, confirmDialog, emptyState } from '../ui.js';
import {
  editableDayCards, dayCards, tally, notesBox, exportButton,
} from './roster-parts.js';
import * as planningCenter from './planning-center.js';
import { show } from '../app.js';
import * as builderView from './roster.js';
import * as sync from '../sync.js';

// Id of the saved roster currently open, or null when showing the list.
let openId = null;

// Whether the open roster is in manual-edit mode. Reset whenever the list is
// shown or a different roster is opened.
let editing = false;

/** Entry point: render the list, or the opened roster, into `container`. */
export function render(container) {
  const rosters = store.rosters();
  if (rosters.length === 0) {
    openId = null;
    // The nudge belongs here too: people and shifts are worth losing even
    // before a single roster has been saved.
    fill(container, [...backupNudge(), emptyState(
      'No rosters yet',
      'Make one on the New Roster screen and save it — it will show up here.',
      el('button', {
        className: 'btn btn-primary', textContent: 'New Roster', onclick: () => show('new'),
      })
    )]);
    return;
  }

  const opened = openId != null ? rosters.find((r) => r.id === openId) : null;
  if (opened) {
    fill(container, renderOpen(opened, container));
  } else {
    openId = null;
    editing = false;
    fill(container, [...backupNudge(), ...renderList(rosters, container)]);
  }
}

/**
 * A reminder to export, shown on the list once a backup is overdue.
 *
 * With sync switched off, an export is the only thing between a cleared
 * browser and losing everything. Saying so on the screen people actually open
 * beats a line in a README nobody reads.
 */
function backupNudge() {
  // Sync switches itself on, so the code can exist without the user ever
  // having seen it - and it is the one thing that cannot be recovered. Ask
  // until they say they have it.
  if (sync.isEnabled() && !sync.codeAcknowledged()) {
    return [el('div', { className: 'notice' }, [
      el('strong', { textContent: 'Save your sync code' }),
      el('div', {
        textContent: 'Your rosters are backed up automatically, but the code that '
          + 'unlocks them exists only on this device. Write it down and this will stop asking.',
      }),
      el('button', {
        className: 'btn btn-sm', textContent: 'Show my code',
        style: 'margin-top:.5rem',
        onclick: () => show('settings', { section: 'sync' }),
      }),
    ])];
  }

  // With sync on, the data is already off this device, so the warning below
  // would simply be untrue. Sync's own state is reported in Settings.
  if (sync.isEnabled()) return [];
  if (!store.backupOverdue()) return [];
  const days = store.daysSinceBackup();

  return [el('div', { className: 'notice' }, [
    el('strong', {
      textContent: days === null ? 'No backup yet' : `Last backup was ${days} days ago`,
    }),
    el('div', {
      textContent: 'Your rosters live only on this device. If the browser data is '
        + 'cleared, they are gone. Exporting takes a second.',
    }),
    el('button', {
      className: 'btn btn-sm', textContent: 'Export backup now',
      style: 'margin-top:.5rem',
      onclick: () => show('settings', { section: 'backup' }),
    }),
  ])];
}

/** Build the list of saved rosters and drafts, most recent first. */
function renderList(rosters, container) {
  const items = rosters.map((r) => (r.draft ? draftRow(r) : savedRow(r, container)));
  return [el('div', { className: 'list' }, items)];
}

/** A row for a saved roster: opens the read-only day-by-day view. */
function savedRow(r, container) {
  const shiftsCount = r.assignments.length;
  return el('button', {
    type: 'button', className: 'item',
    onclick: () => { openId = r.id; render(container); },
  }, [
    el('div', { className: 'item-main' }, [
      el('div', { className: 'item-title', textContent: r.name }),
      el('div', {
        className: 'item-sub',
        textContent: `${formatDate(r.startDate, { withWeekday: false })} – ${formatDate(r.endDate, { withWeekday: false })} · ${shiftsCount} shift${shiftsCount === 1 ? '' : 's'} assigned`,
      }),
    ]),
  ]);
}

/** A row for a draft: reopens it in the builder to keep working on it. */
function draftRow(r) {
  const range = r.startDate
    ? `${formatDate(r.startDate, { withWeekday: false })} – ${formatDate(r.endDate, { withWeekday: false })}`
    : 'No dates picked yet';
  return el('button', {
    type: 'button', className: 'item',
    onclick: () => { builderView.openDraft(r.id); show('new'); },
  }, [
    el('div', { className: 'item-main' }, [
      el('div', { className: 'item-title', textContent: r.name }),
      el('div', { className: 'item-sub', textContent: `${range} · not built yet` }),
    ]),
    el('span', { className: 'item-tag', textContent: 'Draft' }),
  ]);
}

/** Build the full day-by-day view of one saved roster, plus its actions. */
function renderOpen(roster, container) {
  const people = store.people();
  const shifts = store.shifts();

  const back = el('button', {
    className: 'btn btn-ghost', textContent: '← Rosters',
    onclick: () => { openId = null; render(container); },
  });

  const cards = editing
    ? editableDayCards(roster, people, shifts, (next) => {
      store.updateRoster(roster.id, {
        assignments: next,
        notes: auditRoster({ ...roster, assignments: next }, store.people(), store.shifts()),
      });
      render(container);
    })
    : dayCards(roster, people, shifts);

  const actions = [
    el('button', {
      className: 'btn', textContent: editing ? 'Done editing' : 'Edit',
      onclick: () => { editing = !editing; render(container); },
    }),
    exportButton(roster, people, shifts),
    planningCenter.canSend() ? planningCenter.sendButton(roster) : null,
    el('button', {
      className: 'btn btn-danger', textContent: 'Delete',
      onclick: async () => {
        const ok = await confirmDialog('Delete roster?', 'This cannot be undone.', 'Delete');
        if (!ok) return;
        store.deleteRoster(roster.id);
        openId = null;
        toast('Deleted');
        render(container);
      },
    }),
  ];

  return [
    back,
    el('h2', { textContent: roster.name }),
    notesBox(roster),
    ...cards,
    tally(roster, people),
    el('div', { className: 'row' }, actions),
  ];
}
