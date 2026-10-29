/**
 * Shifts screen: define the blocks of work a rostered day is made of.
 *
 * Shifts are filled in the order shown here, so the list doubles as priority
 * order - the up/down controls on each card exist to let the manager put the
 * shift that matters most (e.g. the one hardest to cover) first.
 */
import { store } from '../store.js';
import {
  el, fill, confirmDialog, promptText, toast, collapsible, weekdayPicker, DAY_LABELS, TIME_STEP_SECONDS,
} from '../ui.js';
import { shiftTimes } from '../export.js';
import * as pco from '../sources/planning-center.js';

// The shift just added, so its card opens ready to fill in while the rest stay folded.
let justAdded = null;

/** "Every day", "Mon–Fri", or "Sat, Sun" for a shift's days (none set = every day). */
function daysLabel(days) {
  if (!Array.isArray(days) || days.length === 7) return 'Every day';
  if (days.length === 0) return 'No days';
  // Split into runs of days in a row; three or more read better as a range.
  const runs = [];
  for (const d of [...days].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && d === last[last.length - 1] + 1) last.push(d);
    else runs.push([d]);
  }
  return runs.map((run) => (run.length >= 3
    ? `${DAY_LABELS[run[0]]}–${DAY_LABELS[run[run.length - 1]]}`
    : run.map((d) => DAY_LABELS[d]).join(', '))).join(', ');
}

/** The folded line for a shift: name · days · times · people. */
function shiftSummary(shift) {
  return [
    shift.name, daysLabel(shift.days), shiftTimes(shift),
    `${shift.headcount} ${shift.headcount === 1 ? 'person' : 'people'}`,
  ].filter(Boolean).join(' · ');
}

/** Times a new shift should start with: the organisation's opening hours if set. */
function defaultTimes() {
  const org = store.currentOrg();
  return { start: org?.openTime || '', end: org?.closeTime || '' };
}

/** Entry point: render the shift list into `container`. */
export function render(container) {
  const header = el('div', {}, [
    el('h2', { textContent: 'Shifts' }),
    el('div', {
      className: 'faint',
      textContent: 'Shifts are filled in the order listed below. Tap one to change it. "Staff needed" is how many people that shift requires.',
    }),
  ]);

  const shifts = store.shifts();
  const nodes = [header];

  if (shifts.length === 0) {
    nodes.push(el('div', { className: 'card' }, [
      el('div', { textContent: 'No shifts yet' }),
      el('button', {
        className: 'btn btn-primary btn-block', textContent: '+ Add shift',
        onclick: () => {
          const t = defaultTimes();
          justAdded = store.addShift({ name: 'Cafe', start: t.start || '08:00',
                                       end: t.end || '12:00', headcount: 2 }).id;
          render(container);
        },
      }),
    ]));
    fill(container, nodes);
    return;
  }

  shifts.forEach((shift, index) => {
    nodes.push(renderShiftCard(shift, index, shifts.length, container));
  });

  nodes.push(el('button', {
    className: 'btn btn-primary btn-block', textContent: '+ Add shift',
    onclick: () => {
      const t = defaultTimes();
      justAdded = store.addShift({ name: 'Shift', start: t.start, end: t.end, headcount: 1 }).id;
      render(container);
    },
  }));
  if (store.roles().length) nodes.push(renderRolesList(container));

  fill(container, nodes);
}

/** Card listing every role, to say who can do it and to delete it. */
function renderRolesList(container) {
  const rows = store.roles().map((role) => el('div', { className: 'spread' }, [
    el('div', { textContent: role.name }),
    el('label', { className: 'row-tight' }, [
      el('input', {
        type: 'checkbox', checked: role.anyone,
        onchange: (e) => store.updateRole(role.id, { anyone: e.target.checked }),
      }),
      el('span', { className: 'faint', textContent: 'anyone can do it' }),
    ]),
    el('button', {
      className: 'btn btn-danger btn-sm', textContent: 'Delete',
      onclick: async () => {
        const ok = await confirmDialog('Delete role', `Remove "${role.name}" from every shift and person?`);
        if (!ok) return;
        store.deleteRole(role.id);
        render(container);
      },
    }),
  ]));
  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Roles' }),
    ...rows,
    el('div', { className: 'faint', textContent: 'Tick "anyone can do it" for jobs that need no skill, so people need not be ticked one by one.' }),
  ]);
}

