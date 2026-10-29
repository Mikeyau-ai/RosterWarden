/**
 * New Roster screen: pick the dates, then build. That is all it does - the
 * built roster is saved straight away and opens on the Roster screen, the one
 * place a roster is checked, edited, shared and rebuilt.
 *
 * This is the most used screen, so the common weekend-cafe case stays quick:
 * "All open days" fills a month in one tap, individual dates can then be
 * switched off, and the Build button is always in reach at the foot of the
 * screen. Requests and days off fold into one line until they're wanted.
 */
import { store } from '../store.js';
import {
  buildRoster, formatDate, toDays, fromDays, auditRoster, todayISO, followOnDates, usualDayShifts,
} from '../scheduler.js';
import { parseAvailability, describe, AIError } from '../ai.js';
import {
  el, fill, toast, confirmDialog, calendarPicker, emptyState, openSheet, collapsible,
} from '../ui.js';
import { show } from '../app.js';
import * as teamView from './team.js';
import * as savedView from './saved.js';

// The calendar selection, kept across re-renders (and trips to other tabs)
// until a roster is built from it.
let picked = new Set();
let pickedOrgId = null;

// Whether the next render starts afresh and so picks the weeks that follow on
// from the latest roster. True at first, after each build, and when the
// organisation changes; a selection the user has made is never replaced.
let followOn = true;

// A draft saved by an older version, being continued: its name and dates fill
// the form, and building from it replaces it. `pendingDraftId` is set by
// openDraft() and consumed on the next render.
let draftId = null;
let pendingDraftId = null;

/** Continue a saved draft: its name and dates load on the next render. */
export function openDraft(id) {
  pendingDraftId = id;
}

// Dates handed over by another screen ("Next one"), picked on the next render.
let pendingDates = null;

/** Open New Roster with these dates already picked. */
export function startWith(dates) {
  pendingDates = [...dates];
}

// Whether the requests/days-off section is expanded, kept across its rebuilds.
// Folded by default: it is a grid of everyone against every date, and the
// usual roster needs none of it.
let requestsOpen = false;

/** "Roster 4 Oct 2026" for a roster starting on `first`. */
function autoName(first) {
  return `Roster ${formatDate(first, { withWeekday: false })}`;
}

