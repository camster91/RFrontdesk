# Front Desk — Code Review

Date: 2026-09-18
Subject: `frontdesk.html` (Rotman Front Desk, single-file build, Jun 10 2026)
Method: static read of the split source (`web/js/app.js`), three parallel reviewers
covering the data layer + flows, the interaction layer, and the admin/kiosk/backup
surfaces.

Line numbers refer to `web/js/app.js` (the extracted bundle) unless marked
`web/index.html` or `web/styles.css`. **They are as of the read that produced
this document and have since drifted** — Phases 1–5 all edited that file, so a
reference can be tens of lines out. Search by the function or class name quoted
beside it rather than jumping to the number.

**Status at 2026-09-21: Phases 1–8 complete.** Every finding below is fixed and
covered by `node tools/test-all.cjs` (**eight** suites, all green). The sections
that follow are kept as the record of what was wrong and why — they are no longer
a to-do list. See "Phase 7" for the last round of fixes, "Phase 8" for shipping
the app (icon, packaging, and what the package could have carried out with it),
and "Known, not fixed" for what was found and deliberately left alone. The
endpoint-agent question is in `docs/EDR_AND_SIGNING.md`.

## Verification status

Findings are marked:

- **[CONFIRMED]** — re-verified directly against the source while writing this doc.
- **[REVIEWED]** — evidenced by a specific line + quote by a reviewer, not
  independently re-run. High confidence, but treat the failure scenario as
  predicted rather than observed.

Every finding that was fixed has since been reproduced at runtime, either in
headless Chromium (`tools/test-ui.cjs`) or through the extracted-code suites.

---

## Phase 1 — fixes applied, and how each was verified

Applied to `web/js/app.js`, `web/index.html`, `web/styles.css`. Syntax-checked
with `node --check` after every batch, then exercised in Chromium over
`http://127.0.0.1:8777` with Playwright. Console is clean on load (0 errors).

| Finding | Fix | Verification |
|---|---|---|
| A1 `isOpen` string | New `isLoanOpen(loan)` helper next to `getOpenLoans`; 4 call sites moved to it. Comment records why `if (loan.isOpen)` is wrong. | Static — helper is the only predicate used now. |
| A2 double checkout | Guard moved inside the `createLoan` readwrite transaction, before any write (an async throw does not abort a transaction, so it must precede the writes). Throws `err.code = "ALREADY_OUT"` with holder name and loan id. | Static. Needs a two-device race to fully exercise. |
| A4 import | `validateImportRecord()` + pre-flight validation of every store before any mutation; the device's own PIN is preserved across a restore. | Static. |
| B merge/counters | `mergeBorrowers` re-points requests, guards self-merge, sums counters; `mergeItems` refuses when both copies are out and zeroes the victim's counter; `undoLoansAtomic` guards against a double-undo and recomputes `lastCheckedOutAt`/`lastSeenAt` from surviving records. | Static. |
| B dedup | `runDailyDedup` is now detection-only (`findDuplicateItems`), no longer auto-merging. | Static here; the resolving UI and its runtime verification are in "The Duplicates review UI" below. |
| E1 PIN lockout | PIN field is `maxlength="8" inputmode="numeric"` with a confirm field; save rejects anything not `^\d{4,8}$` or mismatched, and rejects an out-of-range loan duration. | Runtime: 8-char cap and `inputmode` read back off the live DOM. |
| E2 no lockout / no timeout | Failed-PIN count and lock expiry persist in settings; free attempts 5, then 30s doubling to a 5-minute cap. Admin panel locks after 5 minutes idle, and the timer is pushed back by real pointer/key/wheel activity on the admin screens. | Runtime: 7 wrong PINs produced 4/3/2/1 attempts left, then "Locked for 30s", then refusals of the *correct* PIN while locked; `pinFailures: 5` and a 29s-remaining `pinLockedUntil` read back out of IndexedDB. |
| E3 public staff login | Removed. Staff access is a 2-second press-and-hold on the welcome logo; Cancel returns to the kiosk rather than the staff home screen. | Runtime: bare `goToScreen("home")` from the kiosk was refused; hold → login; cancel → back to the kiosk. |
| G2 caret forced to end | Removed the focus/caret-restore branch in the key handler. | Runtime: `abc`, caret to 1, tap `d` → `adbc` with caret 2. |
| G3 Shift cancels itself | Root cause was the focus round-trip re-entering `show()`; keys no longer take focus. | Runtime: after tapping Shift the `a` key reads `A` and tapping it inserts uppercase. |
| G4 123/ABC toggle reverts | Same root cause, plus the removed redundant `focus()`. | Runtime: toggle → layout `alphanumeric`, digit key present, typing `1` inserted a digit. |
| G7 gap taps dismiss the keyboard | `mousedown` on the keyboard container is `preventDefault`ed, so no tap inside it moves focus off the input. | Runtime: no tap stole focus; input stayed focused through every key; a tap on the container padding left it visible. |
| G9 keyboard a11y | `inert` + `aria-hidden` toggled in `show()`/`hide()`. Not `visibility:hidden` — that is inherited and animated, and left the keys invisible for the whole 400ms slide. | Runtime: key cannot take focus while hidden, `inert` true, `aria-hidden="true"`; all cleared on show; keys visible immediately. |
| G9 touch targets | `.suggestion-chip` 56px min-height; `.toast-undo-btn` 48px × 88px. | Runtime: measured 116×56 and 88×48. |
| Item-search layout | `data-kbd="alpha"` → `alphanumeric`, so "key to room 1050" can be typed without toggling. | Runtime: `layout` reads `alphanumeric` on that input. |
| Service worker | Registration removed; existing registrations are unregistered. It pointed at a `sw.js` that does not exist, so every launch logged a 404. | Runtime: console clean; the 404 is gone. |

### Kiosk rebuild (section D) and the bugs it turned up

The kiosk is now a genuinely separate surface: a borrower sees only their own
loans, the catalog is a pick-list rather than free text, and a return is a
*request* that stays open until staff confirm the item is physically back.

| Finding | Fix | Verification |
|---|---|---|
| D2 phone number is the whole credential | A return no longer closes the loan. The borrower flags it (`requestLoanReturn`), the loan stays `open`, and only `confirmRequestedReturn` closes it. | Runtime: after the borrower reported the return, `isOpen` was still `"open"` with `returnRequestedAt` set. |
| D5 public writes to the catalog | The pick-list only offers catalog items; an unknown name is refused. | Runtime: typing "Squeaky Rubber Duck" produced "That item is not on the list" and the catalog stayed at 3 items. |
| D3 no way to see what is already out | Out items render disabled with "already out". | Runtime: the Clicker showed `is-unavailable`, `disabled: true`. |
| D7 condition always recorded "good" | The borrower is asked ("All good" / "Something's wrong" + a note), and the answer is carried on the request. | Runtime: the two-step panel stayed open, refused an empty note, and recorded `damaged` / "one key is bent". |
| — | Admin queue gained a "RETURNS TO CONFIRM" section with Confirm / Returned-damaged / Not handed in. | Runtime: all three buttons rendered and acted on the loan. |

Four further bugs surfaced while exercising that rebuild:

| Bug | Why it mattered | Fix | Verification |
|---|---|---|---|
| `_confirmPendingReturn` hardcoded `conditionIn: "good"` | It *overwrote the borrower's own report*: a borrower saying "one key is bent" was recorded as good condition with the complaint left in the notes. This was the exact failure the rebuild existed to prevent, reintroduced at the staff end. | The plain confirm now passes no condition and accepts the report; the button reads "Accept as reported (damaged)" when there is a report. | Runtime: `conditionIn` is now `damaged`, toast "Closed as returned, damaged". |
| `prompt()` never settled | It passed `onClick`/`primary` to `showDialog`, which reads a button's `value` and neither of those. The dialog appeared, then hung forever with no error — so "Not handed in" silently did nothing. | Rebuilt on the `value` contract and read the field back in a continuation. | Runtime: the reason was typed, OK resolved, toast fired, loan stayed open, note recorded as "Not returned: kept it, returns tomorrow". |
| `confirm2()` — dead, and would have hung | Same root cause, no callers. Left in place it was a loaded gun for the next person. | Deleted; `ui_exports.confirm` now points at `confirmDialog`. | Static. |
| native `confirm()` for cancel-request | Blocking, unstyled, indistinguishable from a browser alert, and impossible to test. | New `confirmDialog(message, {title, danger, confirmLabel, cancelLabel})`. | Runtime: "Keep it" left the request pending; "Cancel request" set status `cancelled` and removed the row. |
| `"just now ago"` | The many sites appending `" ago"` to `formatRelativeTime` produced "Handed over just now ago" on every fresh loan. | New `agoLabel(ms)` helper; all 7 sites moved to it. | Static — `grep` shows no bare `" ago"` appends left. |

One measurement trap worth recording: in the headless Playwright page **CSS
transitions never advance** (`getAnimations()` reports a `CSSTransition` stuck at
`currentTime: 0`), so a dialog carrying `.show` still computes `opacity: 0`. That
looks exactly like "every dialog is invisible" and is not a bug. Verify
visibility by class/DOM, never by a computed style a transition touches.

### Lower-severity (section H) — H1–H4, and what H1 exposed