/**
 * The roles part of a shift card: each role with how many are needed, and a
 * picker to add another (or make a new one). While a shift has roles its
 * "Staff needed" is their total, so that field is shown but not editable.
 */
function renderShiftRoles(shift, container) {
  const roleName = new Map(store.roles().map((r) => [r.id, r.name]));
  const rows = (shift.roles || []).map((r) => {
    const count = el('input', {
      type: 'number', min: '0', step: '1', value: String(r.count), style: 'width:4.5rem',
      onchange: () => { store.setShiftRole(shift.id, r.roleId, count.value); render(container); },
    });
    return el('div', { className: 'spread' }, [
      el('div', { textContent: roleName.get(r.roleId) || '(removed role)' }),
      count,
    ]);
  });

  const onShift = new Set((shift.roles || []).map((r) => r.roleId));
  const add = el('select', {}, [
    el('option', { value: '', textContent: '+ Add a role' }),
    ...store.roles().filter((r) => !onShift.has(r.id))
      .map((r) => el('option', { value: String(r.id), textContent: r.name })),
    el('option', { value: 'new', textContent: 'New role…' }),
  ]);
  add.addEventListener('change', async () => {
    let roleId = Number(add.value);
    if (add.value === 'new') {
      const name = await promptText('New role', 'Name, e.g. Drums or Making coffee');
      roleId = store.addRole(name)?.id;
    }
    if (roleId) store.setShiftRole(shift.id, roleId, 1);
    render(container);
  });

  // With a Planning Center team linked, its positions can become this shift's roles.
  const teamId = store.currentOrg()?.pco?.teamId;
  const fromPco = teamId ? el('button', {
    className: 'btn btn-sm', textContent: 'Add positions from Planning Center',
    onclick: async (e) => {
      e.target.disabled = true;
      try {
        const [names, assignments] = await Promise.all([pco.teamPositions(teamId), pco.teamAssignments(teamId)]);
        let added = 0;
        const roleOf = new Map();
        for (const name of names) {
          const role = store.addRole(name);
          roleOf.set(name, role);
          if (!role.pcoPosition) store.updateRole(role.id, { pcoPosition: name });   // sent back as the same position
          if (!(shift.roles || []).some((r) => r.roleId === role.id) && !onShift.has(role.id)) {
            store.setShiftRole(shift.id, role.id, 1);
            onShift.add(role.id);
            added++;
          }
        }
        // Tick people for the positions Planning Center has them down for.
        const byPco = new Map(store.people().map((p) => [p.pcoId, p]));
        const tickedIds = new Set();
        for (const { personId, position } of assignments) {
          const person = byPco.get(personId);
          const role = roleOf.get(position);
          if (!person || !role || (person.roleIds || []).includes(role.id)) continue;
          store.updatePerson(person.id, { roleIds: [...(person.roleIds || []), role.id] });
          person.roleIds = [...(person.roleIds || []), role.id];
          tickedIds.add(person.id);
        }
        const ticked = tickedIds.size;
        const parts = [added && `added ${added} role${added === 1 ? '' : 's'}`, ticked && `ticked ${ticked} ${ticked === 1 ? 'person' : 'people'}`].filter(Boolean);
        toast(parts.length ? parts.join(', ').replace(/^./, (ch) => ch.toUpperCase()) : 'Nothing new to add');
      } catch (err) {
        toast(err instanceof pco.PCOError ? err.message : 'Could not reach Planning Center.');
      }
      render(container);
    },
  }) : null;
  return el('div', {}, [el('label', { className: 'label', textContent: 'Roles' }), ...rows, add, fromPco]);
}

