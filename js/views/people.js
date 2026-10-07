/**
 * People screen: manage the roster of staff who can be scheduled.
 *
 * Two states are rendered into the same container: a list of everyone in the
 * current organisation, and (when a person is selected) a full-page editor for
 * that one person. There is no side-by-side layout - this is a phone app, and
 * a list-then-detail push is the natural pattern here.
 */
import { store } from '../store.js';
import { formatDate, todayISO } from '../scheduler.js';
import { parsePeopleList } from '../people-import.js';
import { isConfigured as pcoConfigured } from '../sources/planning-center.js';
import { show } from '../app.js';
import {
  el, fill, toast, promptText, confirmDialog, promptDateRange, weekdayPicker, monthGrid,
  dialog, DAY_LABELS,
} from '../ui.js';

// Id of the person currently open in the editor, or null when showing the list.
let editingId = null;

// When walking new people through the day-picker one at a time: the ids still
// to visit and how far through we are. Null when not in the walk-through.
let stepIds = null;
let stepAt = 0;

/** Entry point: render the day walk-through, the editor, or the list. */
export function render(container) {
  // Drop anyone deleted mid-walk, and leave the walk if nobody's left.
  if (stepIds) {
    stepIds = stepIds.filter((id) => store.people().some((p) => p.id === id));
    if (stepIds.length === 0) stepIds = null;
  }

  if (stepIds) {
    stepAt = Math.max(0, Math.min(stepAt, stepIds.length - 1));
    fill(container, renderStepper(container));
  } else if (editingId != null && store.people().some((p) => p.id === editingId)) {
    fill(container, renderEditor(editingId, container));
  } else {
    editingId = null;
    fill(container, renderList(container));
  }
}

/** Build the "who can I work?" summary shown under each person's name. */
function availabilitySummary(person) {
  const days = person.availableWeekdays || [];
  let text;
  if (days.length === 7) text = 'Every day';
  else if (days.length === 0) text = 'No days ticked';
  else {
    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    text = [...days].sort((a, b) => a - b).map((d) => labels[d]).join(', ');
  }
  const away = person.blackouts?.length || 0;
  if (away > 0) text += ` · ${away} away`;
  return text;
}

/** Build the list view: header, add button, and one row per person. */
function renderList(container) {
  const addBtn = el('button', {
    className: 'btn btn-primary btn-sm', textContent: '+ Add',
    onclick: async () => {
      const name = await promptText('New person', "What's their name?");
      if (!name) return;
      const person = store.addPerson(name);
      editingId = person.id;
      render(container);
    },
  });

  const addManyBtn = el('button', {
    className: 'btn btn-sm', textContent: 'Add several',
    onclick: () => openBulkAdd(container),
  });

  const header = el('div', { className: 'spread' }, [
    el('h2', { textContent: 'People' }),
    el('div', { className: 'row-tight' }, [addManyBtn, addBtn]),
  ]);

  // Where people get added is where Planning Center is worth mentioning: a
  // team brought in from there saves typing every name.
  const fromPco = pcoConfigured() ? el('button', {
    className: 'btn btn-sm btn-block',
    textContent: store.currentOrg()?.pco?.teamId
      ? 'Update from Planning Center →'
      : 'Bring people in from Planning Center →',
    onclick: () => show('settings', { section: 'planning-center' }),
  }) : null;

  const people = store.people();
  if (people.length === 0) {
    return [
      header,
      fromPco,
      el('div', { className: 'card' }, [
        el('div', { textContent: 'No people yet' }),
        el('div', {
          className: 'muted',
          textContent: 'Add them one at a time, or use "Add several" to paste a list of names.',
        }),
      ]),
    ];
  }

  // Shortcut into the day walk-through for everyone still without any days -
  // the usual state right after a bulk add.
  const needDays = people.filter((p) => (p.availableWeekdays || []).length === 0);
  const setDaysBtn = needDays.length ? el('button', {
    className: 'btn btn-sm btn-block', style: 'margin:.6rem 0',
    textContent: `Set days for ${needDays.length} ${needDays.length === 1 ? 'person' : 'people'} →`,
    onclick: () => { stepIds = needDays.map((p) => p.id); stepAt = 0; render(container); },
  }) : null;

  const list = el('div', { className: 'list' }, people.map((p) => {
    const item = el('button', {
      type: 'button',
      className: `item${p.active ? '' : ' inactive'}`,
      onclick: () => { editingId = p.id; render(container); },
    }, [
      el('div', { className: 'item-main' }, [
        el('div', { className: 'item-title', textContent: p.name }),
        el('div', { className: 'item-sub', textContent: availabilitySummary(p) }),
      ]),
    ]);
    return item;
  }));

  return [header, fromPco, setDaysBtn, list];
}