| Finding | Fix | Verification |
|---|---|---|
| H1 schema mismatch silently wipes the database | `openDB` now salvages first: `_salvageStores` reads every surviving store into memory, the database is recreated, `_restoreSalvage` puts the records back into the stores the new schema still has. A `localStorage` report (`_recordRecoveryReport` / `takeRecoveryReport`) records how many records carried over and how many were dropped, and bootstrap toasts it with a "take a backup" prompt. | Runtime: staged a version-3 database holding items/borrowers/loans/settings but **no `requests`** store. Reload produced `stores: [borrowers, items, loans, requests, settings]` with the seeded "Survivor Item" intact — recovered, not wiped. |
| H2 `onversionchange` nulls without `close()` | The handler now calls `close()` before nulling, so another tab — or this app after a future schema bump — can actually upgrade or delete. | Static; verified by the H1 test's recreate path reaching completion rather than tripping `onblocked`. |
| H3 three unescaped DB values in `innerHTML` | `_makeClosedLoanRow` escapes `conditionIn` (its colour was already whitelisted); the loan-hours input coerces via `Number(settings.defaultLoanHours) || 8`; both `data-request-id` sites coerce via `Number(req.id)`. | Static. Worth doing because Import writes records verbatim (A4), so an edited backup was a real injection path. |
| H4 date filters are UTC-anchored | New `_localDayStart(value, dayOffset)` builds the boundary from local date parts, with `dayOffset: 1` for the inclusive upper bound so month ends and DST shifts fall out for free. Both call sites (`_renderAllLoansList`, `_exportAllLoansCsv`) moved to it. | Runtime: unit math under `TZ=America/Toronto` plus live filtering in the app. |
| **`getSettings` could revert the staff PIN** (exposed *by* the H1 work) | Settings live under the key `1`, but a rebuilt or older database can hold a real settings record under another key. `getSettings` treated that as "no settings" and wrote defaults — silently reverting the staff PIN, loan duration and theme while the user's actual settings sat unread in the same store. It now adopts an existing record (`existing.find(s => s && s.pin) \|\| existing[0]`), re-keys it to `id: 1`, and deletes the leftovers. | Runtime: with `{id: 'legacy', pin: '4321', defaultLoanHours: 12, theme: 'light'}` staged, the result was a single `{id: 1, pin: '4321', hours: 12, theme: 'light'}` and `<body>` actually carried the `light` class — the adopted record was read, not just stored. |

The recovery toast was confirmed separately by staging the `localStorage` marker
directly and reloading: the toast renders with the count and the "take a backup"
prompt, is `toast-error` when records were dropped, and is still present 1.5s
later.

Still open in Phase 1: nothing. The last item — the "Duplicates" review UI — is
covered below.

### The Duplicates review UI (closing out B dedup)

`runDailyDedup` was made detection-only because two physical units sharing a name
is a legitimate state. Detection without a way to resolve it was only half a fix:
the finding lived in a `console.warn` nobody reads. The other half is a review
surface, and the design constraint is that **nothing merges unless a human picks
the survivor and confirms**.

| Piece | Behaviour | Verification |
|---|---|---|
| Banner (Admin → Items) | "N names shared by more than one entry", with a Review button. Hidden when there is nothing to review. | Runtime: seeded two "HDMI Cable" + two "Clicker"; banner read "2 names shared by more than one entry · 4 entries share 2 names". |
| Review screen | Per group: each entry as a radio row (busiest preselected as a suggestion), then "Merge the other N into the selected one" / "These are different units". | Runtime: both groups rendered with members, counts, condition, and an "out right now" badge. |
| Merge is keeper-driven | The radio decides, not the suggestion. | Runtime: selected the *second* HDMI entry; result was `{3: n=10, archived:false}` and `{2: n=0, archived:true, mergedIntoId:3}` — the selected one survived and got `9+1`. |
| Loans move, nothing is deleted | Every loan re-points to the survivor, including open ones, and its `itemNameSnapshot` is rewritten. | Runtime: `loansByItem` went from `{2:1, 3:4}` to `{3:5}`; the open loan now reads `3:HDMI Cable`. |
| Both-out is refused *before* the click | `mergeItems` throws `BOTH_OPEN` when two entries are out, so the button is disabled up front with the reason, rather than throwing an error the user cannot act on. | Runtime: the Clicker group (both out) rendered `disabled: true` with "2 of these are checked out right now. Check one in first." |
| "Different units" is a first-class answer | Records the group in `settings.dedupAcknowledged`, keyed on the group's **exact membership**, not its name. | Runtime: dismissing wrote `{clicker: "4,5"}`, the toast fired, and the group left the list. |
| …and it comes back if the list changes | Adding a third "Clicker" made the signature `4,5,7` ≠ `4,5`, so the group reappeared as "CLICKER — 3 ENTRIES" despite the name being acknowledged. Keying on the name alone would have hidden it forever. | Runtime: verified exactly this. |
| Undo | A permanent "Duplicates" button (the banner disappears once everything is resolved, which would otherwise strand the screen) plus "Show the N reviewed groups again". | Runtime: reset cleared `dedupAcknowledged` to `{}` and the dismissed group returned. |

### Two bugs this surfaced

| Bug | Why it mattered | Fix | Verification |
|---|---|---|---|
| `onEnterHooks` was never populated | Dead since it was written. Returning from any detail screen (item, borrower) left the list underneath showing pre-edit state — an archived item still listed, an edited name unchanged, and now a resolved duplicate still counted. | `onEnterHooks.set("admin", () => _renderActiveTab())` in `bootstrap`. | Runtime: after merging, Back showed the victim as "(archived) · 0× out", the survivor at 10×, and the banner gone. |
| The review screen was a dead end | Once every group was resolved or dismissed the banner vanished, so the screen — and with it the only undo for a mistaken dismissal — became unreachable. | Added a permanent "Duplicates" button to the Items toolbar. | Runtime: reachable with zero pending groups; undo works from there. |

---

## A. Data loss / corruption

### A1. `isOpen` is a string, and `"closed"` is truthy — detail views are wrong **[CONFIRMED]**

The `isOpen` field holds `"open"` or `"closed"` (`app.js:366`, `app.js:397`), but
two call sites treat it as a boolean:

```js
// app.js:4599-4600  (item detail)
const openLoan = loans.find((l) => l.isOpen) || null;
const closed = loans.filter((l) => !l.isOpen);

// app.js:4677-4678  (borrower detail)
const openLoans = loans.filter((l) => l.isOpen);
const closed = loans.filter((l) => !l.isOpen);
```

Because `"closed"` is truthy, `closed` is always empty and `openLoans` is every
loan ever. Consequences:

- Item detail shows "CURRENTLY OUT" for an item sitting on the shelf (it picks the
  most recent loan, returned or not).
- Item detail STATS — average loan duration, damage count, lost count — are always
  zero, because they filter the always-empty `closed`.
- Borrower detail "CURRENTLY HELD (N)" counts every loan in history, and its TOP
  ITEMS list is always empty.

`getOpenLoans`, `getOpenLoanForItem` and `countLoansByStatus` compare against
`"open"` and are correct — which is why the inconsistency survived.

### A2. `createLoan` does not prevent double-checkout **[REVIEWED]**

The only guard lives in the UI, outside the transaction:

```js
// app.js:2597  (handleConfirm)
const open = await getOpenLoanForItem(item.id);
// ... app.js:2620
const loan = await createLoan({ ... });
```

`createLoan` (`app.js:329-386`) reads the item and writes the loan without checking
for an existing open loan, and there is no unique index on `loans.itemId`. The
check is a read transaction followed by a separate write transaction — a TOCTOU.
Three reachable paths:

1. Two windows (staff + kiosk, or two staff) both see "no open loan" and both write.
2. One window, double-clicked CHECK OUT — `confirmBtn.onclick` (`app.js:2835`) is
   not re-entrancy guarded, and the handler awaits a round-trip per item first.
3. The kiosk has no guard at all (`app.js:4136`) over an unfiltered item list
   (`app.js:4038`).

Result is two open loans for one physical item. `countLoansByStatus().out` and
`timesCheckedOut` double-count, and `getOpenLoanForItem`'s `.find()` shows only
one of the two borrowers — so the desk is told the wrong person has it.

### A3. `runDailyDedup` inflates `timesCheckedOut` forever **[REVIEWED]**

```js
// app.js:570  (mergeItems)
keep.timesCheckedOut = (keep.timesCheckedOut || 0) + (merge.timesCheckedOut || 0);
```

`mergeItems` archives the victim (`app.js:572-573`) but never zeroes its counter,
and `runDailyDedup` scans **all** items including archived ones
(`app.js:578 const all = await getAll("items")`) and re-merges every group of ≥2
every run. The victim's count is re-added on every run, compounding daily.

Two items named "HDMI Cable" with 5 and 3 check-outs: day 1 boots to 8, day 2 to
11, day 3 to 14. This count is displayed on item cards, in admin, in item detail,
and it orders the "frequent items" list on the checkout screen.

Same root cause also means the daily dedup silently destroys *intentional*
same-name duplicates — the second physical item is archived and vanishes from every
picker, and its loans are repointed to the first. The app explicitly supports
creating them (the "Add new anyway" path at `app.js:2559-2571`).

### A4. `importAll` replace-mode can commit a partial import, unvalidated **[REVIEWED]**

`importFromFile` validates only that `items`, `borrowers` and `loans` keys exist
(`app.js:3695`) — never their shape. `importAll` clears every store including
`settings` and writes back only what the file contains
(`const records = data[storeName] || []`, `app.js:685-702`).

- A file with the three arrays but no `settings` — an older export, or one whose
  settings record has an `id` other than 1 — leaves settings empty, and
  `getSettings()` recreates the factory record with `pin: "1234"` (`app.js:520`).
  Import therefore **resets the admin PIN to the default** as a side effect.
