/**
 * Settings: a hub for everything that isn't building a roster.
 *
 * Three groups, the way InvoiceWarden lays its settings out: your workplace
 * (people, shifts, name and opening hours), connections to other systems
 * (Planning Center, AI assist), and the app itself (sync and backup, install,
 * about). There is no appearance setting: RosterWarden is dark only.
 */
import { store } from '../store.js';
import { PROVIDERS } from '../ai.js';
import { todayISO } from '../scheduler.js';
import {
  el, fill, toast, promptText, confirmDialog, downloadText, weekdayPicker, copyText,
  TIME_STEP_SECONDS,
} from '../ui.js';
import { show, refreshOrgs } from '../app.js';
import * as peopleView from './people.js';
import * as shiftsView from './shifts.js';
import * as planningCenter from './planning-center.js';
import { canInstall, isInstalled, isIOS, promptInstall } from '../install.js';
import * as sync from '../sync.js';

/**
 * Which sub-screen is open, or null for the menu.
 *
 * Settings is a hub rather than one long page: it holds the People and Shifts
 * editors, and stacking those with everything else in one scroll would bury them.
 */
let section = null;

/** The menu, grouped so setting the place up is separated from app settings. */
const MENU = [
  {
    group: 'Your workplace',
    items: [
      { id: 'people', label: 'People', hint: 'Who you roster, and the days each can work' },
      { id: 'shifts', label: 'Shifts', hint: 'The blocks of work a rostered day is made of' },
      { id: 'workplace', label: 'Name and opening hours', hint: 'The days you trade, rename or delete' },
    ],
  },
  {
    group: 'Connections',
    items: [
      { id: 'planning-center', label: 'Planning Center', hint: 'Bring in a team and blockouts, send rosters back' },
      { id: 'ai', label: 'AI assist', hint: 'Read availability from a pasted message' },
    ],
  },
  {
    group: 'App',
    items: [
      { id: 'data', label: 'Sync and backup', hint: 'Keep your rosters safe and on every device' },
      { id: 'install', label: 'Add to Home Screen', hint: 'One tap away, and working offline' },
      { id: 'about', label: 'About', hint: 'How it works, and erasing everything' },
    ],
  },
];

/**
 * Older section names, from links elsewhere in the app and earlier versions,
 * mapped onto the sections that now hold them.
 */
const LEGACY_SECTIONS = {
  hours: 'workplace',
  organisation: 'workplace',
  sync: 'data',
  backup: 'data',
};

/** Sections that describe an organisation, so need one to exist first. */
const NEEDS_ORG = ['people', 'shifts', 'workplace'];

/** Open Settings at a particular sub-screen, or at the menu when given null. */
export function openSection(name) {
  const id = LEGACY_SECTIONS[name] || name;
  section = MENU.some((g) => g.items.some((i) => i.id === id)) ? id : null;
}

/** Entry point: the settings menu, or whichever sub-screen is open. */
export function render(container) {
  if (!section) {
    fill(container, [el('h2', { textContent: 'Settings' }), ...renderMenu(container)]);
    return;
  }

  const item = MENU.flatMap((g) => g.items).find((i) => i.id === section);
  const backBtn = el('button', {
    className: 'btn btn-sm', textContent: '← Settings',
    onclick: () => { section = null; render(container); },
  });
  const header = el('div', { className: 'row-tight' }, [backBtn]);

  // Without this guard the people/shifts editors would happily write records
  // against a null organisation that nothing could ever show again.
  if (NEEDS_ORG.includes(section) && !store.currentOrg()) {
    fill(container, [
      header,
      el('h2', { textContent: item?.label || 'Settings' }),
      el('div', {
        className: 'card muted',
        textContent: 'Create an organisation first — use the dropdown at the top of the screen.',
      }),
    ]);
    return;
  }

  // People and Shifts are full editors with their own internal navigation, so
  // they render into a nested element and keep the back bar above them.
  if (section === 'people' || section === 'shifts') {
    const sub = el('div');
    fill(container, [header, sub]);
    (section === 'people' ? peopleView : shiftsView).render(sub);
    return;
  }

  // No section heading here: every card below already carries its own.
  fill(container, [header, ...renderSectionBody(section, container)]);
}

/** The tappable menu rows. */
function renderMenu(container) {
  return MENU.map((group) => el('div', {}, [
    el('label', { className: 'label', textContent: group.group }),
    el('div', { className: 'list' }, group.items.map((item) => el('button', {
      className: 'item',
      onclick: () => { section = item.id; render(container); },
    }, [
      el('div', { className: 'item-main' }, [
        el('div', { className: 'item-title', textContent: item.label }),
        el('div', { className: 'item-sub', textContent: item.hint }),
      ]),
      el('span', { className: 'item-chevron', textContent: '›', 'aria-hidden': 'true' }),
    ]))),
  ]));
}

