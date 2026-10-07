/**
 * Deterministic roster allocation.
 *
 * A direct port of the original Python scheduler, kept behaviour-identical:
 * given the same inputs it always produces the same roster, every constraint it
 * is given is actually enforced, and anything it cannot satisfy is reported as
 * an explicit note rather than quietly fudged.
 *
 * The algorithm is a greedy fill with a fairness ranking. Days are processed in
 * order; within a day, shifts are filled in the organisation's own shift order.
 * For each vacancy the eligible pool is ranked by
 *
 *   1. fewest shifts worked so far in this roster   (spread the load)
 *   2. longest since last worked                    (spread the days out)
 *   3. name                                         (a stable, arbitrary tiebreak)
 *
 * Greedy rather than an exhaustive search because rosters are small, the result
 * must be explainable to whoever reads it ("Alice got Saturday because she'd
 * worked the fewest shifts"), and a solver that silently reshuffles everything
 * on a one-person change is worse to live with than one that does the obvious
 * thing.
 *
 * Dates are handled throughout as "YYYY-MM-DD" strings converted to whole-day
 * integers in UTC. Doing arithmetic on local-time Date objects would shift days
 * across daylight-saving boundaries, which for a roster is a real bug.
 */

/** Sentinel "has never worked" value; any real day sorts after it. */
const NEVER = -Infinity;

