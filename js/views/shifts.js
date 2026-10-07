/**
 * Shifts screen: define the blocks of work a rostered day is made of.
 *
 * Shifts are filled in the order shown here, so the list doubles as priority
 * order - the up/down controls on each card exist to let the manager put the
 * shift that matters most (e.g. the one hardest to cover) first.
 */
import { store } from '../store.js';
import { el, fill, confirmDialog, TIME_STEP_SECONDS } from '../ui.js';

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
      textContent: 'Shifts are filled in the order listed below. "Staff needed" is how many people that shift requires.',
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
          store.addShift({ name: 'Cafe', start: t.start || '08:00',
                           end: t.end || '12:00', headcount: 2 });
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
      store.addShift({ name: 'Shift', start: t.start, end: t.end, headcount: 1 });
      render(container);
    },
  }));

  fill(container, nodes);
}

/** Build one editable card for a shift. */
function renderShiftCard(shift, index, total, container) {
  const nameInput = el('input', {
    type: 'text', value: shift.name,
    onblur: () => {
      const value = nameInput.value.trim();
      if (value) store.updateShift(shift.id, { name: value });
      else nameInput.value = shift.name;
    },
  });

  // step in seconds: 300 = 5 minutes. Nobody rosters a cafe shift to the
  // minute, and a 5-minute picker is far quicker to thumb through on a phone.
  const startInput = el('input', {
    type: 'time', step: String(TIME_STEP_SECONDS), value: shift.start,
    onchange: () => store.updateShift(shift.id, { start: startInput.value }),
  });
  const endInput = el('input', {
    type: 'time', step: String(TIME_STEP_SECONDS), value: shift.end,
    onchange: () => store.updateShift(shift.id, { end: endInput.value }),
  });

  const headcountInput = el('input', {
    type: 'number', min: '0', step: '1', value: String(shift.headcount),
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
    store.updateShift(shift.id, { headcount: n });
  });

  const upBtn = el('button', {
    className: 'btn btn-sm', textContent: '↑', disabled: index === 0,
    onclick: () => { store.moveShift(shift.id, -1); render(container); },
  });
  const downBtn = el('button', {
    className: 'btn btn-sm', textContent: '↓', disabled: index === total - 1,
    onclick: () => { store.moveShift(shift.id, 1); render(container); },
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

  return el('div', { className: 'card' }, [
    el('div', {}, [el('label', { className: 'label', textContent: 'Name' }), nameInput]),
    el('div', { className: 'grid-2' }, [
      el('div', {}, [el('label', { className: 'label', textContent: 'Start' }), startInput]),
      el('div', {}, [el('label', { className: 'label', textContent: 'End' }), endInput]),
    ]),
    el('div', {}, [
      el('label', { className: 'label', textContent: 'Staff needed' }),
      headcountInput,
      headcountErr,
    ]),
    el('div', { className: 'row' }, [upBtn, downBtn, deleteBtn]),
  ]);
}
