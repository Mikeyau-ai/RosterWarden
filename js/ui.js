/**
 * Small DOM helpers shared by every view.
 *
 * Deliberately not a framework: this app has five screens and a few dialogs, so
 * a handful of functions over plain DOM beats pulling in a dependency that has
 * to be cached, updated and understood.
 */
import { weekdayOf, toDays, fromDays, formatDate, todayISO } from './scheduler.js';

/** Weekday labels, Monday-first, matching the scheduler's 0-6 indices. */
export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Granularity of every time field, in seconds (300 = 5 minutes).
 *
 * `<input type="time">` defaults to one-minute steps, which makes the picker
 * needlessly long to scroll on a phone for times nobody sets that precisely.
 */
export const TIME_STEP_SECONDS = 300;

/**
 * Create an element.
 * `attrs` sets properties (className, textContent, onclick, ...); anything
 * containing a dash or starting "aria"/"data" is set as an attribute instead.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('aria') || k.startsWith('data') || k.includes('-')) {
      node.setAttribute(k, v);
    } else {
      node[k] = v;
    }
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Replace an element's contents with the given children. */
export function fill(node, children) {
  node.replaceChildren(...[].concat(children).filter((c) => c != null && c !== false));
  return node;
}

/** Show a brief confirmation message at the bottom of the screen. */
let toastTimer = null;
export function toast(message) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2400);
}

/**
 * Open the shared <dialog> with caller-supplied content.
 * `render(close)` builds the body and calls close(result) to resolve.
 * Returns a promise of whatever close() was given (null if dismissed).
 */
export function dialog(render) {
  const modal = document.getElementById('modal');
  return new Promise((resolve) => {
    let settled = false;
    // Covers Esc and backdrop dismissal, which bypass our own buttons. The
    // browser fires `close` a moment *after* modal.close(), so the previous
    // dialog's event can land once this one is already showing; a dialog that
    // is still open was not the one closed, so that stale event is ignored.
    const onClose = () => { if (!modal.open) close(null); };
    const close = (result = null) => {
      if (settled) return;
      settled = true;
      modal.removeEventListener('close', onClose);
      modal.close();
      modal.replaceChildren();
      resolve(result);
    };
    modal.addEventListener('close', onClose);

    const body = el('div', { className: 'modal-body' }, render(close));
    fill(modal, body);
    modal.showModal();

    const firstField = modal.querySelector('input, textarea, select');
    if (firstField) firstField.focus();
  });
}

/** Ask for a single line of text. Resolves to the trimmed string, or null. */
export function promptText(title, label, initial = '') {
  return dialog((close) => {
    const input = el('input', { type: 'text', value: initial });
    const submit = () => {
      const value = input.value.trim();
      if (value) close(value);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    return [
      el('h2', { textContent: title }),
      el('div', {}, [el('label', { className: 'label', textContent: label }), input]),
      el('div', { className: 'modal-actions' }, [
        el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(null) }),
        el('button', { className: 'btn btn-primary', textContent: 'Save', onclick: submit }),
      ]),
    ];
  });
}

/** Ask a yes/no question. Resolves true only if confirmed. */
export function confirmDialog(title, message, confirmLabel = 'Delete') {
  return dialog((close) => [
    el('h2', { textContent: title }),
    el('p', { className: 'muted', textContent: message }),
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(false) }),
      el('button', {
        className: 'btn btn-danger', textContent: confirmLabel,
        onclick: () => close(true),
      }),
    ]),
  ]);
}

/**
 * Ask for an away period plus an optional reason, by tapping a calendar.
 *
 * The old two-input "From / To" form made the common single day take two
 * fields and a mental check that To wasn't before From. Here the first tap is
 * the start, a later tap closes the range, an earlier tap moves the start, and
 * one tap on its own is a single day.
 *
 * Resolves to { start, end, reason } or null.
 */
