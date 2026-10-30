# RosterWarden: to do

From the app review on 2026-10-24. Verdict: **ready to market as a free beta** (144/144 tests pass, full help
page at sixthdaystudios.com/rosterwarden/help, the live site matches main including the shift-swaps release).

- [ ] **Decide pricing** before the beta ends (the product page says "pricing to come").
- [ ] **This repo is public.** Fine while it's free; make it private before charging for it (it has no
      licence check to protect today). No secrets were found in its files or history.

## Done: staff edit their own details from their link (2026-10-30)

Let a person update their name, email and mobile from their staff link page, so the owner isn't
retyping them. It fits the existing mailbox pattern (`js/staff.js` and `js/views/staff.js`): the
page sends its whole state, and the owner's app takes it in on collect.

- [x] **Publish** their current name, email and mobile on their page (the out box is encrypted
      with their key, so only they and the owner can read it).
- [x] **Staff page:** a "Your details" card with Name, Email and Mobile, sent with Save as
      `profile: { name, email, mobile }`.
- [x] **Owner's app:** `takeProfile(person, value)` in `collect`. Trim and limit lengths, check the
      email's shape, allow only phone characters, and ignore it if nothing changed since their last send.
- [x] **Apply or ask?** Suggested: email and mobile apply straight away. A name change waits as a
      suggestion (`staffLink.profileSuggestion`) with Accept and Dismiss on their person page,
      since the name is on every roster and in messages. Toast "Sam updated their details".
- [x] **Planning Center people:** the name and email come from Planning Center, so say so on the
      card and don't overwrite them; mobile is still fine.
- [x] **Tests:** add to `tests/staff-links.test.mjs` the cases apply, suggest, accept/dismiss,
      bad email, and an unchanged repeat send.
- [x] **Docs:** README "Staff availability links", plus the help guide section and an FAQ.

## Done: "Updates from staff" log for the owner (2026-10-30)

Replies through staff links only show as a short toast today (`takeSwapNews` in `js/staff.js`,
shown by `app.js` after `collect`). Keep a reviewable log instead.

- [x] **Store:** `store.data.activity`, entries `{ id, orgId, at, personId, kind, text, rosterId?,
      date?, seen }`, where `kind` is `reply`, `dates`, `note`, `swap` or later `profile`. Synced and
      backed up like the rest. Prune entries older than 90 days on collect.
- [x] **Write entries** where the toast text is made now: `takeReplies` (can / can't do),
      `takeSwaps` (asks, answers, handovers), and `collect`. For `collect`, log dates added and
      removed (diff against their previous staff dates), whether any clash with a saved roster,
      and a changed note.
- [x] **Roster screen:** an **Updates** button with an unseen count. It opens a sheet listing the
      entries newest first, grouped by day, with unseen ones highlighted. Each has **Open roster**,
      plus **Replace** for a "can't do" still on the roster. **Mark all seen** clears the count.
- [x] **Toast:** keep it, adding **See all**, which opens the sheet.
- [x] **Tests:** entries written for each kind, no duplicates on a repeat send, pruning, and the
      seen count.
- [x] **Docs:** README and the help guide (staff links section and an FAQ).

## Done: roster screen actions in a bottom bar (2026-10-30)

Today **Share / export**, **Edit**, **Undo** and **Rebuild** sit under the roster's name, and
**← Rosters** is at the top (`renderOpen` in `js/views/saved.js`). Move the main actions to a bar
pinned at the foot of the screen, like New Roster's build bar (`.build-bar`):

- [x] **← Rosters** (exit) | **Edit**, which reads **Done** while editing, with a brief "Saved"
      when tapped (changes already save as you go, so there is no separate save step) | **Send**
      (the current Share / export menu, renamed).
- [x] Undo and Rebuild stay near the top, or go into the bar while editing. Decide when building.
      Next one and Delete stay at the foot of the page.
- [x] Check at phone width that the bar doesn't cover the last day card (pad the page bottom).
- [x] Help guide "After building" section and README: say where Send and Edit now are.

## Done: a link for every new person (asked 2026-10-30)

- [x] New people (by hand, in bulk, from Planning Center, from setup) get a link automatically, with a key
      checked against everyone else's.