/**
 * Bulk add: paste a list of names (one per line, optional "- days" suffix),
 * review what will be created, then walk anyone without days through the picker.
 *
 * This is the offline, keyless sibling of AI assist: `parsePeopleList` does the
 * reading, and names that already exist in this org are skipped rather than
 * duplicated.
 */
async function openBulkAdd(container) {
  const created = await bulkAddDialog();
  if (created && created.length) {
    const needDays = created.filter((p) => (p.availableWeekdays || []).length === 0);
    if (needDays.length) { stepIds = needDays.map((p) => p.id); stepAt = 0; }
  }
  render(container);
}

/**
 * The paste-a-list dialog. Resolves to the array of created people, or null.
 *
 * The preview updates as you type so it's clear before committing what each
 * line will become - a day pattern, "no days", or "already on the list".
 */
function bulkAddDialog() {
  return dialog((close) => {
    const existing = new Set(store.people().map((p) => p.name.trim().toLowerCase()));

    const textarea = el('textarea', {
      rows: 7,
      placeholder: 'Sarah - Sat, Sun\nTom - weekdays\nRachel\nKate - every day',
    });
    const preview = el('div', { className: 'list', style: 'max-height:30vh;overflow-y:auto' });
    const addBtn = el('button', { className: 'btn btn-primary', textContent: 'Add', disabled: true });

    // Entries that will actually be created, kept in sync by refresh().
    let toAdd = [];

    /** Re-parse the textarea and rebuild the preview and the Add button. */
    const refresh = () => {
      const seen = new Set();
      toAdd = [];
      const rows = parsePeopleList(textarea.value).map((entry) => {
        const key = entry.name.toLowerCase();
        const dup = existing.has(key) || seen.has(key);
        seen.add(key);
        if (!dup) toAdd.push(entry);

        let note;
        if (dup) note = ' — already on the list';
        else if (entry.weekdays && entry.weekdays.length) {
          note = ` — ${entry.weekdays.map((d) => DAY_LABELS[d]).join(', ')}`;
        } else if (entry.weekdays && entry.weekdays.length === 0) note = ' — no days';
        else note = ' — days not set';

        return el('div', {
          className: 'faint',
          style: dup ? 'text-decoration:line-through' : null,
          textContent: entry.name + note,
        });
      });
      fill(preview, rows);
      addBtn.disabled = toAdd.length === 0;
      addBtn.textContent = toAdd.length ? `Add ${toAdd.length}` : 'Add';
    };
    textarea.addEventListener('input', refresh);

    addBtn.addEventListener('click', () => {
      const created = toAdd.map((e) => store.addPerson(e.name, e.weekdays || []));
      toast(`${created.length} added`);
      close(created);
    });

    return [
      el('h2', { textContent: 'Add several people' }),
      el('div', {
        className: 'faint',
        textContent: 'Paste a list from a message or your notes — one name per line. Put days after a dash if you know them: Mon–Sun, weekdays, weekends, every day.',
      }),
      textarea,
      preview,
      el('div', { className: 'modal-actions' }, [
        el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(null) }),
        addBtn,
      ]),
    ];
  });
}

/**
 * One screen of the day walk-through: the current person's name, the weekday
 * picker, and Previous / Next (or Done on the last). Days save on every tap,
 * so "Finish later" simply leaves - nothing is lost.
 */
