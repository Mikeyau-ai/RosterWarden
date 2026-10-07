/**
 * Planning Center screens: the Settings card (connect, pick a team, update
 * people and blockouts, map shifts to positions) and the "Send to Planning
 * Center" action on a saved roster.
 *
 * All the API work lives in js/sources/planning-center.js; this file only
 * decides what to ask for and writes the answers into the store.
 */
import { store } from '../store.js';
import { todayISO, formatDate } from '../scheduler.js';
import * as pco from '../sources/planning-center.js';
import { el, fill, toast, confirmDialog, dialog } from '../ui.js';

/** Tag on away dates imported from Planning Center, so a refresh can replace them. */
const SOURCE = 'pco';

/** Teams loaded this session, so reopening the card doesn't refetch them. */
let teamsCache = null;

/** Whether the current organisation is connected to a team and can send rosters. */
export function canSend() {
  return pco.isConfigured() && pco.isConnected() && Boolean(store.currentOrg()?.pco?.teamId);
}

/**
 * The Settings card. `redraw` re-renders the whole section, used after
 * connecting, disconnecting or choosing a team.
 */
export function renderCard(redraw) {
  const card = el('div', { className: 'card' }, [el('h3', { textContent: 'Planning Center' })]);

  if (!pco.isConfigured()) {
    card.append(el('div', {
      className: 'muted',
      textContent: 'Planning Center is not set up for this copy of RosterWarden yet.',
    }));
    return card;
  }

  if (!pco.isConnected()) {
    card.append(
      el('div', {
        className: 'muted',
        textContent: 'Bring in a Services team and everyone\'s blockout dates, then send '
          + 'finished rosters back into your plans. You can still add people by hand too.',
      }),
      el('button', {
        className: 'btn btn-primary btn-block', textContent: 'Connect Planning Center',
        onclick: () => pco.startSignIn(),
      }),
    );
    return card;
  }

  const org = store.currentOrg();
  const err = el('div', { className: 'err' });
  const body = el('div');
  card.append(body, err);

  /** Turn a failure into a message on the card (and a sign-out into a redraw). */
  const fail = (e) => {
    err.textContent = e instanceof pco.PCOError ? e.message : 'Something went wrong talking to Planning Center.';
    if (!pco.isConnected()) redraw();
  };

  if (!org) {
    fill(body, el('div', { className: 'muted', textContent: 'Create an organisation first.' }));
  } else {
    fill(body, el('div', { className: 'faint', textContent: 'Loading your teams…' }));
    loadTeams()
      .then((teams) => fill(body, connectedBody(org, teams, redraw, fail, err)))
      .catch(fail);
  }

  card.append(el('button', {
    className: 'btn btn-sm', textContent: 'Disconnect this device',
    onclick: async () => {
      const ok = await confirmDialog(
        'Disconnect Planning Center?',
        'This device signs out. Your people, away dates and rosters stay as they are.',
        'Disconnect'
      );
      if (!ok) return;
      await pco.disconnect();
      teamsCache = null;
      redraw();
    },
  }));
  return card;
}

/** Fetch the team list once per session. */
async function loadTeams() {
  if (!teamsCache) teamsCache = await pco.listTeams();
  return teamsCache;
}