- `{"items":[],"borrowers":[],"loans":[]}` passes validation, so picking the wrong
  file destroys everything with no confirmation and no undo.
- No schema-version check and no per-record validation: an old-schema record is
  written verbatim.
- A *synchronous* throw on a structurally invalid record does not abort the
  transaction, so the DB can be left replaced-but-partial while the user is told
  the import failed.

### A5. `getAllLoans` silently truncates at 2,000 rows **[REVIEWED]**

```js
// app.js:482
return sorted.slice(offset, Math.min(offset + limit, hardCap));   // hardCap = 2000
```

The cap is applied after `Math.min(offset + limit, …)`, so callers passing large
limits get 2,000 rows and no indication. Affected:

- **CSV export** (`limit: 1e5`, `app.js:5074`) — writes only the newest 2,000 loans,
  while the list view tells the user "use export for full list". Silent data loss
  in a file the user trusts.
- **Date filtering** (`app.js:5047-5052`) — filters the newest 1,000 only, so an
  older range renders "No loans in this range" though the loans exist.
- **Settings totals** (`limit: 1e6`, `app.js:5254`) — reports at most 2,000.

Only the JSON backup (`exportAll`, `app.js:666`) reads everything.

### A6. `returnLoan` destroys the check-out note **[REVIEWED]**

```js
// app.js:399
loan.notes = notes || loan.notes;
```

A check-in note replaces rather than appends, so notes written at check-out are
lost. Kiosk attribution depends on the exact string `"kiosk self-checkout"`
(`app.js:4784`), so overwriting it also drops the loan out of the kiosk banner.

---

## B. Merge / counter correctness

### B1. `mergeItems` does not handle both items having open loans **[REVIEWED]**

Every referencing loan is repointed correctly (`app.js:564-570`), but nothing
detects that the survivor already has its own open loan. "HDMI Cable" #1 out to
Alice and #2 out to Bob, merged: item #1 now has two open loans, check-in lists
the same item twice, and the "already out to …" warning names only one of them.

### B2. `mergeBorrowers` orphans `requests.borrowerId` and drops counts **[REVIEWED]**

`app.js:313-318` repoints loans and deletes the victim, but `requests` is not in
the transaction scope (`["borrowers","loans"]`, `app.js:307-310`) and nothing
repoints `requests.borrowerId`. A pending request still carries the deleted id, so
"Fulfill (pick item)" calls `createLoan({borrowerId: req.borrowerId, …})`
(`app.js:4963`) and throws `Borrower N not found` — the request can only be
cancelled, never fulfilled.

Unlike `mergeItems`, it also does not sum `timesCheckedOut` into the survivor or
update `lastSeenAt`, so the merged borrower's counts are dropped even though their
loans were repointed. Loans themselves are preserved.

### B3. `undoLoansAtomic` can be fired twice, double-decrementing **[REVIEWED]**

The undo toast button calls `action.onClick()` then `dismissToast(toast)` in a
`finally` (`app.js:768-774`). `undo` is async and not awaited, and `dismissToast`
only fades the toast — it stays in the DOM for up to 600 ms with
`pointer-events: auto`, so it can be tapped twice. The second call re-runs the
counter decrement (`app.js:427`) for an already-deleted loan: one checkout can take
`timesCheckedOut` from 6 → 5 → 4.

Also: `errors` is created (`app.js:420`) and returned (`app.js:441-444`) but never
pushed to, so a partial undo silently reports success. Undo does not restore
`item.lastCheckedOutAt` / `borrower.lastSeenAt`, which keep pointing at a checkout
that no longer exists.

### B4. `upsertBorrower` is read-then-write across two transactions **[REVIEWED]**

`findBorrowerByPhone` and `put` each open their own transaction (`app.js:256`,
`app.js:282`), so two concurrent flows both see "no match" and both insert —
producing two borrower rows for one phone with the same name. Every later lookup
returns 2 and the desk gets the "Which person?" dialog listing two identical
entries.

---

## C. Checkout / check-in flow

### C1. Confirm screen shows the borrower's *entire* history as "already out" **[REVIEWED]**

```js
// app.js:3170
const openLoans = await getLoansForBorrower(this.state.borrower.id);
```

`getLoansForBorrower` returns **all** loans, open and returned (`app.js:462-466`).
The variable is misnamed and never filtered on `isOpen`, yet the UI renders
"Already has ${otherLoans.length} item(s) out:" with an out-duration and an overdue
flag per row (`app.js:3176-3187`).

A borrower with 30 historical loans is shown "Already has 30 items out:" listing
long-returned items, some flagged overdue. At the moment of confirming a checkout
the desk is shown flatly false information, and a real current-loan warning is lost
in the noise. (`app.js:4348` does this correctly — it filters `getOpenLoans()`.)

### C2. Draft resume ignores the saved `borrowerId` **[REVIEWED]**

The draft saves `borrowerId` (`app.js:3215`) but restore never reads it — it
re-derives the borrower from the phone instead (`app.js:2326`).

- Phone shared by two people: desk picks person A, the tab reloads, "Resume
  checkout?" → `matches.length === 2` → borrower stays `null`. The loan is created
  with `borrowerId: null` and no `customName`, so both snapshots compute to `""`
  (`app.js:361-362`). It renders as "(unknown)" with no phone at check-in, person
  A's history never records it, and their counter is never incremented.
- Inverse: a walk-in draft resumes against a phone that has exactly one borrower
  and is silently attached to that person's record.

### C3. DOM listeners accumulate, creating duplicate catalog items **[REVIEWED]**

`new CheckoutFlow().start()` runs on every `frontdesk:checkout-start`
(`app.js:6002`), so `this._wireOnce` is per-instance and does not prevent
re-wiring. `.onclick =` assignments are safe, but these use `addEventListener` and
are never removed: phone-input Enter (`app.js:2754`), name-input Enter
(`app.js:2764`), items-search `input` (`app.js:2773`) and items-search Enter
(`app.js:2777-2818`).

From the second checkout onward, pressing Enter on a name that is not in the
catalog runs N handlers concurrently; because they are all at the same await depth,
all N reads miss before any write lands — **N duplicate catalog items are created**
(`app.js:2806`, `app.js:2544`). They are then collapsed by the buggy dedup of A3.

The name-input *suggestions* listener is guarded by `dataset.suggestionsWired`
(`app.js:2946`) — evidence the accumulation elsewhere is unintentional.

---

## D. Kiosk (untrusted public surface)

The kiosk is reachable from the public welcome screen and is meant to be used by
borrowers. It is not a mode — it is one screen in the same document, with no guard
on navigation targets. The host shell should enforce this properly; until then:

### D1. One tap from the kiosk to the unrestricted staff screens **[REVIEWED]**

`web/index.html:351`: `<button class="btn btn-ghost" onclick="app.goToScreen('home')">Cancel</button>`

The admin-login screen's Cancel button navigates straight to `screen-home`. The
kiosk welcome footer links to that login screen, and its only other control is
Cancel. So: public user taps "Staff: Admin Login" → "Cancel" → staff home. From
there CHECK OUT opens the real flow, typing a name prints that person's name and
phone (`app.js:2450`) and can rewrite their phone (`app.js:2465`).

`app.js:6052-6057` also binds Ctrl+Shift+A globally to the login screen from any
kiosk screen. There is no route back to the kiosk, so recovery needs a reload.

### D2. A phone number is the entire kiosk credential **[REVIEWED]**

```js
// app.js:4229
const matches = await findBorrowerByPhone(raw);
```

A 10-digit number typed into the kiosk return flow shows that person's name, phone
and every open loan, and the rows are tappable → `returnLoan`. Anyone who knows or
guesses a number can enumerate what that person has out and clear the loans while
the equipment is physically gone — recorded as `conditionIn: "good"`
(`app.js:4468-4470`), so damage is never captured. It also functions as an oracle
for whether a given number is a known borrower.

### D3. Kiosk can check out an item that is already out **[REVIEWED]**

`app.js:4125-4143` calls `createLoan` with no open-loan guard, over
`listItems({includeArchived:false})` with no availability filter (`app.js:4038`).
The staff flow refuses with "already out to X" (`app.js:2597-2616`); the kiosk does
not. See A2 for the consequence.

### D4. "Skip — no name" always fails **[REVIEWED]**

The skip button sets `isWalkIn: true` (`app.js:3909-3924`) and no kiosk caller ever
passes `customName`, while `createLoan` throws without one
(`app.js:352-353`). Every "Skip — no name" → TAKE IT ends in
`Failed: Walk-in borrowers require a customName for the loan`. A dead end on a
primary kiosk flow.

### D5. The public can write arbitrary rows into the item catalog **[REVIEWED]**

```js
// app.js:4118
const newItem = await createItem({ name: sentenceCase(query), category: "Uncategorized" });
```

Any typed string that doesn't match creates a permanent catalog row — no
confirmation, no cap, no rate limit. The Items tab fills with junk and the catalog
stops being trustworthy.

### D6. Ambiguous phone numbers mis-attribute loans **[REVIEWED]**

`app.js:3995-4000` takes `matches[0]` when several borrowers share a number, while
the return flow asks the user to pick (`app.js:4381-4415`). Shared family or office
numbers get loans booked against whichever record sorts first.

### D7. Kiosk returns never record condition **[REVIEWED]**

`app.js:4468-4470` hardcodes `conditionIn: "good"` with no prompt, so
"Damaged"/"Lost" can never be recorded for a kiosk return even though item detail
counts them (`app.js:4603-4604`).

---

