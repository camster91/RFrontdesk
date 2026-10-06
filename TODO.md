# To do

Front Desk is a Windows app. What is left, in order. Tick items off as they are done.

## Before shipping

- [x] **Build and test on Windows** — GitHub does it now, on every push and pull
      request (Actions → *Build*). No build computer needed.
- [x] **Review and merge [PR #10](https://github.com/camster91/RFrontdesk/pull/10).**
- [ ] **Download the zip** from the latest run's Artifacts and try
      *Install Front Desk* on a real desk.

## Setting up a desk

- [ ] **Install it:** extract the zip, double-click *Install Front Desk*. On a
      public tablet tick "This is a public tablet: lock it down".
- [ ] **Change the PIN** the first time you sign in. It starts as 1234.
- [ ] **Turn on "Start with Windows"** (an install option, or Settings → This computer).
- [ ] **Check the backups folder** after the first day: `data\backups` beside the app.

## Outside this app

- [x] **The rotmanav.ca homepage** works (the `rotmanav-hub` Worker).
- [x] **Leftover subdomains** `admin.`, `ai.` and `app.rotmanav.ca` go to the homepage.
- [x] **The web version is retired.** desk.rotmanav.ca, its routes and its sign-in
      are gone, and the homepage no longer lists Front Desk.
- [x] **Code signing.** Every build on `main` is signed with Azure Artifact
      Signing through the shared Rclicker workflow; the first signed build is
      run 37467605234. See `docs/code-signing.md`.

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

**Windows app and packaging** — all done
- [x] An old startup entry is never updated to the current command.
- [x] One failed write check can open an empty database for that launch.
- [x] Backup cleanup deletes any `.json` in the backups folder, including copies
      saved there by hand.
- [x] The zip leaves out WebView2's licence files, and `For IT.txt` always says
      "unsigned".
- [x] A crashed browser process can leave the window dead; the log is never trimmed.
- [x] Easy install and uninstall, per user, no admin.
- [x] Build, test, package and sign on GitHub instead of a local computer.

## Older open items

Listed under "Still open" in `docs/CODE_REVIEW.md`, and as GitHub issues 1–8.