export function promptDateRange(title, { openDays = [0, 1, 2, 3, 4, 5, 6] } = {}) {
  return dialog((close) => {
    const today = todayISO();
    let startISO = null;
    let endISO = null;

    const reason = el('input', { type: 'text', placeholder: 'Holiday, course, ...' });
    const summary = el('div', { className: 'faint' });
    const addBtn = el('button', { className: 'btn btn-primary', textContent: 'Add', disabled: true });

    /** Highlight class for one day, given the current start/end selection. */
    const classOf = (iso) => {
      if (!startISO) return '';
      if (!endISO) return iso === startISO ? 'in-range range-edge' : '';
      if (iso === startISO || iso === endISO) return 'in-range range-edge';
      return iso > startISO && iso < endISO ? 'in-range' : '';
    };

    /** First tap sets the start; a later tap closes the range; an earlier one restarts it. */
    const onTap = (iso) => {
      if (!startISO || endISO) { startISO = iso; endISO = null; }
      else if (iso < startISO) { startISO = iso; }
      else if (iso !== startISO) { endISO = iso; }
      refresh();
    };

    const cal = monthGrid({ start: today, openDays, classOf, onTap });

    /** Redraw the grid and update the summary line and Add button. */
    const refresh = () => {
      cal.redraw();
      addBtn.disabled = !startISO;
      if (!startISO) summary.textContent = 'Tap the first day away.';
      else if (!endISO) {
        summary.textContent = `Away ${formatDate(startISO, { withWeekday: true })}`
          + ' — tap a later day for a range.';
      } else {
        summary.textContent = `Away ${formatDate(startISO, { withWeekday: false })}`
          + ` – ${formatDate(endISO, { withWeekday: false })}`;
      }
    };

    addBtn.addEventListener('click', () => {
      if (!startISO) return;
      close({ start: startISO, end: endISO || startISO, reason: reason.value.trim() });
    });

    refresh();
    return [
      el('h2', { textContent: title }),
      cal.node,
      summary,
      el('div', {}, [el('label', { className: 'label', textContent: 'Reason (optional)' }), reason]),
      el('div', { className: 'modal-actions' }, [
        el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(null) }),
        addBtn,
      ]),
    ];
  });
}

/**
 * A row of seven Mon-Sun toggle chips.
 * `selected` is an array of 0-6; onChange receives the updated sorted array.
 */
export function weekdayPicker(selected, onChange) {
  const chosen = new Set(selected);
  const wrap = el('div', { className: 'days' });

  DAY_LABELS.forEach((label, i) => {
    const chip = el('button', {
      type: 'button', className: 'day-chip', textContent: label,
      'aria-pressed': chosen.has(i) ? 'true' : 'false',
      'aria-label': label,
    });
    chip.addEventListener('click', () => {
      if (chosen.has(i)) chosen.delete(i); else chosen.add(i);
      chip.setAttribute('aria-pressed', chosen.has(i) ? 'true' : 'false');
      onChange([...chosen].sort((a, b) => a - b));
    });
    wrap.append(chip);
  });
  return wrap;
}

/** Month names for the calendar header. */
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                     'August', 'September', 'October', 'November', 'December'];

/**
 * A bare month calendar: a prev/next header and a 7-column grid of day cells.
 *
 * No bulk buttons, no repeat row - just tapping days. Shared by the away-date
 * picker and the per-person requested-dates card, which both want "tap the
 * days you mean" and nothing more.
 *
 * `classOf(iso)` returns extra CSS classes for a cell (or '' for none), so the
 * caller owns what "selected" looks like. `onTap(iso)` fires on every tap - the
 * caller updates its own state and calls the returned `redraw()`. `openDays`
 * (0-6, Mon=0) dims normally-closed days. `start` is the month shown first.
 *
 * Returns `{ node, redraw }`.
 */
