/**
 * Roster screen: the rosters you have, and the one place a roster is looked
 * at and worked on - checked, edited, rebuilt, shared, rolled on to the next
 * one, renamed or deleted. Building on New Roster saves the result and opens
 * it here, so a roster you just built and one from last month behave the same.
 * Follows the same list-then-detail pattern as the People screen - there is no
 * side-by-side layout on a phone.
 */
import { store } from '../store.js';
import { formatDate, auditRoster, buildRoster, rosterDates, rollOn } from '../scheduler.js';
import { el, fill, toast, confirmDialog, emptyState, promptText, openSheet } from '../ui.js';
import {
  editableDayCards, dayCards, tally, notesBox, declinedCard, exportButton, gapFixes,
} from './roster-parts.js';
import { show } from '../app.js';
import * as builderView from './roster.js';
import * as teamView from './team.js';
import * as sync from '../sync.js';
import * as staff from '../staff.js';

// Id of the saved roster currently open, or null when showing the list.
let openId = null;

// Whether the open roster is in manual-edit mode. Reset whenever the list is
// shown or a different roster is opened.
let editing = false;

/**
 * Open a roster on the next render - used by New Roster straight after a
 * build. `edit` starts it in the editor (a roster to fill in by hand).
 */
export function openRoster(id, { edit = false } = {}) {
  openId = id;
  editing = edit;
}

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
    fill(container, [...backupNudge(), swapsCard(null, () => render(container)), ...renderList(rosters, container)]);
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

/**
 * Shift swaps staff asked for through their links that are still going, on
 * one roster or (with null) all of them: ones both agreed, waiting for the
 * owner's Approve or Decline, and ones still waiting for the colleague's
 * answer. Null when there are none.
 */
