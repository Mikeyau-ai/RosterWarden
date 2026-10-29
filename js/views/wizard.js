/**
 * The setup wizard: an optional, step-by-step way to set up a workplace -
 * its name, when it's open, its shifts and roles, the team, and who can do
 * what - for anyone who'd rather be walked through it than find each screen.
 *
 * Everything is held in a draft until the last step, so backing out part-way
 * leaves nothing behind; Finish hands the draft to `applySetup` in one go.
 * Everything it sets can be changed later on Team and Settings as usual.
 */
import { el, fill, openSheet, closeSheet, confirmDialog, weekdayPicker, toast, DAY_LABELS, TIME_STEP_SECONDS } from '../ui.js';
import { parsePeopleList } from '../people-import.js';
import { TEMPLATES, templateShifts, templateRoles, skilledRoleNames, shiftSize, applySetup } from '../setup.js';
import { refreshOrgs, show } from '../app.js';

/** The steps in order. `optional` ones get a Skip button; `when` hides a step that has nothing to ask. */
const STEPS = [
  { id: 'workplace', title: 'Your workplace' },
  { id: 'hours', title: 'When you’re open', optional: true },
  { id: 'shifts', title: 'Shifts' },
  { id: 'team', title: 'Your team', optional: true },
  { id: 'skills', title: 'Who can do what', optional: true,
    when: (d) => d.people.length > 0 && skilledRoleNames(d.shifts, templateRoles(d.kind)).length > 0 },
  { id: 'done', title: 'All set' },
];

/** "Sat, Sun", "Every day" or "No days" for a list of weekday indices (null: every day). */
function daysText(days) {
  if (days == null || days.length === 7) return 'Every day';
  if (days.length === 0) return 'No days';
  return days.map((d) => DAY_LABELS[d]).join(', ');
}

/**
 * Open the wizard over whatever is on screen. `name` and `kind` pre-fill the
 * first step (the welcome screen passes what was already typed there).
 */
export function openWizard({ name = '', kind = 'cafe' } = {}) {
  const draft = {
    name, kind,
    openDays: [0, 1, 2, 3, 4, 5, 6], openTime: '', closeTime: '',
    shifts: templateShifts(kind),
    people: [],
  };
  // Once the shifts are edited by hand, changing the starting point must not wipe them.
  let shiftsEdited = false;
  // Anything entered at all makes cancelling worth a second thought.
  let dirty = Boolean(name);
  let at = 0;

  openSheet('Set up a workplace', (body) => {
    // The sheet's own back button would silently throw the draft away; make it
    // an honest Cancel that asks first once something has been entered.
    const cancel = body.parentElement.querySelector('.sheet-bar .btn');
    cancel.textContent = 'Cancel';
    cancel.onclick = async () => {
      if (dirty && !(await confirmDialog('Stop setting up?', 'Nothing you entered here will be kept.', 'Stop'))) return;
      closeSheet();
    };
    body.addEventListener('input', () => { dirty = true; });

    /** The steps that apply to this draft right now. */
    const steps = () => STEPS.filter((s) => !s.when || s.when(draft));

    const err = el('div', { className: 'err' });

    /** Move to the step `delta` away, if the current one is complete. */
    const go = (delta) => {
      err.textContent = '';
      const step = steps()[at];
      if (delta > 0) {
        const problem = check(step.id);
        if (problem) { err.textContent = problem; return; }
      }
      at = Math.max(0, Math.min(steps().length - 1, at + delta));
      draw();
      body.parentElement.scrollTop = 0;
    };

    /** Why the step can't be left yet, or '' when it can. */
    const check = (id) => {
      if (id === 'workplace' && !draft.name.trim()) return 'Give your workplace a name first.';
      if (id === 'shifts') {
        const named = draft.shifts.filter((s) => s.name.trim());
        // Catering plans its shifts on each week's roster, so it may have none.
        if (named.length === 0 && draft.kind !== 'catering') return 'Add at least one shift with a name.';
        if (named.some((s) => s.roles.length && s.roles.every((r) => !r.name.trim()))) {
          return 'Name each role, or remove the empty ones.';
        }
      }
      return '';
    };

    /** Create the workplace and land on New Roster, ready to pick dates. */
    const finish = () => {
      const org = applySetup(draft);
      closeSheet();
      refreshOrgs();
      show('new');
      toast(`${org.name} is set up — pick your dates and build`);
    };

    /** Redraw the current step. */
    const draw = () => {
      const list = steps();
      if (at >= list.length) at = list.length - 1;
      const step = list[at];
      const last = step.id === 'done';

      const progress = el('div', { className: 'wiz-progress', 'aria-hidden': 'true' },
        list.map((s, i) => el('span', { className: i < at ? 'is-done' : i === at ? 'is-now' : '' })));

      const nav = el('div', { className: 'wiz-nav' }, [
        at > 0 ? el('button', { type: 'button', className: 'btn', textContent: 'Back', onclick: () => go(-1) }) : el('span'),
        el('div', { className: 'row-tight' }, [
          step.optional ? el('button', { type: 'button', className: 'btn btn-ghost', textContent: 'Skip', onclick: () => go(1) }) : null,
          last
            ? el('button', { type: 'button', className: 'btn btn-primary', textContent: `Create ${draft.name.trim()}`, onclick: finish })
            : el('button', { type: 'button', className: 'btn btn-primary', textContent: 'Next', onclick: () => go(1) }),
        ]),
      ]);

      fill(body, [
        progress,
        el('div', { className: 'faint', textContent: `Step ${at + 1} of ${list.length}` }),
        el('div', { className: 'card' }, [el('h2', { textContent: step.title }), ...stepBody(step.id, draw)]),
        err,
        nav,
      ]);
    };

    /** The fields for one step. `redraw` is for changes that add or remove rows. */
    const stepBody = (id, redraw) => {
      switch (id) {
        case 'workplace': return workplaceStep(draft, () => {
          if (!shiftsEdited) draft.shifts = templateShifts(draft.kind);
        });
        case 'hours': return hoursStep(draft);
        case 'shifts': return shiftsStep(draft, () => { shiftsEdited = true; }, redraw);
        case 'team': return teamStep(draft, redraw);
        case 'skills': return skillsStep(draft);
        default: return doneStep(draft);
      }
    };

    draw();
  });
}

