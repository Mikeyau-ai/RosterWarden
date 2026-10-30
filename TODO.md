# RosterWarden: to do

From the app review on 2026-10-24. Verdict: **ready to market as a free beta** (144/144 tests pass, full help
page at sixthdaystudios.com/rosterwarden/help, the live site matches main including the shift-swaps release).

- [ ] **Decide pricing** before the beta ends (the product page says "pricing to come").
- [ ] **This repo is public.** Fine while it's free; make it private before charging for it (it has no
      licence check to protect today). No secrets were found in its files or history.

## Later: staff edit their own details from their link (asked 2026-10-30)

Let a person update their name, email and mobile from their staff link page, so the owner isn't
retyping them. It fits the existing mailbox pattern (`js/staff.js` and `js/views/staff.js`): the
page sends its whole state, and the owner's app takes it in on collect.

- [ ] **Publish** their current name, email and mobile on their page (the out box is encrypted
      with their key, so only they and the owner can read it).
- [ ] **Staff page:** a "Your details" card with Name, Email and Mobile, sent with Save as
      `profile: { name, email, mobile }`.
- [ ] **Owner's app:** `takeProfile(person, value)` in `collect`. Trim and limit lengths, check the
      email's shape, allow only phone characters, and ignore it if nothing changed since their last send.
- [ ] **Apply or ask?** Suggested: email and mobile apply straight away. A name change waits as a
      suggestion (`staffLink.profileSuggestion`) with Accept and Dismiss on their person page,
      since the name is on every roster and in messages. Toast "Sam updated their details".
- [ ] **Planning Center people:** the name and email come from Planning Center, so say so on the
      card and don't overwrite them; mobile is still fine.
- [ ] **Tests:** add to `tests/staff-links.test.mjs` the cases apply, suggest, accept/dismiss,
      bad email, and an unchanged repeat send.
- [ ] **Docs:** README "Staff availability links", plus the help guide section and an FAQ.