/** Convert a "YYYY-MM-DD" string to a whole number of days since the epoch. */
export function toDays(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** Convert a whole-day number back to a "YYYY-MM-DD" string. */
export function fromDays(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/**
 * Today's date on this device's own clock, as "YYYY-MM-DD".
 *
 * Not `toISOString()`: that is UTC, so in Australia it reports yesterday until
 * mid-morning - the calendar rings the wrong day and this morning's away dates
 * count as already past.
 */
export function todayISO(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Weekday index for a date, Monday=0 through Sunday=6 (matches the UI order). */
export function weekdayOf(iso) {
  return (new Date(toDays(iso) * 86400000).getUTCDay() + 6) % 7;
}

/**
 * Month and weekday names, fixed rather than taken from the browser locale.
 *
 * Locale formatting would vary by device (en-GB renders September as "Sept",
 * four characters where every other month gives three) which both breaks the
 * column alignment in the text table and means two people copying the same
 * roster could get different text. A roster is shared output, so it is pinned.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Short weekday name for a date, e.g. "Sat". */
export function weekdayName(iso) {
  return WEEKDAY_NAMES[weekdayOf(iso)];
}

/** Format a date for display, e.g. "Sat 06 Jun 2026". */
export function formatDate(iso, { withWeekday = true } = {}) {
  const [y, m, d] = iso.split('-').map(Number);
  const stamp = `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
  return withWeekday ? `${weekdayName(iso)} ${stamp}` : stamp;
}

/**
 * Every date from start to end inclusive whose weekday is rostered.
 * `weekdays` is a Set of 0-6 values; an empty set yields no days at all.
 */
export function dateRange(start, end, weekdays) {
  let a = toDays(start);
  let b = toDays(end);
  if (b < a) [a, b] = [b, a];

  const out = [];
  for (let n = a; n <= b; n++) {
    const iso = fromDays(n);
    if (weekdays.has(weekdayOf(iso))) out.push(iso);
  }
  return out;
}

/** Expand unordered clash pairs into a person-id -> Set(incompatible ids) map. */
function clashMap(clashes) {
  const map = new Map();
  for (const [a, b] of clashes) {
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(b)) map.set(b, new Set());
    map.get(a).add(b);
    map.get(b).add(a);
  }
  return map;
}

/**
 * True if a person can work `iso`.
 *
 * A blackout is a hard "can't" and always wins. The standing weekday pattern is
 * the default, but an explicit request for this exact date overrides it: "I
 * want to work that day" is a stronger, more deliberate signal than "I don't
 * usually work Saturdays", so a one-off request lets someone work a weekday
 * their pattern would otherwise exclude.
 */
export function canWork(person, iso) {
  if (!person.active) return false;
  const n = toDays(iso);
  if ((person.blackouts || []).some((b) => toDays(b.start) <= n && n <= toDays(b.end))) {
    return false;
  }
  if ((person.requests || []).includes(iso)) return true;
  return person.availableWeekdays.includes(weekdayOf(iso));
}

/**
 * Choose the fairest eligible person for one vacancy, or null if there is none.
 */
function pick(day, people, usedToday, placedIds, incompatible, worked, lastWorked) {
  const eligible = people.filter(
    (p) =>
      !usedToday.has(p.id) &&                                  // not already on today
      canWork(p, day) &&                                       // availability + blackouts
      ![...(incompatible.get(p.id) || [])].some((id) => placedIds.has(id)) && // no clash
      (p.maxShifts == null || worked.get(p.id) < p.maxShifts)
  );
  if (eligible.length === 0) return null;

  // Ranking. Someone who asked for this date goes first - a request is a
  // preference, not a guarantee, so it orders the queue but never overrides a
  // hard constraint. Fairness then applies as usual, and comparing `name` last
  // makes the ordering total, so the result is reproducible run to run.
  eligible.sort((x, y) => {
    const rx = (x.requests || []).includes(day) ? 0 : 1;
    const ry = (y.requests || []).includes(day) ? 0 : 1;
    if (rx !== ry) return rx - ry;
    const wx = worked.get(x.id), wy = worked.get(y.id);
    if (wx !== wy) return wx - wy;
    const lx = lastWorked.get(x.id), ly = lastWorked.get(y.id);
    if (lx !== ly) return lx - ly;
    return x.name.toLowerCase().localeCompare(y.name.toLowerCase());
  });
  return eligible[0];
}

/**
 * Allocate staff across the date range and return the finished roster.
 *
 * Anything that could not be satisfied - an unfillable shift, a person with no
 * availability at all - is pushed onto `roster.notes` instead of being silently
 * dropped, so the UI can surface it next to the result.
 */
export function buildRoster({ orgId, name, people, shifts, clashes, start, end, weekdays, dates }) {
  // `dates` is the canonical input: the exact days to roster, as chosen on the
  // calendar. start/end/weekdays remain supported as a shorthand that derives
  // the same list, which is what the test suite and older saved rosters use.
  // Presence, not length, picks the branch - an empty `dates` means "nothing
  // selected" and must report that, not silently fall back to a date range
  // whose bounds were never supplied.
  const days = Array.isArray(dates)
    ? [...new Set(dates)].sort()
    : dateRange(start, end, weekdays);
  const roster = {
    orgId,
    name,
    startDate: days.length ? days[0] : start,
    endDate: days.length ? days[days.length - 1] : end,
    // The exact dates rostered, kept on the roster so a saved one can be
    // redrawn faithfully later. Without it a day where nothing could be filled
    // would simply vanish from the saved view, hiding the very gap that most
    // needs looking at.
    days,
    assignments: [],
    notes: [],
  };

  // Guard the degenerate inputs up front so the main loop can assume it has
  // something to work with.
  const roll = people.filter((p) => p.active);
  if (days.length === 0) {
    roster.notes.push(dates
      ? 'No dates picked on the calendar.'
      : 'No rostered days fall in the selected date range.');
    return roster;
  }
  if (shifts.length === 0) {
    roster.notes.push('This organisation has no shifts set up.');
    return roster;
  }
  if (roll.length === 0) {
    roster.notes.push('No active people to roster.');
    return roster;
  }

  const incompatible = clashMap(clashes);
  const worked = new Map(roll.map((p) => [p.id, 0]));
  const lastWorked = new Map(roll.map((p) => [p.id, NEVER]));

  for (const day of days) {
    // One shift per person per day: whoever is already on today is out of the
    // pool for the day's remaining shifts.
    const usedToday = new Set();

    for (const shift of shifts) {
      const placedIds = new Set();
      let placed = 0;

      for (let i = 0; i < Math.max(0, shift.headcount); i++) {
        const who = pick(day, roll, usedToday, placedIds, incompatible, worked, lastWorked);
        if (!who) break;
        placed++;
        placedIds.add(who.id);
        usedToday.add(who.id);
        worked.set(who.id, worked.get(who.id) + 1);
        lastWorked.set(who.id, toDays(day));
        roster.assignments.push({ date: day, shiftId: shift.id, personId: who.id });
      }

    }
  }

  roster.notes = auditRoster(roster, roll, shifts);
  return roster;
}

/**
 * Regenerate a roster's notes from its current assignments.
 *
 * Run at the end of a build and again after any manual edit, so the "things to
 * check" list stays true to what the roster actually says now rather than to
 * how it first came out of the scheduler. Covers: understaffed shifts, requests
 * that were asked for but not granted, and active people used nowhere.
 */
export function auditRoster(roster, people, shifts) {
  const notes = [];
  const active = people.filter((p) => p.active);
  const days = roster.days?.length
    ? [...roster.days].sort()
    : [...new Set(roster.assignments.map((a) => a.date))].sort();

  // Understaffed shifts, day by day, in shift order.
  for (const day of days) {
    for (const shift of shifts) {
      const n = roster.assignments.filter(
        (a) => a.date === day && a.shiftId === shift.id
      ).length;
      if (n < shift.headcount) {
        notes.push(`${formatDate(day)} - ${shift.name}: only ${n} of ${shift.headcount} filled.`);
      }
    }
  }

  const datesByPerson = new Map();
  for (const a of roster.assignments) {
    if (!datesByPerson.has(a.personId)) datesByPerson.set(a.personId, new Set());
    datesByPerson.get(a.personId).add(a.date);
  }
  const rostered = new Set(days);

  // Requests asked for within the rostered period but not granted.
  for (const p of active) {
    const got = datesByPerson.get(p.id) || new Set();
    for (const date of (p.requests || [])) {
      if (rostered.has(date) && !got.has(date)) {
        notes.push(`${p.name} asked for ${formatDate(date)} but could not be fitted in.`);
      }
    }
  }

  // Active people the roster never used. Only worth a note when they *couldn't*
  // have worked any of these days - no availability ticked, or unavailable on
  // every one. Someone who could have worked but wasn't picked (fair rotation,
  // or a deliberate manual edit) is not a problem to flag.
  for (const p of active) {
    if (datesByPerson.has(p.id)) continue;
    if ((p.availableWeekdays || []).length === 0) {
      notes.push(`${p.name} was not rostered at all - no days ticked in their availability.`);
    } else if (days.every((d) => !canWork(p, d))) {
      notes.push(`${p.name} was not rostered at all - unavailable on every rostered day.`);
    }
  }

  return notes;
}

/** Shifts worked per person id, for the fairness summary. */
export function counts(roster) {
  const out = new Map();
  for (const a of roster.assignments) {
    out.set(a.personId, (out.get(a.personId) || 0) + 1);
  }
  return out;
}

/**
 * Render a roster as an aligned monospace table.
 *
 * Used for the Copy and Export actions - it pastes cleanly into a message or a
 * printout. The on-screen view uses a day-by-day layout instead, because a wide
 * table is the wrong shape for a phone.
 */
export function formatTable(roster, people, shifts) {
  const names = new Map(people.map((p) => [p.id, p.name]));

  // Index assignments by date+shift so each cell is a single lookup.
  const cells = new Map();
  for (const a of roster.assignments) {
    const key = `${a.date}|${a.shiftId}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(names.get(a.personId) || `#${a.personId}`);
  }

  const days = [...new Set(roster.assignments.map((a) => a.date))].sort();
  const headers = ['Date', 'Day', ...shifts.map((s) => shiftLabel(s))];
  const rows = days.map((d) => [
    formatDate(d, { withWeekday: false }),
    weekdayName(d),
    ...shifts.map((s) => (cells.get(`${d}|${s.id}`) || []).sort().join(', ') || '-'),
  ]);

  // Column widths are the widest cell in each column, header included.
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length), 0)
  );
  const line = (cols) =>
    cols.map((c, i) => c.padEnd(widths[i])).join('  ').replace(/\s+$/, '');

  const out = [line(headers), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const r of rows) out.push(line(r));

  // Fairness summary: how many shifts each person actually ended up with.
  const tally = [...counts(roster).entries()].sort(
    (a, b) => b[1] - a[1] || (names.get(a[0]) || '').localeCompare(names.get(b[0]) || '')
  );
  if (tally.length) {
    out.push('', 'Summary');
    for (const [pid, n] of tally) {
      out.push(`  ${names.get(pid) || `#${pid}`}: ${n} shift${n === 1 ? '' : 's'}`);
    }
  }

  if (roster.notes.length) {
    out.push('', 'Notes');
    for (const n of roster.notes) out.push(`  - ${n}`);
  }

  return out.join('\n');
}

/** Display label for a shift, e.g. "Early (06:00-14:00)". */
export function shiftLabel(shift) {
  if (shift.start && shift.end) return `${shift.name} (${shift.start}-${shift.end})`;
  return shift.name;
}
