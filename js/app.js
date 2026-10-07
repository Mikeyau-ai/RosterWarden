/**
 * RosterWarden bootstrap: loads saved data, wires the nav and organisation
 * switcher, and hands control to whichever view is showing.
 *
 * Views are plain modules exporting `render(container)`. Switching view simply
 * re-renders; there is no virtual DOM and no client-side router beyond the hash,
 * which is enough for three sections and keeps the back button working.
 */
import { store } from './store.js';
import { el, fill, promptText, toast } from './ui.js';

import * as builderView from './views/roster.js';
import * as savedView from './views/saved.js';
import * as settingsView from './views/settings.js';
// Imported for its side effect: it has to be listening for the browser's
// install event from the moment the app starts, not when Settings is opened.
import './install.js';
import * as sync from './sync.js';
import * as pco from './sources/planning-center.js';

// Three sections. "Roster" is the rosters you have saved - the thing you open
// the app to look at - and "New Roster" is the builder. People, shifts and
// opening hours are set-up, so they live inside Settings.
const VIEWS = {
  roster: savedView,
  new: builderView,
  settings: settingsView,
};

// Older hash links (and this app's own earlier tab names) still resolve, so a
// bookmark or a pinned home-screen link doesn't land on a blank screen.
const LEGACY_VIEWS = {
  saved: 'roster',
  build: 'new',
  people: 'settings',
  shifts: 'settings',
};

const NEW_ORG = '__new__';

let current = 'roster';

/** Render the active view into <main>, or prompt for an organisation first. */
export function render() {
  const container = document.getElementById('view');

  // Every screen except Settings needs an organisation to act on.
  if (!store.currentOrg() && current !== 'settings') {
    fill(container, welcome());
    return;
  }
  VIEWS[current].render(container);
  container.scrollTop = 0;
}

/** First-run screen: name the workplace right here, no pop-up. */
function welcome() {
  const nameInput = el('input', {
    type: 'text', placeholder: 'e.g. Church Cafe', 'aria-label': 'Workplace name',
  });
  const create = (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    createOrg(name);
  };

  return el('form', { className: 'card', onsubmit: create }, [
    el('h2', { textContent: 'Welcome to RosterWarden' }),
    el('p', { className: 'muted' }, [
      'Fair rosters in seconds: add your people, say which days each can work, '
      + 'and RosterWarden does the shuffling. Everything stays on your devices.',
    ]),
    el('label', { className: 'label', textContent: 'What do you roster for?' }),
    nameInput,
    el('button', {
      type: 'submit', className: 'btn btn-primary btn-lg btn-block', textContent: 'Get started',
    }),
  ]);
}

/**
 * Create an organisation with a starter shift and take the user to People,
 * the next thing a new roster needs (by hand, or from Planning Center).
 */
function createOrg(name) {
  store.addOrg(name);
  seedDefaults();
  refreshOrgs();
  show('settings', { section: 'people' });
  toast(`${name} created — now add your people`);
}

/**
 * Give a brand-new organisation one weekend shift to start from.
 * An empty Shifts screen is a dead end; a sensible default means the user can
 * go straight to adding people and press Build.
 */
function seedDefaults() {
  store.addShift({ name: 'Cafe', start: '08:00', end: '12:00', headcount: 2 });
}

/** Switch the visible view and update the tab bar. */
export function show(name, options = {}) {
  if (LEGACY_VIEWS[name]) {
    // A legacy name that now lives inside Settings opens straight at its
    // section, so "shifts" still takes you to the shifts editor.
    if (LEGACY_VIEWS[name] === 'settings') options = { section: name, ...options };
    name = LEGACY_VIEWS[name];
  }
  if (!VIEWS[name]) name = 'roster';
  if (name === 'settings') settingsView.openSection(options.section ?? null);
  current = name;
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.view === name;
    tab.setAttribute('aria-current', active ? 'page' : 'false');
  }
  if (location.hash !== `#${name}`) {
    history.replaceState(null, '', `#${name}`);
  }
  render();
}