/** The cards belonging to one sub-screen. */
function renderSectionBody(name, container) {
  const redraw = () => render(container);
  switch (name) {
    case 'workplace': return [renderWorkplaceCard()];
    case 'planning-center': return [planningCenter.renderCard(redraw)];
    case 'ai': return [renderAICard()];
    case 'data': return [renderSyncCard(container), renderBackupCard(container)];
    case 'install': return [renderInstallCard(container)];
    case 'about': return [renderAboutCard()];
    default: return [];
  }
}

/**
 * Section: the organisation's name and opening hours, and deleting it.
 * One card for the things you set once about the place itself.
 */
function renderWorkplaceCard() {
  const org = store.currentOrg();
  const nameInput = el('input', { type: 'text', value: org.name });
  nameInput.addEventListener('change', () => {
    const value = nameInput.value.trim();
    if (!value) { nameInput.value = org.name; return; }
    store.renameOrg(org.id, value);
    refreshOrgs();
    toast('Renamed');
  });

  const deleteBtn = el('button', {
    className: 'btn btn-danger btn-block', textContent: 'Delete organisation',
    onclick: async () => {
      const ok = await confirmDialog(
        'Delete organisation',
        `This deletes "${org.name}" and all of its people, shifts and saved rosters. This cannot be undone.`
      );
      if (!ok) return;
      store.deleteOrg(org.id);
      refreshOrgs();
      show('roster');
      toast('Organisation deleted');
    },
  });

  return el('div', { className: 'card' }, [
    el('h3', { textContent: 'Name and opening hours' }),
    el('div', {}, [el('label', { className: 'label', textContent: 'Name' }), nameInput]),
    renderOpeningHours(org),
    deleteBtn,
  ]);
}

/**
 * Opening days and hours for the current organisation.
 *
 * The days drive the calendar on the New Roster screen - anything outside is
 * dimmed, and an "All open days" shortcut appears. The hours are used to
 * pre-fill the times when a new shift is added, so the common case needs no
 * typing.
 */
function renderOpeningHours(org) {
  // Same 5-minute granularity as shift times - these pre-fill them, so a
  // finer opening hour would produce a shift time the shift editor can't hold.
  const step = String(TIME_STEP_SECONDS);
  const openTime = el('input', { type: 'time', step, value: org.openTime || '' });
  const closeTime = el('input', { type: 'time', step, value: org.closeTime || '' });

  /** Persist whichever hour field changed. */
  const saveHours = () => {
    store.updateOrg(org.id, { openTime: openTime.value, closeTime: closeTime.value });
  };
  openTime.addEventListener('change', saveHours);
  closeTime.addEventListener('change', saveHours);

  const daysWrap = el('div');
  fill(daysWrap, weekdayPicker(store.openDays(), (days) => {
    store.updateOrg(org.id, { openDays: days });
  }));

  return el('div', {}, [
    el('label', { className: 'label', textContent: 'Open on' }),
    daysWrap,
    el('div', {
      className: 'faint',
      textContent: 'Days you are closed are dimmed on the roster calendar. You can still pick them for a one-off.',
      style: 'margin-top:.35rem',
    }),
    el('label', { className: 'label', textContent: 'Opening hours', style: 'margin-top:.8rem' }),
    el('div', { className: 'grid-2' }, [
      el('div', {}, [el('label', { className: 'faint', textContent: 'Opens' }), openTime]),
      el('div', {}, [el('label', { className: 'faint', textContent: 'Closes' }), closeTime]),
    ]),
    el('div', {
      className: 'faint',
      textContent: 'Used to fill in the times when you add a new shift.',
      style: 'margin-top:.35rem',
    }),
  ]);
}

