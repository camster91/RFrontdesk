// The backup round trip: export, lose everything, restore.
//
//   node tools/test-restore.cjs
//
// This is the one operation that can destroy the whole desk's data, so it is
// checked end to end through the app's own UI rather than by calling the
// functions directly: the export button is clicked, the file the app produced
// is fed back through the real import file input, and the database is read
// afterwards.
//
// The exported JSON is captured by wrapping URL.createObjectURL before any page
// script runs, so what is tested is the exact text the app meant to write to
// disk -- no download plumbing, no re-serialising it here.
//
// Fixtures are written straight into IndexedDB, mirroring the record shapes the
// app itself writes (createItem / upsertBorrower / createLoan / getSettings).
// The code under test is export and import, not the seeding.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..", "web");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8799;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`  ok  ${name}`);
    return;
  }
  failures++;
  console.error(`FAIL  ${name}${detail === undefined ? "" : "  -> " + detail}`);
};

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]);
    if (rel === "/favicon.ico") return void res.writeHead(204).end();
    const file = path.join(ROOT, rel === "/" ? "/index.html" : rel);
    if (!file.startsWith(ROOT)) return void res.writeHead(403).end("forbidden");
    fs.readFile(file, (err, body) => {
      if (err) return void res.writeHead(404).end("not found");
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

// A dataset with something in every store, non-default settings, and a
// distinctive PIN so a reset to "1234" cannot pass unnoticed.
const LOAN_OPEN = {
  id: 1,
  itemId: 1,
  itemNameSnapshot: "Clicker",
  borrowerId: 1,
  borrowerPhoneSnapshot: "4165550101",
  borrowerNameSnapshot: "Ada Lovelace",
  checkedOutAt: 1700000000000,
  dueAt: 1700003600000,
  returnedAt: null,
  isOpen: "open",
  conditionOut: "good",
  conditionIn: null,
  notes: "",
  recordedBy: "staff"
};
const LOAN_CLOSED = {
  id: 2,
  itemId: 2,
  itemNameSnapshot: "Hdmi Dongle",
  borrowerId: 2,
  borrowerPhoneSnapshot: "4165550102",
  borrowerNameSnapshot: "Grace Hopper",
  checkedOutAt: 1700000000000,
  dueAt: 1700003600000,
  returnedAt: 1700001000000,
  isOpen: "closed",
  conditionOut: "good",
  conditionIn: "good",
  notes: "",
  recordedBy: "staff"
};

function fixture(pin) {
  return {
    items: [
      {
        id: 1,
        name: "Clicker",
        nameLower: "clicker",
        category: "Av Equipment",
        location: "Desk",
        condition: "good",
        notes: "",
        timesCheckedOut: 3,
        lastCheckedOutAt: 1700000000000,
        isArchived: false,
        createdAt: 1690000000000
      },
      {
        id: 2,
        name: "Hdmi Dongle",
        nameLower: "hdmi dongle",
        category: "Av Equipment",
        location: "Desk",
        condition: "good",
        notes: "",
        timesCheckedOut: 1,
        lastCheckedOutAt: 1700000000000,
        isArchived: false,
        createdAt: 1690000000000
      }
    ],
    borrowers: [
      {
        id: 1,
        phone: "4165550101",
        phoneFormatted: "(416) 555-0101",
        name: "Ada Lovelace",
        nameLower: "ada lovelace",
        contact2: "",
        timesCheckedOut: 2,
        lastSeenAt: 1700000000000,
        notes: "",
        isArchived: false,
        createdAt: 1690000000000
      },
      {
        id: 2,
        phone: "4165550102",
        phoneFormatted: "(416) 555-0102",
        name: "Grace Hopper",
        nameLower: "grace hopper",
        contact2: "",
        timesCheckedOut: 1,
        lastSeenAt: 1700000000000,
        notes: "",
        isArchived: false,
        createdAt: 1690000000000
      }
    ],
    loans: [
      Object.assign({}, LOAN_OPEN),
      Object.assign({}, LOAN_CLOSED),
      // The kiosk leaves its return request on the loan, not in `requests`.
      Object.assign({}, LOAN_OPEN, {
        id: 3,
        itemId: 2,
        borrowerId: 2,
        itemNameSnapshot: "Hdmi Dongle",
        borrowerNameSnapshot: "Grace Hopper",
        returnRequestedAt: 1700002000000,
        returnRequestedCondition: "damaged",
        returnRequestedNote: "one key is bent"
      })
    ],
    settings: [
      {
        id: 1,
        pin,
        defaultLoanHours: 5,
        endOfDayHour: 16,
        theme: "light",
        lastBackupAt: null,
        pinFailures: 0,
        pinLockedUntil: 0,
        schemaVersion: 1
      }
    ],
    requests: []
  };
}

(async () => {
  console.log("\nBackup round trip\n");

  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "frontdesk-restore-"));
  const errors = [];

  try {
    const page = await browser.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e && e.message)));
    await page.setViewport({ width: 1280, height: 1100 });

    // Capture the exact text the app hands to the download, before any page
    // script runs. Anything else it blobs (the CSV exports) is a different
    // type and is ignored.
    await page.evaluateOnNewDocument(() => {
      window.__exported = [];
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        try {
          if (blob && blob.type === "application/json") {
            blob.text().then((t) => window.__exported.push(t)).catch(() => {});
          }
        } catch (_) {}
        return orig(blob);
      };
      // Why the on-screen keyboard is where it is, if the probe ever needs it.
      document.addEventListener("DOMContentLoaded", () => {
        const kbd = document.getElementById("keyboard");
        if (!kbd) return;
        window.__kbdLog = ["kbd:" + kbd.className + " inert=" + kbd.inert];
        new MutationObserver(() => {
          window.__kbdLog.push("kbd:" + kbd.className + " inert=" + kbd.inert);
        }).observe(kbd, { attributes: true, attributeFilter: ["class", "inert"] });
      });
    });

    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 30000 });

    // ── fixtures ──────────────────────────────────────────────────────────
    // Opened without a version so this attaches to whatever the app created
    // instead of pinning a number that has to be updated alongside DB_VERSION.
    const seed = (data) =>
      page.evaluate(async (records) => {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open("frontdesk");
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const names = ["items", "borrowers", "loans", "settings", "requests"];
        await new Promise((res, rej) => {
          const tx = db.transaction(names, "readwrite");
          for (const n of names) {
            const store = tx.objectStore(n);
            store.clear();
            for (const rec of records[n] || []) store.put(rec);
          }
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
          tx.onabort = () => rej(tx.error);
        });
        db.close();
      }, data);

    const dump = () =>
      page.evaluate(async () => {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open("frontdesk");
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const names = ["items", "borrowers", "loans", "settings", "requests"];
        const out = {};
        for (const n of names) {
          out[n] = await new Promise((res, rej) => {
            const rq = db.transaction(n).objectStore(n).getAll();
            rq.onsuccess = () => res(rq.result);
            rq.onerror = () => rej(rq.error);
          });
          out[n].sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));
        }
        db.close();
        return out;
      });

    // ── login, the real way ───────────────────────────────────────────────
    const login = async (pin) => {
      await page.evaluate(() => window.app.showAdminLogin());
      await page.waitForSelector("#screen-admin-login:not(.hidden)", { timeout: 10000 });
      await page.evaluate(() => {
        const el = document.querySelector("#screen-admin-login .pin-input");
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.type("#screen-admin-login .pin-input", pin);
      await page.click("#screen-admin-login .pin-submit");
      const ok = await page
        .waitForSelector("#screen-admin:not(.hidden)", { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (!ok) {
        // Say what the app said rather than just "it did not work": a rejected
        // PIN, a lockout and a screen that never appeared look identical
        // otherwise.
        lastLoginFailure = await page.evaluate(() => ({
          typed: document.querySelector("#screen-admin-login .pin-input")?.value,
          screens: Array.from(document.querySelectorAll(".screen"))
            .filter((s) => !s.classList.contains("hidden"))
            .map((s) => s.id),
          toasts: Array.from(document.querySelectorAll("#toast .toast")).map((t) => t.textContent),
          loginText: document.querySelector("#screen-admin-login")?.textContent?.slice(0, 200)
        }));
        await page.evaluate(() => window.app.cancelAdminLogin && window.app.cancelAdminLogin());
        await sleep(300);
      }
      return ok;
    };
    let lastLoginFailure = null;

    // What the page looks like right now. A wait that times out says only that
    // it timed out; every failure of this suite so far has been something other
    // than the thing the message named, so ask the page directly.
    const probe = () =>
      page
        .evaluate(() => {
          const btn = document.querySelector('#tab-settings [data-action="export-json"]');
          const r = btn && btn.getBoundingClientRect();
          const cx = r ? Math.round(r.left + r.width / 2) : 0;
          const cy = r ? Math.round(r.top + r.height / 2) : 0;
          const at = r ? document.elementFromPoint(cx, cy) : null;
          return {
            screens: Array.from(document.querySelectorAll(".screen"))
              .filter((s) => !s.classList.contains("hidden"))
              .map((s) => s.id),
            activeTab: document.querySelector("#screen-admin .tab.active")?.dataset.tab,
            panelLength: document.querySelector("#tab-settings")?.innerHTML.length,
            panelHead: document.querySelector("#tab-settings")?.innerHTML.slice(0, 240),
            exportButton: r ? { x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height) } : null,
            hitsButton: !!(at && btn && (at === btn || btn.contains(at))),
            atPoint: at ? (at.id ? "#" + at.id : at.tagName) + "." + (at.className || "") : null,
            keyboard: (() => {
              const k = document.getElementById("keyboard");
              const r = k && k.getBoundingClientRect();
              return k
                ? { classes: k.className, inert: k.inert, top: Math.round(r.top), h: Math.round(r.height), log: window.__kbdLog }
                : null;
            })(),
            events: window.__events,
            toasts: Array.from(document.querySelectorAll("#toast .toast")).map((t) => t.textContent)
          };
        })
        // The page cannot see the console listener's list, so it is added here.
        .then((state) => Object.assign(state, { errors }));

    // The settings panel is rendered by an async function, so the tab click is
    // only half of it -- this waits for the panel's own buttons to exist.
    const gotoSettings = async () => {
      const tabsOk = await page
        .waitForSelector('.tab[data-tab="settings"]', { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      if (!tabsOk) throw new Error("the settings tab never appeared: " + JSON.stringify(await probe()));
      await page.click('.tab[data-tab="settings"]');
      const panelOk = await page
        .waitForSelector('#tab-settings [data-action="export-json"]', { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      if (!panelOk) throw new Error("the settings panel never rendered: " + JSON.stringify(await probe()));
    };

    const clearToasts = () =>
      page.evaluate(() => {
        document.querySelectorAll("#toast .toast").forEach((t) => t.remove());
      });

    // Drive the real import input. A fresh file name each time: re-selecting the
    // same path would not fire `change` a second time.
    let importSeq = 0;
    const importPayload = async (text, name) => {
      const file = path.join(tmp, name || `import-${importSeq++}.json`);
      fs.writeFileSync(file, text);
      await clearToasts();
      const input = await page.$('input[data-action="import-file"]');
      await input.uploadFile(file);
      // The handler is async; wait for it to report either way.
      const toast = await page
        .waitForFunction(
          () => {
            const t = document.querySelector("#toast .toast");
            return t && /Import/i.test(t.textContent) ? t.textContent : false;
          },
          { timeout: 10000 }
        )
        .then((h) => h.jsonValue())
        .catch(() => null);
      await sleep(150);
      return toast;
    };

    const exportNow = async () => {
      await clearToasts();
      await page.evaluate(() => {
        window.__exported = [];
        // Record the chain the export is supposed to walk -- the button
        // receiving the click, the blob being made, the link being followed.
        // A timeout on its own cannot say which link was missing.
        window.__events = [];
        const origCreate = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (b) => {
          window.__events.push("createObjectURL(" + (b && b.type) + ")");
          return origCreate(b);
        };
        const origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          window.__events.push("anchor.click(" + this.download + ")");
          return origClick.apply(this, arguments);
        };
        document.addEventListener(
          "click",
          (e) => {
            const t = e.target;
            const action = t.closest && t.closest("[data-action]");
            window.__events.push(
              "click at (" + Math.round(e.clientX) + "," + Math.round(e.clientY) + ") -> " +
              (action ? "action:" + action.dataset.action : (t.id ? "#" + t.id : t.tagName) + "." + (t.className || ""))
            );
          },
          true
        );
      });
      await page.click('#tab-settings [data-action="export-json"]');
      const got = await page
        .waitForFunction(() => window.__exported.length > 0, { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      // The export runs entirely in the page: exportAll reads the database,
      // triggerDownload blobs it and hands it to a link. A timeout here means
      // one of those did not happen, and the app's own toast says which --
      // "Could not save the file" only comes from the host path.
      if (!got) throw new Error("the export produced no JSON blob: " + JSON.stringify(await probe()));
      return JSON.parse(await page.evaluate(() => window.__exported[window.__exported.length - 1]));
    };

    // ── 1. a seeded desk, and a PIN that is really in force ───────────────
    await seed(fixture("4321"));
    const loggedIn = await login("4321");
    check("a desk seeded with a custom PIN can log in with it", loggedIn, JSON.stringify(lastLoginFailure));
    await gotoSettings();

    // ── 2. what the export actually contains ──────────────────────────────
    const exported = await exportNow();
    check("the export carries every store", ["items", "borrowers", "loans", "settings", "requests"].every((k) => Array.isArray(exported[k])), Object.keys(exported).join(","));
    check("with the items that exist", exported.items.length === 2, exported.items.length);
    check("the borrowers", exported.borrowers.length === 2, exported.borrowers.length);
    check("the loans", exported.loans.length === 3, exported.loans.length);
    check("the open loan is still open in the file", exported.loans.find((l) => l.id === 1)?.isOpen === "open");
    check("the kiosk's return request travels with its loan", exported.loans.find((l) => l.id === 3)?.returnRequestedNote === "one key is bent");
    check("the non-default loan duration is in the file", exported.settings[0]?.defaultLoanHours === 5, exported.settings[0]?.defaultLoanHours);
    check("and the file names its schema version", typeof exported.schemaVersion === "number", exported.schemaVersion);

    // The whole point of `includeSecrets: false`.
    check("the export does NOT contain the PIN", exported.settings[0] && !("pin" in exported.settings[0]), JSON.stringify(exported.settings[0]));
    check("it records that the PIN was withheld", exported.settings[0]?.pinOmitted === true, JSON.stringify(exported.settings[0]));

    // ── 3. lose everything, then restore ──────────────────────────────────
    const exportText = JSON.stringify(exported);
    await seed({ items: [], borrowers: [], loans: [], settings: [], requests: [] });
    const emptied = await dump();
    check("the desk can be emptied", emptied.items.length === 0 && emptied.loans.length === 0 && emptied.borrowers.length === 0, JSON.stringify({ i: emptied.items.length, l: emptied.loans.length, b: emptied.borrowers.length }));

    const importToast = await importPayload(exportText, "restore.json");
    check("the restore reports success", /Import complete/i.test(importToast || ""), importToast);

    const after = await dump();
    check("every item came back", after.items.length === 2, after.items.length);
    check("every borrower came back", after.borrowers.length === 2, after.borrowers.length);
    check("every loan came back", after.loans.length === 3, after.loans.length);
    check("with the open/closed states intact", after.loans.find((l) => l.id === 1)?.isOpen === "open" && after.loans.find((l) => l.id === 2)?.isOpen === "closed");
    check("and the return request intact", after.loans.find((l) => l.id === 3)?.returnRequestedNote === "one key is bent");
    check("the item counters survived", after.items.find((i) => i.id === 1)?.timesCheckedOut === 3, after.items.find((i) => i.id === 1)?.timesCheckedOut);
    check("the borrower records survived whole", after.borrowers.find((b) => b.id === 1)?.phone === "4165550101" && after.borrowers.find((b) => b.id === 1)?.name === "Ada Lovelace");
    check("the non-default settings were restored", after.settings[0]?.defaultLoanHours === 5 && after.settings[0]?.endOfDayHour === 16, JSON.stringify({ hours: after.settings[0]?.defaultLoanHours, eod: after.settings[0]?.endOfDayHour }));
    check("and the theme with them", after.settings[0]?.theme === "light", after.settings[0]?.theme);

    // Nothing was left behind from the emptied state.
    check("no store kept a stale record", after.items.length + after.borrowers.length + after.loans.length === 7);

    // A desk with no PIN of its own and a backup with no PIN ends up on the
    // documented factory default -- not on a blank or undefined PIN, which
    // would lock everyone out.
    check("a fresh desk restored from a PIN-less backup falls back to the factory PIN", after.settings[0]?.pin === "1234", after.settings[0]?.pin);
    check("and that PIN really works", await login("1234"));
    await gotoSettings();

    // ── 4. a backup is not a credential ───────────────────────────────────
    // The device's own PIN has to win, or restoring an old file would quietly
    // hand the admin panel to whoever has the file.
    await seed(Object.assign(fixture("9999"), {}));
    await gotoSettings();
    const pinToast = await importPayload(exportText, "restore-again.json");
    check("the second restore also reports success", /Import complete/i.test(pinToast || ""), pinToast);
    const pinAfter = await dump();
    check("importing a backup does not change this device's PIN", pinAfter.settings[0]?.pin === "9999", pinAfter.settings[0]?.pin);
    check("and the device's own PIN is the one that still logs in", await login("9999"));
    await gotoSettings();

    // ── 5. a bad backup changes nothing at all ────────────────────────────
    await seed(fixture("9999"));
    const before = await dump();
    const broken = JSON.parse(exportText);
    broken.loans[0].id = "not-a-number";
    const brokenToast = await importPayload(JSON.stringify(broken), "broken.json");
    check("a backup with a malformed record is refused", /Import failed/i.test(brokenToast || ""), brokenToast);
    check("and says what was wrong with it", /numeric id/i.test(brokenToast || ""), brokenToast);

    // The guarantee that matters: refused means untouched, not half-written.
    const afterBroken = await dump();
    check(
      "not one record was written by the refused import",
      JSON.stringify(afterBroken) === JSON.stringify(before),
      JSON.stringify({ items: afterBroken.items.length, loans: afterBroken.loans.length, borrowers: afterBroken.borrowers.length, pin: afterBroken.settings[0]?.pin })
    );

    // The three core stores are required. A file without one of them is refused
    // outright rather than read as "and that store is empty" -- otherwise a
    // truncated download of a half-written file would look like a desk that
    // had never had any items in it, and clearing is the one thing this must
    // never do by accident.
    const noItems = JSON.parse(exportText);
    delete noItems.items;
    const noItemsToast = await importPayload(JSON.stringify(noItems), "no-items.json");
    check("a backup with no items section is refused", /Import failed/i.test(noItemsToast || ""), noItemsToast);
    check("and says what it is missing", /missing required fields/i.test(noItemsToast || ""), noItemsToast);
    check("and nothing was written by that either", JSON.stringify(await dump()) === JSON.stringify(before));

    // The stores that are not part of the core three are optional -- settings
    // and requests -- and a backup that omits one leaves it alone, rather than
    // reading the omission as "that store is empty". The desk here is seeded
    // deliberately different from the backup in every store the file carries,
    // so "left alone" and "replaced" cannot be confused.
    const sparse = () => {
      const f = fixture("9999");
      f.items = [];
      f.loans = [];
      f.settings[0].defaultLoanHours = 7;
      return f;
    };
    await seed(sparse());
    const noOptional = JSON.parse(exportText);
    delete noOptional.settings;
    delete noOptional.requests;
    const optionalToast = await importPayload(JSON.stringify(noOptional), "no-optional.json");
    check("a backup with no settings or requests section is accepted", /Import complete/i.test(optionalToast || ""), optionalToast);
    const afterOptional = await dump();
    check("and still replaces the core stores it does carry", afterOptional.items.length === 2 && afterOptional.loans.length === 3, JSON.stringify({ i: afterOptional.items.length, l: afterOptional.loans.length }));
    check("while leaving the settings it never mentions alone", afterOptional.settings[0]?.defaultLoanHours === 7 && afterOptional.settings[0]?.pin === "9999", JSON.stringify(afterOptional.settings[0]));

    // ── 6. garbage is refused, not swallowed ──────────────────────────────
    await seed(fixture("9999"));
    const beforeJunk = await dump();
    const junkToast = await importPayload("this is not json at all", "junk.json");
    check("a file that is not JSON is refused", /Import failed/i.test(junkToast || ""), junkToast);
    check("with a message a person can act on", /JSON/i.test(junkToast || ""), junkToast);
    check("and nothing was written", JSON.stringify(await dump()) === JSON.stringify(beforeJunk));

    const emptyToast = await importPayload("{}", "empty.json");
    check("an empty object is refused", /Import failed/i.test(emptyToast || ""), emptyToast);
    check("and nothing was written by that either", JSON.stringify(await dump()) === JSON.stringify(beforeJunk));

    // ── 7. the restored data is usable, not just present ──────────────────
    // A round trip that restores records the app cannot then act on is not a
    // restore. The open loan has to be visible to staff and closable.
    await seed(fixture("9999"));
    await gotoSettings();
    await importPayload(exportText, "usable.json");
    await page.click('.tab[data-tab="currently-out"]');
    await sleep(600);
    const outTab = await page.evaluate(() => document.querySelector("#tab-currently-out").textContent);
    const outRows = await page.evaluate(() => document.querySelectorAll("#tab-currently-out .admin-list .loan-item").length);
    check("the restored open loan is listed as currently out", /Ada Lovelace/.test(outTab) && /Clicker/.test(outTab), outTab.slice(0, 200).replace(/\s+/g, " "));
    // Counted rather than matched by name: the closed loan and the third, open
    // one share both a borrower and an item, so text alone cannot tell them
    // apart. Three loans came back, one of them closed, so two rows.
    check("and the closed loan is not listed", outRows === 2, outRows);

    const realErrors = errors.filter((e) => !/favicon/.test(e));
    check("no console errors through the whole round trip", realErrors.length === 0, realErrors.join(" | "));
  } finally {
    await browser.close();
    server.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {}
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("\nall checks passed\n");
})().catch((err) => {
  console.error("\nThe run itself failed:", err && err.message);
  process.exit(1);
});
