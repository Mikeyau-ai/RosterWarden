/**
 * Signing in to a RosterWarden account, as the screens show it: the Sign in
 * and Sign up buttons (welcome screen and Settings), the code the person
 * approves on sixthdaystudios.com, and what happens to the rosters afterwards.
 * The account itself is js/account.js.
 */
import { store } from '../store.js';
import { el, toast, dialog, confirmDialog } from '../ui.js';
import { ACCOUNT_URL } from '../config.js';
import { refreshOrgs, show } from '../app.js';
import * as account from '../account.js';
import * as sync from '../sync.js';

/**
 * Show the sign-in code and wait for it to be approved on the site.
 * `signUp` points the first link at the sign-up page instead. Resolves true
 * once signed in, false if cancelled.
 */
async function approve(signUp) {
  const started = await account.start();
  let cancelled = false;
  const shown = dialog((close) => {
    account.waitForApproval(started, () => cancelled)
      .then((who) => close(Boolean(who)), (e) => { toast(e.message); close(false); });
    return [
      el('h2', { textContent: signUp ? 'Create your account' : 'Sign in' }),
      el('p', {
        className: 'muted',
        textContent: signUp
          ? 'Make an account on Sixth Day Studios (Google, Microsoft or an email and password), confirm your email, then sign in to connect it to the app. This is the code to check:'
          : 'Sign in on Sixth Day Studios (Google, Microsoft or email and password), then approve this code to connect it to the app.',
      }),
      el('div', { className: 'sync-code mono', textContent: started.user_code }),
      el('a', {
        className: 'btn btn-primary btn-block', target: '_blank', rel: 'noopener',
        textContent: signUp ? 'Open the sign-up page' : 'Open the sign-in page',
        href: signUp ? `${ACCOUNT_URL}/register` : `${started.url}?code=${encodeURIComponent(started.user_code)}`,
      }),
      el('div', { className: 'faint', textContent: `Waiting for you to finish. The code works for ${Math.round(started.expires_in / 60)} minutes.` }),
      el('div', { className: 'modal-actions' }, [
        el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(false) }),
      ]),
    ];
  });
  const ok = await shown;
  cancelled = true;
  return ok;
}

/** Take the account's sync code on this device, bringing in its rosters if it has any. */
async function adopt(code) {
  const result = await sync.pull(code);
  if (result) store.importJSON(JSON.stringify(result.data));
  sync.setDisabled(false);
  sync.setCode(code);
  refreshOrgs();
}

/**
 * After signing in, make the account and this device agree on one sync code.
 * A new phone with nothing on it just takes the account's rosters; a phone
 * with its own rosters asks which to keep.
 */
async function matchAccount() {
  const matched = await account.matchCode();
  sync.acknowledgeCode();      // the account keeps the code now, so there is nothing to write down
  if (matched.mode !== 'differs') return;
  const fresh = store.orgs().length === 0;
  const useAccount = fresh || await dialog((close) => [
    el('h2', { textContent: 'Which rosters do you want?' }),
    el('p', {
      className: 'muted',
      textContent: 'Your account already has rosters saved, and this device has its own. Use the ones on your account '
        + '(this device\'s are replaced), or keep this device\'s and replace what your account has.',
    }),
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn', textContent: 'Keep this device\'s', onclick: () => close(false) }),
      el('button', { className: 'btn btn-primary', textContent: 'Use my account\'s', onclick: () => close(true) }),
    ]),
  ]);
  if (useAccount) {
    await adopt(matched.code);
    toast('Your rosters are back');
    show('roster');
  } else {
    await account.keepCode(sync.currentCode(), true);
    toast('Your account now keeps this device\'s rosters');
  }
}

/**
 * Sign in (or sign up) and sort out the sync code. Problems are written into
 * `err`; `done` runs afterwards so a screen can redraw. Resolves true if signed in.
 */
export async function signIn({ signUp = false } = {}, err, done = () => {}) {
  err.textContent = '';
  try {
    if (!(await approve(signUp))) return false;
    await matchAccount();
    toast(`Signed in as ${account.current().email}`);
    return true;
  } catch (e) {
    err.textContent = e.message;
    return false;
  } finally {
    done();
  }
}

/** The Sign in and Sign up buttons, side by side. */
export function signInButtons(err, done) {
  return el('div', { className: 'row-tight' }, [
    el('button', {
      type: 'button', className: 'btn btn-primary', style: 'flex:1', textContent: 'Sign in',
      onclick: () => signIn({}, err, done),
    }),
    el('button', {
      type: 'button', className: 'btn', style: 'flex:1', textContent: 'Sign up',
      onclick: () => signIn({ signUp: true }, err, done),
    }),
  ]);
}

/** Settings card: who is signed in, or the buttons to sign in or up. Null where no account server is set up. */
export function accountCard(redraw) {
  if (!account.isConfigured() || !sync.isConfigured()) return null;
  const who = account.current();
  const err = el('div', { className: 'err' });
  if (who) {
    return el('div', { className: 'card' }, [
      el('h3', { textContent: 'Your account' }),
      el('div', { textContent: `Signed in as ${who.email}` }),
      el('div', {
        className: 'muted',
        textContent: 'Your rosters are kept with this account. Sign in on a new phone and they come back, no code to type.',
      }),
      el('button', {
        className: 'btn btn-block', textContent: 'Sign out',
        onclick: async () => {
          const ok = await confirmDialog('Sign out?', 'Your rosters stay on this device and keep syncing. Sign in again any time.', 'Sign out');
          if (!ok) return;
          account.signOut();
          redraw();
        },
      }),
    ]);
  }
  return el('div', { className: 'card' }, [
    el('h3', { textContent: 'Your account' }),
    el('div', {
      className: 'muted',
      textContent: 'Sign in with Google, Microsoft or email and your rosters come back on any phone, with no sync code to keep safe.',
    }),
    err,
    signInButtons(err, redraw),
  ]);
}
