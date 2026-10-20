/**
 * The staff member's page, reached from their private link.
 *
 * It stands apart from the rest of the app: no tabs, no workplace, no sync of
 * its own. It shows their name and upcoming shifts (as the owner last
 * published them) and a calendar to tap the dates they can't work, plus a
 * note. Saving sends their whole list, encrypted with the key in their link,
 * to their own mailbox; the owner's app picks it up next time it syncs.
 */
import { el, fill, monthGrid } from '../ui.js';
import { todayISO } from '../scheduler.js';
import { boxesFor, readBox, writeBox, LinkReplaced } from '../staff-link.js';

/** Where this phone remembers its link, so reopening the app comes back here. */
export const STORED_KEY = 'rosterwarden.staff.key';

/** "Sun 1 Nov" for an ISO date. */
function shortDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

/** Render the staff page for link `key` into `container`. */
export async function render(container, key) {
  document.body.classList.add('staff-mode');
  try { localStorage.setItem(STORED_KEY, key); } catch { /* private mode: fine */ }
  fill(container, el('div', { className: 'card muted', textContent: 'Loading…' }));

  const { inId, outId, cryptoKey } = await boxesFor(key);
  let mine = null;
  let page = null;
  try {
    [mine, page] = await Promise.all([readBox(inId, cryptoKey), readBox(outId, cryptoKey)]);
  } catch (e) {
    if (e instanceof LinkReplaced) {
      try { localStorage.removeItem(STORED_KEY); } catch { /* fine */ }
      fill(container, el('div', { className: 'card' }, [
        el('h2', { textContent: 'This link has been replaced' }),
        el('p', { className: 'muted', textContent: 'Ask whoever does the roster to send you the new one.' }),
      ]));
      return;
    }
    fill(container, el('div', { className: 'card' }, [
      el('h2', { textContent: 'Can\'t load right now' }),
      el('p', { className: 'muted', textContent: e.message }),
      el('button', { className: 'btn btn-primary', textContent: 'Try again', onclick: () => render(container, key) }),
    ]));
    return;
  }

  const info = page?.value || {};
  const today = todayISO();
  // Their own last send wins; a brand-new link starts from what the owner has for them.
  const away = new Set(mine?.value?.awayDates ?? info.awayDates ?? []);
  const first = (info.name || '').split(' ')[0];

  const status = el('div', { className: 'faint' });
  const note = el('textarea', { rows: 2, placeholder: 'Anything to add? (optional)', value: mine?.value?.note || '' });
  const count = el('div', { className: 'muted' });
  /** Say how many upcoming dates are marked. */
  const recount = () => {
    const n = [...away].filter((d) => d >= today).length;
    count.textContent = n ? `${n} upcoming date${n === 1 ? '' : 's'} you can't work` : 'No dates marked yet.';
  };

  const cal = monthGrid({
    start: today,
    classOf: (iso) => (away.has(iso) ? 'is-away' : ''),
    onTap: (iso) => {
      if (iso < today) return;   // the past can't be changed
      if (away.has(iso)) away.delete(iso); else away.add(iso);
      cal.redraw();
      recount();
      status.textContent = 'Not saved yet.';
    },
  });
  recount();
  if (mine?.updatedAt) status.textContent = `Last saved ${new Date(mine.updatedAt).toLocaleString()}`;

  const save = el('button', {
    className: 'btn btn-primary btn-lg btn-block', textContent: 'Save',
    onclick: async () => {
      save.disabled = true;
      try {
        await writeBox(inId, cryptoKey, {
          awayDates: [...away].filter((d) => d >= today).sort(),
          note: note.value.trim().slice(0, 500),
        });
        status.textContent = `Saved. ${info.org || 'They'} will see it next time they open RosterWarden.`;
      } catch (e) {
        status.textContent = e instanceof LinkReplaced
          ? 'This link has been replaced. Ask for the new one.'
          : e.message;
      } finally {
        save.disabled = false;
      }
    },
  });

  const shifts = info.shifts || [];
  fill(container, [
    el('h2', { textContent: first ? `Hi ${first}` : 'Your availability' }),
    el('p', { className: 'muted', textContent: `Tap the dates you can't work${info.org ? ` for ${info.org}` : ''}, then Save. Tap again to undo.` }),
    shifts.length ? el('div', { className: 'card' }, [
      el('label', { className: 'label', textContent: 'Your upcoming shifts' }),
      ...shifts.map((s) => el('div', {
        textContent: `${shortDate(s.date)} · ${[s.shift, s.times].filter(Boolean).join(' ')}${s.role ? ` · ${s.role}` : ''}`,
      })),
    ]) : null,
    el('div', { className: 'card' }, [
      el('label', { className: 'label', textContent: 'Dates you can\'t work' }),
      cal.node,
      count,
    ]),
    el('div', { className: 'card' }, [el('label', { className: 'label', textContent: 'Note' }), note]),
    save,
    status,
    el('p', { className: 'faint', textContent: 'Only you and whoever does the roster can see this. Keep this link to yourself.' }),
  ]);
}