function renderStepper(container) {
  const person = store.people().find((p) => p.id === stepIds[stepAt]);
  const leave = () => { stepIds = null; stepAt = 0; render(container); };
  const last = stepAt === stepIds.length - 1;

  const heading = el('div', { className: 'spread' }, [
    el('h2', { textContent: 'Set days' }),
    el('div', { className: 'faint', textContent: `${stepAt + 1} of ${stepIds.length}` }),
  ]);

  const picker = weekdayPicker(person.availableWeekdays, (days) => {
    store.updatePerson(person.id, { availableWeekdays: days });
  });

  const prevBtn = el('button', {
    className: 'btn', textContent: '← Previous', disabled: stepAt === 0,
    onclick: () => { stepAt -= 1; render(container); },
  });
  const nextBtn = el('button', {
    className: 'btn btn-primary', textContent: last ? 'Done' : 'Next →',
    onclick: () => { if (last) { leave(); } else { stepAt += 1; render(container); } },
  });

  return [
    heading,
    el('div', { className: 'card' }, [
      el('div', { className: 'item-title', textContent: person.name }),
      picker,
      el('div', { className: 'faint', textContent: 'Tap the days this person can work. Saved as you go.' }),
    ]),
    el('div', { className: 'row-tight' }, [prevBtn, nextBtn]),
    el('button', { className: 'btn btn-sm', textContent: 'Finish later', onclick: leave }),
  ];
}

/** Build the full editor for one person. */
function renderEditor(id, container) {
  const person = store.people().find((p) => p.id === id);
  const back = () => { editingId = null; render(container); };

  const backBtn = el('button', { className: 'btn btn-sm', textContent: '← Back', onclick: back });
  const header = el('div', { className: 'row-tight' }, [backBtn]);

  const nameCard = renderNameCard(person);
  const availCard = renderAvailabilityCard(person, container);
  const wantedCard = renderWantedDatesCard(person, container);
  const maxCard = renderMaxShiftsCard(person);
  const awayCard = renderAwayCard(person, container);
  const clashCard = renderClashCard(person, container);
  const deleteBtn = el('button', {
    className: 'btn btn-danger btn-block', textContent: 'Delete person',
    onclick: async () => {
      const ok = await confirmDialog('Delete person', `Remove ${person.name}? This cannot be undone.`);
      if (!ok) return;
      store.deletePerson(person.id);
      toast('Person deleted');
      back();
    },
  });

  // Everything already saves as you go, so Save is really "I'm done here" -
  // but it still commits the text fields first, so a value typed and never
  // blurred is kept, and it refuses to leave on a bad max-shifts value rather
  // than dropping it silently.
  const saveBtn = el('button', {
    className: 'btn btn-primary btn-block btn-lg', textContent: 'Save',
    onclick: () => {
      nameCard.commit();
      if (!maxCard.commit()) return;
      toast(`${store.people().find((p) => p.id === id)?.name || 'Person'} saved`);
      back();
    },
  });

  return [
    header, nameCard.node, availCard, wantedCard, maxCard.node, awayCard, clashCard,
    saveBtn, deleteBtn,
  ];
}

/**
 * Card: name text field and the active/inactive toggle.
 *
 * Returns `{ node, commit }`. Fields still save on blur, but Save calls
 * `commit()` too so a value typed and never blurred is not lost.
 */
function renderNameCard(person) {
  /** Save the typed name, falling back to the existing one if it's blank. */
  const commit = () => {
    const value = nameInput.value.trim();
    if (value) store.updatePerson(person.id, { name: value });
    else nameInput.value = person.name;
    return true;
  };

  const nameInput = el('input', {
    type: 'text', value: person.name,
    onblur: commit,
  });

  const activeCheckbox = el('input', {
    type: 'checkbox', checked: person.active,
    onchange: () => store.updatePerson(person.id, { active: activeCheckbox.checked }),
  });

  const node = el('div', { className: 'card' }, [
    el('div', {}, [el('label', { className: 'label', textContent: 'Name' }), nameInput]),
    el('label', { className: 'row-tight' }, [
      activeCheckbox,
      el('span', { textContent: 'Active' }),
    ]),
    el('div', {
      className: 'faint',
      textContent: 'Inactive people are kept on the list but are never rostered.',
    }),
    person.pcoId ? el('div', {
      className: 'faint',
      textContent: 'Linked to Planning Center: their blockouts come in as away dates when you update.',
    }) : null,
  ]);

  return { node, commit };
}