/** Section: export/import the whole database as a JSON backup file. */
function renderBackupCard(container) {
  const importErr = el('div', { className: 'err' });

  const fileInput = el('input', {
    type: 'file', accept: 'application/json,.json', hidden: true,
    onchange: async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const ok = await confirmDialog(
        'Restore from backup',
        'This replaces everything currently on this device with the contents of this backup file. This cannot be undone.',
        'Restore'
      );
      fileInput.value = '';
      if (!ok) return;
      try {
        const text = await file.text();
        const { syncCode } = store.importJSON(text);
        importErr.textContent = '';

        // A backup taken while sync was on carries the code too. Adopting it
        // is what makes this a full recovery rather than a copy that the
        // server has never heard of - but it is asked, not assumed, because it
        // points this device at a different database.
        if (syncCode && sync.normaliseCode(syncCode) !== sync.currentCode()) {
          const adopt = await confirmDialog(
            'Use the sync code from this backup?',
            'This backup was made on a device with sync switched on. Using its code '
            + 'reconnects this device to that same synced data — which is what you '
            + 'want when replacing a lost phone.',
            'Use it'
          );
          if (adopt) {
            sync.setDisabled(false);
            sync.setCode(syncCode);
            sync.acknowledgeCode();      // they clearly have a copy of it
          }
        }

        refreshOrgs();
        toast('Backup restored');
        show('roster');
      } catch (err) {
        importErr.textContent = err.message;
      }
    },
  });

  const exportBtn = el('button', {
    className: 'btn btn-primary btn-block', textContent: 'Export backup',
    onclick: () => {
      const date = todayISO();
      // Include the sync code so one file restores the data *and* the identity
      // the server knows this device by.
      const code = sync.currentCode();
      downloadText(
        `rosterwarden-backup-${date}.json`,
        store.exportJSON(code ? { syncCode: sync.formatCode(code) } : {}),
        'application/json'
      );
      toast('Backup downloaded');
    },
  });
  const importBtn = el('button', {
    className: 'btn btn-block', textContent: 'Restore from backup',
    onclick: () => fileInput.click(),
  });

  return el('div', { className: 'card' }, [
    el('h3', { textContent: 'Backup' }),
    el('div', {
      className: 'notice',
      textContent: 'Your data lives only in this browser, on this device. Clearing browsing data, ' +
        'reinstalling the browser, or switching phones would erase it. Export a backup occasionally, ' +
        'and keep the file somewhere safe (Files, email to yourself, Drive).',
    }),
    exportBtn,
    importBtn,
    fileInput,
    importErr,
  ]);
}

/** Section: AI provider/model/key used to parse availability notes. */
function renderAICard() {
  const provider = store.setting('aiProvider') || 'gemini';
  const spec = PROVIDERS[provider] || PROVIDERS.gemini;

  const providerSelect = el('select', {}, Object.entries(PROVIDERS).map(([key, p]) =>
    el('option', { value: key, textContent: p.label, selected: key === provider })
  ));

  const modelInput = el('input', {
    type: 'text', value: store.setting('aiModel') || '', placeholder: spec.defaultModel,
    onblur: () => store.setSetting('aiModel', modelInput.value.trim()),
  });

  const keyInput = el('input', {
    type: 'password', value: store.setting('aiKey') || '',
    onblur: () => store.setSetting('aiKey', keyInput.value.trim()),
  });
  const showHideBtn = el('button', {
    className: 'btn btn-sm', textContent: 'Show',
    onclick: () => {
      const hidden = keyInput.type === 'password';
      keyInput.type = hidden ? 'text' : 'password';
      showHideBtn.textContent = hidden ? 'Hide' : 'Show';
    },
  });

  const keyLink = el('a', {
    href: spec.keyUrl, target: '_blank', rel: 'noopener', textContent: 'Get a key',
  });

  providerSelect.addEventListener('change', () => {
    store.setSetting('aiProvider', providerSelect.value);
    const newSpec = PROVIDERS[providerSelect.value];
    modelInput.placeholder = newSpec.defaultModel;
    keyLink.href = newSpec.keyUrl;
  });

  return el('div', { className: 'card' }, [
    el('h3', { textContent: 'AI assist' }),
    el('p', { className: 'muted' }, [
      'AI is only used to turn free-text availability notes into structured days and away-dates. ' +
      'It never decides who works when - the roster itself is worked out by a fixed set of rules ' +
      'that always give the same answer.',
    ]),
    el('div', {}, [el('label', { className: 'label', textContent: 'Provider' }), providerSelect]),
    el('div', {}, [el('label', { className: 'label', textContent: 'Model' }), modelInput]),
    el('div', {}, [
      el('label', { className: 'label', textContent: 'API key' }),
      el('div', { className: 'row-tight' }, [keyInput, showHideBtn]),
    ]),
    keyLink,
    el('div', {
      className: 'faint',
      textContent: 'The key is stored on this device only, and is readable by anyone who can use this ' +
        'device. Fine for personal use - avoid it on a shared phone.',
    }),
  ]);
}

/**
 * Section: encrypted sync across devices.
 *
 * Everything is encrypted on this device before it is sent, using a key
 * derived from the sync code. The code never leaves the device, so the server
 * - and whoever runs it - stores bytes it cannot read.
 *
 * The flip side is stated plainly in the UI: lose the code and nobody can get
 * the data back, because nobody else ever had the key.
 */
