# Rotman Front Desk

Equipment checkout and returns for the front desk.

A Windows app with no install and no admin rights: copy the folder, run
`RotmanFrontDesk.exe`. All of its data lives in the same folder, so copying that
folder moves the whole desk — records, backups and log.

The build that goes to a desk is **`release\Rotman-Front-Desk-1.0.0.zip`** —
unzip it wherever the app is going to live and run the exe inside. There is
nothing to install: the zip is the delivery, and unpacking it is the install.
It carries `START HERE.txt` for whoever sets up the desk and `For IT.txt` for
whoever has to let it through the endpoint agent.

It has **two surfaces**. Staff sign in with a PIN and get loans, items, people and
reports. The public surface (`the kiosk`) is what a borrower sees on an unattended
tablet: they can borrow and ask to return, and nothing else.

---

## For the desk

### Getting in

The app opens on a welcome screen. **Staff access is a press-and-hold on the
Rotman logo, about two seconds** — deliberately not a button, because the welcome
screen is the public surface. Let go and you get the PIN screen.

The factory PIN is **1234**. **Change it the first time you log in** —
Admin → Settings → PIN. It takes 4 to 8 digits.

Five wrong PINs locks the panel for 30 seconds, doubling each time after that up
to 5 minutes. The count survives a restart, so closing the app does not clear it.
The panel also **locks itself after 5 minutes idle**; any mouse, key or scroll
activity on the admin screens resets that timer.

### Getting between the two surfaces

The app has two faces: the **kiosk**, which borrowers use and which anyone
standing at the tablet can see, and the **staff screens**, which show names,
phone numbers and who has what. Getting from the kiosk to a staff screen always
takes the hold gesture and the PIN. Nothing else crosses that line.

Coming back is one tap, and it should be the last thing you do at the desk:

| From | Control | Lands on |
| --- | --- | --- |
| Kiosk | press and hold the Rotman logo | PIN screen |
| PIN screen | Cancel | wherever you came from |
| PIN screen | LOGIN, or the keypad's Done key | admin panel |
| Admin panel | Back | the kiosk |
| Admin panel | Front desk | staff home |
| Staff home | Admin | PIN screen |
| Staff home | Kiosk | the kiosk |

**Tap Kiosk on the way out.** The staff home shows a borrower's name and phone
at the top of a checkout, so a tablet left on it after a shift is showing the
next person in the queue someone else's details. Escape works too on a machine
with a keyboard, and the app is never more than a restart away from the kiosk,
but the Kiosk button is the one that works on a tablet.

### Checkout — the main staff job

From the staff home screen, start a checkout and:

1. **Find the borrower** by phone number, or check out as a walk-in.
2. **Add items.** Type to search the catalog or tap from the list. Choosing an
   item that is already out is refused, by name.
3. **Confirm.** The screen shows what is being taken and by whom, then completes
   the checkout.

The confirmation screen deliberately shows only *this* loan's items, not the
borrower's entire history.

A checkout that is interrupted is kept as a draft, so a half-finished checkout
survives navigating away.

### Check-in and returns

Find the loan, then check the items back in. A borrower asking to return something
**is a request, not a completed return** — the loan stays open until a staff member
confirms the item is physically back. Those requests appear in the **Queue** tab.

The return screen offers three outcomes — **Returned OK**, **Damaged**, and
**Lost** — and the confirmation step repeats your choice back to you before
anything is written, so the record matches what you saw.

Two limits worth knowing: marking something **Damaged** or **Lost** records that on
the *loan*, but it does **not** change the item's own condition or take it out of
the catalog. If an item is lost or broken, also edit or archive it in the Items
tab, or it will be offered for checkout again.

### The admin panel — eight tabs

| Tab | What it is for |
|---|---|
| **Queue** | Returns waiting for staff confirmation, with a count badge. Confirm, mark returned-damaged, or mark not handed in. |
| **Currently Out** | Everything out right now. |
| **Overdue** | Loans past their due time. |
| **All Loans** | The complete history, searchable. |
| **Items** | The catalog: add, edit, and review duplicate names. |
| **People** | Borrowers, their contact details and history. |
| **Reports** | Totals and trends (below). |
| **Settings** | PIN, loan length, backups, theme, host details. |

**Duplicates** are surfaced, never merged silently. If two catalog entries share a
name, the Items tab shows a banner offering to review them. For each group you pick
which entry survives and confirm. If they are genuinely two different units, you
say so and nothing merges.

### Reports

Choose a period — **This week**, **Last 30 days**, **Last 90 days**, or **All
time** — and get eight summary figures, a loans-over-time chart, the busiest items
and people, and the inventory that was never touched in that period. **Export CSV**
writes one row per loan.