/** Step 1: the name, and which template to start the shifts from. */
function workplaceStep(draft, onKind) {
  const nameInput = el('input', { type: 'text', value: draft.name, placeholder: 'e.g. Church Cafe', 'aria-label': 'Workplace name' });
  nameInput.addEventListener('input', () => { draft.name = nameInput.value; });

  const choices = el('div', { className: 'list' });
  /** One row per template, the chosen one pressed. */
  const drawChoices = () => fill(choices, Object.entries(TEMPLATES).map(([kind, t]) => el('button', {
    type: 'button', className: 'item', 'aria-pressed': String(draft.kind === kind),
    onclick: () => { draft.kind = kind; onKind(); drawChoices(); },
  }, [el('div', { className: 'item-main' }, [
    el('div', { className: 'item-title', textContent: t.label }),
    el('div', { className: 'item-sub', textContent: t.hint }),
  ]), el('span', { className: 'item-chevron', textContent: draft.kind === kind ? '✓' : '' })])));
  drawChoices();

  return [
    el('p', { className: 'muted', textContent: 'A few quick questions and you’ll be ready to build your first roster. You can change any of it later.' }),
    el('label', { className: 'label', textContent: 'What do you roster for?' }),
    nameInput,
    el('label', { className: 'label', textContent: 'Start from' }),
    choices,
  ];
}

/** Step 2: open days and hours, as on Settings → Name and opening hours. */
function hoursStep(draft) {
  const step = String(TIME_STEP_SECONDS);
  const openTime = el('input', { type: 'time', step, value: draft.openTime });
  const closeTime = el('input', { type: 'time', step, value: draft.closeTime });
  openTime.addEventListener('change', () => { draft.openTime = openTime.value; });
  closeTime.addEventListener('change', () => { draft.closeTime = closeTime.value; });

  return [
    el('p', { className: 'muted', textContent: 'The days you trade are what the roster calendar offers first; other days are dimmed, not blocked.' }),
    el('label', { className: 'label', textContent: 'Open on' }),
    weekdayPicker(draft.openDays, (days) => { draft.openDays = days; }),
    el('label', { className: 'label', textContent: 'Opening hours (optional)' }),
    el('div', { className: 'grid-2' }, [
      el('div', {}, [el('label', { className: 'faint', textContent: 'Opens' }), openTime]),
      el('div', {}, [el('label', { className: 'faint', textContent: 'Closes' }), closeTime]),
    ]),
  ];
}

/**
 * Step 3: the shifts a day is made of, each either "this many people" or a
 * set of roles. `edited` marks the shifts as hand-made; `redraw` redraws the
 * step after a row is added or removed.
 */