## E. Admin / auth

### E1. PIN change can lock the panel out permanently **[REVIEWED]**

The settings field has no `maxlength`, no confirmation field and no length
validation (`web/index.html:348` vs `app.js:5301-5310`), while the login field caps
at 8 characters (`web/index.html:348`). A 9-character PIN can never match at
`app.js:4549`, and there is no in-app recovery. A PIN stored with a stray space is
equally unmatchable — the input is trimmed, the stored value is not.

### E2. No session timeout, no lockout, plaintext PIN **[REVIEWED]**

- No idle/lock/logout logic exists. `showAdmin()` (`app.js:4568-4575`) navigates to
  the panel and nothing leaves it except Back. Staff who unlock over lunch leave
  every name, phone, note and loan history readable in a public area.
- `app.js:4549` compares the PIN with no rate limit against the 4-digit default
  (`app.js:520`), nothing forces a change at first run, and `_wipeData` resets it
  to `1234` (`app.js:5837`).
- The PIN is stored unencrypted (`app.js:5309`) and shipped in every backup.

### E3. Backups contain the admin PIN and all PII in cleartext **[REVIEWED]**

`exportAll` (`app.js:666-683`) includes the `settings` record, so `pin: "1234"` is
written into `frontdesk-backup-YYYY-MM-DD.json` — the file staff are told to keep
and typically email to themselves or drop on a shared drive.

### E4. Scale: the admin panel is N+1 over IndexedDB with no pagination **[REVIEWED]**

`for (const loan of open) panel.appendChild(await _makeOpenLoanRow(loan))`
(`app.js:4985-5013`) — each row costs two sequential transactions plus a node.
1,000 items out means ~2,000 serialized round-trips and 1,000 nodes before anything
appears, with no spinner. Both Currently Out and Overdue re-render wholesale after
a single row action (`app.js:5400`, `app.js:5502`). Items and People search has no
debounce (`app.js:5146`, `app.js:5206`) — every keystroke re-reads and rebuilds
every row, while the staff flows do debounce (`app.js:2774`).

### E5. Call/Text do nothing on the target hardware **[REVIEWED]**

`telUri`/`smsUri` build correct URIs (`app.js:2186-2198`), but Windows has no
default `tel:`/`sms:` handler. On the Surface, tapping Call/Text raises "You'll need
a new app to open this tel link" (or an app picker if Phone Link is installed) —
it never places a call or opens a message. Only Copy works (`app.js:5467-5486`), so
the primary chase-an-overdue-borrower affordance is inert while staff believe they
called. The host shell can fix this properly.

Related: `_makeOverdueRow` guards only `if (phone)` (`app.js:5449`), so a truthy
non-10-digit phone yields `href=""` — an empty-href anchor resolves to the current
document, so tapping Call reloads the app and discards screen state.

### E6. The Queue tab is dead code **[REVIEWED]**

Nothing writes to the `requests` store — only the schema (`app.js:85-98`) and the
readers/fulfill/cancel (`app.js:613-665`). `renderQueue` is the default tab
(`app.js:5917`), so "Queue is empty. No pending borrower requests." is permanent
and `_fulfillRequestFlow`/`cancelRequest` are unreachable.

---

## F. Backup

### F1. `autoBackup` is a page-load check, not a daily timer **[REVIEWED]**

```js
// app.js:3632
if (now - last < BACKUP_INTERVAL_MS && last > 0) return { ok: true, triggered: false, reason: "recent" };
```

No `setInterval` — the 24h gate is evaluated only in `bootstrap()`, called once
(`app.js:6024`). A tablet left open for a month backs up exactly once, ever. The
service-worker PWA case makes "left open for weeks" the normal case.

Worse, `triggerDownload` is fire-and-forget and cannot report failure, yet
`lastBackupAt` is stamped and the user is told "Backup saved" regardless. Chromium
silently blocks automatic downloads, so a device can go indefinitely with a
`lastBackupAt` documenting backups that never landed.

### F2. The File System Access backup path cannot work **[REVIEWED]**

`showDirectoryPicker()` requires transient user activation, but `autoBackup()` runs
from `bootstrap()` with none — so it always throws SecurityError, swallowed by the
empty `catch` at `app.js:3654-3655`, silently falling through to a download.

The handle is never persisted either: `saveHandle` stores a boolean flag instead of
the handle (which is structured-cloneable), while `loadHandle()` returns only the
session variable (`app.js:3758-3813`). The `queryPermission`/`requestPermission`
re-grant path at `app.js:3762-3769` is unreachable dead code. There is no
persistent backup folder.

### F3. Backup filenames use UTC dates **[REVIEWED]**

`dateStamp()` uses `toISOString().slice(0,10)` (`app.js:3732-3734`), so backups
after 8pm Toronto are named with tomorrow's date, and two backups in that window
overwrite each other in a directory. The filename is otherwise safe — only
`[0-9-]` from the ISO date reaches it, no user input.

---

## G. Interaction layer

The remaining open items in this section — G6, G8, G9 (dialog focus) and G11 —
were all fixed after the table in "Phase 1": the history stack no longer re-pushes
what Back is leaving (`_navigatingBack`), identical toasts collapse to one with a
cap of three, the dialog traps and restores focus, and the kiosk phone field's
backspace reaches past its own formatting characters. All four now have checks in
`tools/test-router.cjs` and `tools/test-toast.cjs`.

### G1. A new dialog is wiped by the previous dialog's cleanup timer **[REVIEWED]**

```js
// app.js:886  (inside close(), armed at 895-898)
const cleanup = () => { container.innerHTML = ""; container.classList.add("hidden"); ... };
```

`cleanup` blanks the container unconditionally 400 ms after a close, without
checking whether a newer dialog has opened in the meantime. `showDialog` resolves
its promise in the button's `onClick` (`app.js:1201-1203`), so the awaiting flow
continues in a microtask and opens the next dialog immediately.

Reachable at `app.js:5655 → 5661` (`mergeBorrowerFlow`), nothing awaited between:

```js
const other = await showDialog({ title: 'Merge "..." with…' });   // 5655
if (!other) return;
const confirmChoice = await showDialog({ title: "Confirm merge" }); // 5661
```

Admin → borrower → Merge → pick the other borrower: the "Confirm merge" dialog
appears then vanishes ~0.4 s later. The merge silently never runs, and the function
is stuck forever awaiting a promise that can no longer settle. The stale dialog's
`keydown` listener also survives, so a later Escape can blank a different dialog.

### G2. Every on-screen key press moves the caret to the end **[REVIEWED]**

```js
// app.js:1794-1795
const len = (this.targetInput.value || "").length;
this.targetInput.setSelectionRange(len, len);
```

Tapping a key button focuses it (Chromium on Windows focuses buttons on tap; there
is no `preventDefault` on `mousedown` and the keys have no `tabindex="-1"`), which
blurs the input. The character is then inserted at the correct caret position, but
this restore branch forces the selection to the end.

Typing "Key to Room 1050", then tapping mid-string to fix "1050": the character is
inserted correctly but the caret jumps to the end, so every subsequent tap appends.
The same branch also re-enters `show()` via `focusin` (`app.js:1707-1716`), which
rebuilds all ~40 key elements on **every keystroke** — visible lag on a tablet.

### G3. The Shift key never produces an uppercase letter **[REVIEWED]**

`app.js:1636` sets `this.isShifted = false`, reached from the restore branch at
`app.js:1788-1793`. After tapping Shift, the keys re-render uppercase, then the
restore branch calls `targetInput.focus()` → `focusin` → `show()` → `isShifted =
false` and a full re-render. Shift is cancelled a frame later.

### G4. The 123/ABC layout-toggle key does nothing **[REVIEWED]**

`app.js:1885-1887` sets the layout and re-renders, then immediately calls
`targetInput.focus()`, which fires `focusin` → `show()` → the layout is
**re-inferred from the input** (`_inferLayout`, `app.js:1684-1704`), and
`data-kbd="alpha"` on the search input always wins. The digits row appears for one
frame and reverts. Tapping "123" to type "1050" on item search does not work.

### G5. Escape navigates away instead of closing the open dialog **[REVIEWED]**

The global handler (`app.js:6052-6069`) is registered at bootstrap, so it runs
before the per-dialog handler registered later, and never checks whether a dialog
is open. On the checkout screen with the "Which person?" dialog open, pressing Esc
throws the user to Home mid-checkout (the draft survives and resumes later), and
the `await showDialog(...)` resolves `undefined` so the step silently aborts.

Related: the promise adapter at `app.js:1197-1209` hardcodes `dismissible: true`
and drops each button's `dismiss` flag, so a dialog can never be made
non-dismissible, and a backdrop tap resolves `undefined` — which `handleName`
(`app.js:2489`) treats as "create a new borrower".

### G6. Router: unbounded `historyStack`, and `goBack` re-pushes **[REVIEWED]**

`goBack` pops then calls `goToScreen`, which pushes the current screen back on
(`app.js:2062-2075`), so Home → Checkout → Back → Checkout → Back accumulates
duplicates for the life of the session. Back means "the last screen I happened to
visit", not a parent. `onEnterHooks` (`app.js:2025`, `app.js:2045`) is dead code —
nothing ever registers a hook.

### G7. Tapping between keys dismisses the keyboard **[REVIEWED]**

`app.js:1717-1724`: a tap on a non-focusable element (an 8px flex gap between key
rows, or the 16px keyboard padding) moves focus to `body`, so 150 ms later the
keyboard slides away mid-entry. Taps on key buttons are safe.