/** Team picker, the Update button, and the shift-to-position mapping. */
function connectedBody(org, teams, redraw, fail, err) {
  const link = org.pco || {};
  const label = (t) => (t.serviceTypeName ? `${t.serviceTypeName} · ${t.name}` : t.name);

  const select = el('select', {}, [
    el('option', { value: '', textContent: 'Choose a team…', selected: !link.teamId }),
    ...teams.map((t) => el('option', { value: t.id, textContent: label(t), selected: t.id === link.teamId })),
  ]);
  select.addEventListener('change', () => {
    const team = teams.find((t) => t.id === select.value);
    // Positions belong to a team, so the old team's mapping means nothing now.
    for (const shift of store.shifts()) store.updateShift(shift.id, { pcoPosition: null });
    store.updateOrg(org.id, {
      pco: team
        ? { teamId: team.id, teamName: team.name, serviceTypeId: team.serviceTypeId,
            serviceTypeName: team.serviceTypeName }
        : null,
    });
    redraw();
  });

  const nodes = [
    el('div', {}, [el('label', { className: 'label', textContent: 'Team' }), select]),
  ];
  if (!link.teamId) {
    nodes.push(el('div', {
      className: 'faint',
      textContent: 'Pick the team you roster for this organisation, e.g. Cafe or Hospitality.',
    }));
    return nodes;
  }

  const status = el('div', {
    className: 'faint',
    textContent: link.updatedAt
      ? `Last updated ${formatDate(link.updatedAt.slice(0, 10))}.`
      : 'Not updated yet.',
  });
  const updateBtn = el('button', { className: 'btn btn-primary btn-block', textContent: 'Update from Planning Center' });
  updateBtn.addEventListener('click', async () => {
    err.textContent = '';
    updateBtn.disabled = true;
    try {
      const summary = await updateFromTeam(org, link, (text) => { updateBtn.textContent = text; });
      store.updateOrg(org.id, { pco: { ...link, updatedAt: new Date().toISOString() } });
      toast(summary);
      redraw();
    } catch (e) {
      fail(e);
    } finally {
      updateBtn.disabled = false;
      updateBtn.textContent = 'Update from Planning Center';
    }
  });

  nodes.push(
    updateBtn,
    el('div', {
      className: 'faint',
      textContent: 'Adds anyone new on the team and refreshes everyone\'s blockout dates. '
        + 'Days they can work are still set here.',
    }),
    status,
    positionsBlock(link, fail),
  );
  return nodes;
}

/**
 * Bring the team's people and blockouts into the current organisation.
 *
 * People are matched on their Planning Center id first, then on name (so a
 * list built by hand before connecting is linked, not duplicated). New people
 * arrive with no days ticked, same as adding them by hand. Returns a one-line
 * summary for the toast.
 */
async function updateFromTeam(org, link, progress) {
  progress('Reading the team…');
  const members = await pco.teamMembers(link.teamId);
  const people = store.people();
  const byPco = new Map(people.filter((p) => p.pcoId).map((p) => [p.pcoId, p]));
  const byName = new Map(people.map((p) => [p.name.trim().toLowerCase(), p]));

  let added = 0;
  let linked = 0;
  const linkedPeople = [];
  for (const m of members) {
    let person = byPco.get(m.id);
    if (!person) {
      // Someone of the same name not yet linked to anyone is taken to be them;
      // otherwise (no match, or the name already belongs to a different
      // Planning Center person) they are added fresh.
      const sameName = byName.get(m.name.toLowerCase());
      if (sameName && !sameName.pcoId) {
        person = sameName;
        linked += 1;
      } else {
        person = store.addPerson(m.name);
        added += 1;
      }
      store.updatePerson(person.id, { pcoId: m.id });
    }
    linkedPeople.push(person);
  }

  // One person at a time: repeating blockouts each need a request of their
  // own, and a burst for a large team would hit the API's rate limit.
  const from = todayISO();
  for (const [i, person] of linkedPeople.entries()) {
    progress(`Blockouts ${i + 1} of ${linkedPeople.length}…`);
    const ranges = await pco.blockoutsFor(person.pcoId, from);
    store.replaceSourcedBlackouts(person.id, SOURCE, ranges.map((r) => ({
      ...r, reason: r.reason ? `Planning Center: ${r.reason}` : 'Planning Center',
    })));
  }

  const parts = [`${members.length} on the team`];
  if (added) parts.push(`${added} added`);
  if (linked) parts.push(`${linked} matched`);
  return `${parts.join(', ')} · blockouts updated`;
}

/**
 * "Send each shift as": one position picker per shift, so a roster can be
 * placed into the right slot on the plan. A shift left on "Don't send" is
 * skipped when sending.
 */
