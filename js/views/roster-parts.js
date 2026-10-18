/**
 * The pieces of a roster on screen, shared by the just-built result (New
 * Roster) and an opened saved roster: the day-by-day cards, the "who's on how
 * much" tally, Copy/Share, and manual editing.
 *
 * Manual editing swaps, adds or removes the people on any shift. The scheduler's fill is deterministic and usually right, but the real world
 * throws late swaps at it - someone calls in sick, two people trade a day - and
 * going back to change availability and rebuilding would reshuffle everything
 * else. This lets the roster be nudged in place instead.
 */
import { store } from '../store.js';
import { el, copyText, dialog, downloadText, toast } from '../ui.js';
import { formatDate, toDays, weekdayOf, counts, canDoRole, canWork } from '../scheduler.js';
import {
  rosterDays, rosterLines, shiftTimes, formatMessage, formatPerPerson, toCSV, toICS, fileBase,
} from '../export.js';

/**
 * People who could be put on `date` without double-booking them or working
 * them through a blackout.
 *
 * Sorted by name. Someone whose standing weekday pattern doesn't cover the date
 * is still offered - a manual edit is a deliberate override - but the caller
 * flags them so it is a conscious choice, not a slip.
 */
export function candidatesFor(roster, people, date) {
  const busy = new Set(
    roster.assignments.filter((a) => a.date === date).map((a) => a.personId)
  );
  const n = toDays(date);
  return people
    .filter((p) => p.active && !busy.has(p.id))
    .filter((p) => !(p.blackouts || []).some(
      (b) => toDays(b.start) <= n && n <= toDays(b.end)
    ))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One shift's row in edit mode when the shift is made of roles: a line per
 * role with its people as removable chips and a picker of those who can do it.
 * Anyone on the shift under a role it no longer lists keeps a chip under
 * "Others", so editing never hides a saved assignment.
 */
function editableRoleRow(roster, people, shift, day, here, roleById, apply) {
  const nameOf = (id) => people.find((p) => p.id === id)?.name || '(removed)';
  const listed = new Set(shift.roles.map((r) => r.roleId));
  const slots = shift.roles.map((r) => ({
    roleId: r.roleId, count: r.count, label: roleById.get(r.roleId)?.name || '(removed role)',
    mine: here.filter((a) => a.roleId === r.roleId),
  }));
  const strays = here.filter((a) => !listed.has(a.roleId ?? null));
  if (strays.length) slots.push({ roleId: null, count: 0, label: 'Others', mine: strays, noAdd: true });

  const lines = slots.map((slot) => {
    const chips = slot.mine.map((a) => el('span', { className: 'edit-chip' }, [
      nameOf(a.personId),
      el('button', {
        type: 'button', className: 'edit-x', textContent: '×',
        'aria-label': `Remove ${nameOf(a.personId)} from ${shift.name}, ${slot.label}, on ${day}`,
        onclick: () => apply(roster.assignments.filter((x) => x !== a)),
      }),
    ]));
    const candidates = slot.noAdd ? [] : candidatesFor(roster, people, day)
      .filter((p) => canDoRole(p, slot.roleId, roleById));
    let adder = null;
    if (candidates.length) {
      const select = el('select', { className: 'edit-add' }, [
        el('option', { value: '', textContent: slot.mine.length < slot.count ? '+ add' : '+ add another' }),
        ...candidates.map((p) => el('option', {
          value: String(p.id),
          textContent: p.availableWeekdays.includes(weekdayOf(day)) ? p.name : `${p.name} · usually off`,
        })),
      ]);
      select.addEventListener('change', () => {
        const id = Number(select.value);
        if (id) apply([...roster.assignments, { date: day, shiftId: shift.id, personId: id, roleId: slot.roleId }]);
      });
      adder = select;
    }
    const short = slot.mine.length < slot.count;
    return el('div', { className: short ? 'swho edit gap' : 'swho edit' }, [
      el('span', { className: 'faint', textContent: `${slot.label}: ` }),
      ...chips,
      adder,
      !chips.length && !adder ? el('span', { className: 'faint', textContent: 'nobody free' }) : null,
    ]);
  });
  return el('div', { className: 'day-shift' }, [el('span', { className: 'sname', textContent: shift.name }), el('div', {}, lines)]);
}

/**
 * The day-by-day cards in edit mode: every shift row shows its people as
 * removable chips plus an "add" picker. `apply(nextAssignments)` is called with
 * a new assignments array on every change and is responsible for persisting it
 * and re-rendering.
 */
export function editableDayCards(roster, people, shifts, apply) {
  const nameOf = (id) => people.find((p) => p.id === id)?.name || '(removed)';
  const roles = store.roles();
  const roleById = new Map(roles.map((r) => [r.id, r]));
  return rosterDays(roster).map((day) => {
    const rows = shifts.map((shift) => {
      const here = roster.assignments.filter(
        (a) => a.date === day && a.shiftId === shift.id
      );
      if (shift.roles?.length) return editableRoleRow(roster, people, shift, day, here, roleById, apply);
      const candidates = candidatesFor(roster, people, day);

      // One removable chip per person currently on this shift.
      const chips = here.map((a) => el('span', { className: 'edit-chip' }, [
        nameOf(a.personId),
        el('button', {
          type: 'button', className: 'edit-x', textContent: '×',
          'aria-label': `Remove ${nameOf(a.personId)} from ${shift.name} on ${day}`,
          onclick: () => apply(roster.assignments.filter((x) => x !== a)),
        }),
      ]));

      // A picker of everyone who could take a place on this shift.
      let adder = null;
      if (candidates.length) {
        const select = el('select', { className: 'edit-add' }, [
          el('option', {
            value: '',
            textContent: here.length < shift.headcount ? '+ add' : '+ add another',
          }),
          ...candidates.map((p) => el('option', {
            value: String(p.id),
            textContent: p.availableWeekdays.includes(weekdayOf(day))
              ? p.name
              : `${p.name} · usually off`,
          })),
        ]);
        select.addEventListener('change', () => {
          const id = Number(select.value);
          if (id) {
            apply([...roster.assignments, { date: day, shiftId: shift.id, personId: id }]);
          }
        });
        adder = select;
      }

      const short = here.length < shift.headcount;
      return el('div', { className: 'day-shift' }, [
        el('span', { className: 'sname', textContent: shift.name }),
        el('span', { className: short ? 'swho edit gap' : 'swho edit' }, [
          ...chips,
          adder,
          !chips.length && !adder
            ? el('span', { className: 'faint', textContent: 'nobody free' })
            : null,
        ]),
      ]);
    });

    return el('div', { className: 'day-card' }, [
      el('div', { className: 'day-date', textContent: formatDate(day) }),
      ...rows,
    ]);
  });
}

/**
 * Read-only day cards: one per date, one row per shift.
 *
 * Every current shift is shown on every day, so a shift nobody could take
 * reads "Nobody available" rather than silently vanishing. A shift deleted
 * since the roster was saved still shows its people, last, as "(removed)".
 */
export function dayCards(roster, people, shifts) {
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const known = new Set(shifts.map((s) => s.id));
  const byDay = new Map(rosterLines(roster, people, shifts, store.roles()).map((l) => [l.date, l]));

  return rosterDays(roster).map((day) => {
    const todays = roster.assignments.filter((a) => a.date === day);
    const extraIds = [...new Set(todays.map((a) => a.shiftId))].filter((id) => !known.has(id));

    const rows = [...shifts, ...extraIds.map((id) => ({ id, name: '(removed)', headcount: 0 }))]
      .map((shift) => {
        // A shift made of roles: a line per role, flagged when it is short.
        if (shift.roles?.length) {
          const groups = byDay.get(day)?.shifts.find((s) => s.shift.id === shift.id)?.groups || [];
          return el('div', { className: 'day-shift' }, [
            el('span', { className: 'sname', textContent: shift.name }),
            el('div', {}, groups.map((g) => el('div', {
              className: g.short ? 'swho gap' : 'swho',
              textContent: `${g.role || 'Others'}: ${g.names.join(', ') || 'nobody'}${g.short && g.names.length ? ` (needs ${g.short} more)` : ''}`,
            }))),
          ]);
        }
        const names = todays
          .filter((a) => a.shiftId === shift.id)
          .map((a) => nameOf.get(a.personId) || '(removed)');

        let who = names.join(', ');
        let gap = false;
        if (names.length === 0) {
          who = 'Nobody available';
          gap = true;
        } else if (names.length < shift.headcount) {
          who += ` (needs ${shift.headcount - names.length} more)`;
          gap = true;
        }
        return el('div', { className: 'day-shift' }, [
          el('span', { className: 'sname', textContent: shift.name }),
          el('span', { className: gap ? 'swho gap' : 'swho', textContent: who }),
        ]);
      });

    return el('div', { className: 'day-card' }, [
      el('div', { className: 'day-date', textContent: formatDate(day) }),
      ...rows,
    ]);
  });
}

/** "Who's on how much": one chip per person, busiest first. */
export function tally(roster, people) {
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const entries = [...counts(roster).entries()]
    .map(([id, n]) => [nameOf.get(id) || '(removed)', n])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return el('div', { className: 'tally' }, entries.map(([name, n]) => (
    el('span', { className: 'chip' }, [`${name} `, el('b', { textContent: String(n) })])
  )));
}

/** The "N things to check" box above a roster, or null when there are none. */
/**
 * The roles a built roster left short, with who could fill them if they were
 * ticked for it: `[{ role, days, missing, candidates }]`. A candidate is an
 * active person not yet ticked for the role who is free on at least one of the
 * days it was short. Roles open to anyone are never short for want of a tick.
 */
export function roleGaps(roster, people, shifts, roles) {
  const days = roster.days?.length ? roster.days : [...new Set(roster.assignments.map((a) => a.date))];
  const found = new Map();   // roleId -> { days: Set, missing, shortDays: [] }
  for (const day of days) {
    for (const shift of shifts) {
      for (const r of shift.roles || []) {
        const n = roster.assignments.filter(
          (a) => a.date === day && a.shiftId === shift.id && a.roleId === r.roleId
        ).length;
        if (n >= r.count) continue;
        const f = found.get(r.roleId) || { days: new Set(), missing: 0, shortDays: [] };
        f.days.add(day); f.missing += r.count - n; f.shortDays.push(day);
        found.set(r.roleId, f);
      }
    }
  }
  return [...found].map(([roleId, f]) => ({
    role: roles.find((r) => r.id === roleId),
    days: f.days.size,
    missing: f.missing,
    candidates: people
      .filter((p) => p.active && !(p.roleIds || []).includes(roleId) && f.shortDays.some((d) => canWork(p, d)))
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.role && !g.role.anyone);
}

/**
 * A card that turns "Drums: only 0 of 1 filled" into a fix: pick someone who
 * can play it, and they are ticked for the role and the roster is rebuilt.
 * `rebuild` rebuilds the roster; `openSkills` opens the who-can-do-what grid.
 */
export function gapFixes(roster, people, shifts, { rebuild, openSkills }) {
  const gaps = roleGaps(roster, people, shifts, store.roles());
  if (gaps.length === 0) return null;
  const rows = gaps.map((g) => {
    const label = `${g.role.name}: short on ${g.days} day${g.days === 1 ? '' : 's'}`;
    if (g.candidates.length === 0) {
      return el('div', {}, [label, el('div', { className: 'faint', textContent: 'Nobody else is free on those days.' })]);
    }
    const pick = el('select', {}, [
      el('option', { value: '', textContent: `Who else can do ${g.role.name}?` }),
      ...g.candidates.map((p) => el('option', { value: String(p.id), textContent: p.name })),
    ]);
    pick.addEventListener('change', () => {
      const person = people.find((p) => p.id === Number(pick.value));
      if (!person) return;
      store.updatePerson(person.id, { roleIds: [...(person.roleIds || []), g.role.id] });
      toast(`${person.name} can now do ${g.role.name}`);
      rebuild();
    });
    return el('div', {}, [label, pick]);
  });
  return el('div', { className: 'card' }, [
    el('strong', { textContent: 'Fill the gaps' }),
    ...rows,
    el('button', { className: 'btn btn-sm', textContent: 'See who can do what', onclick: openSkills }),
  ]);
}

export function notesBox(roster) {
  const n = roster.notes.length;
  if (n === 0) return null;
  return el('div', { className: 'notice bad' }, [
    el('strong', { textContent: `${n} thing${n === 1 ? '' : 's'} to check` }),
    el('ul', {}, roster.notes.map((note) => el('li', { textContent: note }))),
  ]);
}

/** The Share / export button for a roster; opens the export menu. */
export function exportButton(roster, people, shifts) {
  return el('button', {
    className: 'btn', textContent: 'Share / export',
    onclick: () => openExport(roster, people, shifts),
  });
}

/**
 * Hand text to the phone's share sheet, falling back to the clipboard where
 * there is none. Closing the share sheet is not an error, so it is swallowed.
 */
async function shareText(title, text) {
  if (!navigator.share) return copyText(text);
  try {
    await navigator.share({ title, text });
  } catch (e) {
    if (e?.name !== 'AbortError') copyText(text);
  }
}

/**
 * The export menu: message and per-person text (copy or share), print, and
 * calendar / spreadsheet files. It stays open so several can be done in a row.
 */
function openExport(roster, people, shifts) {
  const base = fileBase(roster);

  /** One row of the menu: what it is, a line on when to use it, its buttons. */
  const row = (title, hint, actions) => el('div', { className: 'export-row' }, [
    el('div', { className: 'item-main' }, [
      el('div', { className: 'item-title', textContent: title }),
      el('div', { className: 'item-sub', textContent: hint }),
    ]),
    el('div', { className: 'row-tight' }, actions),
  ]);
  /** Copy and (where there is a share sheet) Share buttons for some text. */
  const textButtons = (make) => [
    el('button', { className: 'btn btn-sm', textContent: 'Copy', onclick: () => copyText(make()) }),
    navigator.share
      ? el('button', { className: 'btn btn-sm', textContent: 'Share', onclick: () => shareText(roster.name, make()) })
      : null,
  ];
  /** A button that saves a generated file. */
  const fileButton = (label, name, make, type) => el('button', {
    className: 'btn btn-sm', textContent: label,
    onclick: () => downloadText(name, make(), type),
  });

  return dialog((close) => [
    el('h2', { textContent: 'Share or export' }),
    el('div', { className: 'list' }, [
      row('Message', 'For a group chat or email: each day and who is on.',
        textButtons(() => formatMessage(roster, people, shifts, store.roles()))),
      row("Each person's shifts", 'One line per person, to message people one by one.',
        textButtons(() => formatPerPerson(roster, people, shifts, store.roles()))),
      row('Print or PDF', 'A clean page for the noticeboard. Choose "Save as PDF" to email it.', [
        el('button', {
          className: 'btn btn-sm', textContent: 'Print',
          onclick: () => { close(); printRoster(roster, people, shifts); },
        }),
      ]),
      row('Calendar', "An .ics file people can add to their phone's calendar.", [
        fileButton('Download', `${base}.ics`, () => toICS(roster, people, shifts, new Date(), store.roles()), 'text/calendar'),
      ]),
      row('Spreadsheet', 'A .csv file for Excel or Google Sheets.', [
        fileButton('Download', `${base}.csv`, () => toCSV(roster, people, shifts, store.roles()), 'text/csv'),
      ]),
    ]),
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn btn-primary', textContent: 'Done', onclick: () => close() }),
    ]),
  ]);
}

/**
 * Print the roster on its own: a plain table, one row per day and a column
 * per shift, on a white page. The app itself is hidden while printing (see
 * `body.printing` in app.css), and the sheet is removed again afterwards.
 */
export function printRoster(roster, people, shifts) {
  const lines = rosterLines(roster, people, shifts, store.roles());
  const columns = lines[0]?.shifts.map(({ shift }) => shift) || [];

  const head = el('tr', {}, [
    el('th', { textContent: 'Date' }),
    ...columns.map((shift) => el('th', {}, [
      shift.name,
      shiftTimes(shift) ? el('div', { className: 'print-times', textContent: shiftTimes(shift) }) : null,
    ])),
  ]);
  const body = lines.map((day) => el('tr', {}, [
    el('td', { className: 'print-date', textContent: formatDate(day.date) }),
    ...day.shifts.map(({ groups, short }) => el('td', {}, [
      groups.flatMap((g) => g.names.map((n) => (g.role ? `${n} (${g.role})` : n))).join(', ') || null,
      short ? el('div', { className: 'print-gap', textContent: groups.some((g) => g.names.length) ? `needs ${short} more` : 'unfilled' }) : null,
    ])),
  ]));

  const sheet = el('section', { id: 'print-sheet' }, [
    el('h1', { textContent: roster.name }),
    el('table', {}, [el('thead', {}, head), el('tbody', {}, body)]),
    el('p', { className: 'print-foot', textContent: 'Made with RosterWarden' }),
  ]);

  document.getElementById('print-sheet')?.remove();
  document.body.append(sheet);
  document.body.classList.add('printing');

  /** Put the app back once the print dialog closes. */
  const done = () => {
    document.body.classList.remove('printing');
    sheet.remove();
  };
  window.addEventListener('afterprint', done, { once: true });
  // Let the closing dialog leave the screen before the print snapshot is taken.
  setTimeout(() => window.print(), 50);
}