/** Card: the weekday picker for standing availability. */
function renderAvailabilityCard(person, container) {
  const hint = el('div', { className: 'faint' });

  /** Say plainly when nobody has picked any days yet. */
  const refreshHint = (days) => {
    hint.textContent = days.length === 0
      ? 'No days ticked, so they will not be rostered. Tap the days they can work.'
      : '';
  };

  const picker = weekdayPicker(person.availableWeekdays, (days) => {
    store.updatePerson(person.id, { availableWeekdays: days });
    refreshHint(days);
  });
  refreshHint(person.availableWeekdays);

  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Available on' }),
    picker,
    hint,
  ]);
}

/**
 * Card: specific dates this person has asked to work.
 *
 * A request is a preference, not a rule: it puts them first in the queue for
 * that day, but a hard constraint or a full shift still wins. The same list is
 * editable on the New Roster screen; this card is for when you already know
 * ("Sarah wants the 12th") and don't have a roster open yet.
 */
function renderWantedDatesCard(person, container) {
  const today = todayISO();
  const summary = el('div', { className: 'faint' });

  // Open on the month of the earliest upcoming request, else this month.
  const upcoming = (person.requests || []).filter((d) => d >= today).sort();
  const startMonth = upcoming[0] || today;

  /** Highlight class for one day: a request, an away date, or nothing. */
  const classOf = (iso) => {
    const state = store.dateState(person.id, iso);
    if (state === 'wants') return 'is-want';
    if (state === 'cant' || state === 'cant-range') return 'is-away';
    return '';
  };

  /** Say how many days are picked, so the card reads at a glance. */
  const refreshSummary = () => {
    const n = (person.requests || []).length;
    summary.textContent = n === 0
      ? 'None picked. Tap the days they have asked to work.'
      : `${n} day${n === 1 ? '' : 's'} picked — they go first in the queue for those.`;
  };

  const onTap = (iso) => {
    // An away date wins: toggling a request under it would be a confusing
    // half-state, so send the user to the Away card instead.
    if (store.dateState(person.id, iso).startsWith('cant')) {
      toast('They have an away date then — clear it below to ask them to work.');
      return;
    }
    store.toggleRequest(person.id, iso);
    cal.redraw();
    refreshSummary();
  };

  const cal = monthGrid({ start: startMonth, openDays: store.openDays(), classOf, onTap });
  refreshSummary();

  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Asked to work' }),
    cal.node,
    summary,
  ]);
}

/**
 * Card: max shifts per roster, validated as blank or a positive integer.
 *
 * Returns `{ node, commit }`; `commit()` is false when the value is invalid,
 * so Save can keep the user on the screen instead of discarding what they typed.
 */
function renderMaxShiftsCard(person) {
  const input = el('input', {
    type: 'number', min: '1', step: '1',
    value: person.maxShifts == null ? '' : String(person.maxShifts),
  });
  const err = el('div', { className: 'err' });

  /** Validate and save the cap. Returns false (and shows why) if unusable. */
  const commit = () => {
    const raw = input.value.trim();
    if (raw === '') {
      err.textContent = '';
      store.updatePerson(person.id, { maxShifts: null });
      return true;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      err.textContent = 'Enter a positive whole number, or leave blank for no cap.';
      return false;
    }
    err.textContent = '';
    store.updatePerson(person.id, { maxShifts: n });
    return true;
  };

  input.addEventListener('blur', commit);

  const node = el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Max shifts per roster' }),
    input,
    err,
  ]);

  return { node, commit };
}

/**
 * Card: away-date ranges, with add/remove.
 *
 * Past dates are never deleted on their own - throwing away someone's records
 * without being asked is the kind of thing you only notice once it has already
 * happened. They are folded away instead, with a button to clear them.
 */