function shiftsStep(draft, edited, redraw) {
  const step = String(TIME_STEP_SECONDS);
  /** Apply a structural change, then redraw. */
  const change = (fn) => { fn(); edited(); redraw(); };

  const cards = draft.shifts.map((shift, i) => {
    const name = el('input', { type: 'text', value: shift.name, placeholder: 'e.g. Morning', 'aria-label': 'Shift name' });
    const start = el('input', { type: 'time', step, value: shift.start, 'aria-label': 'Starts' });
    const end = el('input', { type: 'time', step, value: shift.end, 'aria-label': 'Ends' });
    name.addEventListener('input', () => { shift.name = name.value; edited(); });
    start.addEventListener('change', () => { shift.start = start.value; edited(); });
    end.addEventListener('change', () => { shift.end = end.value; edited(); });

    const size = el('div', { className: 'faint' });
    const showSize = () => { size.textContent = `Needs ${shiftSize(shift)} ${shiftSize(shift) === 1 ? 'person' : 'people'}`; };
    showSize();

    // Without roles: just a number. With roles: one row per role, and the number is their total.
    let needs;
    if (shift.roles.length === 0) {
      const count = el('input', { type: 'number', min: '1', max: '50', value: String(shift.headcount), 'aria-label': 'People needed' });
      count.addEventListener('input', () => { shift.headcount = Math.max(1, Number(count.value) || 1); edited(); });
      needs = el('div', {}, [
        el('label', { className: 'label', textContent: 'People needed' }),
        count,
        el('button', {
          type: 'button', className: 'btn btn-sm', textContent: '+ Split into roles', style: 'margin-top:.5rem',
          onclick: () => change(() => shift.roles.push({ name: '', count: 1, anyone: false })),
        }),
      ]);
    } else {
      needs = el('div', {}, [
        // Column headings once, so each row has room for the role's name.
        el('div', { className: 'wiz-role wiz-role-head' }, [
          el('span', { className: 'label', textContent: 'Roles' }),
          el('span', { className: 'faint', textContent: 'Need' }),
          el('span', { className: 'faint', textContent: 'Anyone' }),
          el('span'),
        ]),
        ...shift.roles.map((role, r) => {
          const roleName = el('input', { type: 'text', value: role.name, placeholder: 'e.g. Barista', 'aria-label': 'Role name' });
          const roleCount = el('input', { type: 'number', min: '1', max: '20', value: String(role.count), 'aria-label': `How many ${role.name || 'of this role'}` });
          const anyone = el('input', { type: 'checkbox', checked: role.anyone, 'aria-label': 'Anyone can do it' });
          roleName.addEventListener('input', () => { role.name = roleName.value; edited(); });
          roleCount.addEventListener('input', () => { role.count = Math.max(1, Number(roleCount.value) || 1); showSize(); edited(); });
          anyone.addEventListener('change', () => { role.anyone = anyone.checked; edited(); });
          return el('div', { className: 'wiz-role' }, [
            roleName, roleCount,
            el('label', { className: 'wiz-anyone' }, [anyone]),
            el('button', {
              type: 'button', className: 'btn btn-sm btn-ghost', textContent: '×', 'aria-label': `Remove role ${role.name}`,
              onclick: () => change(() => shift.roles.splice(r, 1)),
            }),
          ]);
        }),
        el('button', {
          type: 'button', className: 'btn btn-sm', textContent: '+ Add role',
          onclick: () => change(() => shift.roles.push({ name: '', count: 1, anyone: false })),
        }),
        el('div', { className: 'faint', textContent: 'Tick “Anyone” for jobs that need no particular skill, so nobody has to be ticked for them.', style: 'margin-top:.35rem' }),
      ]);
    }

    return el('div', { className: 'wiz-shift' }, [
      el('div', { className: 'spread' }, [
        el('strong', { textContent: `Shift ${i + 1}` }),
        draft.shifts.length > 1 || draft.kind === 'catering' ? el('button', {
          type: 'button', className: 'btn btn-sm btn-ghost', textContent: 'Remove',
          onclick: () => change(() => draft.shifts.splice(i, 1)),
        }) : null,
      ]),
      el('label', { className: 'label', textContent: 'Name' }), name,
      el('div', { className: 'grid-2' }, [
        el('div', {}, [el('label', { className: 'faint', textContent: 'Starts' }), start]),
        el('div', {}, [el('label', { className: 'faint', textContent: 'Ends' }), end]),
      ]),
      needs,
      size,
    ]);
  });

  return [
    el('p', { className: 'muted', textContent: 'The blocks of work a day is made of, filled in this order. Most places need just one.' }),
    ...cards,
    el('button', {
      type: 'button', className: 'btn btn-block', textContent: '+ Add another shift',
      // A new shift starts at the opening hours, as on the Shifts screen.
      onclick: () => change(() => draft.shifts.push({ name: '', start: draft.openTime, end: draft.closeTime, headcount: 1, roles: [] })),
    }),
  ];
}

