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
import { el, copyText } from '../ui.js';
import { formatDate, toDays, weekdayOf, counts, formatTable } from '../scheduler.js';

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
 * The day-by-day cards in edit mode: every shift row shows its people as
 * removable chips plus an "add" picker. `apply(nextAssignments)` is called with
 * a new assignments array on every change and is responsible for persisting it
 * and re-rendering.
 */
export function editableDayCards(roster, people, shifts, apply) {
  const nameOf = (id) => people.find((p) => p.id === id)?.name || '(removed)';
  return rosterDays(roster).map((day) => {
    const rows = shifts.map((shift) => {
      const here = roster.assignments.filter(
        (a) => a.date === day && a.shiftId === shift.id
      );
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
 * The dates a roster covers, in order.
 *
 * Prefers the day list recorded when it was built, so a day where nothing
 * could be filled still shows. Rosters saved before that field existed fall
 * back to the dates that actually got someone.
 */
export function rosterDays(roster) {
  return roster.days?.length
    ? [...roster.days].sort()
    : [...new Set(roster.assignments.map((a) => a.date))].sort();
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

  return rosterDays(roster).map((day) => {
    const todays = roster.assignments.filter((a) => a.date === day);
    const extraIds = [...new Set(todays.map((a) => a.shiftId))].filter((id) => !known.has(id));

    const rows = [...shifts, ...extraIds.map((id) => ({ id, name: '(removed)', headcount: 0 }))]
      .map((shift) => {
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
export function notesBox(roster) {
  const n = roster.notes.length;
  if (n === 0) return null;
  return el('div', { className: 'notice bad' }, [
    el('strong', { textContent: `${n} thing${n === 1 ? '' : 's'} to check` }),
    el('ul', {}, roster.notes.map((note) => el('li', { textContent: note }))),
  ]);
}

/**
 * Copy, and Share where the device has a share sheet, for a roster as text.
 * Dismissing the share sheet is not an error, so it is swallowed.
 */
export function copyShareButtons(roster, people, shifts) {
  const text = () => formatTable(roster, people, shifts);
  const buttons = [
    el('button', { className: 'btn', textContent: 'Copy', onclick: () => copyText(text()) }),
  ];
  if (navigator.share) {
    buttons.push(el('button', {
      className: 'btn', textContent: 'Share',
      onclick: async () => {
        try {
          await navigator.share({ title: roster.name, text: text() });
        } catch (e) {
          if (e?.name !== 'AbortError') copyText(text());
        }
      },
    }));
  }
  return buttons;
}
