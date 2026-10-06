# To do

What is left before and after shipping. Tick items off as they are done.

## Before shipping

- [ ] **Build and test the Windows app.** On a Windows machine, build it and run
      `node tools/test-all.cjs`. The backup change in `host/FrontDesk.cs` has not
      been compiled yet, and the "host flags and navigation" suite only runs on
      Windows.
- [ ] **Review and merge [PR #10](https://github.com/camster91/RFrontdesk/pull/10).**
      Mark it ready for review first; it is still a draft. Merging does not deploy
      anything.
- [x] **Publish the web build.** Done 2026-10-05: the polish is live at
      desk.rotmanav.ca. For later changes, run `cd deploy && npx wrangler deploy`
      with `CLOUDFLARE_API_TOKEN` set (see README, "On the web").

## Setting up a desk

- [ ] **Change the PIN** on every device. It starts as 1234.
- [ ] **Lock the tablet to the app:** Guided Access on an iPad, app pinning on
      Android, or kiosk mode in Chrome.
- [ ] **Sign the tablet in to Cloudflare Access** once. The sign-in lasts 30 days.
- [ ] **Add other staff emails** to the "Staff" policy of the "Front Desk
      (desk.rotmanav.ca)" Access app, if anyone else will set up or re-sign-in the
      tablet. Right now only one email can sign in.
- [ ] **Keep the backup downloads** somewhere safe. In the browser, records live
      only on the device.

## Outside this app

- [x] **Fix the rotmanav.ca homepage.** Done: since 2026-10-02 the `rotmanav-hub`
      Worker serves a "Rotman AV" page there with links to Cast, Clicker, Front
      Desk and Mics.
- [x] **Tidy the leftover subdomains.** Done 2026-10-06: `admin.`, `ai.` and
      `app.rotmanav.ca` now route to the `rotmanav-hub` Worker, which sends them on
      to rotmanav.ca.
- [ ] **Get a code-signing certificate** for the Windows build, so endpoint
      security tools trust it. See `docs/EDR_AND_SIGNING.md`.

## Remaining fixes (lower priority)

Found in the Phase 13 review and not yet fixed. Details are in
`docs/CODE_REVIEW.md`, under "Found, not fixed".

**App**
- [ ] A dismissed duplicate group comes back after one checkout.
- [ ] Two places can lose a setting or alias if two writes happen at once.
- [ ] All loans: the date filter misses older loans on a busy desk (1,000 cap).
- [ ] People → "Merge with…" only offers the first ten people.
- [ ] Editing an item or person allows an empty name.
- [ ] People says "No people yet" when a search just finds nothing.
- [ ] Settings → Import replaces everything without asking first.

**Windows app and packaging**
- [ ] `--no-devtools` still allows the tray's Open folder, Exit and Start with
      Windows, and ignores a misspelt flag.
- [ ] An old startup entry is never updated to the current command.
- [ ] One failed write check can open an empty database for that launch.
- [ ] Backup cleanup deletes any `.json` in the backups folder, including copies
      saved there by hand.
- [ ] The zip leaves out WebView2's licence files, and `For IT.txt` always says
      "unsigned".
- [ ] A crashed browser process can leave the window dead; the log is never
      trimmed and keeps phone numbers.

## Older open items

Listed under "Still open" in `docs/CODE_REVIEW.md`:

- [ ] Test the Windows startup entry on a real machine.
- [ ] Add a test for Wipe All Data.
- [ ] Add a test for leaving the kiosk's Done screen.
- [ ] Decide whether names keep their capitals (now "McDonald" becomes
      "Mcdonald").
- [ ] Review the README's "Known quirks".