/**
 * Build one shift card: folded to a one-line summary (name · days · times ·
 * people), and opening to edit it. The summary follows every change.
 */
function renderShiftCard(shift, index, total, container) {
  /** Save a change to this shift and bring the folded line up to date. */
  const update = (patch) => {
    store.updateShift(shift.id, patch);
    card.querySelector('.fold-head strong').textContent = shiftSummary(shift);
  };

  const nameInput = el('input', {
    type: 'text', value: shift.name,
    onblur: () => {
      const value = nameInput.value.trim();
      if (value) update({ name: value });
      else nameInput.value = shift.name;
    },
  });

  // step in seconds: 300 = 5 minutes. Nobody rosters a cafe shift to the
  // minute, and a 5-minute picker is far quicker to thumb through on a phone.
  const startInput = el('input', {
    type: 'time', step: String(TIME_STEP_SECONDS), value: shift.start,
    onchange: () => update({ start: startInput.value }),
  });
  const endInput = el('input', {
    type: 'time', step: String(TIME_STEP_SECONDS), value: shift.end,
    onchange: () => update({ end: endInput.value }),
  });

  // The weekdays it runs on. No days set means every day, which is how every
  // shift made before this existed behaves.
  const daysPicker = weekdayPicker(
    Array.isArray(shift.days) ? shift.days : [0, 1, 2, 3, 4, 5, 6],
    (days) => update({ days: days.length === 7 ? undefined : days }),
  );

  const headcountInput = el('input', {
    type: 'number', min: '0', step: '1', value: String(shift.headcount),
    disabled: Boolean(shift.roles?.length),   // the total of its roles
  });
  const headcountErr = el('div', { className: 'err' });
  headcountInput.addEventListener('blur', () => {
    const raw = headcountInput.value.trim();
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < 0) {
      headcountErr.textContent = 'Enter a whole number of 0 or more.';
      return;
    }
    headcountErr.textContent = '';
    update({ headcount: n });
  });

  const upBtn = el('button', {
    className: 'btn btn-sm', textContent: '↑', disabled: index === 0,
    onclick: () => { store.moveShift(shift.id, -1); render(container); },
  });
  const downBtn = el('button', {
    className: 'btn btn-sm', textContent: '↓', disabled: index === total - 1,
    onclick: () => { store.moveShift(shift.id, 1); render(container); },
  });
  const copyBtn = el('button', {
    className: 'btn btn-sm', textContent: 'Copy',
    onclick: () => { store.duplicateShift(shift.id); render(container); },
  });
  const deleteBtn = el('button', {
    className: 'btn btn-danger btn-sm', textContent: 'Delete',
    onclick: async () => {
      const ok = await confirmDialog('Delete shift', `Remove the "${shift.name}" shift?`);
      if (!ok) return;
      store.deleteShift(shift.id);
      render(container);
    },
  });

  const card = collapsible(`shift-${shift.id}`, shiftSummary(shift), [
    el('div', {}, [el('label', { className: 'label', textContent: 'Name' }), nameInput]),
    el('div', {}, [el('label', { className: 'label', textContent: 'Runs on' }), daysPicker]),
    el('div', { className: 'grid-2' }, [
      el('div', {}, [el('label', { className: 'label', textContent: 'Start' }), startInput]),
      el('div', {}, [el('label', { className: 'label', textContent: 'End' }), endInput]),
    ]),
    el('div', {}, [
      el('label', { className: 'label', textContent: 'Staff needed' }),
      headcountInput,
      headcountErr,
    ]),
    renderShiftRoles(shift, container),
    el('div', { className: 'row' }, [upBtn, downBtn, copyBtn, deleteBtn]),
  ], { open: shift.id === justAdded });
  return card;
}
