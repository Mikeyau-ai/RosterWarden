# RosterWarden

**Fair staff rosters in seconds, on your phone.** From [Sixth Day Studios](https://sixthdaystudios.com),
alongside InvoiceWarden and RamWarden. Formerly **Rosterm8** (renamed 2026-10).

Add your people, tick the days each of them can work, note who's away and who
shouldn't be paired up, then press **Build roster**. RosterWarden spreads the
shifts fairly, honours every constraint you gave it, and tells you plainly when
it couldn't fill something rather than quietly fudging it.

Built for a small church cafe's casual weekend roster, but nothing in it is
specific to that: it handles any set of named shifts on any days of the week.
Churches on **Planning Center** can bring a Services team and everyone's
blockout dates straight in, and send finished rosters back into their plans.

## Using it

Open the site, tap **Add to Home Screen** (Safari: Share → Add to Home Screen;
Chrome: menu → Install app), and it behaves like an installed app: full screen,
its own icon, and it works with no signal.

Three sections:

- **Roster**: the rosters you've saved. This is what you open it to look at.
- **New Roster**: the calendar and the Build button.
- **Settings**, in three groups:
  - *Your workplace*: People, Shifts, Name and opening hours
  - *Connections*: Planning Center, AI assist
  - *App*: Sync and backup, Add to Home Screen, About

1. **Name your workplace** on the welcome screen: the cafe, the shop, the team.
   You can have more than one; the dropdown at the top switches between them.
2. **People**: add everyone and tick the days each can work. **Add several**
   takes a pasted list of names (one per line, with an optional `- Sat, Sun`)
   and walks you through the day picker for anyone whose days you didn't type.
   Or bring a team in from Planning Center (below).
3. **Shifts**: the blocks of work a day is made of, e.g. `Cafe 08:00–12:00,
   2 people needed`. They're filled in the order listed.
4. **New Roster**: tap the dates on the calendar, press **Build**. Save it and
   it appears under **Roster**, where you can edit, copy, share, or send it to
   Planning Center.

### Opening days and hours

**Settings → Name and opening hours**:

- **Open on**: the days you normally trade. Everything else is dimmed on the
  roster calendar, and an **All open days** shortcut appears. Dimmed, not
  blocked: you can still pick a closed day for a one-off, and it shows dashed.
- **Opening hours**: fill in the times when you add a new shift.

Time fields step in 5-minute blocks, which is far quicker on a phone.

### Picking dates

The calendar takes exact dates rather than a repeating rule, because real
rosters aren't a clean pattern. The bulk buttons under each month (All open
days, Saturdays, Weekends...) keep the ordinary case quick; tap a single date to
switch it off, and tap a bulk button again to clear what it selected.

**Repeat weekly** carries the first week's pattern forward, by number of weeks
or to an end date. It's recalculated each time, so dropping 12 weeks to 4 takes
the later dates back off.

### Requests and days off

