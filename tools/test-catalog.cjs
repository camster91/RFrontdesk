// The catalog at scale: matching tiers, create-on-the-spot, a merge that sticks
// and can be undone, and 10,000 items without a slow screen.
//
//   node tools/test-catalog.cjs
//
// Everything here is driven through the real UI -- real clicks, real typing, real
// screens -- rather than by calling the app's internals. A suite that reached
// into `mergeItems` directly would still pass if the button meant to call it were
// never wired, which is exactly the class of bug this file exists to catch.
//
// Port 8793. 8791 is serve.cjs, 8792 test-ui, 8795 test-touch, 8798 test-kiosk
// and test-responsive, 8799 test-restore.
//
// Its own browser profile per run, so the 10,000-item seed cannot leak into
// another suite, and no other suite's catalog can make a check here pass.
//
// The catalog suite covers matching, creation and cache invalidation. The kiosk
// suite drives Borrow something else and Finish to verify that each borrower
// gets a fresh three-item creation allowance.

const fs = require("fs");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..", "web");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8793;
const PIN = "1234";

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`  ok  ${name}`);
    return;
  }
  failures++;
  console.error(`FAIL  ${name}${detail === undefined ? "" : "  -> " + detail}`);
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]);
    if (rel === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    const file = path.join(ROOT, rel === "/" ? "/index.html" : rel);
    // The separator, not a bare prefix: "...\web-backup" also startsWith("...\web").
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(body);
    });
  });
  return new Promise((r) => server.listen(PORT, "127.0.0.1", () => r(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("\nThe catalog at scale\n");

  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const errors = [];

  try {
    const page = await browser.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e && e.message)));
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 30000 });

    // Headless never finishes a CSS transition, so anything measured mid-slide is
    // measured wrong. Nothing here asserts on animation; removing them keeps the
    // measurements honest.
    await page.addStyleTag({
      content: "*, *::before, *::after { transition: none !important; animation: none !important; }"
    });

    // ── primitives ────────────────────────────────────────────────────────
    // Programmatic clicks throughout: the on-screen keyboard sits over the bottom
    // of a kiosk step, so a real mouse click can land on the keypad instead.
    const clickEl = (sel) =>
      page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return "no element: " + s;
        el.click();
        return "ok";
      }, sel);

    const clickIn = (screenId, sel) =>
      page.evaluate(
        ({ screenId, sel }) => {
          const root = document.getElementById(screenId) || document;
          const el = root.querySelector(sel);
          if (!el) return "no element: " + sel;
          el.click();
          return "ok";
        },
        { screenId, sel }
      );

    const textIn = (screenId, sel) =>
      page.evaluate(
        ({ screenId, sel }) => {
          const root = document.getElementById(screenId);
          const el = root && root.querySelector(sel);
          return el ? el.textContent.trim() : null;
        },
        { screenId, sel }
      );

    const fill = (sel, value) =>
      page.evaluate(
        ({ sel, value }) => {
          const el = document.querySelector(sel);
          if (!el) return "no element: " + sel;
          el.focus();
          el.value = value;
          try {
            el.setSelectionRange(value.length, value.length);
          } catch (_) {}
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return "ok";
        },
        { sel, value }
      );

    const screenNow = () =>
      page.evaluate(() => {
        const el = document.querySelector(".screen:not(.hidden)");
        return el ? el.id : null;
      });

    const visibleText = (sel) =>
      page.evaluate((s) => {
        const el = document.querySelector(s);
        return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
      }, sel);

    const clearToasts = () =>
      page.evaluate(() => {
        const c = document.getElementById("toast");
        if (c) c.textContent = "";
      });
    const toastText = () =>
      page.evaluate(() => (document.getElementById("toast") || {}).textContent || "");
    // Returns the matching toast text, or null. Falsey rather than throwing: when
    // it does not match, what the toast actually said is the whole diagnosis, and
    // a thrown timeout buries it. Flags are carried across, not just the source --
    // a toast's copy is capitalised mid-sentence far more often than not, and a
    // case-sensitive pattern silently waits for a toast already on screen.
    const waitToast = (re) =>
      waitUntil(async () => {
        const t = await toastText();
        return re.test(t) ? t : null;
      }, 8000, 150);

    // Poll a Node-side predicate. Used for everything that waits on a database
    // write: a `waitForFunction` on a DOM node can resolve before the write the
    // assertion is actually about, and an identifier referenced inside a page
    // function that does not exist there fails silently under a `.catch`.
    const waitUntil = async (fn, ms = 15000, step = 200) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > deadline) return null;
        await sleep(step);
      }
    };

    const gotoWelcome = () => page.evaluate(() => window.app.goToScreen("welcome"));

    // ── direct reads of the store ─────────────────────────────────────────
    // Read straight from IndexedDB rather than through the app, so a cached
    // catalog cannot make a check pass by agreeing with itself. That is the whole
    // point of this suite: the bug it was written for was a cache.
    const openDb = (stores) =>
      page.evaluate(
        (names) =>
          new Promise((resolve) => {
            const out = {};
            const req = indexedDB.open("frontdesk");
            req.onerror = () => resolve(null);
            req.onsuccess = () => {
              const tx = req.result.transaction(names, "readonly");
              let left = names.length;
              const done = () => {
                left--;
                if (left === 0) resolve(out);
              };
              for (const n of names) {
                const a = tx.objectStore(n).getAll();
                a.onsuccess = () => {
                  out[n] = a.result;
                  done();
                };
                a.onerror = () => {
                  out[n] = null;
                  done();
                };
              }
              tx.onerror = () => resolve(null);
            };
          }),
        stores
      );

    const dbItems = async () => (await openDb(["items"]) || {}).items || [];
    const dbLoans = async () => (await openDb(["loans"]) || {}).loans || [];
    const itemByName = async (name) => (await dbItems()).find((i) => i.name === name) || null;
    const pendingReview = async () =>
      (await dbItems()).filter((i) => i.needsReview === true && i.isArchived !== true);

    // ── the admin panel ───────────────────────────────────────────────────
    const login = async () => {
      if ((await screenNow()) === "screen-admin") return;
      await page.evaluate(() => window.app.showAdminLogin());
      await page.waitForSelector("#screen-admin-login:not(.hidden)", { timeout: 10000 });
      await page.type("#screen-admin-login .pin-input", PIN);
      await clickEl("#screen-admin-login .pin-submit");
      await page.waitForSelector("#screen-admin:not(.hidden)", { timeout: 15000 });
    };

    const itemsTab = async () => {
      await login();
      await clickEl('#screen-admin .tab[data-tab="items"]');
      await page.waitForFunction(
        () => {
          const c = document.getElementById("items-content");
          return !!c && c.children.length > 0;
        },
        { timeout: 20000 }
      );
    };

    // The count line and the Show-more button are direct children of
    // #items-content, as are the rows; a row's own meta lines are nested, so a
    // direct-child selector picks the summary and never a row's.
    const itemRows = () =>
      page.evaluate(() => document.querySelectorAll("#items-content > .admin-list-item").length);
    const itemCountLine = () =>
      page.evaluate(() => {
        const el = document.querySelector("#items-content > .loan-meta");
        return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
      });
    const itemsSearch = (value) => fill('#tab-items input[data-filter="q"]', value);

    // Close an open loan the way staff do: the Currently Out tab's check-in
    // button. The kiosk's own return flow only *requests* a return -- a human
    // still has to confirm it -- so it cannot make an item available again, which
    // is exactly the state the merge guard below turns on.
    const staffCheckIn = async (itemName) => {
      await login();
      await clickEl('#screen-admin .tab[data-tab="currently-out"]');
      await page.waitForFunction(
        () => !!document.querySelector("#tab-currently-out .admin-list .loan-item"),
        { timeout: 20000 }
      );
      return page.evaluate(
        (name) => {
          const rows = Array.from(document.querySelectorAll("#tab-currently-out .admin-list .loan-item"));
          const row = rows.find((r) =>
            ((r.querySelector(".loan-meta") || {}).textContent || "").indexOf(name) !== -1
          );
          if (!row) return `no open loan for ${name}`;
          const btn = Array.from(row.querySelectorAll("button")).find(
            (b) => /^✓( Mark returned)?$/.test(b.textContent.trim())
          );
          if (!btn) return "no check-in button on the row";
          btn.click();
          return "ok";
        },
        itemName
      );
    };

    // Drive a merge from the kiosk review screen, through the real picker. Returns
    // "ok" or a description of what was missing, so a failure says which step.
    const mergeInto = async (victimName, keeperName) => {
      const opened = await rowAction(victimName, "merge-into");
      if (opened !== "ok") return opened;
      await page.waitForSelector("#dialog:not(.hidden) [data-f='q']", { timeout: 15000 });
      await fill("#dialog [data-f='q']", keeperName);
      await page.waitForFunction(
        (name) =>
          ((document.querySelector("#dialog #merge-picker-results") || {}).textContent || "").indexOf(name) !==
          -1,
        { timeout: 15000 },
        keeperName
      );
      // The row named exactly, not the first row in the list: the picker ranks by
      // score, so clicking position zero could pass while picking the wrong item.
      const picked = await page.evaluate((name) => {
        const rows = Array.from(document.querySelectorAll("#dialog #merge-picker-results .dedup-member"));
        const r = rows.find(
          (x) => ((x.querySelector(".borrower-name") || {}).textContent || "").trim() === name
        );
        if (!r) return `no picker row named ${name}`;
        r.click();
        return "ok";
      }, keeperName);
      if (picked !== "ok") return picked;
      return dialogButton(/^merge$/i);
    };

    // The review screen's own render, so an action taken here stays here.
    const openKioskReview = async (expectName) => {
      await itemsTab();
      await clickIn("screen-admin", '#kiosk-review-panel [data-action="review-kiosk"]');
      await page.waitForFunction(
        (name) =>
          ((document.querySelector("#screen-admin-detail .detail-content") || {}).textContent || "").indexOf(
            name
          ) !== -1,
        { timeout: 20000 },
        expectName
      );
    };

    // The review screen's rows each carry their own action buttons, so an action
    // is always addressed through the row naming the item -- clicking the first
    // button in document order would act on whichever item happened to sort first.
    const rowAction = (name, action) =>
      page.evaluate(
        ({ name, action }) => {
          const rows = Array.from(document.querySelectorAll("#screen-admin-detail .loan-section"));
          const row = rows.find(
            (r) => r.textContent.indexOf(name) !== -1 && r.querySelector(`[data-action="${action}"]`)
          );
          if (!row) return "no row for " + name;
          row.querySelector(`[data-action="${action}"]`).click();
          return "ok";
        },
        { name, action }
      );

    const dialogText = () =>
      page.evaluate(() => (document.getElementById("dialog") || {}).textContent || "");
    const dialogButton = (re) =>
      page.evaluate(
        (src) => {
          const rx = new RegExp(src, "i");
          const b = Array.from(document.querySelectorAll("#dialog button")).find((x) =>
            rx.test(x.textContent.trim())
          );
          if (!b) return "no button matching " + src;
          b.click();
          return "ok";
        },
        re.source
      );

    // ── the kiosk ─────────────────────────────────────────────────────────
    const kioskSuggestions = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("#kiosk-need-suggestions .kiosk-suggestion")).map((b) => {
          const spans = b.querySelectorAll("span");
          return {
            text: spans.length ? spans[0].textContent.trim() : b.textContent.trim(),
            disabled: !!b.disabled,
            unavailable: b.classList.contains("is-unavailable")
          };
        })
      );
    const hasAddControl = () =>
      page.evaluate(() => !!document.querySelector('[data-action="kiosk-confirm-pick"][data-adds="1"]'));
    const suggestText = () => visibleText("#kiosk-need-suggestions");

    // The real back-home control, on whichever kiosk screen is showing, so the
    // session is reset the way the app resets it. `offsetParent` is the visibility
    // test because two screens carry this action and one of them is hidden.
    const backHome = async () => {
      const clicked = await page.evaluate(() => {
        const vis = Array.from(document.querySelectorAll('[data-action="kiosk-back-home"]')).find(
          (b) => b.offsetParent !== null
        );
        if (!vis) return false;
        vis.click();
        return true;
      });
      if (!clicked) await gotoWelcome();
      await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 10000 });
    };

    // Walk to the item step. A fresh phone number every time, so the borrower is
    // always new and the name step is always shown -- a known number skips
    // straight to the items step, which would silently change the path under test.
    let phoneSeq = 0;
    const kioskWalkToNeed = async (who) => {
      await gotoWelcome();
      await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 10000 });
      await clickIn("screen-welcome", ".btn-kiosk-borrow");
      await page.waitForSelector("#screen-kiosk-borrow-phone:not(.hidden)", { timeout: 10000 });
      phoneSeq++;
      await fill("#kiosk-phone", `416555${String(2000 + phoneSeq).slice(-4)}`);
      await clickIn("screen-kiosk-borrow-phone", '[data-action="kiosk-phone-continue"]');
      await page.waitForSelector("#screen-kiosk-borrow-name:not(.hidden)", { timeout: 10000 });
      await fill("#kiosk-name", who);
      await clickIn("screen-kiosk-borrow-name", '[data-action="kiosk-name-continue"]');
      await page.waitForSelector("#screen-kiosk-borrow-need:not(.hidden)", { timeout: 10000 });
    };

    const kioskConfirm = () => clickIn("screen-kiosk-borrow-need", '[data-action="kiosk-confirm-pick"]');
    const kioskDoneText = async () => {
      await page.waitForSelector("#screen-kiosk-borrow-done:not(.hidden)", { timeout: 15000 });
      return textIn("screen-kiosk-borrow-done", "#kiosk-done-text");
    };

    // ── the staff checkout flow ───────────────────────────────────────────
    // The kiosk screens **lock** the app: `goToScreen` refuses to move off one
    // unless the exit was granted, and the only thing that grants it is the hidden
    // hold-to-login. So a checkout started while the kiosk welcome screen is up is
    // refused, and the screen simply never appears -- which reads as a dead app
    // unless you know the rule. Going through the admin login first is both the
    // app's own way out and how a staff member actually gets there.
    const gotoStaff = async () => {
      await login();
    };

    // A draft from an abandoned checkout lives in sessionStorage, and the next
    // start puts a "Resume checkout?" dialog in front of the flow. Cleared before
    // each start, and a stray dialog is discarded rather than left to swallow the
    // typing that follows.
    const startCheckout = async () => {
      await page.evaluate(() => {
        try {
          sessionStorage.removeItem("frontdesk.draft");
        } catch (_) {}
      });
      await page.evaluate(() => window.dispatchEvent(new Event("frontdesk:checkout-start")));
      await page.waitForSelector("#screen-checkout:not(.hidden)", { timeout: 15000 });
      if ((await dialogButton(/^discard$/i)) === "ok") {
        await page.waitForFunction(() => document.getElementById("dialog").classList.contains("hidden"), {
          timeout: 10000
        }).catch(() => {});
      }
      await page.waitForFunction(
        () => !!window.__checkoutFlow && window.__checkoutFlow._wireOnce === true,
        { timeout: 15000 }
      );
    };

    const stepVisible = (step) =>
      page.waitForFunction(
        (s) => {
          const el = document.querySelector("#screen-checkout " + s);
          return !!el && !el.classList.contains("hidden");
        },
        { timeout: 15000 },
        step
      );

    // `expectAtLeast` is the catalog size the items step should be showing. It is
    // not decoration: the flow instance is reused between checkouts and only its
    // *visibility* changes, so the step's markup is the previous checkout's until
    // the fresh render lands -- and "the items step is visible" is therefore true
    // of the leftovers too. Reading the list at that moment means reading a list
    // built for an earlier catalog, which is how this suite produced a run that
    // reported "ALL ITEMS (5)" while the store held 10,009. The heading carrying
    // this run's own count is the signal that the render has actually happened.
    const checkoutToItems = async (phone, who, expectAtLeast = 1) => {
      await startCheckout();
      await stepVisible(".step-phone");
      await page.type("#screen-checkout .step-phone .input", phone);
      await clickIn("screen-checkout", ".step-phone .step-continue");
      await stepVisible(".step-name");
      await page.type("#screen-checkout .step-name .input", who);
      await clickIn("screen-checkout", ".step-name .step-continue");
      await stepVisible(".step-items");
      await page.waitForFunction(
        (min) => {
          const h = document.querySelector("#screen-checkout .item-section:nth-of-type(2) .section-title");
          const m = h && /ALL ITEMS \((\d+)\)/.exec(h.textContent.trim());
          return !!m && Number(m[1]) >= min;
        },
        { timeout: 40000 },
        expectAtLeast
      );
    };

    const checkoutAddItem = async (name) => {
      await fill("#screen-checkout .step-items .search-input", name);
      await page.waitForSelector("#screen-checkout .all-items .add-new-row", { timeout: 20000 });
      await clickIn("screen-checkout", ".all-items .add-new-row");
      return waitUntil(async () => await itemByName(name), 15000);
    };

    // ── the seed ──────────────────────────────────────────────────────────
    // One transaction for the whole seed, resolved on tx.oncomplete, ids far above
    // anything autoIncrement has handed out. "115 Key" is the only entry whose key
    // holds a bare 115 -- nothing is named so that its own key is "115" -- which is
    // what leaves "Room 115" free to be a tier-3 subset attach.
    await page.evaluate(
      () =>
        new Promise((res, rej) => {
          const q = indexedDB.open("frontdesk");
          q.onerror = () => rej(q.error);
          q.onsuccess = () => {
            const now = Date.now();
            const tx = q.result.transaction(["items"], "readwrite");
            tx.oncomplete = () => res(true);
            tx.onerror = () => rej(tx.error);
            const store = tx.objectStore("items");
            const rows = [
              [7001, "Projector"],
              [7002, "Projector Screen"],
              [7003, "Cable HDMI"],
              [7004, "Cable VGA"],
              [7005, "115 Key"],
              [7006, "Clicker"]
            ];
            for (const [id, name] of rows) {
              store.put({
                id,
                name,
                nameLower: name.toLowerCase(),
                category: "Other",
                location: "",
                condition: "good",
                notes: "",
                timesCheckedOut: 0,
                lastCheckedOutAt: null,
                isArchived: false,
                createdAt: now
              });
            }
          };
        })
    );
    const seeded = (await dbItems()).filter((i) => i.id >= 7001 && i.id <= 7006).length;
    check("the controlled catalog is in place", seeded === 6, `${seeded} of 6 seeded`);

    // ── 1. the three matching tiers ───────────────────────────────────────
    // One canonical key, three tiers. Each tier gets its own check because the
    // guards between them are the whole safety argument for attaching silently.
    await kioskWalkToNeed("Tier Tester");

    // Tier 3, and the desk owner's own example: "Room 115" is not an item, "room"
    // is noise, and exactly one live entry is a superset -- so it attaches.
    await fill("#kiosk-need", "Room 115");
    await page.waitForSelector("#kiosk-need-suggestions .kiosk-suggestion", { timeout: 10000 });
    const roomPicks = await kioskSuggestions();
    check(
      "a near miss offers the item it means",
      roomPicks.some((p) => p.text.toLowerCase() === "115 key"),
      JSON.stringify(roomPicks)
    );
    check("and offers to add nothing while an item matches", (await hasAddControl()) === false);
    await clearToasts();
    await kioskConfirm();
    const roomDone = await kioskDoneText();
    check('typing "Room 115" checks out "115 Key"', roomDone === "115 Key", String(roomDone));
    const roomLoan = await waitUntil(async () => {
      const ls = await dbLoans();
      return ls.find((l) => l.itemNameSnapshot === "115 Key" && l.isOpen === "open") || null;
    });
    check(
      "and the loan records what was actually typed",
      !!roomLoan && roomLoan.matchedFrom === "Room 115",
      roomLoan ? String(roomLoan.matchedFrom) : "no loan"
    );
    await backHome();

    // Tier 1 beats tier 3: "Projector" is itself an item, so it must win over
    // "Projector Screen" rather than being read as a subset of it.
    await kioskWalkToNeed("Exact Tester");
    await fill("#kiosk-need", "Projector");
    await page.waitForSelector("#kiosk-need-suggestions .kiosk-suggestion", { timeout: 10000 });
    const projPicks = await kioskSuggestions();
    check(
      "an exact name is offered first",
      projPicks.length > 0 && projPicks[0].text === "Projector",
      JSON.stringify(projPicks)
    );
    await kioskConfirm();
    const projDone = await kioskDoneText();
    check('typing "Projector" checks out the Projector, not the Screen', projDone === "Projector", String(projDone));
    await backHome();

    // Ambiguity never resolves silently: "Cable" fits two supersets, so nothing
    // attaches, both are offered, and confirming says so instead of guessing.
    await kioskWalkToNeed("Ambiguous Tester");
    await fill("#kiosk-need", "Cable");
    await page.waitForSelector("#kiosk-need-suggestions .kiosk-suggestion", { timeout: 10000 });
    const cablePicks = await kioskSuggestions();
    const cableNames = cablePicks.map((p) => p.text.toLowerCase()).sort();
    check(
      "a name that could mean two things offers both",
      cableNames.indexOf("cable hdmi") !== -1 && cableNames.indexOf("cable vga") !== -1,
      JSON.stringify(cablePicks)
    );
    await clearToasts();
    await kioskConfirm();
    const ambiguousToast = await waitToast(/more than one item matches/i);
    check("and confirming it attaches to neither", !!ambiguousToast, await toastText());    check("the borrower stays on the item step to choose", (await screenNow()) === "screen-kiosk-borrow-need");
    await backHome();

    // ── 2. creating an item at the kiosk ──────────────────────────────────
    await kioskWalkToNeed("Kiosk Creator");
    await fill("#kiosk-need", "Room 115");
    await page.waitForSelector("#kiosk-need-suggestions .kiosk-suggestion", { timeout: 10000 });
    check("a name that matches the catalog is not offered as a new item", (await hasAddControl()) === false);

    // The first reachable guard rail: a name too short to be an item can never be
    // added, so a stray letter cannot leave a junk row in a catalog of thousands.
    //
    // Only the *guard* is asserted, not the wording. `kioskCreateCheck`'s
    // "Type a bit more..." note is rendered only when the matcher found nothing,
    // and against a seeded catalog a single letter always matches something --
    // here it matched two cables. So the note is real but not reachable from this
    // state, and asserting it would be asserting a branch this path never takes.
    await clearToasts();
    await fill("#kiosk-need", "A");
    await sleep(500);
    check("a one-character name cannot be added", (await hasAddControl()) === false, await suggestText());

    // And the other half of the guard: pressing Done on that name must not add it
    // either. Creating lives behind the add button alone, which is what keeps a
    // stray Enter from writing a catalog row.
    const beforeStray = await dbItems();
    await kioskConfirm();
    await sleep(600);
    check(
      "and pressing Done on it adds nothing to the catalog",
      (await dbItems()).length === beforeStray.length,
      `${beforeStray.length} -> ${(await dbItems()).length}`
    );
    check("the borrower is told why rather than left at a dead end", !!String(await toastText()).trim(), await toastText());

    await fill("#kiosk-need", "Squeaky Rubber Duck");
    await page.waitForSelector('[data-action="kiosk-confirm-pick"][data-adds="1"]', { timeout: 10000 });
    await clickIn("screen-kiosk-borrow-need", '[data-action="kiosk-confirm-pick"]');
    const duckDone = await kioskDoneText();
    // `sentenceCase` is applied to a name created at the kiosk, so this compares
    // the words rather than the exact casing.
    check(
      "tapping Add creates the item and checks it out",
      String(duckDone).toLowerCase() === "squeaky rubber duck",
      String(duckDone)
    );
    const duck = await waitUntil(async () => await itemByName("Squeaky Rubber Duck"));
    check("the item exists in the catalog", !!duck);
    check(
      "it is stamped as created by the kiosk",
      !!duck && duck.createdBy === "kiosk",
      duck ? String(duck.createdBy) : "missing"
    );
    check("and flagged for staff review", !!duck && duck.needsReview === true, duck ? String(duck.needsReview) : "missing");
    const duckLoan = duck ? (await dbLoans()).find((l) => Number(l.itemId) === Number(duck.id)) : null;
    check("with its loan already recorded, not left for later", !!duckLoan && duckLoan.isOpen === "open");
    await backHome();

    // An item created on the tablet is in the catalog from that moment, so the
    // same name is never offered again -- with no reload in between.
    await kioskWalkToNeed("Kiosk Creator");
    await fill("#kiosk-need", "Squeaky Rubber Duck");
    await page.waitForSelector("#kiosk-need-suggestions .kiosk-suggestion", { timeout: 10000 });
    const againPicks = await kioskSuggestions();
    check(
      "a name just created at the kiosk is found, not offered again",
      againPicks.some((p) => p.text.toLowerCase() === "squeaky rubber duck") && (await hasAddControl()) === false,
      JSON.stringify(againPicks)
    );
    await backHome();

    // ── 3. the review surface ─────────────────────────────────────────────
    await itemsTab();
    const pendingNow = await pendingReview();
    check("the review queue has the kiosk's additions", pendingNow.length >= 1, `${pendingNow.length} pending`);
    await page.waitForSelector("#kiosk-review-panel .dedup-banner-title", { timeout: 20000 });
    const banner = await visibleText("#kiosk-review-panel .dedup-banner-title");
    check(
      "the Items tab says items from the kiosk need a look",
      !!banner && /nee(d|ds) a look/.test(banner),
      String(banner)
    );
    check(
      "and says how many",
      !!banner && banner.indexOf(String(pendingNow.length)) === 0,
      `banner "${banner}" vs ${pendingNow.length} pending`
    );

    await openKioskReview("Squeaky Rubber Duck");
    const reviewText = await page.evaluate(
      () => (document.querySelector("#screen-admin-detail .detail-content") || {}).textContent || ""
    );
    check("Review opens a screen listing what the kiosk added", true);
    check(
      "the row names whoever took it out",
      /Kiosk Creator/.test(reviewText),
      reviewText.replace(/\s+/g, " ").slice(0, 200)
    );

    // Keep is one of the answers, and it clears the flag -- which is the point of
    // the flag at all.
    const kept = await rowAction("Squeaky Rubber Duck", "keep");
    check("the review row offers Keep", kept === "ok", kept);
    const duckAfterKeep = await waitUntil(async () => {
      const d = await itemByName("Squeaky Rubber Duck");
      return d && d.needsReview === false ? d : null;
    });
    check("Keep clears the review flag on the item", !!duckAfterKeep);
    check("and the item is still in the catalog", !!duckAfterKeep && duckAfterKeep.isArchived === false);
    const stillListed = await page.evaluate(
      () =>
        /Squeaky Rubber Duck/.test(
          (document.querySelector("#screen-admin-detail .detail-content") || {}).textContent || ""
        )
    );
    check("and is gone from the review list", stillListed === false);

    // ── 4. a merge that sticks ────────────────────────────────────────────
    // The owner's requirement: "combine and merge duplicate items if people are
    // entering Room 115 or 115". A merge has to make the losing name keep working,
    // or the duplicate is back by lunchtime -- so this checks the alias, not just
    // that two rows became one.
    await gotoWelcome();
    await kioskWalkToNeed("Merge Victim");
    await fill("#kiosk-need", "Room 115 Extra");
    await page.waitForSelector('[data-action="kiosk-confirm-pick"][data-adds="1"]', { timeout: 10000 });
    await clickIn("screen-kiosk-borrow-need", '[data-action="kiosk-confirm-pick"]');
    await kioskDoneText();
    await backHome();

    const victim = await waitUntil(async () => await itemByName("Room 115 Extra"));
    check("the duplicate to be merged exists and is out on loan", !!victim && victim.needsReview === true);
    const victimLoanBefore = victim
      ? (await dbLoans()).find((l) => Number(l.itemId) === Number(victim.id) && l.isOpen === "open")
      : null;
    check("with an open loan against it", !!victimLoanBefore);

    await openKioskReview("Room 115 Extra");

    // The guard first, because it is reachable in exactly this state and it is a
    // good answer: both entries are out, so moving the loan would leave one
    // physical item carrying two open loans. "115 Key" is still out from the
    // matching checks above, which is what makes this the honest first move rather
    // than a contrivance.
    await clearToasts();
    const refused = await mergeInto("Room 115 Extra", "115 Key");
    check("the review row offers to merge into an existing entry", refused === "ok", refused);
    const refusedToast = await waitToast(/both entries are checked out/i);
    check(
      "merging two entries that are both out is refused, and says why",
      !!refusedToast,
      await toastText()
    );
    const notMerged = await itemByName("Room 115 Extra");
    check(
      "and the refusal leaves the catalog alone",
      !!notMerged && notMerged.isArchived === false && notMerged.mergedIntoId == null,
      notMerged ? JSON.stringify({ archived: notMerged.isArchived, into: notMerged.mergedIntoId }) : "missing"
    );

    // Now make it possible, the way staff do, and merge for real.
    const checkedIn = await staffCheckIn("115 Key");
    check("staff can check an item back in", checkedIn === "ok", checkedIn);
    const keyIsFree = await waitUntil(async () => {
      const open = (await dbLoans()).filter(
        (l) => l.isOpen === "open" && l.itemNameSnapshot === "115 Key"
      );
      return open.length === 0;
    });
    check("and the item is no longer out", keyIsFree === true);

    await openKioskReview("Room 115 Extra");
    await clearToasts();
    const merged = await mergeInto("Room 115 Extra", "115 Key");
    check("merging is confirmed once only the duplicate is out", merged === "ok", merged);
    const mergeToast = await waitToast(/merged into/i);
    check("and the desk is told what moved", !!mergeToast, await toastText());

    const mergedVictim = await waitUntil(async () => {
      const v = await itemByName("Room 115 Extra");
      return v && v.mergedIntoId != null ? v : null;
    }, 20000);
    check("merging archives the entry it absorbed", !!mergedVictim && mergedVictim.isArchived === true);
    check(
      "recording what it was merged into",
      !!mergedVictim && Number(mergedVictim.mergedIntoId) === 7005,
      mergedVictim ? String(mergedVictim.mergedIntoId) : "missing"
    );
    check(
      "and keeping a record of what moved, so the merge can be undone",
      !!mergedVictim &&
        !!mergedVictim.mergeMeta &&
        Array.isArray(mergedVictim.mergeMeta.loanIds) &&
        mergedVictim.mergeMeta.loanIds.length === 1,
      mergedVictim ? JSON.stringify(mergedVictim.mergeMeta) : "missing"
    );
    const keeper = await itemByName("115 Key");
    check(
      "the survivor remembers the name it absorbed",
      !!keeper && (keeper.aliases || []).some((a) => a && a.k === "115 extra"),
      keeper ? JSON.stringify(keeper.aliases) : "missing"
    );
    const victimLoanAfter = victimLoanBefore ? (await dbLoans()).find((l) => l.id === victimLoanBefore.id) : null;
    check(
      "the loan moved to the survivor",
      !!victimLoanAfter && Number(victimLoanAfter.itemId) === 7005,
      victimLoanAfter ? String(victimLoanAfter.itemId) : "missing"
    );

    // The point of all of it: the losing name still finds the survivor.
    await gotoWelcome();
    await kioskWalkToNeed("After Merge");
    await fill("#kiosk-need", "Room 115 Extra");
    await page.waitForSelector("#kiosk-need-suggestions .kiosk-suggestion", { timeout: 10000 });
    const afterMergePicks = await kioskSuggestions();
    check(
      "the merged-away name now finds the survivor",
      afterMergePicks.some((p) => p.text === "115 Key"),
      JSON.stringify(afterMergePicks)
    );
    check("and is not offered as a new item", (await hasAddControl()) === false);
    await backHome();

    // ── 5. undoing the merge ──────────────────────────────────────────────
    // Silent attachment is only survivable because a wrong merge can be put back.
    // Everything the merge took has to come back, including the alias -- leaving
    // that behind is what would make the resurrected name unreachable.
    await itemsTab();
    await itemsSearch("Room 115 Extra");
    await sleep(700);
    const openedVictim = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("#items-content > .admin-list-item")).find((r) =>
        /Room 115 Extra/.test(r.textContent)
      );
      if (!row) return "not found";
      row.click();
      return "ok";
    });
    check("the archived entry is reachable from the Items list", openedVictim === "ok", openedVictim);
    await page.waitForFunction(
      () =>
        ((document.querySelector("#screen-admin-detail .detail-title") || {}).textContent || "").trim() ===
        "Room 115 Extra",
      { timeout: 20000 }
    );
    check(
      "and offers Undo merge instead of a plain unarchive",
      (await page.evaluate(() => !!document.querySelector('#screen-admin-detail [data-action="unmerge-item"]'))) ===
        true
    );
    await clickEl('#screen-admin-detail [data-action="unmerge-item"]');
    await page.waitForSelector("#dialog:not(.hidden)", { timeout: 15000 });
    // Whitespace-tolerant: the copy wraps mid-sentence in its template, so a regex
    // with a literal single space would never match what textContent holds.
    const undoCopy = (await dialogText()).replace(/\s+/g, " ");
    check("the confirmation says what comes back", /still out/i.test(undoCopy), undoCopy.slice(0, 240));
    check("and what does not", /nothing is deleted/i.test(undoCopy), undoCopy.slice(0, 240));
    check("and undoing is confirmed", (await dialogButton(/undo merge/i)) === "ok");

    const victimBack = await waitUntil(async () => {
      const v = await itemByName("Room 115 Extra");
      return v && v.mergedIntoId == null ? v : null;
    }, 20000);
    check(
      "undoing the merge puts the entry back in the catalog",
      !!victimBack && victimBack.isArchived === false,
      victimBack ? String(victimBack.isArchived) : "missing"
    );
    check(
      "its checkout count comes back with it",
      !!victimBack && victimBack.timesCheckedOut === 1,
      victimBack ? String(victimBack.timesCheckedOut) : "missing"
    );
    const keeperAfterUndo = await itemByName("115 Key");
    check(
      "the survivor no longer claims the resurrected name",
      !!keeperAfterUndo && !(keeperAfterUndo.aliases || []).some((a) => a && a.k === "115 extra"),
      keeperAfterUndo ? JSON.stringify(keeperAfterUndo.aliases) : "missing"
    );
    const loanBack = victimLoanBefore ? (await dbLoans()).find((l) => l.id === victimLoanBefore.id) : null;
    check(
      "a loan that is still out comes back with it",
      !!loanBack && Number(loanBack.itemId) === Number(victim.id),
      loanBack ? String(loanBack.itemId) : "missing"
    );
    check(
      "with its original item name restored",
      !!loanBack && loanBack.itemNameSnapshot === "Room 115 Extra",
      loanBack ? String(loanBack.itemNameSnapshot) : "missing"
    );

    // ── 6. the regression the desk actually reported ──────────────────────
    // An item added from the staff checkout step was invisible to the kiosk until
    // the page reloaded, because `createItem` was not one of the four places that
    // invalidated the catalog cache. An empty catalog made it unfalsifiable: with
    // nothing in the catalog, "the kiosk cannot find it" looks exactly like "the
    // kiosk has nothing to find". No reload here, on purpose -- a reload is what
    // hid the bug.
    await gotoStaff();
    await checkoutToItems("4165559999", "Regression Tester");
    const addedAtDesk = await checkoutAddItem("Post-it Notes");
    check("the desk can add an item from the checkout step", !!addedAtDesk);

    await gotoWelcome();
    await kioskWalkToNeed("Cache Tester");
    await fill("#kiosk-need", "Post-it Notes");
    await page.waitForSelector("#kiosk-need-suggestions .kiosk-suggestion", { timeout: 10000 });
    const cachePicks = await kioskSuggestions();
    check(
      "and the kiosk finds it immediately, without a reload",
      cachePicks.some((p) => p.text === "Post-it Notes"),
      JSON.stringify(cachePicks)
    );
    check("so it is not offered as a new item either", (await hasAddControl()) === false);
    await backHome();

    // ── 7. ten thousand items ─────────────────────────────────────────────
    // Seeded inside the evaluated function from a count, not serialised in as
    // arguments: 10,000 records is megabytes of JSON to marshal, and the ids are
    // built here so they stay clear of everything above.
    const beforeSeed = (await dbItems()).length;
    await page.evaluate(
      () =>
        new Promise((res, rej) => {
          const q = indexedDB.open("frontdesk");
          q.onerror = () => rej(q.error);
          q.onsuccess = () => {
            const now = Date.now();
            const tx = q.result.transaction(["items"], "readwrite");
            tx.oncomplete = () => res(true);
            tx.onerror = () => rej(tx.error);
            const store = tx.objectStore("items");
            for (let i = 0; i < 10000; i++) {
              const name = "Scale Widget " + i;
              store.put({
                id: 20000 + i,
                name,
                nameLower: name.toLowerCase(),
                category: "Other",
                location: "",
                condition: "good",
                notes: "",
                timesCheckedOut: 0,
                lastCheckedOutAt: null,
                isArchived: false,
                createdAt: now
              });
            }
          };
        })
    );
    const total = (await dbItems()).length;
    check("ten thousand items are in the catalog", total === beforeSeed + 10000, `${total} items`);

    // Wait out the catalog cache's TTL before reading through the app.
    //
    // The seed above writes straight to IndexedDB, which is the only way to get
    // 10,000 rows in without marshalling megabytes through `page.evaluate` -- and
    // the price is that it bypasses the app, so nothing invalidates the app's
    // cached catalog. That cache is a self-healing backstop with a 1.5s TTL: the
    // next read after it expires refetches. Waiting it out makes the following
    // checks deterministic instead of a race that a fast machine loses -- which is
    // exactly the shape of the flake this suite exists to catch, so it must not
    // have one of its own.
    //
    // The count-line check below is what proves the app's own read path picked the
    // seed up: it reports the true total, which only the real catalog can give.
    await sleep(1800);

    // The admin list: capped, honest about the total, and quick.
    const tItems = Date.now();
    await itemsTab();
    await page.waitForFunction(() => !!document.querySelector("#items-content > .loan-meta"), { timeout: 30000 });
    const itemsMs = Date.now() - tItems;
    const rows = await itemRows();
    check("the Items list draws at most its cap", rows <= 200, `${rows} rows`);
    check("and draws a useful number of them", rows === 200, `${rows} rows`);
    const countLine = await itemCountLine();
    check(
      "the count line reports the true total, not the cap",
      !!countLine && countLine.indexOf(String(total)) !== -1,
      String(countLine)
    );
    check(
      "it says the list is a window, not the whole catalog",
      !!countLine && /^Showing 200 of/.test(countLine),
      String(countLine)
    );
    check(`the Items list opens in reasonable time at ${total} items`, itemsMs < 8000, `${itemsMs}ms`);

    const moreLabel = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("#items-content > button")).find((x) =>
        /Show \d+ more/.test(x.textContent)
      );
      return b ? b.textContent.trim() : null;
    });
    check("there is a way to see more", !!moreLabel && /Show 200 more/.test(moreLabel), String(moreLabel));
    if (moreLabel) {
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("#items-content > button")).find((x) =>
          /Show \d+ more/.test(x.textContent)
        );
        if (b) b.click();
      });
      await page
        .waitForFunction(() => document.querySelectorAll("#items-content > .admin-list-item").length > 200, {
          timeout: 15000
        })
        .catch(() => {});
      check("and it draws more rows when asked", (await itemRows()) > rows, `${await itemRows()} rows`);
    }

    // Typing narrows it -- the way in at this size.
    await itemsSearch("Scale Widget 9999");
    await sleep(800);
    const narrowed = await itemRows();
    check("typing narrows the list to what was asked for", narrowed > 0 && narrowed < 20, `${narrowed} rows`);
    check(
      "and the row asked for is the one shown",
      /Scale Widget 9999\b/.test(String(await visibleText("#items-content")))
    );

    // The staff checkout step with an empty box: the frequent strip and a capped
    // list, never 10,000 cards.
    await gotoStaff();
    await checkoutToItems("4165557777", "Scale Tester", 10000);
    await fill("#screen-checkout .step-items .search-input", "");
    await page.waitForFunction(
      () =>
        /ALL ITEMS/.test(
          (document.querySelector("#screen-checkout .item-section:nth-of-type(2) .section-title") || {})
            .textContent || ""
        ),
      { timeout: 30000 }
    );
    // One read of the rendered list, so a failure reports the whole shape of what
    // was on screen -- how many cards, whether a note was there and what it said --
    // plus the store's own count at that instant. Without that last number there is
    // no way to tell a view that is capped from a read that came back short, and
    // those are very different bugs.
    // One read of the rendered list, so a failure reports the whole shape of what
    // was on screen -- how many cards, whether a note was there and what it said --
    // plus the store's own count at that instant. Without that last number there is
    // no way to tell a view that is capped from a read that came back short, and
    // those are very different bugs.
    const checkoutList = await page.evaluate(async () => {
      const wrap = document.querySelector("#screen-checkout .all-items");
      const note = wrap ? wrap.querySelector(".item-list-empty") : null;
      const head = document.querySelector("#screen-checkout .item-section:nth-of-type(2) .section-title");
      const inStore = await new Promise((res) => {
        const q = indexedDB.open("frontdesk");
        q.onerror = () => res(-1);
        q.onsuccess = () => {
          const r = q.result.transaction(["items"], "readonly").objectStore("items").count();
          r.onsuccess = () => res(r.result);
          r.onerror = () => res(-2);
        };
      });
      return {
        cards: wrap ? wrap.querySelectorAll(".item-card").length : -1,
        heading: head ? head.textContent.trim() : null,
        note: note ? note.textContent.replace(/\s+/g, " ").trim() : null,
        inStore
      };
    });
    check("the catalog is still ten thousand strong in the store", checkoutList.inStore > 10000, JSON.stringify(checkoutList));
    check(
      "the checkout list draws at most its cap",
      checkoutList.cards > 0 && checkoutList.cards <= 60,
      JSON.stringify(checkoutList)
    );
    check(
      "and says how much of the catalog is not shown",
      /Showing the first 60 of/.test(String(checkoutList.note)),
      JSON.stringify(checkoutList)
    );

    // The kiosk typeahead at this size: at most five rows, and an answer quickly
    // enough that a borrower is not tapping at a stale list.
    await gotoWelcome();
    await kioskWalkToNeed("Typeahead Tester");
    const tType = Date.now();
    await fill("#kiosk-need", "Scale Widget 9999");
    await page.waitForSelector("#kiosk-need-suggestions .kiosk-suggestion", { timeout: 15000 });
    const typeMs = Date.now() - tType;
    const scalePicks = await kioskSuggestions();
    check("the kiosk typeahead stays at five rows", scalePicks.length <= 5, `${scalePicks.length} rows`);
    check(
      "and offers the item that was typed",
      scalePicks.some((p) => p.text === "Scale Widget 9999"),
      JSON.stringify(scalePicks)
    );
    check(`the kiosk answers a keystroke at ${total} items inside 1.5s`, typeMs < 1500, `${typeMs}ms`);
    await backHome();

    // ── a name a form cannot use, and a number that cannot be dialled ──────
    // The same bug twice: a surface accepted something, handed it to code that
    // refuses it, and said nothing. On the item paths the refusal was a throw out
    // of a click handler whose dialog had already closed -- no item, no message,
    // a rejection in the console and nothing else. On the phone path it built an
    // anchor with href="", which is not inert: the browser resolves it to the
    // current page, so tapping Call reloaded the whole app.

    const itemsBefore = (await dbItems()).length;

    // 1. The staff checkout step, a name of pure punctuation.
    await gotoStaff();
    await checkoutToItems("4165558888", "Punctuation Tester", 1);
    await fill("#screen-checkout .step-items .search-input", "...");
    const addRow = await page
      .waitForSelector("#screen-checkout .all-items .add-new-row", { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check("a name of pure punctuation is still offered as an add", addRow, "no add row appeared");
    if (addRow) {
      await clickIn("screen-checkout", ".all-items .add-new-row");
      const said = await waitToast(/letter or digit/i);
      check(
        "adding it says why it cannot be added, rather than failing silently",
        !!said,
        `toast said: ${JSON.stringify(await toastText())}`
      );
      check(
        "and nothing is written to the catalog",
        (await dbItems()).length === itemsBefore,
        `${(await dbItems()).length} items, was ${itemsBefore}`
      );
      check("and no success toast claims otherwise", !/^Added /.test(await toastText()), await toastText());
    }
    await clearToasts();

    // 2. The admin's own Add item dialog, same name, same answer. Two surfaces
    //    creating items is exactly how they come to disagree.
    await itemsTab();
    await clickEl('#tab-items [data-action="add-item"]');
    await page.waitForSelector("#dialog:not(.hidden)", { timeout: 15000 });
    await fill("#dialog [data-f='name']", "???");
    check("the admin dialog takes the Add", (await dialogButton(/^add$/i)) === "ok");
    const adminSaid = await waitToast(/letter or digit/i);
    check(
      "the admin dialog says why too, and says it the same way",
      !!adminSaid,
      `toast said: ${JSON.stringify(await toastText())}`
    );
    check(
      "and it wrote nothing either",
      (await dbItems()).length === itemsBefore,
      `${(await dbItems()).length} items, was ${itemsBefore}`
    );
    await clearToasts();

    // 3. An open loan whose phone is not a number: two loans, one of each kind,
    //    so the check cannot pass by the buttons simply never rendering.
    await page.evaluate(
      () =>
        new Promise((res, rej) => {
          const q = indexedDB.open("frontdesk");
          q.onerror = () => rej(q.error);
          q.onsuccess = () => {
            const now = Date.now();
            const tx = q.result.transaction(["items", "loans"], "readwrite");
            tx.oncomplete = () => res(true);
            tx.onerror = () => rej(tx.error);
            const items = tx.objectStore("items");
            for (const [id, name] of [
              [7020, "Bad Phone Item"],
              [7021, "Good Phone Item"]
            ]) {
              items.put({
                id,
                name,
                nameLower: name.toLowerCase(),
                category: "Other",
                location: "",
                condition: "good",
                notes: "",
                timesCheckedOut: 1,
                lastCheckedOutAt: now,
                isArchived: false,
                createdAt: now
              });
            }
            const loans = tx.objectStore("loans");
            const row = (id, itemId, name, phone) => ({
              id,
              itemId,
              itemNameSnapshot: name,
              borrowerId: null,
              borrowerPhoneSnapshot: phone,
              borrowerNameSnapshot: "Walk-in",
              checkedOutAt: now - 36e5,
              dueAt: now - 36e5,
              returnedAt: null,
              isOpen: "open",
              conditionOut: "good",
              conditionIn: null,
              notes: "",
              recordedBy: "desk"
            });
            loans.put(row(7030, 7020, "Bad Phone Item", "x1234"));
            loans.put(row(7031, 7021, "Good Phone Item", "4165550100"));
          };
        })
    );

    await login();
    // The Overdue tab, not Currently Out: Call and Text live on the overdue card,
    // which is the one with a reason to ring someone.
    await clickEl('#screen-admin .tab[data-tab="overdue"]');
    await page.waitForFunction(
      () => document.querySelectorAll("#tab-overdue .admin-list .admin-list-item").length >= 2,
      { timeout: 20000 }
    );
    const phoneRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("#tab-overdue .admin-list .admin-list-item"));
      const read = (name) => {
        const r = rows.find((x) => (x.textContent || "").indexOf(name) !== -1);
        if (!r) return null;
        const anchors = Array.from(r.querySelectorAll("a"));
        return {
          hrefs: anchors.map((a) => a.getAttribute("href")),
          empty: anchors.filter((a) => !a.getAttribute("href")).length,
          buttons: Array.from(r.querySelectorAll("button")).map((b) => b.textContent.trim()),
          text: r.textContent.replace(/\s+/g, " ").trim()
        };
      };
      return { bad: read("Bad Phone Item"), good: read("Good Phone Item") };
    });

    check("the loan with an unusable phone is on screen", !!phoneRows.bad, JSON.stringify(phoneRows.bad));
    check(
      "no anchor on it is left with an empty href, which would reload the app",
      !!phoneRows.bad && phoneRows.bad.empty === 0,
      JSON.stringify(phoneRows.bad && phoneRows.bad.hrefs)
    );
    check(
      "so Call and Text are not offered for it at all",
      !!phoneRows.bad && phoneRows.bad.hrefs.length === 0,
      JSON.stringify(phoneRows.bad && phoneRows.bad.hrefs)
    );
    check(
      "but Copy is, so the number is still reachable",
      !!phoneRows.bad && phoneRows.bad.buttons.some((b) => /copy/i.test(b)),
      JSON.stringify(phoneRows.bad && phoneRows.bad.buttons)
    );
    check(
      "and it is shown as it was typed, not half-formatted into a number it is not",
      // "(123) 4" is what formatPhone makes of the extension "x1234", and it is
      // what Copy would have handed over. The row shows what the desk entered.
      !!phoneRows.bad && /x1234/.test(String(phoneRows.bad.text)),
      phoneRows.bad && phoneRows.bad.text
    );

    check("the loan with a real number still offers Call", !!phoneRows.good, JSON.stringify(phoneRows.good));
    check(
      "and a real number is still formatted for reading",
      !!phoneRows.good && /\(416\) 555-0100/.test(String(phoneRows.good.text)),
      phoneRows.good && phoneRows.good.text
    );
    check(
      "and its Call link is a tel: uri, not an empty one",
      !!phoneRows.good && phoneRows.good.hrefs.some((h) => h === "tel:+14165550100"),
      JSON.stringify(phoneRows.good && phoneRows.good.hrefs)
    );
    check(
      "and its Text link carries the item, so the message is specific",
      !!phoneRows.good && phoneRows.good.hrefs.some((h) => /^sms:\+14165550100\?body=/.test(String(h))),
      JSON.stringify(phoneRows.good && phoneRows.good.hrefs)
    );
    await clearToasts();

    // ── a number that moves, and a name that arrives under someone else's ──
    // Two silences, reported as nothing at all. Editing a borrower's number left
    // every open loan quoting the old one -- the overdue list, the receipt and
    // the CSV export all read the snapshot -- and left the formatted copy the
    // People search matches on empty. And adding a person on a number already on
    // record replaced the typed name with whoever owns it while still reporting
    // "Borrower added", so the desk went looking for someone never created.
    await page.evaluate(
      () =>
        new Promise((res, rej) => {
          const q = indexedDB.open("frontdesk");
          q.onerror = () => rej(q.error);
          q.onsuccess = () => {
            const now = Date.now();
            const tx = q.result.transaction(["items", "borrowers", "loans"], "readwrite");
            tx.oncomplete = () => res(true);
            tx.onerror = () => rej(tx.error);
            const borrowers = tx.objectStore("borrowers");
            for (const [id, name, phone] of [
              [7040, "Phone Changer", "4165550300"],
              [7050, "Jane Smith", "4165550400"]
            ]) {
              borrowers.put({
                id,
                name,
                nameLower: name.toLowerCase(),
                phone,
                phoneFormatted: `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`,
                contact2: "",
                notes: "",
                timesCheckedOut: 0,
                lastSeenAt: null,
                isArchived: false,
                createdAt: now
              });
            }
            const items = tx.objectStore("items");
            for (const [id, name] of [
              [7041, "Sync Item A"],
              [7042, "Sync Item B"]
            ]) {
              items.put({
                id,
                name,
                nameLower: name.toLowerCase(),
                category: "Other",
                location: "",
                condition: "good",
                notes: "",
                timesCheckedOut: 1,
                lastCheckedOutAt: now,
                isArchived: false,
                createdAt: now
              });
            }
            const loans = tx.objectStore("loans");
            const loan = (id, itemId, name, isOpen) => ({
              id,
              itemId,
              itemNameSnapshot: name,
              borrowerId: 7040,
              borrowerPhoneSnapshot: "4165550300",
              borrowerNameSnapshot: "Phone Changer",
              checkedOutAt: now - 36e5,
              dueAt: now + 36e5,
              returnedAt: isOpen === "open" ? null : now - 6e5,
              isOpen,
              conditionOut: "good",
              conditionIn: null,
              notes: "",
              recordedBy: "desk"
            });
            loans.put(loan(7043, 7041, "Sync Item A", "open"));
            loans.put(loan(7044, 7042, "Sync Item B", "closed"));
          };
        })
    );

    // Read the borrower and both loans in one transaction, so the three
    // assertions below describe one moment rather than three.
    const readPhoneChange = () =>
      page.evaluate(
        () =>
          new Promise((res, rej) => {
            const q = indexedDB.open("frontdesk");
            q.onerror = () => rej(q.error);
            q.onsuccess = () => {
              const t = q.result.transaction(["borrowers", "loans"]);
              const out = {};
              t.objectStore("borrowers").get(7040).onsuccess = function () {
                out.borrower = this.result;
              };
              t.objectStore("loans").get(7043).onsuccess = function () {
                out.open = this.result;
              };
              t.objectStore("loans").get(7044).onsuccess = function () {
                out.closed = this.result;
              };
              t.oncomplete = () => {
                q.result.close();
                res(out);
              };
              t.onerror = () => rej(t.error);
            };
          })
      );

    await login();
    await clickEl('#screen-admin .tab[data-tab="people"]');
    await page.waitForSelector("#tab-people #people-content .admin-list-item", { timeout: 20000 });
    // Narrowed first, because the list is sorted and the row under the cursor is
    // whatever the sort chose -- clicking "the first row" is how a test passes
    // against the wrong person.
    await fill('#tab-people input[data-filter="q"]', "Phone Changer");
    const openedPerson = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("#tab-people #people-content .admin-list-item")).find((x) =>
        /Phone Changer/.test(x.textContent)
      );
      if (!row) return false;
      row.click();
      return true;
    });
    check("the person whose number is about to change is on screen", openedPerson === true);
    await page.waitForSelector('[data-action="edit-borrower"]', { timeout: 15000 });
    await clickEl('[data-action="edit-borrower"]');
    await page.waitForSelector('#dialog [data-f="phone"]', { timeout: 10000 });
    await fill('#dialog [data-f="phone"]', "4165550399");
    const savedEdit = await dialogButton(/^save$/i);
    check("the edit takes a new number and saves it", savedEdit === "ok", savedEdit);

    // Saving writes the person, then carries the number onto their open loans
    // in a second transaction, so the read waits for that to land rather than
    // racing it. It still fails if the loan never changes.
    let afterEdit = await readPhoneChange();
    for (let i = 0; i < 50 && !(afterEdit.open && afterEdit.open.borrowerPhoneSnapshot === "4165550399"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      afterEdit = await readPhoneChange();
    }
    check(
      "the copy the People search reads is written along with the number",
      afterEdit.borrower && afterEdit.borrower.phoneFormatted === "(416) 555-0399",
      JSON.stringify(afterEdit.borrower && afterEdit.borrower.phoneFormatted)
    );
    check(
      "the loan that is still out quotes the new number, so the desk rings the right one",
      afterEdit.open && afterEdit.open.borrowerPhoneSnapshot === "4165550399",
      JSON.stringify(afterEdit.open && afterEdit.open.borrowerPhoneSnapshot)
    );
    check(
      "the loan already returned is left as history, not rewritten",
      afterEdit.closed && afterEdit.closed.borrowerPhoneSnapshot === "4165550300",
      JSON.stringify(afterEdit.closed && afterEdit.closed.borrowerPhoneSnapshot)
    );

    // The other silence. Jane is on record at this number, and the desk adds a
    // person under it by hand -- the one path where the number is the identity and
    // the typed name is what gets dropped. "Borrower added" would be a lie in the
    // way that matters: the desk would go looking for someone never created.
    await clearToasts();
    const openedAdd = await page.evaluate(() => {
      const b = document.querySelector('#tab-people [data-action="add-borrower"]');
      if (!b) return false;
      b.click();
      return true;
    });
    check("the People tab offers to add a person", openedAdd === true);
    await page.waitForSelector('#dialog [data-f="name"]', { timeout: 10000 });
    await fill('#dialog [data-f="name"]', "Bob Jones");
    await fill('#dialog [data-f="phone"]', "4165550400");
    const addedKnown = await dialogButton(/^add$/i);
    check("adding a person on a number already on record is submitted", addedKnown === "ok", addedKnown);
    const numberTakenToast = await waitToast(/already on record for Jane Smith/i);
    check(
      "and the desk is told whose number it is, instead of that a person was added",
      !!numberTakenToast,
      await toastText()
    );
    check(
      "no success toast contradicts it",
      !/Borrower added/i.test(await toastText()),
      await toastText()
    );

    const people = await page.evaluate(
      () =>
        new Promise((res, rej) => {
          const q = indexedDB.open("frontdesk");
          q.onerror = () => rej(q.error);
          q.onsuccess = () => {
            const r = q.result.transaction("borrowers").objectStore("borrowers").getAll();
            r.onsuccess = () => {
              const rows = r.result || [];
              q.result.close();
              res({
                onNumber: rows.filter((b) => b.phone === "4165550400").length,
                bobs: rows.filter((b) => /bob jones/i.test(b.name)).length
              });
            };
            r.onerror = () => rej(r.error);
          };
        })
    );
    check(
      "and no second person was quietly created for that number",
      people.onNumber === 1 && people.bobs === 0,
      JSON.stringify(people)
    );

    // The control. A refusal that also refuses the ordinary case would pass every
    // check above and break the People tab.
    await clearToasts();
    await page.evaluate(() => {
      document.querySelector('#tab-people [data-action="add-borrower"]').click();
    });
    await page.waitForSelector('#dialog [data-f="name"]', { timeout: 10000 });
    await fill('#dialog [data-f="name"]', "Nadia Okafor");
    await fill('#dialog [data-f="phone"]', "4165550455");
    const addedNew = await dialogButton(/^add$/i);
    check("a person on a number nobody else has is added", addedNew === "ok", addedNew);
    const addedToast = await waitToast(/Borrower added/i);
    check("and that is what the desk is told", !!addedToast, await toastText());
    check(
      "and the new person is really in the store",
      (await page.evaluate(
        () =>
          new Promise((res, rej) => {
            const q = indexedDB.open("frontdesk");
            q.onerror = () => rej(q.error);
            q.onsuccess = () => {
              const r = q.result.transaction("borrowers").objectStore("borrowers").getAll();
              r.onsuccess = () => {
                const n = (r.result || []).filter((b) => b.phone === "4165550455").length;
                q.result.close();
                res(n);
              };
              r.onerror = () => rej(r.error);
            };
          })
      )) === 1
    );

    // Wipe uses this suite's disposable browser profile, never desk data.
    // Warm the catalog first so a forgotten invalidation cannot pass on a cold cache.
    await kioskWalkToNeed("Before Wipe");
    await fill("#kiosk-need", "Projector");
    await page.waitForSelector("#kiosk-need-suggestions .kiosk-suggestion", { timeout: 10000 });
    await backHome();
    await login();
    await clickEl('#screen-admin .tab[data-tab="settings"]');
    await page.waitForSelector('#tab-settings [data-action="wipe"]', { timeout: 10000 });

    await page.evaluate(() => new Promise((resolve, reject) => {
      const q = indexedDB.open("frontdesk");
      q.onerror = () => reject(q.error);
      q.onsuccess = () => {
        const db = q.result;
        const tx = db.transaction(["requests", "settings"], "readwrite");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
        tx.objectStore("requests").put({ id: 900001, status: "pending", borrowerId: 1, createdAt: Date.now(), name: "Wipe fixture" });
        tx.objectStore("settings").put({ id: 55, pin: "legacy-fixture", endOfDayHour: 21 });
        const req = tx.objectStore("settings").get(1);
        req.onsuccess = () => tx.objectStore("settings").put({ ...req.result, endOfDayHour: 20, wipeFixture: true });
      };
    }));
    const stores = ["items", "borrowers", "loans", "settings", "requests"];
    const snapshot = async () => {
      const data = await openDb(stores);
      return stores.map((name) => JSON.stringify(data[name])).join("\n");
    };
    const beforeWipe = await snapshot();
    const openWipe = async () => {
      await clearToasts();
      await clickEl('#tab-settings [data-action="wipe"]');
      await page.waitForSelector('#dialog [data-f="confirm"]', { timeout: 10000 });
    };
    await openWipe();
    check("wipe explains every store, settings reset, and backing up first",
      /request.*reset settings.*Make a backup first.*Existing backup files are kept/s.test(await dialogText()));
    await dialogButton(/^cancel$/i);
    await page.waitForFunction(() => document.getElementById("dialog").classList.contains("hidden"));
    check("cancelling wipe leaves every stored record unchanged", await snapshot() === beforeWipe);

    for (const wrong of ["", "delete", "DELETE ", "DELET"]) {
      await openWipe();
      await fill('#dialog [data-f="confirm"]', wrong);
      await dialogButton(/^wipe$/i);
      await waitToast(/Confirmation text didn't match/i);
      check(`wipe refuses ${JSON.stringify(wrong)} without changing any store`, await snapshot() === beforeWipe);
      await page.waitForFunction(() => document.getElementById("dialog").classList.contains("hidden"));
    }
    await openWipe();
    await fill('#dialog [data-f="confirm"]', "DELETE");
    await dialogButton(/^wipe$/i);
    const wiped = await waitToast(/All data wiped/i);
    check("confirmed wipe reports success", !!wiped, await toastText());
    const afterWipe = await openDb(stores);
    check("confirmed wipe clears items, borrowers, loans and requests",
      ["items", "borrowers", "loans", "requests"].every((name) => afterWipe[name].length === 0));
    check("wipe removes legacy settings and recreates the complete defaults",
      afterWipe.settings.length === 1 && JSON.stringify(afterWipe.settings[0]) === JSON.stringify({
        id: 1, pin: "1234", defaultLoanHours: 8, endOfDayHour: 17, theme: "dark",
        lastBackupAt: null, pinFailures: 0, pinLockedUntil: 0, schemaVersion: 1
      }), JSON.stringify(afterWipe.settings));
    await itemsTab();
    check("admin catalog immediately stops showing the wiped rows", await itemRows() === 0);
    await kioskWalkToNeed("After Wipe");
    await fill("#kiosk-need", "Projector");
    await page.waitForSelector('[data-action="kiosk-confirm-pick"][data-adds="1"]', { timeout: 10000 });
    check("kiosk cache no longer offers a wiped item",
      await page.$$eval("#kiosk-need-suggestions .kiosk-suggestion", (rows) => rows.length === 0));

    const lateErrors = errors.filter((e) => !/favicon/i.test(e));
    check("no console errors through the whole run", lateErrors.length === 0, lateErrors.join(" | "));

    console.log("");
  } finally {
    await browser.close();
    server.close();
  }

  if (failures) {
    console.error(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("all checks passed\n");
})().catch((err) => {
  console.error("\nThe run itself failed:", (err && err.stack) || err);
  process.exit(1);
});