function renderSyncCard(container) {
  if (!sync.isConfigured()) {
    return el('div', { className: 'card' }, [
      el('h3', { textContent: 'Sync' }),
      el('div', {
        className: 'muted',
        textContent: 'No sync server is set up for this app, so everything stays on '
          + 'this device. Use Backup to keep a copy safe.',
      }),
    ]);
  }

  const code = sync.currentCode();
  const err = el('div', { className: 'err' });
  const redraw = () => render(container);

  const blurb = el('div', {
    className: 'muted',
    textContent: 'Sync keeps your rosters on every device you use, and off this '
      + 'phone alone. Everything is encrypted here before it is sent — the server '
      + 'stores it but cannot read it.',
  });

  if (!code) {
    const startBtn = el('button', {
      className: 'btn btn-primary btn-block', textContent: 'Turn on sync',
      onclick: async () => {
        const fresh = sync.generateCode();
        sync.setDisabled(false);
        sync.setCode(fresh);
        try {
          await sync.push(store.data, fresh);
          toast('Sync is on');
        } catch (e) {
          sync.setCode(null);
          err.textContent = e.message;
        }
        redraw();
      },
    });
    const joinBtn = el('button', {
      className: 'btn btn-block', textContent: 'Use a code from another device',
      onclick: async () => {
        const entered = await promptText('Enter sync code', 'Code from your other device');
        if (!entered) return;
        try {
          const result = await sync.pull(entered);
          if (!result) {
            err.textContent = 'No data found for that code — check it and try again.';
            return;
          }
          const ok = await confirmDialog(
            'Replace what is on this device?',
            'The data from that code will replace everything currently on this device. '
            + 'Export a backup first if you are not sure.',
            'Replace'
          );
          if (!ok) return;
          store.importJSON(JSON.stringify(result.data));
          sync.setDisabled(false);
          sync.setCode(entered);
          refreshOrgs();
          toast('Synced from your other device');
          show('roster');
        } catch (e) {
          err.textContent = e.message;
        }
      },
    });
    return el('div', { className: 'card' }, [
      el('h3', { textContent: 'Sync' }), blurb, err, startBtn, joinBtn,
    ]);
  }

  // Sync is on: show the code, and be blunt about what losing it means.
  // Grouped for the eye; the stored value stays stripped.
  const shown = sync.formatCode(code);
  const codeBox = el('div', { className: 'sync-code mono', textContent: shown });
  const state = sync.status.state === 'error'
    ? `Last sync failed: ${sync.status.message}`
    : sync.status.state === 'synced' ? 'Up to date.'
      : sync.status.state === 'pending' ? 'Saving changes…' : 'Ready.';

  return el('div', { className: 'card' }, [
    el('h3', { textContent: 'Sync' }),
    blurb,
    el('label', { className: 'label', textContent: 'Your sync code' }),
    codeBox,
    el('div', { className: 'notice bad' }, [
      el('strong', { textContent: 'Write this down.' }),
      el('div', {
        textContent: 'It is the only key to your data. Nobody — including whoever '
          + 'runs the server — can recover it for you if it is lost, because nobody '
          + 'else has ever had it.',
      }),
    ]),
    // Getting the code into email is the practical answer to "what if I lose
    // the phone": email already has its own account recovery, so borrowing it
    // gives a way back in without the server ever being able to read anything.
    el('button', {
      className: 'btn btn-primary btn-block', textContent: 'Send this code to myself',
      onclick: async () => {
        const body = `RosterWarden sync code: ${shown}\n\n`
          + 'Keep this. It is the only key to your rosters — entering it in RosterWarden '
          + 'on a new phone brings everything back. Nobody can recover it for you, '
          + 'not even whoever runs the server, because nobody else has ever had it.';
        try {
          if (navigator.share) {
            await navigator.share({ title: 'RosterWarden sync code', text: body });
          } else {
            // No share sheet (most desktop browsers): hand it to the mail client.
            window.location.href = `mailto:?subject=${encodeURIComponent('RosterWarden sync code')}`
              + `&body=${encodeURIComponent(body)}`;
          }
          sync.acknowledgeCode();
          redraw();
        } catch (e) {
          if (e && e.name === 'AbortError') return;   // they closed the sheet
          copyText(shown);
        }
      },
    }),
    sync.codeAcknowledged() ? null : el('button', {
      className: 'btn btn-block', textContent: 'I have written it down',
      onclick: () => {
        sync.acknowledgeCode();
        toast('Thanks — that reminder will stop now');
        redraw();
      },
    }),
    el('div', { className: 'row' }, [
      el('button', {
        className: 'btn', textContent: 'Copy code', onclick: () => copyText(shown),
      }),
      el('button', {
        className: 'btn', textContent: 'Sync now',
        onclick: async () => {
          err.textContent = '';
          try {
            await sync.push(store.data);
            toast('Synced');
          } catch (e) { err.textContent = e.message; }
          redraw();
        },
      }),
    ]),
    el('div', { className: 'faint', textContent: state }),
    err,
    el('button', {
      className: 'btn btn-danger btn-block', textContent: 'Turn off sync on this device',
      onclick: async () => {
        const ok = await confirmDialog(
          'Turn off sync?',
          'This device will stop sending changes. Your rosters stay on this device, '
          + 'and the copy on the server is left as it is.',
          'Turn off'
        );
        if (!ok) return;
        sync.setCode(null);
        // Remember the choice: without this, the next launch would helpfully
        // switch sync straight back on again.
        sync.setDisabled(true);
        toast('Sync off');
        redraw();
      },
    }),
  ]);
}