export function monthGrid({ start, openDays = [0, 1, 2, 3, 4, 5, 6], classOf, onTap }) {
  const wrap = el('div', { className: 'cal' });
  let [year, month] = (start || todayISO()).split('-').map(Number);

  /** Step the displayed month by `delta` months, wrapping the year. */
  const shiftMonth = (delta) => {
    month += delta;
    if (month < 1) { month = 12; year -= 1; }
    if (month > 12) { month = 1; year += 1; }
    draw();
  };

  /** Redraw the header and grid for the current month. */
  function draw() {
    const today = todayISO();
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const firstISO = `${year}-${String(month).padStart(2, '0')}-01`;
    const leading = weekdayOf(firstISO);

    const header = el('div', { className: 'cal-head' }, [
      el('button', { type: 'button', className: 'btn btn-sm', textContent: '‹',
                     'aria-label': 'Previous month', onclick: () => shiftMonth(-1) }),
      el('div', { className: 'cal-month', textContent: `${MONTH_NAMES[month - 1]} ${year}` }),
      el('button', { type: 'button', className: 'btn btn-sm', textContent: '›',
                     'aria-label': 'Next month', onclick: () => shiftMonth(1) }),
    ]);

    const grid = el('div', { className: 'cal-grid' });
    for (const label of DAY_LABELS) {
      grid.append(el('div', { className: 'cal-dow', textContent: label.slice(0, 2) }));
    }
    for (let i = 0; i < leading; i++) grid.append(el('div', { className: 'cal-blank' }));
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const closed = !openDays.includes(weekdayOf(iso));
      const extra = classOf(iso);
      const cell = el('button', {
        type: 'button',
        className: `cal-day${iso === today ? ' is-today' : ''}`
          + `${closed ? ' is-closed' : ''}${extra ? ` ${extra}` : ''}`,
        textContent: String(d),
        'aria-label': closed ? `${iso} (normally closed)` : iso,
      });
      cell.addEventListener('click', () => onTap(iso));
      grid.append(cell);
    }

    fill(wrap, [header, grid]);
  }

  draw();
  return { node: wrap, redraw: draw };
}

/**
 * A tappable month calendar for choosing exactly which dates to roster.
 *
 * Rosters in the real world are not a clean weekday pattern - a cafe skips the
 * weekend it's closed and adds the odd Christmas market - so the dates are
 * picked individually rather than derived from a rule. The per-month bulk
 * buttons keep the common case ("every weekend in September") down to one tap.
 *
 * `selected` is a Set of "YYYY-MM-DD" strings, mutated in place; `onChange` is
 * called after every change with that Set, so the caller can update its count.
 *
 * `openDays` (0-6, Monday=0) dims the days the organisation is normally shut.
 * Dimmed, not disabled: a cafe that opens specially for a Christmas market
 * still needs to roster that day, so the styling is a hint, never a barrier.
 */