### G8. Repeated taps stack duplicate toasts **[REVIEWED]**

No dedup or cap (`app.js:777`). Tapping CONTINUE five times on a bad phone number
stacks five identical 400px-wide toasts over the top-centre of the form for 3s.
Sticky toasts (`duration: 0`, e.g. `app.js:6033`) can never be removed —
`hideToast` is exported but never called.

### G9. Dialog/keyboard accessibility **[REVIEWED]**

- `role="dialog"`/`aria-modal="true"` are set, but focus is never moved into the
  dialog, never trapped, and never restored. The previously focused input keeps DOM
  focus behind the backdrop, so keystrokes go into the screen behind it.
- `#keyboard` when hidden is only moved off-screen (`styles.css:1766`) — no
  `aria-hidden`, `inert` or `display:none` — so ~40 invisible buttons stay in the
  tab order and the accessibility tree. Its `hidden` class in the initial markup is
  a no-op (there is no generic `.hidden { display:none }` rule, only
  `.screen.hidden`).
- Touch targets below the app's own 64px standard: `.suggestion-chip`
  (`styles.css:1868-1879`) and `.toast-undo-btn` (`styles.css:1939-1950`) are
  ~33-37px. The Undo button is the critical 5-second-window affordance on a touch
  kiosk.

### G10. `confirm2()` and `prompt()` can never resolve **[REVIEWED]**

`app.js:924-943` and `app.js:944-977` pass the *impl* button contract (`onClick`,
`primary`, `danger`) into the *promise* adapter `showDialog`, which discards
`onClick` and resolves from `b.value` (undefined for these buttons). Their
`resolve()` handlers never run, so `await confirm2(...)` hangs forever and the
primary/danger styling is lost. Both are exported and called from nowhere today —
latent, but exactly what the next feature will reach for.

### G11. Kiosk phone auto-format swallows backspaces **[REVIEWED]**

`app.js:3956-3964`: `if (e.target.value !== formatted) e.target.value = formatted;`
— assigning `.value` resets the caret to the end, and the reformat re-inserts any
formatting character the user just deleted. This exists only on the kiosk
return-phone input; the staff checkout field has no live formatter and formats once
on submit.

---

## H. Lower-severity

> H1–H4 are **fixed and verified** — see "Lower-severity (section H) — H1–H4" in
> Phase 1 above for the fixes, the verification, and the `getSettings` PIN-revert
> bug the H1 salvage work exposed. H5 was fixed last. The entries below are the
> original findings.

- **H1 [REVIEWED]** Schema-mismatch recovery deletes the entire database with only
  a console warning (`app.js:108-116`) — no prompt, no export-first, no restore
  path. Latent (no reachable mismatch in this build) but unconditional, so any
  future schema drift wipes everything silently.
- **H2 [REVIEWED]** `_db.onversionchange` nulls the reference without calling
  `close()` (`app.js:119-121`), so the connection stays open and blocks the very
  `deleteDatabase`/upgrade the recovery path depends on.
- **H3 [REVIEWED]** Three unescaped DB values in `innerHTML`: `app.js:5524`
  (`loan.conditionIn` into a style attribute), `app.js:5265`
  (`settings.defaultLoanHours` into a value attribute) and `app.js:4857`
  (`req.id` into a data attribute). In-app writers only produce safe values, so
  this is not a normal stored-XSS path — but Import writes records verbatim with no
  validation (A4), so a shared or edited backup can inject markup. Every other
  render path checked does escape, including attributes.
- **H4 [REVIEWED]** Date filters are UTC-anchored (`app.js:5047-5048`,
  `app.js:5072-5073`), so a Toronto filter of Sep 1 includes loans from Aug 31 8pm
  onward.
- **H5 [FIXED]** Clipboard fallback reports success it cannot know
  (`app.js:5467-5486`) — the `execCommand` boolean return is discarded and "Copied"
  is toasted either way. Now the return value decides the toast, and the scratch
  textarea is moved off-screen so appending it cannot scroll the list.

## I. Verified correct (checked, not bugs)

- Counters are written inside the loan transaction in `createLoan`
  (`app.js:372-383`) and `undoLoansAtomic` (`app.js:412-445`).
- `returnLoan` is idempotent — it re-reads the loan inside the write transaction
  and throws on an already-returned loan (`app.js:395`). Double-return is safe.
- `getOpenLoans`, `getOverdueLoans`, `countLoansByStatus` return what they claim.
- Migrations are idempotent at `DB_VERSION = 3`; every `createObjectStore` is
  inside an `oldVersion` guard.
- A successful multi-item checkout resets state and clears the draft, and creates
  exactly one loan per selected item (duplicates prevented at `app.js:2518`).
- Fuzzy search handles empty/short/unicode input without crashing, builds no regex
  from user input, and ranks sensibly (exact > prefix > word-boundary > substring >
  fuzzy) with a stable sort.
- Keyboard listeners do not leak across screens (document-level, installed once
  behind `this.bound`); toasts append into a column so they cannot overwrite each
  other; `closeDialog()` is guarded against a missing dialog.
- `exportAll` captures all five stores plus `exportedAt` and `schemaVersion`. Its
  gap is that import never uses the version — see A4.

## J. Unverified — all three followed up

These were the items this review could not settle without the tablet. Each was
then chased down; the outcome is recorded here rather than deleted, so the
review keeps saying what was open at the time and what closed it.

- **Long-press backspace to clear** — the suspicion was right, and it was worse
  than "likely". Measured in headless Chromium with real touch input: on the
  compatibility path the whole press cleared exactly one character and the hold
  cleared nothing at all. The timer was armed in `mousedown` and cancelled by the
  `mouseup` that a touchscreen fires microseconds later at `touchend`. Fixed and
  covered — see Phase 5.
- **G2/G3/G4 depend on the key button taking focus on tap** — resolved in
  Phase 1, where all three were fixed and runtime-verified. The focus dependency
  turned out not to be the cause.
- **A2's double-checkout and C3's duplicate items** — both resolved. C3 by
  reusing one `__checkoutFlow` instance (`app.js:8269`) instead of building a new
  one per visit; A2's guard sits inside the `createLoan` transaction, so the
  check and the write cannot be separated by a second tap.

---

## Phase 4 — reporting, and fewer taps on the way out

Added last, against the two remaining priorities ("reporting & oversight" and
"faster checkout").

### The checkout pick-list was never on screen

`web/index.html` carried `item-sections` inside a container with an inline
`style="display: none;"`, and **no code path anywhere cleared it**. The app
faithfully built a card for every catalog item into `.frequent-items` and
`.all-items` on every visit to the item step, and a borrower saw an empty text
box. Quick-picks for the eight most-borrowed items existed, populated, and were
unreachable.

Confirmed before the change, in headless Chromium, with four items seeded through
the app's own "add to catalog" affordance:

```
sectionsInlineStyle: "display: none;"
sectionsVisible:     false
allCards:            4        <- built, and invisible
```

After: `sectionsDisplay: "block"`, `sectionsVisible: true`, search box above the
list. The same probe was then run inside the shipped WebView2 build (Edge
153.0.4234.32), which reported `display=block onScreen=true searchAbove=true`.

Alongside it: an empty `SUGGESTIONS` heading now hides itself rather than sitting
there blank on a first run, an empty catalog says so instead of showing an empty
grid, and the recent-borrower row went from three entries to six.

### Reports tab

A seventh tab (`web/index.html`, `renderReports` in `web/js/app.js`): a period
switch (This week / Last 30 days / Last 90 days / All time, remembered in
`localStorage`), eight summary tiles, a loans-by-day or by-month chart, busiest
items and people, and the inventory nothing touched in the period. Export CSV
writes one row per loan in the period.

The aggregation (`buildReport`, `reportToCsv`) is deliberately pure — rows in, a
plain object out — so `tools/test-report.cjs` exercises it with a pinned clock and
no browser. That suite is where the edge cases got settled:

- **"This week" charts five bars on a Friday, not seven.** Buckets run from the
  period start through today; a chart cannot draw the future.
- **Anonymous walk-ins are not people.** Every walk-in loan carries the literal
  phone snapshot `"walk-in"`, so keying people on the phone alone folded the whole
  desk's walk-in traffic into one imaginary person who would then top the busiest
  list. They are now counted as `totals.walkIns` and reported separately; a
  walk-in who *gives* a number is still a real, countable person.
- **Deleted items keep their history.** Ranking is by `itemId` with the snapshot
  name as fallback, so an item removed from the catalog still appears in past
  reports.
- **Renames do not split a row.** Names come from the live catalog, grouping from
  the id.
- **The "All time" chart is capped at 24 months** and starts from the oldest loan
  in range, so a desk with no history does not get a chart running from 1970. The
  totals still cover everything; the tab says so on screen rather than leaving the
  difference to be discovered.

### Test harness

`node tools/test-all.cjs` runs the suites: host bridge, toast stack, screen
router, report aggregation, keyboard touch, browser UI, kiosk — and, since
Phase 6, backup round trip (eight in total). The first four lift their section
out of the real `app.js` by marker rather than copying it, so they cannot drift
from what ships. The browser suites drive the real page in headless Edge —
`test-ui.cjs` end to end through login, Settings, Reports, a complete checkout
and the report afterwards; `test-touch.cjs` by real touch input through CDP;
`test-kiosk.cjs` through the whole public surface; `test-restore.cjs` through
export and import.

## Phase 5 — closing out the review's own open items

Section J, a stray byte, and the two surfaces that had no tests at all: the
on-screen keyboard under a finger, and the public kiosk.