/**
 * Section: put RosterWarden on the home screen.
 *
 * Three states, because the platforms genuinely differ: already installed,
 * installable via the browser's own prompt, or iOS - where no such API exists
 * and the only truthful option is to show the steps.
 */
function renderInstallCard(container) {
  const blurb = el('div', {
    className: 'muted',
    textContent: 'Installed, RosterWarden opens full screen with its own icon and works '
      + 'with no signal at all. This is not an app-store download - nothing lands on '
      + 'the phone but a shortcut and the page itself.',
  });

  if (isInstalled()) {
    return el('div', { className: 'card' }, [
      el('h3', { textContent: 'Add to Home Screen' }),
      el('div', { className: 'notice', textContent: 'Already installed — you are using it right now.' }),
      blurb,
    ]);
  }

  if (canInstall()) {
    const btn = el('button', {
      className: 'btn btn-primary btn-block btn-lg', textContent: 'Add to Home Screen',
      onclick: async () => {
        const accepted = await promptInstall();
        toast(accepted ? 'Added to your home screen' : 'Not added');
        render(container);            // the prompt is spent either way
      },
    });
    return el('div', { className: 'card' }, [
      el('h3', { textContent: 'Add to Home Screen' }), blurb, btn,
    ]);
  }

  // iOS offers no programmatic route, so spell out the Share-sheet steps.
  const steps = isIOS()
    ? ['Tap the Share button at the bottom of Safari.',
       'Scroll down and choose "Add to Home Screen".',
       'Tap Add.']
    : ['Open your browser’s menu.',
       'Choose "Install app" or "Add to Home screen".',
       'Confirm.'];

  return el('div', { className: 'card' }, [
    el('h3', { textContent: 'Add to Home Screen' }),
    blurb,
    el('ol', { className: 'install-steps' }, steps.map((s) => el('li', { textContent: s }))),
    el('div', {
      className: 'faint',
      textContent: 'If you cannot see the option, it may already be installed, or the '
        + 'browser may not support it — Safari on iPhone and Chrome on Android both do.',
    }),
  ]);
}

/** Section: app identity and the full data wipe. */
function renderAboutCard() {
  const deleteAllBtn = el('button', {
    className: 'btn btn-danger btn-block', textContent: 'Delete all data',
    onclick: async () => {
      const ok = await confirmDialog(
        'Delete all data',
        'This permanently deletes every organisation, person, shift and saved roster on this device. ' +
          'There is no undo. Make sure you have a backup if you might want any of this again.',
        'Delete everything'
      );
      if (!ok) return;
      store.reset();
      refreshOrgs();
      show('roster');
      toast('All data deleted');
    },
  });

  // How it works: the one-time setup, then the build loop.
  const howSteps = [
    'Add your people and tick the days each of them can work.',
    'Set up the shifts a day is made of, and your opening days and hours.',
    'Note who is away, and any two people who should not be rostered together.',
    'Pick the dates on the calendar and press Build. RosterWarden spreads the '
      + 'shifts fairly, honours every constraint, and says so plainly when it '
      + 'cannot fill one.',
  ];

  return el('div', { className: 'card' }, [
    el('h3', { textContent: 'About' }),
    el('div', { textContent: 'RosterWarden' }),
    el('div', { className: 'muted', textContent: 'Everything stays on this device.' }),
    el('h4', { textContent: 'How it works' }),
    el('ol', { className: 'install-steps' }, howSteps.map((s) => el('li', { textContent: s }))),
    deleteAllBtn,
  ]);
}
