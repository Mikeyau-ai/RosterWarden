/**
 * Setting up a workplace in one go: the starting templates, and turning the
 * setup wizard's draft into a real organisation with its shifts, roles and
 * people.
 *
 * Kept free of the DOM so it can be tested on its own, and so the wizard can
 * hold everything in memory until Finish: backing out half-way leaves nothing
 * behind, and the store sees one complete workplace rather than a trickle.
 */
import { store } from './store.js';
import * as staff from './staff.js';

/**
 * The starting points offered when a workplace is made. Each is a list of
 * shifts; a shift with roles needs one person per role place, a shift without
 * just needs `headcount` people.
 */
export const TEMPLATES = {
  cafe: {
    label: 'A cafe or similar',
    hint: 'One shift of 2 people',
    shifts: [{ name: 'Cafe', start: '08:00', end: '12:00', headcount: 2, roles: [] }],
  },
  band: {
    label: 'A worship team',
    hint: 'Lead singer, guitars, drums, keys…',
    shifts: [{
      name: 'Service', start: '09:00', end: '11:00', headcount: 1,
      roles: [
        ['Lead singer', 1], ['Backup singer', 2], ['Acoustic guitar', 1],
        ['Electric guitar', 1], ['Bass', 1], ['Drums', 1], ['Keys', 1],
      ].map(([name, count]) => ({ name, count, anyone: false })),
    }],
  },
  catering: {
    label: 'Catering or events',
    hint: 'No regular shifts; add each week’s events, with roles ready',
    shifts: [],
    roleNames: ['Chef', 'Waiter', 'Bar', 'Kitchen hand'],
  },
  blank: {
    label: 'A blank start',
    hint: 'One empty shift to fill in',
    shifts: [{ name: 'Shift', start: '', end: '', headcount: 1, roles: [] }],
  },
};

/** A fresh, editable copy of a template's shifts (never the template itself). */
export function templateShifts(kind) {
  const template = TEMPLATES[kind] || TEMPLATES.cafe;
  return template.shifts.map((s) => ({ ...s, roles: s.roles.map((r) => ({ ...r })) }));
}

/** The role names a template sets up even without shifts to hold them. */
export function templateRoles(kind) {
  return [...(TEMPLATES[kind] || TEMPLATES.cafe).roleNames || []];
}

/** The people a shift needs: its roles' total when it has roles, else its headcount. */
export function shiftSize(shift) {
  return shift.roles?.length
    ? shift.roles.reduce((sum, r) => sum + (Number(r.count) || 0), 0)
    : Number(shift.headcount) || 0;
}

/**
 * The roles across all draft shifts that need people ticking for them, by
 * name, once each (the same name on two shifts is one role, as in the store).
 * `extra` are role names to list first (those a template brings without shifts).
 */
export function skilledRoleNames(shifts, extra = []) {
  const seen = new Map();
  for (const name of extra) seen.set(name.toLowerCase(), name);
  for (const shift of shifts) {
    for (const role of shift.roles || []) {
      const name = role.name.trim();
      if (name && !role.anyone && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    }
  }
  return [...seen.values()];
}

/** Add the roles a template comes with (a no-op for one without) to the current organisation. */
export function addTemplateRoles(kind) {
  for (const name of templateRoles(kind)) store.addRole(name);
}

/**
 * Add draft shifts, and the roles inside them, to the current organisation.
 * Roles are shared by name, so "Guitar" on two shifts becomes one role.
 */
export function addShifts(shifts) {
  for (const s of shifts) {
    if (!s.name?.trim()) continue;
    const shift = store.addShift({
      name: s.name.trim(), start: s.start || '', end: s.end || '',
      headcount: Math.max(1, Number(s.headcount) || 1),
    });
    for (const r of s.roles || []) {
      const role = store.addRole(r.name);
      if (!role) continue;
      if (r.anyone) store.updateRole(role.id, { anyone: true });
      store.setShiftRole(shift.id, role.id, Math.max(1, Number(r.count) || 1));
    }
  }
}

/**
 * Create the workplace a wizard draft describes, select it, and return it.
 *
 * `draft` is { name, openDays, openTime, closeTime, shifts, people }, where a
 * shift is { name, start, end, headcount, roles: [{ name, count, anyone }] } and
 * a person is { name, weekdays (null for every day), roleNames: [] }. Blank
 * names are skipped, so a half-filled row in the wizard never becomes data.
 */
export function applySetup(draft) {
  const org = store.addOrg(draft.name);
  store.updateOrg(org.id, {
    openDays: Array.isArray(draft.openDays) ? [...draft.openDays] : [0, 1, 2, 3, 4, 5, 6],
    openTime: draft.openTime || '',
    closeTime: draft.closeTime || '',
  });

  // Shifts first, so their roles exist before people are ticked for them.
  addTemplateRoles(draft.kind);
  addShifts(draft.shifts || []);

  // People, with their role ticks matched to the roles just made, by name.
  const roleIdByName = new Map(store.roles().map((r) => [r.name.toLowerCase(), r.id]));
  for (const p of draft.people || []) {
    if (!p.name?.trim()) continue;
    const person = store.addPerson(p.name, p.weekdays ?? undefined);
    if (p.email || p.mobile) store.updatePerson(person.id, { email: p.email || '', phone: p.mobile || '' });
    staff.autoLink(person);
    const roleIds = (p.roleNames || [])
      .map((n) => roleIdByName.get(n.trim().toLowerCase()))
      .filter((id) => id != null);
    if (roleIds.length) store.updatePerson(person.id, { roleIds: [...new Set(roleIds)] });
  }
  return org;
}