function renderAwayCard(person, container) {
  const today = todayISO();
  const all = person.blackouts || [];
  const past = all.filter((b) => b.end < today);
  const current = all.filter((b) => b.end >= today);

  const rows = current.map((b) => {
    const span = b.start === b.end
      ? formatDate(b.start, { withWeekday: false })
      : `${formatDate(b.start, { withWeekday: false })} – ${formatDate(b.end, { withWeekday: false })}`;
    return el('div', { className: 'spread' }, [
      el('div', {}, [
        el('div', { textContent: span }),
        b.reason ? el('div', { className: 'muted', textContent: b.reason }) : null,
      ]),
      el('button', {
        className: 'btn btn-sm', textContent: 'Remove',
        // Index against the real list, not the filtered one, or removing a
        // current entry would delete whichever record happened to sit at that
        // position in the full array.
        onclick: () => {
          store.deleteBlackout(person.id, all.indexOf(b));
          render(container);
        },
      }),
    ]);
  });

  const addBtn = el('button', {
    className: 'btn btn-sm', textContent: '+ Add away dates',
    onclick: async () => {
      const result = await promptDateRange('Away dates', { openDays: store.openDays() });
      if (!result) return;
      store.addBlackout(person.id, result.start, result.end, result.reason);
      render(container);
    },
  });

  // Past entries: collapsed, with a way to clear them once they are just clutter.
  let pastBlock = null;
  if (past.length) {
    const clearBtn = el('button', {
      className: 'btn btn-sm', textContent: `Remove ${past.length} past`,
      onclick: async () => {
        const ok = await confirmDialog(
          'Remove past away dates',
          past.length === 1
            ? 'Delete 1 away date that has already been and gone? This cannot be undone.'
            : `Delete ${past.length} away dates that have already been and gone? This cannot be undone.`,
          'Remove'
        );
        if (!ok) return;
        // Remove back-to-front so earlier indices stay valid as we splice.
        for (const b of [...past].reverse()) store.deleteBlackout(person.id, all.indexOf(b));
        toast('Past dates removed');
        render(container);
      },
    });
    pastBlock = el('details', {}, [
      el('summary', { className: 'muted', textContent: `${past.length} past away date${past.length === 1 ? '' : 's'}` }),
      el('div', { className: 'list', style: 'margin-top:.5rem' }, past.map((b) => el('div', {
        className: 'muted',
        textContent: b.start === b.end
          ? formatDate(b.start, { withWeekday: false })
          : `${formatDate(b.start, { withWeekday: false })} – ${formatDate(b.end, { withWeekday: false })}`,
      }))),
      el('div', { style: 'margin-top:.5rem' }, clearBtn),
    ]);
  }

  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Away dates' }),
    rows.length
      ? el('div', { className: 'list' }, rows)
      : el('div', { className: 'muted', textContent: 'None coming up.' }),
    addBtn,
    pastBlock,
  ]);
}

/** Card: "never with" clash rules against other people. */
function renderClashCard(person, container) {
  const others = store.people().filter((p) => p.id !== person.id);
  const partnerIds = store.clashes()
    .filter(([a, b]) => a === person.id || b === person.id)
    .map(([a, b]) => (a === person.id ? b : a));

  const rows = partnerIds.map((pid) => {
    const other = others.find((p) => p.id === pid);
    return el('div', { className: 'spread' }, [
      el('div', { textContent: other ? other.name : `#${pid}` }),
      el('button', {
        className: 'btn btn-sm', textContent: 'Remove',
        onclick: () => {
          store.deleteClash(person.id, pid);
          render(container);
        },
      }),
    ]);
  });

  const available = others.filter((p) => !partnerIds.includes(p.id));
  let addRow = null;
  if (available.length > 0) {
    const select = el('select', {}, available.map((p) => el('option', { value: String(p.id), textContent: p.name })));
    addRow = el('div', { className: 'row-tight' }, [
      select,
      el('button', {
        className: 'btn btn-sm', textContent: 'Add',
        onclick: () => {
          store.addClash(person.id, Number(select.value));
          render(container);
        },
      }),
    ]);
  }

  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Never with' }),
    rows.length ? el('div', { className: 'list' }, rows) : el('div', { className: 'muted', textContent: 'No clash rules.' }),
    addRow,
  ]);
}