function swapsCard(rosterId, redraw) {
  const open = staff.openSwaps(rosterId);
  if (open.length === 0) return null;
  /** Approve or decline, and say what happened. */
  const answer = (swap, approve) => {
    const ok = staff.decideSwap(swap.id, approve);
    toast(!approve ? 'Swap declined' : ok ? 'Swapped' : 'Their shift has changed since, so the swap was cancelled');
    redraw();
  };
  return el('div', { className: 'notice' }, [
    el('strong', { textContent: 'Shift swaps' }),
    ...open.map(({ swap, label }) => (swap.status === 'accepted'
      ? el('div', { className: 'spread' }, [
        el('span', { textContent: label }),
        el('span', { className: 'row-tight' }, [
          el('button', { className: 'btn btn-sm btn-primary', textContent: 'Approve', onclick: () => answer(swap, true) }),
          el('button', { className: 'btn btn-sm', textContent: 'Decline', onclick: () => answer(swap, false) }),
        ]),
      ])
      : el('div', { className: 'faint', textContent: `${label} · waiting for their answer` }))),
  ]);
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

/**
 * Start the next roster from this one: the same days of the week, moved on by
 * whole weeks past its last day, picked on New Roster ready to build.
 */
function rollForward(roster) {
  const days = rosterDates(roster);
  if (days.length === 0) return;
  builderView.startWith(rollOn(days));
  show('new');
}

/**
 * Refill a roster's dates with the scheduler, keeping the places it must:
 * the locked ones, or on a roster being filled in by hand, everyone placed so
 * far. Returns the new assignments and notes; nothing is saved here.
 */
function refill(roster) {
  const kept = roster.byHand
    ? roster.assignments.map((a) => ({ ...a, locked: true }))
    : roster.assignments.filter((a) => a.locked);
  const fresh = buildRoster({
    orgId: roster.orgId, name: roster.name, dates: rosterDates(roster),
    people: store.people(), shifts: store.shifts(), clashes: store.clashes(), roles: store.roles(),
    // Other saved rosters count towards who is due next. This one's own
    // current turns must not, or everyone on it would look over-used.
    history: store.rosters().filter((r) => !r.draft && r.id !== roster.id).flatMap((r) => r.assignments || []),
    locked: kept,
  });
  return { assignments: fresh.assignments, notes: fresh.notes };
}

// Earlier assignments of the open roster, newest last, for Undo.
const undo = { id: null, stack: [] };

/** Build the full day-by-day view of one roster, plus everything you can do with it. */
function renderOpen(roster, container) {
  const people = store.people();
  const shifts = store.shifts();
  const redraw = () => render(container);

  const back = el('button', {
    className: 'btn btn-ghost', textContent: '← Rosters',
    onclick: () => { openId = null; redraw(); },
  });

  /** Remember the current assignments for Undo before they change. */
  const remember = () => {
    if (undo.id !== roster.id) { undo.id = roster.id; undo.stack = []; }
    undo.stack.push(roster.assignments);
  };

  /** Save a changed list of assignments (an edit or a swap) with its notes re-checked. */
  const change = (next) => {
    remember();
    store.updateRoster(roster.id, {
      assignments: next,
      notes: auditRoster({ ...roster, assignments: next }, store.people(), store.shifts(), store.roles()),
    });
    redraw();
  };

  /** Refill the roster around what it keeps, and show the result. */
  const rebuild = () => {
    remember();
    // Read it afresh: Fill the gaps ticks someone for a role just before this.
    const current = store.roster(roster.id);
    store.updateRoster(roster.id, { ...refill(current), byHand: false });
    editing = false;
    toast(current.byHand ? 'Filled the rest — your picks are kept' : 'Rebuilt around the locked places');
    redraw();
  };

  /** The who-can-do-what grid over this screen; closing it redraws the roster. */
  const openSkills = () => {
    teamView.openSection('skills');
    openSheet('Who you roster', (body) => teamView.render(body), redraw);
  };

  /** Rename by tapping the title. */
  const rename = async () => {
    const name = await promptText('Rename roster', 'Name', roster.name);
    if (!name) return;
    store.updateRoster(roster.id, { name });
    redraw();
  };

  const cards = editing
    ? editableDayCards(roster, people, shifts, change)
    : dayCards(roster, people, shifts, change);

  // The everyday actions sit right under the title, so sharing or fixing a
  // roster never means scrolling past it. Rarer ones wait at the foot.
  const actions = [
    exportButton(roster, people, shifts, (replies) => {
      store.updateRoster(roster.id, { responses: replies });
      redraw();
    }),
    el('button', {
      className: 'btn', textContent: editing ? 'Done editing' : 'Edit',
      onclick: () => { editing = !editing; redraw(); },
    }),
    undo.id === roster.id && undo.stack.length ? el('button', {
      className: 'btn', textContent: 'Undo',
      onclick: () => {
        const prev = undo.stack.pop();
        store.updateRoster(roster.id, {
          assignments: prev,
          notes: auditRoster({ ...roster, assignments: prev }, store.people(), store.shifts(), store.roles()),
        });
        redraw();
      },
    }) : null,
    // By hand: the scheduler can take over the places still empty. Otherwise:
    // refill everything except the locked places.
    roster.byHand ? el('button', {
      className: 'btn btn-primary', textContent: 'Fill the rest for me', onclick: rebuild,
    }) : roster.assignments.some((a) => a.locked) ? el('button', {
      className: 'btn', textContent: 'Rebuild around locked', onclick: rebuild,
    }) : null,
  ];

  const footer = [
    el('button', {
      className: 'btn', textContent: 'Next one',
      onclick: () => rollForward(roster),
    }),
    el('button', {
      className: 'btn btn-danger', textContent: 'Delete',
      onclick: async () => {
        const ok = await confirmDialog('Delete roster?', 'This cannot be undone.', 'Delete');
        if (!ok) return;
        store.deleteRoster(roster.id);
        openId = null;
        toast('Deleted');
        redraw();
      },
    }),
  ];

  return [
    back,
    el('button', {
      type: 'button', className: 'title-btn', onclick: rename, 'aria-label': `Rename ${roster.name}`,
    }, [el('h2', { textContent: roster.name }), el('span', { className: 'faint', textContent: '✎', 'aria-hidden': 'true' })]),
    el('div', { className: 'row' }, actions),
    editing ? null : swapsCard(roster.id, redraw),
    roster.byHand && editing ? el('div', { className: 'notice' }, [
      el('strong', { textContent: 'Filling in by hand' }),
      el('div', {
        textContent: 'Use “+ add” on each shift to put someone on; everyone free that day is listed. '
          + '“Fill the rest for me” keeps who you placed and fills the gaps fairly.',
      }),
    ]) : null,
    // Checked afresh each time, so a date someone sent since it was saved shows here.
    notesBox({ ...roster, notes: auditRoster(roster, people, shifts, store.roles()) }),
    editing ? null : declinedCard(roster, people, shifts, change),
    editing ? null : gapFixes(roster, people, shifts, { rebuild, openSkills }),
    ...cards,
    tally(roster, people, shifts),
    el('div', { className: 'row' }, footer),
  ];
}