/** Entry point: the calendar, requests, and the Build controls. */
export function render(container) {
  const org = store.currentOrg();
  // A draft belongs to one organisation; switching away abandons it.
  if (pickedOrgId !== org.id) draftId = null;

  // Loading a draft: pull its dates into the calendar, then forget the
  // request so ordinary re-renders don't keep resetting it.
  if (pendingDraftId != null) {
    const d = store.roster(pendingDraftId);
    pendingDraftId = null;
    if (d && d.draft && d.orgId === org.id) {
      draftId = d.id;
      picked = new Set(d.days || []);
      pickedOrgId = org.id;
    }
  }
  if (pendingDates) {
    picked = new Set(pendingDates);
    pickedOrgId = org.id;
    draftId = null;
    pendingDates = null;
  }

  // A different organisation starts afresh.
  if (pickedOrgId !== org.id) {
    picked = new Set();
    pickedOrgId = org.id;
    followOn = true;
  }

  // Starting afresh: pick the weeks after the latest roster, ready to build.
  // `carriedOn` labels the selection until the user changes it.
  let carriedOn = false;
  if (followOn) {
    followOn = false;
    if (picked.size === 0) {
      picked = new Set(followOnDates(store.rosters(), todayISO(), store.openDays()));
      carriedOn = picked.size > 0;
    }
  }
  const draft = draftId != null ? store.roster(draftId) : null;

  const summary = el('div', { className: 'faint' });
  const clearBtn = el('button', {
    type: 'button', className: 'btn btn-sm', textContent: 'Clear',
    onclick: () => { picked.clear(); carriedOn = false; refreshCalendar(); },
  });

  // The requests section lists the picked dates, so it has to be rebuilt
  // whenever the calendar selection changes - not just once on first render.
  const requestsWrap = el('div');
  const refreshRequests = () => { fill(requestsWrap, requestsSection(container)); };

  /** Update the "N dates picked" line and the requests under the calendar. */
  const refreshSummary = () => {
    refreshRequests();
    const n = picked.size;
    const sorted = [...picked].sort();
    summary.textContent = (carriedOn ? 'Following on from your last roster. ' : '') + (n === 0
      ? 'Tap the dates you want rostered.'
      : n === 1
        ? `1 date picked — ${formatDate(sorted[0])}`
        : `${n} dates picked — ${formatDate(sorted[0], { withWeekday: false })} to ` +
          `${formatDate(sorted[n - 1], { withWeekday: false })}`);
    clearBtn.disabled = n === 0;
  };

  const calendarWrap = el('div');
  /** Rebuild the calendar (needed after Clear changes the selection wholesale). */
  const refreshCalendar = () => {
    // Any tap on the calendar makes the selection the user's own.
    const onPick = () => { carriedOn = false; refreshSummary(); };
    fill(calendarWrap, calendarPicker(picked, onPick, { openDays: store.openDays() }));
    refreshSummary();
  };
  refreshCalendar();

  const activePeople = store.people().filter((p) => p.active);
  const shifts = store.shifts();
  /**
   * Open the Team screen as a sheet over this one, so people, shifts and roles
   * can be fixed without leaving the dates being picked. Closing it redraws
   * the page with the new counts; the dates picked are kept.
   */
  const openTeam = (part) => {
    teamView.openSection(part);
    openSheet('Who you roster', (body) => teamView.render(body), () => render(container));
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const readiness = el('div', { className: 'setup-chips' }, [
    el('button', {
      type: 'button', className: 'btn btn-sm', onclick: () => openTeam('people'),
      textContent: `${plural(activePeople.length, 'person', 'people')} ›`,
    }),
    el('button', {
      type: 'button', className: 'btn btn-sm', onclick: () => openTeam('shifts'),
      textContent: `${plural(shifts.length, 'shift', 'shifts')} ›`,
    }),
    store.roles().some((r) => !r.anyone) ? el('button', {
      type: 'button', className: 'btn btn-sm', onclick: () => openTeam('skills'),
      textContent: 'Who can do what ›',
    }) : null,
  ]);

  const errDiv = el('div', { className: 'err' });

  /** The picked dates, sorted, or null (with a message) when there are none. */
  const datesOrComplain = () => {
    errDiv.textContent = '';
    if (picked.size === 0) {
      errDiv.textContent = 'Pick at least one date on the calendar.';
      return null;
    }
    return [...picked].sort();
  };

  /**
   * Save a new roster and open it on the Roster screen. A draft it was built
   * from is replaced by it, and the dates are cleared ready for the next one.
   */
  const finish = (roster, { edit = false } = {}) => {
    if (draftId != null) {
      store.deleteRoster(draftId);
      draftId = null;
    }
    const saved = store.saveRoster(roster);
    picked = new Set();
    followOn = true;
    savedView.openRoster(saved.id, { edit });
    show('roster');
    toast(edit ? 'Put people on each shift, or let it fill the rest' : 'Built and saved');
  };

  /** Build the roster for the picked dates, save it, and open it. */
  const onBuild = () => {
    const dates = datesOrComplain();
    if (!dates) return;
    finish(buildRoster({
      orgId: org.id,
      name: draft?.name || autoName(dates[0]),
      people: store.people(),
      shifts: store.shifts(),
      clashes: store.clashes(),
      dates,
      roles: store.roles(),
      // Turns in saved rosters count towards who is due next.
      history: store.rosters().filter((r) => !r.draft).flatMap((r) => r.assignments || []),
    }));
  };

  /**
   * Start an empty roster for the picked dates and open it in the editor, to
   * be filled in by hand. Every place shows as a gap until someone is put on
   * it, so Things to check doubles as the list of what is left to do.
   */
  const onManual = () => {
    const dates = datesOrComplain();
    if (!dates) return;
    const roster = {
      orgId: org.id,
      name: draft?.name || autoName(dates[0]),
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      days: dates,
      // Its own copy of each day's shifts, as a built roster keeps.
      dayShifts: usualDayShifts(store.shifts(), dates),
      assignments: [],
      notes: [],
      // Marks it as being filled in by hand until the scheduler fills the rest.
      byHand: true,
    };
    roster.notes = auditRoster(roster, store.people(), store.shifts(), store.roles());
    finish(roster, { edit: true });
  };

  // The build controls, pinned to the foot of the screen - or, if the org
  // has nothing to schedule yet, a pointer to the screen that fixes it, so the
  // scheduler is never invoked with nothing to work with.
  let buildControl;
  if (shifts.length === 0) {
    buildControl = emptyState(
      'No shifts yet',
      'Add at least one shift before building a roster.',
      el('button', {
        className: 'btn btn-primary', textContent: 'Add shifts', onclick: () => openTeam('shifts'),
      })
    );
  } else if (activePeople.length === 0) {
    buildControl = emptyState(
      'No active people yet',
      'Add people before building a roster.',
      el('button', {
        className: 'btn btn-primary', textContent: 'Add people', onclick: () => openTeam('people'),
      })
    );
  } else {
    buildControl = el('div', { className: 'build-bar' }, [
      errDiv,
      el('div', { className: 'build-actions' }, [
        el('button', { type: 'button', className: 'btn', textContent: 'Fill in by hand', onclick: onManual }),
        el('button', { type: 'button', className: 'btn btn-primary', textContent: 'Build roster', onclick: onBuild }),
      ]),
    ]);
  }

  // Only a draft from an older version needs this; new rosters have no drafts.
  const deleteDraftBtn = draft ? el('button', {
    type: 'button', className: 'btn btn-sm btn-danger', textContent: 'Delete draft',
    onclick: async () => {
      const ok = await confirmDialog('Delete draft?', 'This cannot be undone.', 'Delete');
      if (!ok) return;
      store.deleteRoster(draftId);
      draftId = null;
      picked.clear();
      toast('Draft deleted');
      show('roster');
    },
  }) : null;

  const formCard = el('div', { className: 'card' }, [
    draft ? el('div', { className: 'spread' }, [el('strong', { textContent: draft.name }), deleteDraftBtn]) : null,
    collapsible('dates', 'Dates to roster', calendarWrap, { className: '' }),
    el('div', { className: 'spread', style: 'margin-top:.6rem' }, [summary, clearBtn]),
    readiness,
  ]);

  fill(container, [formCard, requestsWrap, buildControl]);
}

/**
 * Per-person requests and days off, for the dates currently picked.
 *
 * Entered here rather than only under People because this is where you have
 * the messages in front of you - "Sarah asked for the 12th, Tom can't do the
 * 19th" - and going into each profile to record that is the slow way round.
 *
 * A request is a preference: it puts that person first in the queue for the
 * day, but a full shift or a hard constraint still wins. A day off is the same
 * thing People calls an away date, so the two stay in step.
 */
function requestsSection(container) {
  const people = store.people().filter((p) => p.active);
  const dates = [...picked].sort();

  // Remember whether it was open: this is rebuilt on every calendar tap, and
  // having it snap shut mid-edit would be maddening.
  const details = el('details', { className: 'card', open: requestsOpen });
  details.addEventListener('toggle', () => { requestsOpen = details.open; });

  // What is already set for these dates, on the folded line, so it says
  // whether it is worth opening: "2 asked to work · 1 can't".
  const counts = el('span', { className: 'faint' });
  const refreshCounts = () => {
    let asked = 0;
    let off = 0;
    for (const person of people) {
      for (const date of dates) {
        const state = store.dateState(person.id, date);
        if (state === 'wants') asked += 1;
        else if (state !== 'neutral') off += 1;
      }
    }
    const parts = [asked ? `${asked} asked to work` : null, off ? `${off} can’t` : null].filter(Boolean);
    counts.textContent = parts.length ? ` · ${parts.join(' · ')}` : dates.length ? ' · none yet' : '';
  };
  refreshCounts();
  details.append(el('summary', {}, ['Requests and days off', counts]));

  if (dates.length === 0 || people.length === 0) {
    details.append(el('div', {
      className: 'muted',
      textContent: dates.length === 0
        ? 'Pick the dates above first, then set who asked for what.'
        : 'Add some people first.',
    }));
    details.append(...[availabilityNotes(container)].filter(Boolean));
    return details;
  }

  details.append(el('div', {
    className: 'faint',
    textContent: 'Tap a date to cycle: nothing → asked to work → can’t work.',
  }));

  for (const person of people) {
    const chips = el('div', { className: 'req-dates' });

    /** Draw this person's chips from what is currently stored. */
    const drawChips = () => {
      fill(chips, dates.map((date) => {
        const state = store.dateState(person.id, date);
        const chip = el('button', {
          type: 'button',
          className: `req-chip is-${state}`,
          textContent: formatDate(date, { withWeekday: false }).replace(/ \d{4}$/, ''),
          'aria-label': `${person.name} ${date} ${state}`,
        });
        chip.addEventListener('click', () => {
          // Cycle neutral → wants → can't → neutral. A date inside a multi-day
          // away period is left alone; splitting that range here would be a
          // surprising side effect of a single tap.
          if (state === 'cant-range') {
            toast(`${person.name} has a longer away period covering this — edit it under People.`);
            return;
          }
          if (state === 'neutral') store.toggleRequest(person.id, date);
          else if (state === 'wants') {
            store.toggleRequest(person.id, date);
            store.addBlackout(person.id, date, date, 'asked off');
          } else {
            store.removeBlackoutOnDate(person.id, date);
          }
          drawChips();
          refreshCounts();
        });
        return chip;
      }));
    };
    drawChips();

    details.append(el('div', { className: 'req-person' }, [
      el('div', { className: 'req-name', textContent: person.name }),
      chips,
    ]));
  }

  details.append(...[availabilityNotes(container)].filter(Boolean));
  return details;
}

/**
 * "Paste a message": read requests, away dates and clashes out of free text
 * with AI. Lives at the foot of Requests and days off, and only appears once
 * an AI key is set - a permanently disabled box is just clutter.
 */
function availabilityNotes(container) {
  const apiKey = store.setting('aiKey');
  if (!apiKey) return null;
  const provider = store.setting('aiProvider');
  const model = store.setting('aiModel');

  const textarea = el('textarea', {
    rows: 3,
    placeholder: 'e.g. Sarah can only do Saturdays\nTom away 5-9 June',
  });
  const aiBtn = el('button', { className: 'btn btn-sm', textContent: 'Read with AI' });
  const err = el('div', { className: 'err' });

  aiBtn.addEventListener('click', async () => {
    err.textContent = '';
    aiBtn.disabled = true;
    aiBtn.textContent = 'Reading…';
    try {
      const people = store.people();
      const names = people.map((p) => p.name);
      // Give the model the period actually being rostered, so "away the first
      // weekend" resolves against those dates rather than an arbitrary window.
      const sorted = [...picked].sort();
      const start = sorted[0] || todayISO();
      const end = sorted[sorted.length - 1] || fromDays(toDays(start) + 13);
      const result = await parseAvailability({ text: textarea.value, names, start, end, provider, model, apiKey });
      const lines = describe(result);
      if (lines.length === 0) {
        toast('Nothing recognisable in those notes.');
        return;
      }
      const ok = await confirmDialog('Apply these changes?', lines.join('\n'), 'Apply');
      if (!ok) return;

      // Only now do we touch the store - everything above was read-only review.
      const byName = new Map(people.map((p) => [p.name.toLowerCase(), p]));
      let count = 0;
      for (const p of result.people) {
        const person = byName.get(p.name.toLowerCase());
        if (!person) continue;
        if (p.weekdays) {
          store.updatePerson(person.id, { availableWeekdays: p.weekdays });
          count++;
        }
        for (const b of p.blackouts || []) {
          store.addBlackout(person.id, b.start, b.end, b.reason);
          count++;
        }
      }
      for (const [a, b] of result.clashes) {
        const pa = byName.get(a.toLowerCase());
        const pb = byName.get(b.toLowerCase());
        if (pa && pb) {
          store.addClash(pa.id, pb.id);
          count++;
        }
      }
      toast(`${count} change${count === 1 ? '' : 's'} applied`);
      render(container);
    } catch (e) {
      err.textContent = e instanceof AIError ? e.message : 'Something went wrong reading those notes.';
    } finally {
      aiBtn.disabled = false;
      aiBtn.textContent = 'Read with AI';
    }
  });

  return el('div', { className: 'req-person' }, [
    el('div', { className: 'req-name', textContent: 'Or paste a message' }),
    textarea, aiBtn, err,
  ]);
}