/** Rebuild the organisation dropdown from the store. */
export function refreshOrgs() {
  const select = document.getElementById('org-select');
  const orgs = store.orgs();
  const currentId = store.data.currentOrgId;

  fill(select, [
    ...orgs.map((o) => el('option', {
      value: String(o.id), textContent: o.name, selected: o.id === currentId,
    })),
    el('option', { value: NEW_ORG, textContent: '+ New organisation…' }),
  ]);
  select.hidden = orgs.length === 0;
}

/** Handle a change in the organisation dropdown. */
async function onOrgChange(event) {
  const value = event.target.value;
  if (value === NEW_ORG) {
    const name = await promptText('New organisation', 'What do you call this workplace?');
    refreshOrgs();                       // revert the select if they cancelled
    if (name) createOrg(name);
    return;
  }
  store.setCurrentOrg(Number(value));
  render();
}

/** Register the service worker so the app opens with no connection. */
function registerWorker() {
  if (!('serviceWorker' in navigator)) return;

  // Not during local development: the worker serves the previous version from
  // its cache on first load, so an edit appears not to have taken effect. That
  // is the right behaviour for an installed app and the wrong one at a code
  // editor. Offline is verified against the deployed site instead.
  if (['localhost', '127.0.0.1', '::1'].includes(location.hostname)) return;

  // The worker refreshes its cache in the background (stale-while-revalidate),
  // but without this the new code only runs on the next cold start - so a phone
  // that is opened, glanced at and pocketed keeps showing the old version for
  // days. Reload once, the moment the worker says it has pulled a newer copy of
  // the app itself.
  let reloading = false;
  const reloadOnce = () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  };

  // Sent by sw.js when it replaces a precached shell file with a changed one.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data === 'shell-updated') reloadOnce();
  });

  // A brand-new worker took control. Ignored on a first-ever visit (there was
  // no controller to replace), where it just means the worker has claimed the
  // page rather than that anything changed.
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
  }

  // Registration failure is not fatal - the app still works online - so this
  // must never surface an error to the user. Ask for an update check on every
  // launch rather than waiting for the browser's own schedule.
  navigator.serviceWorker.register('sw.js')
    .then((reg) => reg.update())
    .catch(() => {});
}

/** Wire everything up and show the first screen. */
function init() {
  store.load();

  // Sync is on unless the user has turned it off. Enabling it uploads what is
  // already here rather than replacing it, so switching on never costs anyone
  // the rosters they already had.
  sync.autoEnable();

  // Every save marks the device as having moved on, and queues an upload.
  store.onSaved((data) => {
    sync.markChanged();
    sync.schedulePush(data);
  });
  refreshOrgs();

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => show(tab.dataset.view));
  }
  document.getElementById('org-select').addEventListener('change', onOrgChange);
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));

  show(location.hash.slice(1) || 'roster');
  registerWorker();
  startSync();
  finishPlanningCenterSignIn();
}

/**
 * Coming back from Planning Center's sign-in page: swap the code for a token
 * and open the Planning Center settings so the next step (pick a team) is
 * right there.
 */
async function finishPlanningCenterSignIn() {
  try {
    const outcome = await pco.finishSignIn();
    if (!outcome) return;
    show('settings', { section: 'planning-center' });
    toast(outcome === 'connected' ? 'Connected to Planning Center' : 'Planning Center sign-in cancelled');
  } catch (err) {
    show('settings', { section: 'planning-center' });
    toast(err instanceof pco.PCOError ? err.message : 'Planning Center sign-in failed');
  }
}

/**
 * Catch up with the server once the screen is already usable.
 *
 * Deliberately after the first render and never awaited: the device's own copy
 * is enough to work from, so nobody should be looking at a spinner while a
 * request completes - least of all on a bad connection.
 */
async function startSync() {
  const result = await sync.reconcile(store.data, (serverData) => {
    store.replaceAll(serverData);
    refreshOrgs();
    render();
  });

  if (result.action === 'downloaded') toast('Updated from your other device');
  if (result.action === 'conflict') {
    toast('This and another device both changed things — kept what is on this one');
  }
}

init();