function positionsBlock(link, fail) {
  const wrap = el('div', {}, [
    el('label', { className: 'label', textContent: 'Send each shift as', style: 'margin-top:.6rem' }),
  ]);
  const rows = el('div', { className: 'list' }, el('div', { className: 'faint', textContent: 'Loading positions…' }));
  wrap.append(rows);

  pco.teamPositions(link.teamId).then((positions) => {
    const shifts = store.shifts();
    if (shifts.length === 0) {
      fill(rows, el('div', { className: 'faint', textContent: 'Add shifts first.' }));
      return;
    }
    fill(rows, shifts.map((shift) => {
      const select = el('select', {}, [
        el('option', { value: '', textContent: 'Don\'t send' }),
        ...positions.map((name) => el('option', { value: name, textContent: name, selected: shift.pcoPosition === name })),
      ]);
      select.addEventListener('change', () => store.updateShift(shift.id, { pcoPosition: select.value || null }));
      return el('div', { className: 'spread' }, [el('div', { textContent: shift.name }), select]);
    }));
  }).catch(fail);

  return wrap;
}

/**
 * "Send to Planning Center" on a saved roster.
 *
 * Asks first (it writes into someone else's system), then reports exactly what
 * went in and what didn't, because a partial send is normal: a date with no
 * plan, a person not on the team, or a shift with no position.
 */
export function sendButton(roster) {
  const btn = el('button', { className: 'btn', textContent: 'Send to Planning Center' });
  btn.addEventListener('click', async () => {
    const link = store.currentOrg().pco;
    const ok = await confirmDialog(
      'Send to Planning Center?',
      `Adds everyone on this roster to the ${link.teamName} team in the matching ${link.serviceTypeName || ''} `
        + 'plans, as Unconfirmed. Notifications are prepared but not sent: nobody hears '
        + 'anything until you press Send in Planning Center.',
      'Send'
    );
    if (!ok) return;

    btn.disabled = true;
    const people = new Map(store.people().map((p) => [p.id, p]));
    const shifts = new Map(store.shifts().map((s) => [s.id, s]));
    try {
      const result = await pco.sendRoster(roster.assignments, {
        teamId: link.teamId,
        serviceTypeId: link.serviceTypeId,
        personPcoId: (id) => people.get(id)?.pcoId || null,
        positionFor: (id) => shifts.get(id)?.pcoPosition || null,
      }, (done, total) => { btn.textContent = `Sending ${done} of ${total}…`; });
      showSendResult(result, people, shifts);
    } catch (e) {
      toast(e instanceof pco.PCOError ? e.message : 'Sending to Planning Center failed.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send to Planning Center';
    }
  });
  return btn;
}

/** The after-send report: what went in, and each reason something didn't. */
function showSendResult(result, people, shifts) {
  const lines = [];
  lines.push(`${result.added} added to Planning Center.`);
  if (result.already) lines.push(`${result.already} were already there, left as they were.`);
  if (result.noPlan.size) {
    lines.push(`No plan on ${[...result.noPlan].map((d) => formatDate(d, { withWeekday: false })).join(', ')}. `
      + 'Create those plans in Planning Center, then send again.');
  }
  if (result.unlinked.size) {
    lines.push(`Not on the Planning Center team: ${[...result.unlinked].map((id) => people.get(id)?.name || '(removed)').join(', ')}.`);
  }
  if (result.unmapped.size) {
    lines.push(`No position picked for: ${[...result.unmapped].map((id) => shifts.get(id)?.name || '(removed)').join(', ')} `
      + '(Settings → Planning Center).');
  }
  return dialog((close) => [
    el('h2', { textContent: 'Sent to Planning Center' }),
    el('ul', { className: 'install-steps' }, lines.map((l) => el('li', { textContent: l }))),
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn btn-primary', textContent: 'OK', onclick: () => close() }),
    ]),
  ]);
}
