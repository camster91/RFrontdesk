# To do

Front Desk is a Windows app. What is left, in order. Tick items off as they are done.

## Before shipping

- [ ] **Build and test on Windows.** On a Windows machine, run
      `pwsh -File host/build.ps1`, then `node tools/test-all.cjs`. The Windows
      code compiles and its tests pass under Mono, but the real Windows build has
      not been run yet.
- [ ] **Review and merge [PR #10](https://github.com/camster91/RFrontdesk/pull/10).**
      Mark it ready for review first; it is still a draft.
- [ ] **Package it:** `pwsh -File tools/package.ps1` makes the zip that goes to a desk.

## Setting up a desk

- [ ] **Start it locked down on a public tablet:** add `--no-devtools` to its
      shortcut. It then runs full screen, and the tray has no way out of the app.
- [ ] **Change the PIN** the first time you sign in. It starts as 1234.
- [ ] **Turn on "Start with Windows"** in Settings → This computer.
- [ ] **Check the backups folder** after the first day: `data\backups` beside the app.

## Outside this app

- [x] **The rotmanav.ca homepage** works (the `rotmanav-hub` Worker).
- [x] **Leftover subdomains** `admin.`, `ai.` and `app.rotmanav.ca` go to the homepage.
- [x] **The web version is retired.** desk.rotmanav.ca, its routes and its sign-in
      are gone, and the homepage no longer lists Front Desk.
- [ ] **Get a code-signing certificate** so endpoint security tools trust the exe.
      See `docs/EDR_AND_SIGNING.md`.

## Remaining fixes (lower priority)

Details in `docs/CODE_REVIEW.md`, under "Found, not fixed".

**App**
- [ ] A dismissed duplicate group comes back after one checkout.
- [ ] Two places can lose a setting or alias if two writes happen at once.
- [ ] All loans: the date filter misses older loans on a busy desk (1,000 cap).
- [ ] People → "Merge with…" only offers the first ten people.
- [ ] Editing an item or person allows an empty name.
- [ ] People says "No people yet" when a search just finds nothing.
- [ ] Settings → Import replaces everything without asking first.

**Windows app and packaging**
- [ ] An old startup entry is never updated to the current command.
- [ ] One failed write check can open an empty database for that launch.
- [ ] Backup cleanup deletes any `.json` in the backups folder, including copies
      saved there by hand.
- [ ] The zip leaves out WebView2's licence files, and `For IT.txt` always says
      "unsigned".
- [ ] A crashed browser process can leave the window dead; the log is never trimmed.

## Older open items

Listed under "Still open" in `docs/CODE_REVIEW.md`, and as GitHub issues 1–8.
