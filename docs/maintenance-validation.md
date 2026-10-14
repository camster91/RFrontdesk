# Staff sessions and record persistence maintenance

Reviewed and tested on CAM-DESKTOP on 2026-10-14 using synthetic records and a fresh test browser profile.

## Changes

- Home, checkout, check-in and return screens now retain the existing five-minute staff idle lock. Document activity refreshes it, including dialogs and the on-screen keyboard. Returning to the public kiosk cancels it. A repeated login shortcut cannot overwrite the lock screen's public Cancel destination.
- Individual `put` and `del` operations use the same commit-aware transaction helper as multi-record operations. A request that succeeds before its transaction aborts now rejects; read-cache invalidation occurs only after commit.
- Checkout Undo adjusts the current item and borrower after a merge, rather than the original toast's stale ownership. Repeated Undo remains harmless.
- Numeric name ordering reuses an `Intl.Collator`; People filtering preserves the order already supplied by the data layer, avoiding a second sort. Activity/date ties retain alphabetical ordering. List size and pagination behavior are unchanged.

## Regression evidence

`tools/test-sessions.cjs` exercises every staff screen's idle timeout, active input, kiosk reset, dialog closure, lock -> Ctrl+Shift+A -> Cancel, and splash -> login -> Cancel. Timers are shortened only in the test browser.

`tools/test-records.cjs` forces actual IndexedDB transactions to abort after their request succeeds, then checks the rejected operation, rolled-back record, unchanged committed cache, and successful committed deletion. It also performs actual item and borrower merges before checkout Undo, checks survivor counts/latest timestamps, leaves originals unchanged, and repeats Undo. Numeric name order, archived records, activity sorting, recent sorting and tied values have explicit checks.

The router's isolated fixture supplies the session-timer dependency; real timer behavior remains covered by the browser suite.

Full-suite validation command:

```powershell
$env:FRONTDESK_TEST_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tools/test-all.cjs
```

Full-suite result: **all 14 suites passed**, exit code 0, on the final patch. The ignored local transcript is `dist/maintenance-validation.log`. `git diff --check` and Node syntax checks also passed.

The local `npm test` child shell did not have Node on PATH; the command above invokes the identical runner directly with the task's callable Node runtime. No host PATH or security settings were changed.

No installed-app interaction, live desk data, production write, signing, publication or release claim is made by these local tests. The application version remains unchanged in this patch; release versioning and CI verification are handled separately.
