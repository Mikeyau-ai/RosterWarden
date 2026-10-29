/**
 * The staff member's page, reached from their private link.
 *
 * It stands apart from the rest of the app: no tabs, no workplace, no sync of
 * its own. It shows their name and upcoming shifts (as the owner last
 * published them) and a calendar to tap the dates they can't work, plus a
 * note. Saving sends their whole list, encrypted with the key in their link,
 * to their own mailbox; the owner's app picks it up next time it syncs.
 *
 * When the workplace has shift swaps on, they can also ask a colleague to take
 * a shift and answer colleagues' asks; those go in the same mailbox, sent
 * straight away (see "Shift swaps" in js/staff.js).
 */
import { el, fill, monthGrid, dialog, toast } from '../ui.js';
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

/** Statuses of a swap that is still going (as js/staff.js publishes them). */
const OPEN = ['asked', 'accepted'];

/** "Sun 1 Nov · Cafe 08:00–12:00 · Barista" for a shift on the page. */
function placeText(s) {
  return `${shortDate(s.date)} · ${[s.shift, s.times].filter(Boolean).join(' ')}${s.role ? ` · ${s.role}` : ''}`;
}

/** A fresh random id for a swap ask, so the owner's app can tell asks apart. */
function newSwapId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * The "Your upcoming shifts" card. With swaps on, each shift can be offered to
 * a colleague, and says how an ask for it is going; shifts handed over are
 * listed after, so they don't just vanish.
 */
function shiftList(info, swaps, sent, change) {
  const shifts = info.shifts || [];
  const out = swaps?.out || [];
  const handed = out.filter((o) => o.status === 'done');
  if (!shifts.length && !handed.length) return null;
  const org = info.org || 'whoever does the roster';

  const rows = shifts.map((s) => {
    const line = el('div', {}, [
      placeText(s),
      s.note ? el('span', { className: 'faint', textContent: ` · ${s.note}` }) : null,
    ]);
    if (!swaps || !s.ref) return line;

    // An ask still going: say where it is, and let them take it back.
    const ask = sent.swapAsks.find((a) => a.ref === s.ref);
    if (ask) {
      const known = out.find((o) => o.id === ask.id);
      const who = known?.toName || swaps.colleagues.find((c) => c.id === ask.toId)?.name || 'them';
      return el('div', { className: 'swap-row' }, [line, el('div', { className: 'spread' }, [
        el('span', {
          className: 'faint',
          textContent: known?.status === 'accepted'
            ? `${who} said yes · waiting for ${org} to approve`
            : `Asked ${who} to take it · waiting for their answer`,
        }),
        el('button', {
          className: 'btn btn-sm', textContent: 'Cancel ask',
          onclick: () => change(() => { sent.swapAsks = sent.swapAsks.filter((a) => a !== ask); }, 'Ask cancelled'),
        }),
      ])]);
    }

    // Otherwise offer it, saying how the last ask for it ended if it was turned down.
    const last = out.filter((o) => o.ref === s.ref && (o.status === 'declined' || o.status === 'rejected')).pop();
    return el('div', { className: 'swap-row' }, [line, el('div', { className: 'spread' }, [
      el('span', {
        className: 'faint',
        textContent: !last ? '' : last.status === 'declined' ? `${last.toName} said no` : `${org} didn't approve ${last.toName} taking it`,
      }),
      el('button', {
        className: 'btn btn-sm', textContent: 'Ask someone to take it',
        onclick: () => askSomeone(s, swaps, sent, change),
      }),
    ])]);
  });

  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Your upcoming shifts' }),
    ...rows,
    ...handed.map((h) => el('div', { className: 'faint', textContent: `${placeText(h)} · ${h.toName} took it` })),
  ]);
}

/** Pick a colleague to ask to take `shift`, and send the ask. Anyone can be asked. */
async function askSomeone(shift, swaps, sent, change) {
  const chosen = await dialog((close) => [
    el('h2', { textContent: 'Who could take it?' }),
    el('div', { className: 'faint', textContent: placeText(shift) }),
    swaps.colleagues.length
      ? el('div', { className: 'list' }, swaps.colleagues.map((c) => el('button', {
        type: 'button', className: 'item', onclick: () => close(c),
      }, [el('div', { className: 'item-main' }, [el('div', { className: 'item-title', textContent: c.name })])])))
      : el('div', { className: 'muted', textContent: 'Nobody else on the team has a link yet.' }),
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(null) }),
    ]),
  ]);
  if (!chosen) return;
  change(
    () => { sent.swapAsks = [...sent.swapAsks, { id: newSwapId(), ref: shift.ref, toId: chosen.id }]; },
    `Asked ${chosen.name.split(' ')[0]}`,
  );
}