Two things worth knowing, both stated on screen: "This week" charts from the start
of the period through today, so on a Friday it draws five bars, not seven — a chart
cannot draw the future. The all-time chart is capped at 24 months of history
(the totals still cover everything).

Walk-in loans are counted separately rather than being folded into one imaginary
person who would top the busiest-borrower list.

### Settings

Loan length defaults to **8 hours**. Self-service kiosk checkouts are due back by
**5pm** by default — change the hour and the kiosk follows it.

**Theme** switches between Dark and Light, and it sticks — the choice is saved with
the other settings and applies from the next launch. Light is a real theme, not a
filter: the whole app is drawn from one set of colour tokens, so screens, dialogs,
reports and the on-screen keyboard all follow it. The magenta stays the Rotman
colour in both, deepened slightly on light where the pure brand value would not
meet the WCAG AA contrast floor as text.

---

## The kiosk

Put the app on a tablet and the borrower sees only the welcome screen. They can:

- **Borrow.** Enter a phone number, then a name, then pick items **from the
  catalog list** — free text is refused, so a borrower cannot invent an item. An
  item already out shows as "already out" and cannot be taken twice. They are told
  when it is due back.
- **Return.** Enter their phone number, see **only their own loans**, and say what
  they are handing back, plus how it is — "All good" or "Something's wrong" with a
  note.

A borrower's return is a request. Staff confirm it in the Queue tab.

There is **no route from the kiosk to the staff screens** — no link, and the staff
routes refuse a kiosk visitor. Staff entry from the kiosk is the logo hold.

### If the tablet is public

Launch the app with `--no-devtools`. That closes the developer tools, which would
otherwise be a way around the kiosk's PIN.

---

## Touch

Everything works with a finger. There is an on-screen keyboard for the numeric and
text fields, with a shift key, a layout toggle, and **press-and-hold on backspace to
clear the whole field**. It appears for fields that need typing and stays out of the
way of the panels underneath.

---

## Data, backup and restore

Everything lives in the **`data`** folder beside the app:

```
data/browser/     the database
data/backups/     backups, newest 30 kept
data/frontdesk.log
```

- **A backup is taken automatically at most once a day** — the first launch of the
  day writes one into `data/backups`, and the newest 30 are kept. Launching five
  times in an afternoon does not produce five backups. This requires nothing from
  staff. (An earlier draft of this file said "on every launch"; the throttle is
  `BACKUP_INTERVAL_MS` in `app.js`, 24 hours.)
- **Back up now** is also in the tray menu.
- **Export a copy** (Settings) writes a backup wherever you choose, using a real
  Save dialog.
- **Restore** either from the list of backups the app already has, or from a file.
- A backup is **verified when it is written** — the app reads it back and checks it.
- Restoring **does not change the PIN.** The device's own PIN wins over the one in
  the file, so an old backup cannot unlock a panel whose PIN has since changed.
- A backup that fails validation is **refused and nothing is written** — a bad
  import cannot leave the desk half-restored.
- Backups contain borrower names and phone numbers in readable form. Treat the
  backup folder as you would any list of names and numbers.

**To move the desk to another machine**, copy the whole app folder. That is the
whole migration.

---

## If something goes wrong

- **The app does not start.** It needs the Microsoft Edge WebView2 Runtime, which
  is present on nearly every Windows 10/11 machine. If it is missing the app offers
  to open the download page.
- **The window is blank or stops responding.** The app offers to reload it. Tray →
  Reload does the same.
- **Anything else.** Read `data/frontdesk.log` — the app writes what it was doing
  there, including errors reported by the page itself. Settings → Host shows the
  log's exact location.
- **Nobody knows the PIN.** Restoring a backup will not clear it. Whoever manages
  the machine can recover it from the database in `data/browser`; treat that as an
  admin action, not a desk one.

---

## For whoever maintains this

### Layout

```
web/      the app itself  (index.html, js/app.js, styles.css)
host/     the Windows wrapper (C#), the build script, and the exe's icon
tools/    test suites, a local dev server, the icon, and the packaging script
docs/     the code review, and the endpoint-agent / signing write-up
dist/     the built app  (this is what you copy to a desk)
release/  the zip that goes out  (built from dist, not edited by hand)
```

The `web` folder is the whole application. The host is a window, a tray icon, the
data folder and native file dialogs — it deliberately holds no app logic.

### Building

No SDK, no NuGet, nothing to install — it compiles with the C# compiler that ships
with Windows, against WebView2 assemblies vendored in `host/lib`.

```powershell
pwsh -File host/build.ps1                 # build into dist
pwsh -File host/build.ps1 -Sign <thumbprint>   # and sign it
pwsh -File host/fetch-deps.ps1            # re-download the WebView2 assemblies
pwsh -File tools/make-icon.ps1            # redraw host/frontdesk.ico
pwsh -File tools/package.ps1              # build the zip in release\
```