### An invisible shield that ate every tap

The most serious find of the whole review, and it was found by accident — a
kiosk test failed with `elementFromPoint` returning `dialog-container show
hidden` where the app's logo should have been.

`showDialog` fades the dialog in by dropping `hidden` immediately and adding
`show` on the **next animation frame** — the deferral is load-bearing, since
adding both in one task paints them together and the fade never runs. That
callback had no `closed` guard, unlike the focus timer thirty lines below it:

```js
container.classList.remove("hidden");
requestAnimationFrame(() => container.classList.add("show"));   // no guard
setTimeout(() => {
  if (closed) return;                                           // guarded
```

So if `close()` landed before that frame — an Escape, a backdrop tap, or any
programmatic close within ~16 ms of opening, and *arbitrarily long* whenever the
browser throttles frames because the window is minimised — the sequence was:

1. `close()` removes `show` (not there yet — no-op) and arms the 400 ms teardown.
2. Teardown empties the container and adds `hidden`.
3. The late frame fires and adds `show` back.

`.dialog-container` overrides `.hidden` on that element (equal specificity,
declared later — deliberate, see the note at `styles.css:118`), so the leftover
`show` wins and the container becomes a full-screen `position: fixed` overlay
with `opacity: 1` and **`pointer-events: auto`** around *nothing at all*. The app
looks completely normal and ignores every tap until the next dialog happens to
open. On a kiosk tablet that reads as "the machine froze".

The fix is the missing guard, plus a belt-and-braces `remove("show")` in the
teardown so no path can leave a container it has finished with in the blocking
state. Pinned by six checks in `tools/test-ui.cjs` that hold frames back with a
stubbed `requestAnimationFrame`, close the dialog, then deliver the outstanding
frame — every callback is still run afterwards, so the app's own code is what is
under test. With the guard removed the checks fail and report the exact state
seen in the wild:

```
FAIL  and leaves nothing covering the screen
  -> {"cls":"dialog-container hidden show","show":true,
      "pointerEvents":"auto","blocks":true,"atPoint":"dialog-container hidden show"}
FAIL  and the app still responds to a click afterwards
```

There is now a second, independent lock. The shield needed two mistakes: the
stray `show` *and* `.hidden` being a no-op on that element. `.dialog-container`
sets `pointer-events`/`opacity` itself and never consulted `hidden` at all, so
the class read as if it hid the thing and did nothing. A
`.dialog-container.hidden { opacity: 0; pointer-events: none }` rule declared
after `.show` breaks the specificity tie in `hidden`'s favour, making the name
honest.

That lock was verified the same way — by removing the JS guard again and leaving
the CSS in place:

```
FAIL  a frame delivered after close does not re-show the dialog
  -> {"cls":"dialog-container hidden show","show":true,
      "pointerEvents":"none","blocks":false,"atPoint":"tab-panel active"}
  ok  and the app still responds to a click afterwards
```

The stray class still lands, so the guard is the real fix — but the failure mode
degrades from "the kiosk is frozen" to "a class nobody looks at".

### The same bug, three more times

The shield was not a one-off: it is a *shape*. `app.js` defers work to the next
frame in exactly four places, and every one of them is "reveal a thing that was
just mounted" — the pattern that breaks when the thing is unmounted first. All
four were swept:

| Site | What a stale frame did | Guard |
|---|---|---|
| `showDialog` | Re-showed an emptied dialog container — the full-screen shield above. | `closed` flag; teardown also drops `show`. **Proven**, six checks. |
| `Keyboard.show` | Slid the keyboard back up over a screen that had put it away, **already `inert`** — on screen and dead to every tap. | `_showToken`, bumped by `hide()` and by each `show()`. **Proven**, seven checks. |
| `showToast` | Made a toast the app had already dropped visible again; a `.toast` is `pointer-events: auto`, so it also swallowed a tap where it sat. | `_liveToasts` membership — the registry already meant "still a toast". **Proven**, four checks. |
| `prompt` input focus | Would pull focus into a dialog on its way out, and `focusin` is what opens the keyboard. | `input.isConnected`. **Defensive** — unreproduced, and the dialog's own guarded 30 ms timer is the focus that matters. |

Each of the first three was reproduced by holding frames with a stubbed
`requestAnimationFrame`, performing the open and the close, then delivering the
outstanding frame — so the app's real code runs and only the *timing* is
controlled. Each check was then shown to fail with its guard removed. The
keyboard's failure is the most legible of the three:

```
FAIL  a frame delivered after hide() does not slide the keyboard back up
  -> {"visible":true,"hidden":false,"inert":true}
```

Visible and inert at once is precisely the dead-keyboard state.

The reachability is worth stating honestly: for the keyboard and the toast the
open and the close are naturally a few hundred milliseconds apart (a 150 ms
focusout, a 600 ms slide-out), so the ordinary case is safe. What makes them
real is that a frame is not guaranteed to arrive in 16 ms — a main thread busy
writing to IndexedDB or rendering a report delays it past the close, and the
dialog's own case was caught in the wild.

### A raw NUL byte in the bundle

`app.js` carried a literal `0x00` inside a toast-dedupe key, so `grep` reported
the file as binary and tooling that treats the bundle as text would choke. Now
the six-character escape it should always have been. Worth recording *how* it
went wrong twice: the first fix silently did nothing, because the shell collapses
backslashes and `"\\u0000"` arrived as a single-backslash escape, which JavaScript then read as the NUL character itself, so the replacement was
byte-identical to the byte it was replacing. Verified by length and NUL count
(305344 → 305349 bytes, 1 → 0 NULs), not by eyeballing the file.

### Press-and-hold on a tablet

Section J's suspicion confirmed and fixed properly. The timer now arms on
`pointerdown` — issued once, when the finger lands — and is cancelled by
`pointerup`/`pointercancel`/`pointerleave`. Pointer events rather than mouse or
touch because they are exactly the abstraction for "the finger is down", and the
browser's touch-to-mouse synthesis is the thing that was broken.

Two follow-on changes fell out of testing it for real:

- **The context menu.** Press-and-hold is right-click on Windows touch, so
  holding to clear popped the menu over the keyboard at the moment the clear
  fired. Suppressed for the keyboard only.
- **`touch-action: manipulation`** on `.kbd`. A key is not a scroll surface; the
  browser could claim a drag starting on a keycap as a pan and fire
  `pointercancel` mid-hold. `manipulation` rather than `none` because it still
  permits pinch-zoom, and it also drops the double-tap-zoom delay, which matters
  on a keyboard people tap quickly.

### Two suites where there were none

`tools/test-touch.cjs` (20 checks) drives the on-screen keyboard by **real**
input — CDP `Input.dispatchTouchEvent` and `page.mouse`, never synthetic JS
events, because the behaviour under test *is* the browser's touch translation. A
synthetic `mousedown` would pass whether or not the gesture works.

`tools/test-kiosk.cjs` (44 checks) covers the public surface end to end:
containment (the staff routes refuse a kiosk visitor, and no visible link leads
out), the hold-the-logo staff login, borrowing, free text refused against the
pick-list, an already-out item refused by name, the empty state, return with
confirmation and condition, the staff queue, and the damaged path.

Both are in `tools/test-all.cjs`, which at that point ran seven (eight, after
Phase 6). `tools/test-toast.cjs`
gained a deferrable-frame hook so the toast's own case of the race could be
tested where it already lived, rather than from the browser.

## Phase 6 — the fifth instance of the same shape, and the backup round trip

Phase 5 swept the four sites that defer work to the next frame. This phase found
a fifth instance of the same underlying fault — *state that outlives the thing it
belongs to* — that no frame was involved in at all, and it was found the same way
the first one was: a test failing for a reason that made no sense.

### The keyboard outlived the screen it belonged to

`tools/test-restore.cjs` was being written to test something else entirely, and
its export step timed out:

```
Waiting failed: 15000ms exceeded
```

The button was found, was visible, was clicked, and nothing happened. A probe
that logged `document.elementFromPoint` at the click coordinates answered it:

```
click at (137,792) -> DIV.kbd-row
```

The on-screen keyboard was taking the tap. Not while it was up — *while it was
leaving*. The relevant CSS:

```css
.keyboard { position: fixed; bottom: 0; left: 0; right: 0; z-index: 100;
            transform: translateY(100%); transition: transform var(--transition-slow); }
.keyboard.visible { transform: translateY(0); }
```

Being off-screen is a **transform**, not `display: none`, and there was no
`pointer-events` rule anywhere on it. So the element stayed a full-width, z-index
100 strip across the bottom of the viewport, hit-testable, for the entire
slide-out — and the strip it covers is where the Settings panel keeps its Export
and Wipe buttons.

Why it was on its way out at that moment is the other half, and it is the part
staff would actually have noticed. The keyboard's only hide path was a
`focusout` handler guarded by a 150 ms timer, and the guard reads
`document.activeElement` — which, right after a screen is hidden, is *still the
input that was typed into*, because focus fixup has not happened yet. Measured
with a throwaway probe on the real page:

| | `document.activeElement` | `getClientRects().length` |
|---|---|---|
| right after the class change | the input | 0 |
| `focusout` fires | the input | 0 |
| +600 ms | `BODY` | 0 |

So the guard returned, the hide was deferred, and by the time it ran focus had
moved on its own. Net effect: **every navigation made with the keyboard up
carried it into the next screen for 150 ms and then slid it out across that
screen's bottom edge.** Staff hit this on the way in, every time — the PIN field's
focusout is followed immediately by the admin panel.

Two fixes were kept.