Under the calendar, **Requests and days off** lists everyone against the picked
dates: tap a date to cycle *asked to work → can't work → nothing*. With an AI
key set, you can also paste a message there ("Sarah can only do Saturdays, Tom's
away 5–9 June") and approve what it read before anything is saved.

## Planning Center

**Settings → Planning Center → Connect Planning Center** signs in with the
person's own Planning Center login (OAuth). Then:

- **Team**: pick the Services team you roster for this workplace.
- **Update from Planning Center**: adds anyone new on the team (matching
  existing people by name first, so a list typed by hand is linked, not
  duplicated) and replaces everyone's Planning Center blockouts with the current
  ones, including repeating blockouts. Away dates you typed yourself are never
  touched. The days each person can work are still set in RosterWarden.
- **Send each shift as**: the team position each shift fills (e.g. Cafe →
  Barista).
- **Send to Planning Center** (on a saved roster): adds everyone to the plans on
  those dates as **Unconfirmed**, with notifications *prepared but not sent*.
  Nobody hears anything until you press Send in Planning Center. Sending twice
  doesn't double anyone up. Dates with no plan, people not on the team, and
  shifts with no position are listed afterwards.

Each device signs in for itself; the token stays on that device and is not in
backups or sync. The app talks to Planning Center directly, except for the
sign-in swap, which needs the app's client secret and so goes through the sync
worker (see `worker/README.md`). With `PCO_CLIENT_ID` empty in `js/config.js`
the card just says Planning Center isn't set up.

### Setting it up (once)

1. Register an app at <https://api.planningcenteronline.com/oauth/applications>
   with callback URLs `https://mikeyau-ai.github.io/RosterWarden/` and
   `http://localhost:8123/`.
2. Put the client id in `js/config.js` (`PCO_CLIENT_ID`) and
   `worker/wrangler.toml` (`PCO_CLIENT_ID`).
3. From `worker/`: `npx wrangler secret put PCO_CLIENT_SECRET`, then
   `npx wrangler deploy`.

**Never put the secret (or a personal access token) in the app's own files.**
This is a public static site: anything in it can be read by anyone.

## Backups and sync

With **sync** on (the default when a sync server is configured), your data is
encrypted on the device and kept on the server, which stores it but cannot read
it. Your **sync code** brings everything back on a new phone. **Lose the code and
the data is gone**: nobody else has ever held the key, which is the point.

Without sync, everything is in this browser's storage only, and **clearing your
browsing data erases it**. Use **Settings → Sync and backup → Export backup** now
and then; **Restore from backup** puts it all back.

## The scheduler

`js/scheduler.js` is the part that matters, and it is deliberately boring:
given the same inputs it always produces the same roster. No AI, no randomness.

For each vacancy it ranks everyone who is eligible by

1. fewest shifts worked so far in this roster: spread the load
2. longest since they last worked: spread the days out
3. name: a stable tiebreak, so the result never changes between runs

and takes the top candidate. It works from the exact dates picked, and enforces
weekly availability, away dates, "never together" pairs, an optional per-person
cap, and one shift per person per day. Requested dates override the weekday
pattern. Anything it can't satisfy becomes a note on the roster instead of a
silent gap.

## The AI bit is optional

**Settings → AI assist** turns pasted messages into ticked days, away dates and
clash pairs for you to approve. Names it doesn't recognise are thrown away. It
never decides who works when. Supported: Gemini, Anthropic and OpenAI; the key is
stored on this device only (fine for a personal phone, not a shared one).

## Running it locally

A static site with no build step:

```bash
python dev-server.py
```

Then open `http://localhost:8123`. `dev-server.py` sends no-cache headers so an
edit always shows, and the service worker is skipped on localhost for the same
reason. Tests:

```bash
node --test tests/*.mjs
```

## Layout

| Area | Files |
|------|-------|
| Shell + look | `index.html`, `css/app.css` (dark only, studio teal) |
| Boot + nav | `js/app.js` |
| Allocation | `js/scheduler.js` |
| Storage + backup | `js/store.js` |
| Planning Center | `js/sources/planning-center.js` (API), `js/views/planning-center.js` (screens) |
| AI assist | `js/ai.js` |
| Shared widgets | `js/ui.js` |
| Roster display + editing | `js/views/roster-parts.js` |
| Encrypted sync + sign-in swap | `js/sync.js`, `js/config.js`, `worker/` |
| Home-screen install | `js/install.js` |
| Screens | `js/views/*.js` |
| Offline | `sw.js`, `manifest.webmanifest` |
| Branding | `make_icons.py` → `icons/` |
| Tests | `tests/*.test.mjs` |

`legacy-desktop/` holds the original Windows app this replaced (still called
Rosterm8). It is no longer developed.

## Deploying

GitHub Pages, straight from `main`: push and the site updates. The service
worker serves the cached copy first and refreshes in the background; when that
finds a changed file the open page reloads onto it within seconds. Add any new
file to the `SHELL` list in `sw.js` so it works offline.