`build.ps1` **preserves `dist/data` across a rebuild** — without that, rebuilding
an update would delete the desk's records, backups and log.

`build.ps1` also prints the SHA-256 of the built exe and whether it is signed. See
`docs/EDR_AND_SIGNING.md` before rebuilding anything that has been allowlisted:
**this compiler cannot build reproducibly, so every rebuild is a different binary.**

### Packaging

```powershell
pwsh -File tools/package.ps1
```

Produces `release\Rotman-Front-Desk-<version>.zip`: a top-level `Rotman Front
Desk` folder holding the app, an empty `data` folder, `START HERE.txt` and
`For IT.txt`. It **verifies what it made by unpacking it again** — the exe has to
come back byte-for-byte with its version resource and icon intact, and `data` has
to be a clean install, because `dist` on this machine is a live install and
packaging it with a desk's records in it would ship borrower names and phone
numbers. It refuses to build the zip rather than let that happen.

**It is a zip on purpose, and the exe inside is a folder build.** The obvious
"installable file" — a self-extracting `.exe` from `iexpress` — is the exact
shape SentinelOne and CrowdStrike delete on execution, so it is the one
deliverable that cannot work on an arbitrary machine. There is no MSI installer
either, and that is also deliberate: the app writes its data beside itself, and
`Program Files` is not writable without elevation, so an install there would
break the one property the app depends on.

### The icon

`host/frontdesk.ico` is **generated, not edited** — `tools/make-icon.ps1` draws it
from source with `System.Drawing`, because this machine has no image tooling. It
writes seven sizes (16 to 256) as classic 32-bit DIBs rather than PNG-compressed
entries: PNG entries are smaller and Windows renders them, but `System.Drawing.Icon`
cannot parse them, and DIB works everywhere. The frames compress to almost nothing
in the zip, so the compatibility costs nothing that matters.

The mark is a magenta tile with "FD" — the same one `FrontDesk.cs:MakeIcon()`
draws for the tray. The Rotman wordmark in `index.html` (`window.__ROT_LOGO`) is
deliberately *not* the icon: it is a 190×69 horizontal wordmark drawn white for
the dark header, and it would be a few unreadable pixels inside a square tile.

### Tests

```powershell
node tools/test-all.cjs
```

Nine suites, 411 checks (10 host bridge, 11 toast stack, 8 screen router, 17
report aggregation, 34 keyboard touch, 79 browser UI, 54 kiosk, 153 layout at
real widths, 45 backup round trip). Four lift their section out of the real
`app.js` and run it in a sandbox (host bridge, toast stack, screen router,
report aggregation); five drive the real page in headless Edge (keyboard touch
through real touch input, the browser UI end to end, the kiosk surface, the
layout suite, and the backup round trip).

The layout suite is the odd one out in how it reports: it checks every screen
at every width and passes or fails each one by name — 153 checks across 375,
412, 768, 1024, 1280 and 1440 — so a failure names the screen and the width
rather than just a count. It also measures the PIN screen twice: once as it
opens, and once with the on-screen keypad up, because that is a different
layout and the one where a control is likeliest to end up underneath something.
It seeds the worst case the forms allow (36 items and
24 borrowers with names at the input limit, 70 loans split open, overdue and
returned) because an empty database makes any layout look clean, and it checks
that the seeded rows actually reached the DOM before it believes the result.
768 and 1024 are measured as touch devices and 1280 and 1440 as a mouse, which
is what they are, and which changes the layout: the stylesheet grows every
`.btn`, `.input` and `.tab` to 64–80px under `pointer: coarse`.

`node tools/serve.cjs` serves `web/` on `127.0.0.1:8791` for looking at it in a
normal browser. Nothing about the app needs it; it exists because IndexedDB needs a
real origin.

### Known quirks

- **Typed item, category and borrower names are sentence-cased** when stored:
  "HDMI dongle" becomes "Hdmi Dongle", and "McDonald" becomes "Mcdonald". This is
  pre-existing behaviour, it applies to what is stored rather than to how it is
  displayed, and every screen and report shows the stored form. It is pinned by a
  test so a change is visible. Fixing it means deciding whether to rewrite names
  that are already saved, which is a call for whoever owns the desk.
- **The `requests` object store is unused.** It has a schema and accessors, but
  nothing ever writes to it — the kiosk's return request lives on the loan itself.
  Left in place rather than migrated away, for no user-visible benefit either way.
- **Developer tools are on by default.** Fine for staff machines, which is why
  `--no-devtools` exists for kiosk installs.

The full review — what was wrong, what was fixed, and how each fix was verified —
is in `docs/CODE_REVIEW.md`.