export function calendarPicker(selected, onChange, { openDays = [0, 1, 2, 3, 4, 5, 6] } = {}) {
  const wrap = el('div', { className: 'cal' });
  const isOpenDay = (iso) => openDays.includes(weekdayOf(iso));
  // Only worth offering an "Open days" shortcut when that differs from "all".
  const hasOpeningPattern = openDays.length > 0 && openDays.length < 7;

  // The month on show. Starts on whatever the user already picked, so
  // re-opening a part-built roster lands where they left off.
  const first = [...selected].sort()[0] || todayISO();
  let [year, month] = first.split('-').map(Number);   // month is 1-12 here

  /** Toggle one date and tell the caller. */
  const toggle = (iso) => {
    if (selected.has(iso)) selected.delete(iso); else selected.add(iso);
    onChange(selected);
    refreshRepeat();      // the repeat pattern is derived from the selection
  };

  /** Every date in the displayed month falling on one of `weekdays` (Mon=0). */
  const monthDatesFor = (weekdays) => {
    const out = [];
    const total = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let d = 1; d <= total; d++) {
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (weekdays.includes(weekdayOf(iso))) out.push(iso);
    }
    return out;
  };

  /** Add every matching date in this month, or remove them if all are already on. */
  const bulk = (weekdays) => {
    const dates = monthDatesFor(weekdays);
    const allOn = dates.every((d) => selected.has(d));
    for (const d of dates) {
      if (allOn) selected.delete(d); else selected.add(d);
    }
    onChange(selected);
    draw();
  };

  // ── repeat weekly ────────────────────────────────────────────────────
  // The calendar alone would mean one bulk tap per month for a roster that
  // runs all year. This projects the first week's pattern forward instead,
  // the way a calendar app repeats an event.
  const repeatCheck = el('input', { type: 'checkbox', id: 'cal-repeat' });
  const repeatWeeks = el('input', { type: 'number', min: '1', max: '104', value: '12' });
  const repeatUntil = el('input', { type: 'date' });
  const repeatNote = el('div', { className: 'faint cal-repeat-note' });
  const repeatFields = el('div', { className: 'cal-repeat-fields', hidden: true });

  // The two boxes are two views of one setting, so editing either updates the
  // other. The guard stops that mutual update bouncing back and forth.
  let syncing = false;

  /** The selected dates, sorted ascending. */
  const sortedSelection = () => [...selected].sort();

  /**
   * The weekday pattern to repeat: the weekdays picked within seven days of
   * the earliest selection. Using just the first week means adding a one-off
   * date months later doesn't silently join the repeat.
   */
  const seedPattern = () => {
    const picked = sortedSelection();
    if (picked.length === 0) return { from: null, weekdays: [] };
    const from = picked[0];
    const lastOfWeek = toDays(from) + 6;
    const weekdays = [...new Set(
      picked.filter((d) => toDays(d) <= lastOfWeek).map(weekdayOf)
    )].sort();
    return { from, weekdays };
  };

  /**
   * Rebuild the selection as the first week's pattern repeated forward.
   *
   * Recomputed from scratch rather than only added to, so shortening the range
   * takes dates away again - otherwise dropping 12 weeks to 4 would leave the
   * later dates stranded in the roster.
   */
  const applyRepeat = () => {
    const { from, weekdays } = seedPattern();
    if (!from || weekdays.length === 0 || !repeatUntil.value) return;

    const lastOfSeedWeek = toDays(from) + 6;
    for (const d of [...selected]) {
      if (toDays(d) > lastOfSeedWeek) selected.delete(d);
    }

    const end = toDays(repeatUntil.value);
    for (let n = toDays(from); n <= end; n++) {
      const iso = fromDays(n);
      if (weekdays.includes(weekdayOf(iso))) selected.add(iso);
    }
    onChange(selected);
    draw();
  };

  /** Trim the selection back to its first week when repeating is switched off. */
  const clearRepeat = () => {
    const picked = sortedSelection();
    if (picked.length === 0) return;
    const lastOfWeek = toDays(picked[0]) + 6;
    for (const d of picked) if (toDays(d) > lastOfWeek) selected.delete(d);
    onChange(selected);
    draw();
  };

  /** Set the "until" date from the week count, measured off the first date. */
  const weeksToUntil = () => {
    const { from } = seedPattern();
    const weeks = Math.max(1, Math.min(104, Number(repeatWeeks.value) || 1));
    if (!from) return;
    syncing = true;
    repeatUntil.value = fromDays(toDays(from) + weeks * 7 - 1);
    syncing = false;
  };

  /** Set the week count from the "until" date, rounding up a part week. */
  const untilToWeeks = () => {
    const { from } = seedPattern();
    if (!from || !repeatUntil.value) return;
    const span = toDays(repeatUntil.value) - toDays(from) + 1;
    syncing = true;
    repeatWeeks.value = String(Math.max(1, Math.ceil(span / 7)));
    syncing = false;
  };

  /** Update the repeat row's visibility and explanatory line. */
  const refreshRepeat = () => {
    const { from, weekdays } = seedPattern();
    repeatCheck.disabled = weekdays.length === 0;
    repeatFields.hidden = !repeatCheck.checked;

    if (weekdays.length === 0) {
      repeatNote.textContent = 'Pick a date first, then repeat it weekly.';
    } else if (!repeatCheck.checked) {
      repeatNote.textContent = '';
    } else if (!repeatUntil.value) {
      repeatNote.textContent = 'Choose how long to repeat for.';
    } else {
      const names = weekdays.map((d) => DAY_LABELS[d]).join(', ');
      repeatNote.textContent =
        `Every ${names} from ${formatDate(from, { withWeekday: false })} ` +
        `until ${formatDate(repeatUntil.value, { withWeekday: false })}.`;
    }
  };

  repeatCheck.addEventListener('change', () => {
    if (repeatCheck.checked) {
      // One tap should do something useful, so fall back to the week count.
      if (!repeatUntil.value) weeksToUntil();
      applyRepeat();
    } else {
      clearRepeat();
    }
    refreshRepeat();
  });
  repeatWeeks.addEventListener('input', () => {
    if (syncing) return;
    weeksToUntil();
    applyRepeat();
    refreshRepeat();
  });
  repeatUntil.addEventListener('change', () => {
    if (syncing) return;
    untilToWeeks();
    applyRepeat();
    refreshRepeat();
  });

  fill(repeatFields, [
    el('div', { className: 'row-tight' }, [
      el('label', { className: 'faint', textContent: 'for' }),
      repeatWeeks,
      el('label', { className: 'faint', textContent: 'weeks' }),
    ]),
    el('div', { className: 'row-tight' }, [
      el('label', { className: 'faint', textContent: 'until' }),
      repeatUntil,
    ]),
  ]);

  const repeatRow = el('div', { className: 'cal-repeat' }, [
    el('div', { className: 'row-tight' }, [
      repeatCheck,
      el('label', { htmlFor: 'cal-repeat', textContent: 'Repeat weekly' }),
    ]),
    repeatFields,
    repeatNote,
  ]);

  /** Step the displayed month by `delta` months. */
  const shiftMonth = (delta) => {
    month += delta;
    if (month < 1) { month = 12; year -= 1; }
    if (month > 12) { month = 1; year += 1; }
    draw();
  };

  /** Redraw the whole calendar for the current month. */
  function draw() {
    const today = todayISO();
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const firstISO = `${year}-${String(month).padStart(2, '0')}-01`;
    const leading = weekdayOf(firstISO);          // blank cells before the 1st

    const header = el('div', { className: 'cal-head' }, [
      el('button', {
        type: 'button', className: 'btn btn-sm', textContent: '‹',
        'aria-label': 'Previous month', onclick: () => shiftMonth(-1),
      }),
      el('div', { className: 'cal-month', textContent: `${MONTH_NAMES[month - 1]} ${year}` }),
      el('button', {
        type: 'button', className: 'btn btn-sm', textContent: '›',
        'aria-label': 'Next month', onclick: () => shiftMonth(1),
      }),
    ]);

    const grid = el('div', { className: 'cal-grid' });
    // Two letters, not one: "T" and "S" appear twice each, so single initials
    // make Tue/Thu and Sat/Sun indistinguishable at a glance.
    for (const label of DAY_LABELS) {
      grid.append(el('div', { className: 'cal-dow', textContent: label.slice(0, 2) }));
    }
    for (let i = 0; i < leading; i++) {
      grid.append(el('div', { className: 'cal-blank' }));
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const closed = !isOpenDay(iso);
      const cell = el('button', {
        type: 'button',
        className: `cal-day${iso === today ? ' is-today' : ''}${closed ? ' is-closed' : ''}`,
        textContent: String(d),
        'aria-pressed': selected.has(iso) ? 'true' : 'false',
        'aria-label': closed ? `${iso} (normally closed)` : iso,
      });
      cell.addEventListener('click', () => {
        toggle(iso);
        cell.setAttribute('aria-pressed', selected.has(iso) ? 'true' : 'false');
      });
      grid.append(cell);
    }

    // Once opening days are set they are almost always what you want to pick,
    // so that shortcut leads and the generic ones fall in behind it.
    const bulkRow = el('div', { className: 'row-tight cal-bulk' }, [
      hasOpeningPattern
        ? el('button', { type: 'button', className: 'btn btn-sm btn-primary',
                         textContent: 'All open days', onclick: () => bulk(openDays) })
        : null,
      el('button', { type: 'button', className: 'btn btn-sm', textContent: 'Saturdays',
                     onclick: () => bulk([5]) }),
      el('button', { type: 'button', className: 'btn btn-sm', textContent: 'Sundays',
                     onclick: () => bulk([6]) }),
      el('button', { type: 'button', className: 'btn btn-sm', textContent: 'Weekends',
                     onclick: () => bulk([5, 6]) }),
      el('button', { type: 'button', className: 'btn btn-sm', textContent: 'Weekdays',
                     onclick: () => bulk([0, 1, 2, 3, 4]) }),
    ].filter(Boolean));

    fill(wrap, [header, grid, bulkRow, repeatRow]);
    refreshRepeat();
  }

  draw();
  return wrap;
}

/** Copy text to the clipboard, falling back for browsers without the async API. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    // Safari refuses clipboard writes outside a user gesture in some contexts;
    // the textarea trick still works there.
    const ta = el('textarea', { value: text });
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('Copied');
    } catch {
      toast('Could not copy — select the text and copy manually');
    }
    ta.remove();
  }
}

/**
 * Offer a text file for download.
 * Used by Export; on iOS this opens the share sheet, which is the sane way to
 * get a backup into Files or Drive.
 */
export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A standard empty-state block. */
export function emptyState(title, detail, action) {
  return el('div', { className: 'empty' }, [
    el('strong', { textContent: title }),
    el('div', { className: 'muted', textContent: detail }),
    action ? el('div', { style: 'margin-top:.9rem' }, action) : null,
  ]);
}
