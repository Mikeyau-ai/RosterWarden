/**
 * New Roster screen: the builder. Tap the dates to roster on the
 * calendar, build a roster, then save/copy/share it. This is the single most
 * used screen, so the common weekend-cafe case stays quick: the month's
 * "Weekends" button fills a month in one tap, and individual dates can then
 * be switched off for the weekends the cafe is closed.
 */
import { store } from '../store.js';
import {
  buildRoster, formatDate, toDays, fromDays, auditRoster, todayISO,
} from '../scheduler.js';
import { parseAvailability, describe, AIError } from '../ai.js';
import {
  el, fill, toast, confirmDialog, calendarPicker, emptyState,
} from '../ui.js';
import {
  editableDayCards, dayCards, tally, notesBox, exportButton,
} from './roster-parts.js';
import { show } from '../app.js';

// The most recently built roster, kept across re-renders (e.g. after Save)
// so the result isn't lost. `days` is the exact list of rostered dates used
// to build it. Cleared whenever the current organisation changes.
let built = null;
let builtOrgId = null;

// The calendar selection, likewise kept across re-renders so building or
// saving doesn't clear the dates the user just tapped.
let picked = new Set();
let pickedOrgId = null;

// The draft currently being continued, if any: saving writes back to it
// instead of making a new entry, and building then saving replaces it.
// `pendingDraftId` is set by openDraft() and consumed on the next render.
let draftId = null;
let pendingDraftId = null;

/** Continue a saved draft: its name and dates load on the next render. */
export function openDraft(id) {
  pendingDraftId = id;
}

// Whether the requests/days-off section is expanded, kept across its rebuilds.
let requestsOpen = false;

// Whether the built roster is in manual-edit mode. Kept across the result
// section's own re-renders, reset on a full page render (leaving/returning).
let editing = false;