**1. Navigation puts it away itself.** `goToScreen` is the one path every screen
change goes through, and nothing can be typed into across a screen change, so it
is the one place that can put the keyboard away without guessing whether somebody
is still typing. A no-op before bootstrap has built the keyboard, idempotent
after:

```js
// Nothing can be typed into across a screen change, so this is the one place
// that can put the on-screen keyboard away without guessing whether somebody
// is still typing. It used to be left to the focusout path, which is 150ms
// plus a slide-out away, and the screen change is not.
putKeyboardAway();
```

**2. The class name now governs hit-testing.**

```css
.keyboard:not(.visible) { pointer-events: none; }
```

This is the same shape as the `.dialog-container.hidden` lock from Phase 5: the
first fix is the real one, and the second makes the class mean what it says, so
the failure mode of any future path that drops `visible` degrades from "the
bottom of the screen is dead" to "a transform is still animating".

**A third fix was written and then reverted.** The obvious repair for the
`focusout` guard is to ask whether the element is still *rendered* rather than
whether it is still focused — `activeElement` staying on a `display: none` input
is plainly a browser quirk. `getClientRects().length === 0` was added to the
condition. The probe above is why it came back out: the guard runs 150 ms later,
by which time `activeElement` is already `BODY`, so the new branch is unreachable
in every state the app can reach. An unreachable branch that looks like a fix is
worse than no branch — it reads as protection that is not there. The handler is
back to its original form, deliberately.

Both kept fixes are pinned, and both were shown to bite. `test-touch.cjs` gained
the navigation check, taken at 120 ms because that is inside the window the
`focusout` path cannot cover; with the fix disabled it reports the state exactly:

```
FAIL  navigating away puts the keyboard away at once
  -> {"visible":true,"hidden":false,"inert":false}
```

`test-ui.cjs` covers the other half, which `test-touch.cjs` structurally cannot:
that suite disables transitions to make touch coordinates stable, so it can
never observe a slide-out. `test-ui.cjs` leaves transitions alone and asserts the
computed `pointer-events`, plus an `elementFromPoint` hit test on the Settings
panel's own Export button after a full login — "nothing is covering the settings
panel's own buttons".

`tools/test-router.cjs` — the extracted-code suite — carries a third check, at
the level where the fix lives: the router's vm sandbox now has a `window` and a
keyboard stub that counts `hide()` calls, so a screen change that forgets to put
the keyboard away fails without a browser in the loop.

### The backup round trip, where the bug was found

`tools/test-restore.cjs` — the eighth suite, 45 checks, port 8799 — exists
because the backup was the one feature in the app whose correctness nobody could
see. A backup you have never restored is not a backup.

It captures the exported JSON by wrapping `URL.createObjectURL`, seeds data
through raw `indexedDB.open("frontdesk")`, logs in through
`window.app.showAdminLogin()`, and imports by uploading to
`input[data-action="import-file"]` with a fresh filename each time. Seven
sections: PIN login against a seeded store; export contents (including *the
export does not contain the PIN*); empty-then-restore; PIN preservation across a
replace; atomicity; the required-field rules; and a usability pass that counts
rows in the admin list afterwards.

Three behaviours it pinned that had only been assumed:

- **`importFromFile` requires `items`, `borrowers` and `loans`, but not
  `settings` or `requests`.** The two code paths differ — `importAll` skips an
  absent store (`if (records == null) continue;`) while the validator refuses a
  backup missing a core one. Both are checked, the second with a deliberately
  sparse fixture.
- **Replace-mode import does not restore the PIN.**
  `pin: current && current.pin ? current.pin : incoming.pin || "1234"` — an
  existing PIN wins over the one in the file. That is the right behaviour (you
  cannot restore an old database to unlock a panel someone has since changed the
  PIN on) and it is now written down.
- **A refused import writes nothing.** Checked by stringifying the whole database
  before and after a malformed payload and asserting the two are equal, not by
  trusting the error message.

Two of the checks were wrong when first written, and the app was right both
times — a backup with no `items` section is **refused**, not accepted, and a
borrower assumed absent from the list was legitimately there via an open loan.
Both expectations were rewritten to what the app does rather than the app being
changed to match the test.

### The build could delete the desk

Unrelated to the above, found while editing `build.ps1`: the script cleans its
output directory wholesale before compiling, and that directory is the live desk
— `dist\data\` holds the IndexedDB folder, the backups and the log. A rebuild
after an update would have taken the front desk's records with it, silently. The
build now moves `dist\data` aside for the duration and puts it back afterwards.
Verified by rebuilding over a working install and confirming the profile, the
backups and the log all survived and the app still launched clean.

The same edit added PE metadata (`host/AssemblyInfo.cs`) so the exe stops being
an anonymous `0.0.0.0` binary, and a signing path that verifies its own output:
`-Sign <thumbprint>` for an installed certificate, `-Pfx <file>` for the way IT
usually hands one over, and `signtool` when the Windows SDK is present falling
back to the in-box `Set-AuthenticodeSignature` when it is not — which is the case
on this machine, and was verified end to end rather than assumed. The hash and the
signature status are printed at the end of every build, with a note when the
build is unsigned. Those are about the endpoint agent rather than the code, and
are written up separately in `docs/EDR_AND_SIGNING.md`.

## Phase 7 — two controls that did nothing, and a bar nobody could see

Found after Phase 6, while inventorying the app's features for the README. Three
findings, all of the same family: **the code was in place, the wiring was not, and
no test asked the question that would have caught it.** Each is fixed and each fix
has a check that fails without it.

### The return buttons all meant "good"

The worst of the three, because it silently corrupted records rather than merely
failing to help.

`web/index.html` had three staff return buttons — Returned OK, DAMAGED, LOST:

```html
<button class="btn btn-return btn-success">✓ RETURNED OK</button>
<button class="btn btn-return btn-warning">⚠ DAMAGED</button>
<button class="btn btn-return btn-danger">✗ LOST</button>
```

and the handler (`app.js`, `_bindReturnButtons`) read a condition off each one:

```js
const condition = b.dataset.condition || "good";
```

No button carried `data-condition`, so the `|| "good"` fallback was not a fallback
at all — it was the only branch that ever ran. Every return, including a damaged
one and a lost one, was recorded as `conditionIn: "good"`.

The dialog made it worse rather than better. `_confirmAndReturn` (app.js:~4088)
has always been truthful code — a `conditionLabel` map that renders the condition
it was handed — so it took the incorrect value and told the staff member, in the
confirmation step, **"✓ Returned in good condition"** after they had tapped
DAMAGED. That is a screen actively contradicting what the person standing there
just did, at the moment they are being asked to confirm it.

The fix is the three attributes the handler was always reading:

```html
<button class="btn btn-return btn-success" data-condition="good">✓ RETURNED OK</button>
<button class="btn btn-return btn-warning" data-condition="damaged">⚠ DAMAGED</button>
<button class="btn btn-return btn-danger" data-condition="lost">✗ LOST</button>
```

Covered by four checks in `tools/test-ui.cjs`: the DOM wiring is pinned (the three
buttons' `dataset.condition` must be exactly `["good","damaged","lost"]`), a
damaged return is driven end to end through the real screens, the confirmation
dialog must say damaged, and the closed loan read back out of IndexedDB must carry
`conditionIn === "damaged"`. Reverting the fix produces
`FAIL the return buttons name the conditions they record -> [null,null,null]`.

### The Theme setting changed nothing

`Settings → Theme` has always offered Dark and Light, always saved the choice, and
always applied it: `app.js:8290` puts `light` on `<body>` at boot and `app.js:6923`
does it again on change. `web/styles.css` contained **no `.light` rule at all** —
a grep for it returned zero matches. The control was honest about persisting a
preference and dishonest about doing anything with it.

The existing check was the reason this survived:

```js
await page.waitForFunction(() => document.body.classList.contains("light"));
check("choosing Light actually applies it", true);
```

That asserts the class, which was always applied. It passed every run for as long
as the feature did nothing. It is the clearest example in this review of a test
that measures the implementation rather than the outcome.

The stylesheet was already built for this: 50 custom properties against 634
`var()` references, so the fix is a token block rather than a second stylesheet —
`body.light` redefines the colour tokens and every selector that reads them follows
without knowing a theme exists. Two values are not simple inversions:

- **`--magenta` is deepened to `#C40069`.** Brand magenta `#E6007E` on white is
  4.46:1 — under the 4.5:1 WCAG AA floor for normal text — and it is used as a
  text colour in 30 places (active tabs, badges, the recent-kiosk strip's item
  names). `#C40069` is 5.9:1 and still reads as the Rotman colour. Dark keeps the
  pure brand value.
- **Shadows are rebuilt.** The dark set is a black glow, which is depth on a
  near-black page and dirt on a white one.

`--border-strong` is redefined there for symmetry but has **no consumers anywhere
in the stylesheet** (`grep -c 'var(--border-strong)'` → 0); it is a dead token in
both themes, noted here rather than deleted.

The check now reads the resolved tokens instead of the class — custom properties
are not animatable, so unlike a `background-color` the read is not at the mercy of
the transition:

```js
check("and the light theme's tokens are the ones that resolve", lightTokens.bg !== darkTokens.bg);
check("the light background is light",  luminance(lightTokens.bg)  > 0.5);
check("the dark background is dark",    luminance(darkTokens.bg)   < 0.2);
check("light text is dark and dark text is light", luminance(lightTokens.text) < luminance(darkTokens.text));
```

Disabling the block fails four of them, the first with the exact diagnostic the
original bug deserved: `--bg is #0a0a0b in both themes`.