/** Step 4: the people, from a pasted list or one name at a time. */
function teamStep(draft, redraw) {
  const paste = el('textarea', {
    rows: 4, placeholder: 'Sarah - Sat, Sun\nTom - weekdays\nRachel', 'aria-label': 'Names, one per line',
  });
  const note = el('div', { className: 'faint' });

  /** Add every new name from the box; names already on the list are left as they are. */
  const add = () => {
    const have = new Set(draft.people.map((p) => p.name.toLowerCase()));
    const found = parsePeopleList(paste.value).filter((p) => !have.has(p.name.toLowerCase()) && have.add(p.name.toLowerCase()));
    if (found.length === 0) { note.textContent = paste.value.trim() ? 'Those are all on the list already.' : 'Type or paste some names first.'; return; }
    draft.people.push(...found.map((p) => ({ name: p.name, weekdays: p.weekdays, roleNames: [] })));
    redraw();
  };

  const rows = draft.people.map((person, i) => el('div', { className: 'spread wiz-person' }, [
    el('div', {}, [
      el('div', { textContent: person.name }),
      el('div', { className: 'faint', textContent: daysText(person.weekdays) }),
    ]),
    el('button', {
      type: 'button', className: 'btn btn-sm btn-ghost', textContent: '×', 'aria-label': `Remove ${person.name}`,
      onclick: () => { draft.people.splice(i, 1); redraw(); },
    }),
  ]));

  return [
    el('p', { className: 'muted', textContent: 'Type or paste names, one per line. Add the days someone can work after a dash if they can’t do every day.' }),
    paste,
    el('button', { type: 'button', className: 'btn btn-block', textContent: 'Add to the team', onclick: add }),
    note,
    draft.people.length
      ? el('div', {}, [el('label', { className: 'label', textContent: `On the team (${draft.people.length})` }), ...rows])
      : el('div', { className: 'faint', textContent: 'You can skip this and add people later on the Team tab, or bring them in from Planning Center.' }),
  ];
}

/** Step 5 (only with roles and people): tick who can do each role. */
function skillsStep(draft) {
  const roles = skilledRoleNames(draft.shifts, templateRoles(draft.kind));
  const has = (person, role) => person.roleNames.some((n) => n.toLowerCase() === role.toLowerCase());

  const head = el('tr', {}, [el('th'), ...roles.map((r) => el('th', { className: 'skill-head', textContent: r }))]);
  const rows = draft.people.map((person) => el('tr', {}, [
    el('th', { className: 'skill-person', scope: 'row', textContent: person.name }),
    ...roles.map((role) => {
      const box = el('input', {
        type: 'checkbox', checked: has(person, role), 'aria-label': `${person.name} can do ${role}`,
        onchange: () => {
          person.roleNames = person.roleNames.filter((n) => n.toLowerCase() !== role.toLowerCase());
          if (box.checked) person.roleNames.push(role);
        },
      });
      return el('td', {}, [box]);
    }),
  ]));

  return [
    el('p', { className: 'muted', textContent: 'People are only put on roles they’re ticked for, so the only drummer isn’t used up elsewhere.' }),
    el('div', { className: 'skill-wrap' }, [el('table', { className: 'skill-grid' }, [el('thead', {}, [head]), el('tbody', {}, rows)])]),
  ];
}

/** Last step: what is about to be created. */
function doneStep(draft) {
  const shifts = draft.shifts.filter((s) => s.name.trim());
  const people = draft.people.length;
  const hours = draft.openTime && draft.closeTime ? `, ${draft.openTime}–${draft.closeTime}` : '';
  return [
    el('p', { className: 'muted', textContent: 'Here’s what will be set up. Next you’ll pick the dates to roster, then build it automatically or fill it in by hand.' }),
    el('ul', { className: 'wiz-summary' }, [
      el('li', {}, [el('strong', { textContent: draft.name.trim() })]),
      el('li', { textContent: `Open: ${daysText(draft.openDays)}${hours}` }),
      el('li', { textContent: shifts.length
        ? `${shifts.length} ${shifts.length === 1 ? 'shift' : 'shifts'}: ${shifts.map((s) => `${s.name.trim()} (${shiftSize(s)})`).join(', ')}`
        : 'No usual shifts — plan each week’s shifts when you build' }),
      el('li', { textContent: people ? `${people} ${people === 1 ? 'person' : 'people'} on the team` : 'No people yet — add them on the Team tab' }),
    ]),
  ];
}