/** Colleagues' asks waiting for their answer, each with Yes and No. Null when there are none. */
function askedOfMe(info, swaps, sent, change) {
  if (!swaps.in?.length) return null;
  const org = info.org || 'whoever does the roster';
  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Can you take these?' }),
    ...swaps.in.map((w) => {
      const answer = sent.swapAnswers.find((a) => a.id === w.id);
      /** Send their answer; it can't be changed once sent. */
      const reply = (accept) => change(
        () => { sent.swapAnswers = [...sent.swapAnswers.filter((a) => a.id !== w.id), { id: w.id, accept }]; },
        accept ? 'Sent: yes' : 'Sent: no',
      );
      return el('div', { className: 'swap-row' }, [
        el('div', { textContent: `${w.fromName} asks: ${placeText(w)}` }),
        answer
          ? el('div', {
            className: 'faint',
            textContent: !answer.accept ? 'You said no'
              : swaps.mode === 'approval' ? `You said yes · waiting for ${org} to approve` : 'You said yes · it\'s yours once the roster updates',
          })
          : el('div', { className: 'row-tight' }, [
            el('button', { className: 'btn btn-sm btn-primary', textContent: 'Yes, I\'ll take it', onclick: () => reply(true) }),
            el('button', { className: 'btn btn-sm', textContent: 'No', onclick: () => reply(false) }),
          ]),
      ]);
    }),
  ]);
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

  // What this page last sent. Every send carries all of it, so asking for a
  // swap never sends dates that haven't been saved, and saving dates never
  // drops a swap.
  const swaps = info.swaps && info.swaps.mode !== 'off' ? info.swaps : null;
  const settled = new Set((swaps?.out || []).filter((o) => !OPEN.includes(o.status)).map((o) => o.id));
  const waiting = new Set((swaps?.in || []).map((w) => w.id));
  const sent = {
    awayDates: [...away],
    note: mine?.value?.note || '',
    // Asks still going (the owner's app forgets finished ones) and answers not yet taken in.
    swapAsks: (mine?.value?.swapAsks || []).filter((a) => !settled.has(a.id)),
    swapAnswers: (mine?.value?.swapAnswers || []).filter((a) => waiting.has(a.id)),
  };

  /** Write everything in `sent` to their mailbox. Throws a readable error. */
  const send = async () => {
    try {
      await writeBox(inId, cryptoKey, sent);
    } catch (e) {
      throw new Error(e instanceof LinkReplaced ? 'This link has been replaced. Ask for the new one.' : e.message);
    }
  };

  const save = el('button', {
    className: 'btn btn-primary btn-lg btn-block', textContent: 'Save',
    onclick: async () => {
      save.disabled = true;
      try {
        sent.awayDates = [...away].filter((d) => d >= today).sort();
        sent.note = note.value.trim().slice(0, 500);
        await send();
        status.textContent = `Saved. ${info.org || 'They'} will see it next time they open RosterWarden.`;
      } catch (e) {
        status.textContent = e.message;
      } finally {
        save.disabled = false;
      }
    },
  });

  const shiftsCard = el('div');
  const askedCard = el('div');
  /** Redraw the parts that change with a swap: their shifts, and asks waiting for them. */
  const redraw = () => {
    fill(shiftsCard, shiftList(info, swaps, sent, change));
    fill(askedCard, swaps ? askedOfMe(info, swaps, sent, change) : null);
  };
  /** Apply a swap change to `sent`, send it, and redraw; undone if it couldn't be sent. */
  const change = async (update, done) => {
    const before = { swapAsks: sent.swapAsks, swapAnswers: sent.swapAnswers };
    update();
    try {
      await send();
      toast(done);
    } catch (e) {
      Object.assign(sent, before);
      toast(e.message);
    }
    redraw();
  };
  redraw();

  fill(container, [
    el('h2', { textContent: first ? `Hi ${first}` : 'Your availability' }),
    el('p', { className: 'muted', textContent: `Tap the dates you can't work${info.org ? ` for ${info.org}` : ''}, then Save. Tap again to undo.` }),
    swaps ? el('div', { className: 'notice' }, [
      el('strong', { textContent: 'Shift swaps are on' }),
      el('div', {
        textContent: `Can't make a shift? Ask anyone on the team to take it. They say yes or no on their own page, `
          + (swaps.mode === 'approval' ? `then ${info.org || 'whoever does the roster'} approves it.` : 'and a yes hands it over.')
          + ' The roster changes next time it is opened.',
      }),
    ]) : null,
    askedCard,
    shiftsCard,
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