Verified by eye as well as by assertion — every admin tab, the staff home, the
kiosk welcome, a dialog and the on-screen keyboard were rendered in light mode and
looked at. The keyboard and the dialog needed no rules of their own: both are drawn
entirely from tokens (`--surface-elevated` panel, `--surface` keys, `--text`).

### The sixth instance of the same shape

`.hidden` in this stylesheet is deliberately weak. Its own comment says so: *"Kept
low-specificity and last-word-free so a component rule can still win."* The
consequence is that any component setting `display` must declare its own hidden
state, and `.screen.hidden` and `.dialog-container.hidden` exist for exactly that
reason. `.admin-recent-kiosk` sets `display: flex` and never declared one.

So `renderRecentKiosk`'s `container.classList.add("hidden")` — the branch it takes
whenever there has been no kiosk self-checkout in the last ten minutes, which is
almost always — did not hide it. An empty 26px magenta strip was painted under the
admin header on every tab, and was hit-testable across that band. Measured, not
inferred, with `document.elementFromPoint` down the page: at y=96 the topmost
element is `div#admin-recent-kiosk.admin-recent-kiosk.hidden` with
`getComputedStyle().display === "flex"` and a 1248x26 rect, in **both** themes. In
dark it reads as a dark maroon band, which is why it went unnoticed.

Fixed with the rule the other two components already have:

```css
.admin-recent-kiosk.hidden { display: none; }
```

Two checks: the strip's computed `display` must be `none` while it carries
`hidden`, and its rect height must be 0. With the rule removed they report
`{"hidden":true,"display":"flex","height":26}`.

### What the sweep turned up and did not change

Found while inventorying the app, recorded rather than acted on:

- **`conditionIn: "fair"` is never written by any UI path.** The dialog's
  `conditionLabel` map has an entry for it, but nothing produces it — the staff
  buttons offer good/damaged/lost and the kiosk's two choices ("All good" /
  "Something's wrong") map to good/damaged (`app.js`, `_askReturnCondition`).
  It is a display-only value that no code path can reach.
  `"lost"` **was** in the same position and is not any more: the staff LOST button
  fixes it by passing `conditionIn: "lost"` through `returnLoan`, which means the
  item detail's "Lost" statistic (it counts `conditionIn === "lost"`) can now be
  non-zero for the first time. Worth knowing when reading older numbers.
  Note also that marking a loan LOST does **not** change the item's own condition
  or archive it, so a lost item stays in the catalog and is offered again — which
  is a design question rather than a bug, and is now stated in the README so staff
  know to also edit the item.
- **`localStorage["frontdesk.recentPhones"]` is written and never read.**
- **`state.borrower.isWalkIn` is never set**, so the kiosk walk-in-return branch is
  unreachable.
- **`data-kbd="off"` has no consumer**, alongside the `[data-kbd-toggle]` hook
  already listed in "Known, not fixed".
- **Stale static markup in `index.html`**: the header's `Out: 12 / Overdue: 3`
  placeholder is overwritten the moment `refreshHome` runs; `#tab-settings`' static
  contents are replaced wholesale by `renderSettings`; `.splash-action:focus-visible`
  is styled with no element carrying the class.

---

## Phase 8 — shipping it: no icon, and a package that could have shipped the desk

The request was to make this something you can put on any computer: an icon, some
polish, and one file to carry. Three things came out of doing it.

### The exe had no icon at all

`host/build.ps1` passed `/win32manifest` to the compiler but never `/win32icon`,
and `FrontDesk.cs` never set `Form.Icon`. So every place Windows shows the *file*
— Explorer, the taskbar, Alt-Tab, the Start menu, a shortcut — fell back to the
generic blank application icon, while the tray drew a magenta "FD" tile. The app
looked like a half-finished build in the first place anyone meets it, and the one
surface that showed the mark was the one behind a menu.

Fixed by generating `host/frontdesk.ico` and compiling it in with `/win32icon`.
The icon is **drawn from source** (`tools/make-icon.ps1`, `System.Drawing`)
because this machine has no image tooling — no ImageMagick, no Inkscape, no
Windows SDK — so a checked-in .ico would be unmaintainable, and generating it
means it can be redrawn at any size rather than upscaled from a 32px bitmap.

Two decisions worth recording, both made by measuring rather than assuming:

- **Seven sizes, not one.** Windows asks for a different size for the taskbar, the
  Alt-Tab switcher, Explorer's small and large views, and the 256px tile view.
  One 32px bitmap scaled to 256 looks like a mistake at exactly the size a user
  notices. Verified by asking the shell (`PrivateExtractIcons`) for each size:
  16, 24, 32, 48, 64, 128 and 256 all come back as themselves, and non-exact
  requests (20, 40, 96) scale cleanly from the nearest frame.
- **DIB entries, not PNG.** PNG-compressed icon entries are smaller and Windows
  renders them happily, but `System.Drawing.Icon` — the .NET path, and what
  `ExtractAssociatedIcon` uses — does not parse them. It was verified that the
  DIB form loads through both paths, including that the alpha channel survives
  the PE resource round trip (checked by re-extracting the frames out of the
  built exe and rendering them, not by trusting that it compiled). The cost is
  that the icon is 364KB of the exe's 395KB — and it compresses to nothing in the
  zip, because it is mostly flat magenta. The whole package is 0.43MB.

The glyph needed one non-obvious adjustment. At 16px a single `DrawString` has to
choose between weight (legible) and spacing (F and D separated), and the first
attempt could not do both — the letters merged. Rendering the 16px frame at 12x
next to scale/tracking variants and comparing showed that **placing each
character by hand with a little tracking** breaks the tie: the glyphs keep the
weight that survives at 16px and the tracking keeps them apart. Settled on
`FontScale 0.50`, `Tracking 0.08`.

### A corrected claim that had a second copy in the build output

Phase 6 corrected the README: a backup is taken **once a day**, not on every
launch (`BACKUP_INTERVAL_MS`). But `build.ps1` writes a `README.txt` into every
fresh `data` folder, and it contained the same wrong sentence — "a backup is
written here on every launch".

Correcting the prose did not correct the thing that ships. The text lived in the
build script, so the shipped copy kept saying it no matter how many times the
README was fixed. Worth stating plainly because of the shape, not the size: **a
documentation claim duplicated into generated output has to be fixed in the
generator.** Both now say once a day.

### The packaging step could have shipped the desk's records

`dist\` on the machine that builds it *is* a live install: it holds `data\browser`
(the IndexedDB the desk has been using), `data\backups`, and `frontdesk.log`. A
packaging script that zipped `dist\` wholesale — the obvious implementation —
would have put borrower names and phone numbers inside the zip handed to another
desk, silently, with the zip looking perfectly correct.

`tools/package.ps1` therefore **refuses to package** unless `data\` holds nothing
but its `README.txt`, naming what it found. It also verifies the archive by
unpacking it again rather than trusting the staging folder: the exe must come back
byte-for-byte (so the SHA-256 printed inside `For IT.txt` describes the file that
is actually in the zip), with its version resource and icon intact — both of which
are easy to lose in a build change and impossible to notice from a file listing.

The deliverable is a **zip**, deliberately, not an installer. `iexpress` produces
exactly the self-extracting shape that gets deleted on execution here, so it
cannot be the "one file to carry" answer; and an MSI would install to
`Program Files`, where the app cannot write its own data folder without
elevation, breaking the one property the app depends on. Unpacking the zip is the
install.

Re-verified against the endpoint agents, since that is the constraint the whole
shape exists for: with `SentinelAgent`, `SentinelStaticEngineScanner` and
`CSFalconService` all running, the exe was executed repeatedly from three
different folders and survived with its hash unchanged and nothing quarantined.

---

## Known, not fixed

Four things found while working, left alone deliberately rather than silently
changed.

- **Typed item and category names are sentence-cased.** `sentenceCase`
  (`app.js:1837`) lowercases everything after the first letter, so "HDMI dongle"
  is stored as "Hdmi Dongle" and "AV Equipment" as "Av Equipment". This is
  pre-existing behaviour and it is applied to the catalog, not to display strings,
  so every screen and every report shows the mangled form. It is pinned by a check
  in `tools/test-ui.cjs` so a change is visible. Fixing it means deciding whether
  to leave existing names alone (mixed casing in one catalog) or rewrite them
  (a migration over user data), which is a call for whoever owns the desk.
- **Borrower names are sentence-cased too**, with the same effect on "McDonald"
  and similar. Same reasoning.
- **The `requests` object store is vestigial.** It has a schema (added in the v3
  migration, with indexes), read and update accessors (`getRequests`,
  `fulfillRequest`, `cancelRequest`), export and import support — and nothing in
  the app ever creates a record in it. The kiosk's return request is not stored
  there; it lives on the loan, as `returnRequestedAt` / `returnRequestedCondition`
  / `returnRequestedNote`, which is what the staff Queue tab actually reads.
  Removing the store means a database version bump and a migration over live data
  for no user-visible change, so it is documented rather than deleted. Anything
  built on top of it should not assume it has ever been populated.
- **`_onDocClick` looks for `[data-kbd-toggle]`, and no element has it.** A dead
  hook left from an earlier design — a tap-outside-to-dismiss affordance for the
  keyboard. Harmless (the handler simply never matches), and left in place because
  the keyboard now genuinely should *not* dismiss on an outside tap: the kiosk
  fields and the admin search field both live in scrollable panels where a tap
  between keys is usually a mis-aimed key. Worth deleting the next time that
  handler is touched.