/** Entry point: render the build form, optional AI notes box, and any result. */
export function render(container) {
  editing = false;                 // a fresh page render always starts read-only
  const org = store.currentOrg();
  if (builtOrgId !== org.id) {
    built = null;
    builtOrgId = org.id;
  }
  // A draft belongs to one organisation; switching away abandons it.
  if (pickedOrgId !== org.id) draftId = null;

  const start = todayISO();

  // Loading a draft: pull its name and dates into the form, then forget the
  // request so ordinary re-renders (Save, AI apply) don't keep resetting it.
  if (pendingDraftId != null) {
    const d = store.roster(pendingDraftId);
    pendingDraftId = null;
    if (d && d.draft && d.orgId === org.id) {
      draftId = d.id;
      picked = new Set(d.days || []);
      pickedOrgId = org.id;
      built = null;
    }
  }

  // The dates to roster, chosen on the calendar. Kept across re-renders of the
  // result section so a build doesn't wipe the selection.
  if (pickedOrgId !== org.id) {
    picked = new Set();
    pickedOrgId = org.id;
  }

  const draft = draftId != null ? store.roster(draftId) : null;
  const nameInput = el('input', {
    type: 'text',
    value: draft ? draft.name : `Roster ${formatDate(start, { withWeekday: false })}`,
  });

  const summary = el('div', { className: 'faint' });
  const clearBtn = el('button', {
    type: 'button', className: 'btn btn-sm', textContent: 'Clear',
    onclick: () => { picked.clear(); refreshCalendar(); },
  });

  // The requests section lists the picked dates, so it has to be rebuilt
  // whenever the calendar selection changes - not just once on first render.
  const requestsWrap = el('div');
  const refreshRequests = () => { fill(requestsWrap, requestsSection(container)); };

  /** Update the "N dates picked" line and the suggested roster name. */
  const refreshSummary = () => {
    refreshRequests();
    const n = picked.size;
    const sorted = [...picked].sort();
    summary.textContent = n === 0
      ? 'Tap the dates you want rostered.'
      : n === 1
        ? `1 date picked — ${formatDate(sorted[0])}`
        : `${n} dates picked — ${formatDate(sorted[0], { withWeekday: false })} to ` +
          `${formatDate(sorted[n - 1], { withWeekday: false })}`;
    clearBtn.disabled = n === 0;

    // Keep the suggested name in step with the first date, but stop the moment
    // the user types their own - a roster they named "Christmas" must not get
    // silently renamed when they nudge the dates.
    if (nameIsAuto) {
      nameInput.value = `Roster ${formatDate(sorted[0] || start, { withWeekday: false })}`;
    }
  };

  const calendarWrap = el('div');
  /** Rebuild the calendar (needed after Clear changes the selection wholesale). */
  const refreshCalendar = () => {
    fill(calendarWrap, calendarPicker(picked, refreshSummary, { openDays: store.openDays() }));
    refreshSummary();
  };

  // A draft carries a name the user chose (or accepted), so don't overwrite it
  // as the dates change; a fresh roster's name tracks the first date until typed.
  let nameIsAuto = !draft;
  nameInput.addEventListener('input', () => { nameIsAuto = false; });

  refreshCalendar();

  const activePeople = store.people().filter((p) => p.active);
  const shifts = store.shifts();
  const readiness = el('div', {
    className: 'faint',
    textContent: `${activePeople.length} ${activePeople.length === 1 ? 'person' : 'people'} · ` +
                 `${shifts.length} ${shifts.length === 1 ? 'shift' : 'shifts'}`,
  });

  const errDiv = el('div', { className: 'err' });
  const resultsBox = el('div');

  /** Redraw just the result section, without disturbing the form above it. */
  const renderResults = () => {
    fill(resultsBox, built ? buildResultView(container, renderResults) : []);
  };

  /** Build the roster from the current form values and show the result. */
  const onBuild = () => {
    errDiv.textContent = '';
    if (picked.size === 0) {
      errDiv.textContent = 'Pick at least one date on the calendar.';
      return;
    }
    const dates = [...picked].sort();
    const roster = buildRoster({
      orgId: org.id,
      name: nameInput.value.trim() || `Roster ${formatDate(dates[0], { withWeekday: false })}`,
      people: store.people(),
      shifts: store.shifts(),
      clashes: store.clashes(),
      dates,
    });
    built = { roster, days: dates };
    renderResults();
  };

  /** Save the current name and dates as a draft, without building. */
  const onSaveDraft = () => {
    const dates = [...picked].sort();
    const name = nameInput.value.trim()
      || `Roster ${formatDate(dates[0] || start, { withWeekday: false })}`;
    const rec = store.saveDraft({ id: draftId, name, dates });
    draftId = rec.id;
    toast(draft ? 'Draft updated' : 'Draft saved');
    show('roster');
  };

  const saveDraftBtn = el('button', {
    type: 'button', className: 'btn btn-lg',
    textContent: draft ? 'Update draft' : 'Save draft',
    onclick: onSaveDraft,
  });

  // The build control is either the big primary button, or - if the org has
  // nothing to schedule yet - a pointer to the screen that fixes it. Either
  // way the scheduler is never invoked with nothing to work with. A draft can
  // still be saved with nothing set up, so Save draft sits outside this.
  let buildControl;
  if (shifts.length === 0) {
    buildControl = emptyState(
      'No shifts yet',
      'Add at least one shift before building a roster.',
      el('button', {
        className: 'btn btn-primary', textContent: 'Add shifts', onclick: () => show('shifts'),
      })
    );
  } else if (activePeople.length === 0) {
    buildControl = emptyState(
      'No active people yet',
      'Add people before building a roster.',
      el('button', {
        className: 'btn btn-primary', textContent: 'Add people', onclick: () => show('people'),
      })
    );
  } else {
    buildControl = el('button', {
      className: 'btn btn-primary btn-lg', textContent: 'Build roster', onclick: onBuild,
    });
  }

  const ready = shifts.length > 0 && activePeople.length > 0;
  saveDraftBtn.classList.toggle('btn-block', !ready);

  // Actions live at the foot of the page: fill the form top to bottom, then
  // save it for later or build it. When ready, the two buttons sit side by
  // side (Save draft left, Build right). When something is still missing, Save
  // draft stays (a draft needs nothing set up) and the build pointer drops
  // below, outside the card, as its own block.
  const actions = ready
    ? el('div', { className: 'build-actions' }, [saveDraftBtn, buildControl])
    : saveDraftBtn;

  const deleteDraftBtn = draft ? el('button', {
    type: 'button', className: 'btn btn-sm btn-danger', textContent: 'Delete draft',
    style: 'margin-top:.6rem',
    onclick: async () => {
      const ok = await confirmDialog('Delete draft?', 'This cannot be undone.', 'Delete');
      if (!ok) return;
      store.deleteRoster(draftId);
      draftId = null;
      picked.clear();
      built = null;
      toast('Draft deleted');
      show('roster');
    },
  }) : null;

  const formCard = el('div', { className: 'card' }, [
    el('div', {}, [el('label', { className: 'label', textContent: 'Roster name' }), nameInput]),
    el('div', {}, [
      el('label', { className: 'label', textContent: 'Dates to roster' }),
      calendarWrap,
      el('div', { className: 'spread', style: 'margin-top:.6rem' }, [summary, clearBtn]),
    ]),
  ]);

  const actionCard = el('div', { className: 'card' }, [
    readiness, errDiv, actions, deleteDraftBtn,
  ]);

  renderResults();
  fill(container, [
    formCard,
    requestsWrap,
    actionCard,
    ready ? null : buildControl,
    resultsBox,
  ]);
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
  details.append(el('summary', { textContent: 'Requests and days off' }));

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

/** Build the day-by-day result view, tally and action buttons for `built`. */
function buildResultView(container, rerender) {
  const { roster } = built;
  const people = store.people();
  const shifts = store.shifts();

  const cards = editing
    ? editableDayCards(roster, people, shifts, (next) => {
      roster.assignments = next;
      roster.notes = auditRoster(roster, store.people(), store.shifts());
      rerender();
    })
    : dayCards(roster, people, shifts);

  const actions = [
    el('button', {
      className: 'btn btn-primary', textContent: 'Save',
      onclick: () => {
        // Building a draft and saving the result retires the draft: the saved
        // roster takes its place in the list.
        if (draftId != null) {
          store.deleteRoster(draftId);
          draftId = null;
        }
        store.saveRoster(roster);
        toast('Saved — find it under Roster');
        render(container);
      },
    }),
    el('button', {
      className: 'btn', textContent: editing ? 'Done editing' : 'Edit',
      onclick: () => { editing = !editing; rerender(); },
    }),
    exportButton(roster, people, shifts),
  ];

  // A shortfall must be impossible to miss, so it goes above the schedule.
  return [
    notesBox(roster),
    ...cards,
    tally(roster, people),
    el('div', { className: 'row' }, actions),
  ];
}
