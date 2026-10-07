/**
 * Ways to get a roster out of the app: a message for a group chat, a line per
 * person, a spreadsheet and a calendar file. (Printing is a view, in
 * views/roster-parts.js; it uses the same day-by-day shape as `rosterLines`.)
 *
 * Pure functions over plain data - no DOM - so they run under `node --test`.
 * Every format lists every rostered day and every shift, so an unfilled shift
 * shows as a gap to chase rather than quietly vanishing.
 */
import { formatDate, weekdayName } from './scheduler.js';

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

/** "8:00–12:00" from "08:00"/"12:00", or '' when a shift has no times. */
export function shiftTimes(shift) {
  if (!shift?.start || !shift?.end) return '';
  const short = (t) => t.replace(/^0(\d)/, '$1');
  return `${short(shift.start)}–${short(shift.end)}`;
}

/** "Sun 11 Oct" - the short date used in messages, where the year is noise. */
function shortDate(iso) {
  return `${weekdayName(iso)} ${formatDate(iso, { withWeekday: false }).replace(/ \d{4}$/, '').replace(/^0/, '')}`;
}

/**
 * The roster as rows: one per day, each with one entry per shift.
 *
 * Shifts follow the organisation's current order; a shift deleted since the
 * roster was saved still appears (as "(removed)") if anyone was on it.
 * Each shift entry is `{ shift, names, short }`, `short` being how many more
 * people it needed.
 */
export function rosterLines(roster, people, shifts) {
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const known = new Set(shifts.map((s) => s.id));

  return rosterDays(roster).map((date) => {
    const todays = roster.assignments.filter((a) => a.date === date);
    const extra = [...new Set(todays.map((a) => a.shiftId))]
      .filter((id) => !known.has(id))
      .map((id) => ({ id, name: '(removed)', headcount: 0, start: '', end: '' }));

    return {
      date,
      shifts: [...shifts, ...extra].map((shift) => {
        const names = todays
          .filter((a) => a.shiftId === shift.id)
          .map((a) => nameOf.get(a.personId) || '(removed)');
        return { shift, names, short: Math.max(0, shift.headcount - names.length) };
      }),
    };
  });
}

/** "11 Oct – 25 Oct 2026" for a title line. */
function span(roster) {
  const days = rosterDays(roster);
  if (!days.length) return '';
  const first = formatDate(days[0], { withWeekday: false }).replace(/^0/, '');
  const last = formatDate(days[days.length - 1], { withWeekday: false }).replace(/^0/, '');
  return days.length === 1 ? last : `${first.replace(/ \d{4}$/, '')} – ${last}`;
}

/**
 * The roster as a message for WhatsApp, SMS or email: a title, then each day
 * with its shifts. Plain text with no table, because a fixed-width table
 * breaks the moment a phone wraps it.
 */
export function formatMessage(roster, people, shifts) {
  const lines = [`${roster.name} (${span(roster)})`];
  for (const day of rosterLines(roster, people, shifts)) {
    lines.push('', shortDate(day.date));
    for (const { shift, names, short } of day.shifts) {
      if (names.length === 0 && shift.headcount === 0) continue;   // a shift nobody is needed on
      const times = shiftTimes(shift);
      const label = times ? `${shift.name} ${times}` : shift.name;
      const who = names.length ? names.join(', ') : 'nobody yet';
      lines.push(`• ${label}: ${who}${names.length && short ? ` (needs ${short} more)` : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * One line per person with the days they're on - for messaging people
 * individually. The shift name is added only when the roster has more than
 * one shift, since "Sun 11 Oct (Cafe)" is clutter if Cafe is all there is.
 */
export function formatPerPerson(roster, people, shifts) {
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const shiftOf = new Map(shifts.map((s) => [s.id, s]));
  const manyShifts = new Set(roster.assignments.map((a) => a.shiftId)).size > 1;

  const byPerson = new Map();
  for (const a of [...roster.assignments].sort((x, y) => x.date.localeCompare(y.date))) {
    const name = nameOf.get(a.personId) || '(removed)';
    const shift = shiftOf.get(a.shiftId);
    const when = shortDate(a.date) + (manyShifts ? ` (${shift ? shift.name : 'removed shift'})` : '');
    if (!byPerson.has(name)) byPerson.set(name, []);
    byPerson.get(name).push(when);
  }

  const lines = [`${roster.name}: who's on when`, ''];
  for (const name of [...byPerson.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push(`${name}: ${byPerson.get(name).join(', ')}`);
  }
  return lines.join('\n');
}

/** One CSV field, quoted when it holds a comma, quote or line break (RFC 4180). */
function csvField(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * A spreadsheet: one row per person per shift, plus a row for each place
 * still unfilled, so the sheet can be sorted or filtered by person or date.
 * Starts with a byte-order mark so Excel reads names with accents correctly.
 */
export function toCSV(roster, people, shifts) {
  const rows = [['Date', 'Day', 'Shift', 'Start', 'End', 'Person']];
  for (const day of rosterLines(roster, people, shifts)) {
    for (const { shift, names, short } of day.shifts) {
      const base = [day.date, weekdayName(day.date), shift.name, shift.start || '', shift.end || ''];
      for (const name of names) rows.push([...base, name]);
      for (let i = 0; i < short; i++) rows.push([...base, '(unfilled)']);
    }
  }
  return '\uFEFF' + rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** Text escaped for an iCalendar value (backslash, semicolon, comma, newline). */
function icsText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** "2026-10-11" + "08:00" -> "20261011T080000"; date only -> "20261011". */
function icsStamp(date, time) {
  const d = date.replace(/-/g, '');
  return time ? `${d}T${time.replace(':', '')}00` : d;
}

/** The ISO date the day after `iso`. */
function nextDay(iso) {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/**
 * A calendar file (.ics) with one event per shift per day, listing who is on.
 *
 * Times are "floating" (no time zone): 8am means 8am wherever the phone is,
 * which is what a local roster means. A shift without times becomes an
 * all-day event; one that ends before it starts runs past midnight.
 * `now` is only a parameter so tests get a fixed timestamp.
 */
export function toICS(roster, people, shifts, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const out = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sixth Day Studios//RosterWarden//EN',
    'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsText(roster.name)}`,
  ];
  for (const day of rosterLines(roster, people, shifts)) {
    for (const { shift, names } of day.shifts) {
      if (names.length === 0) continue;
      const timed = Boolean(shift.start && shift.end);
      const endDate = timed && shift.end <= shift.start ? nextDay(day.date) : day.date;
      out.push(
        'BEGIN:VEVENT',
        `UID:${roster.id || 'roster'}-${day.date}-${shift.id}@rosterwarden`,
        `DTSTAMP:${stamp}`,
        timed ? `DTSTART:${icsStamp(day.date, shift.start)}` : `DTSTART;VALUE=DATE:${icsStamp(day.date)}`,
        timed ? `DTEND:${icsStamp(endDate, shift.end)}` : `DTEND;VALUE=DATE:${icsStamp(nextDay(day.date))}`,
        `SUMMARY:${icsText(`${shift.name}: ${names.join(', ')}`)}`,
        `DESCRIPTION:${icsText(`${roster.name}\n${shift.name}: ${names.join(', ')}`)}`,
        'END:VEVENT',
      );
    }
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

/** A filename-safe version of the roster's name, e.g. "Roster-11-Oct-2026". */
export function fileBase(roster) {
  return (roster.name || 'roster').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'roster';
}
