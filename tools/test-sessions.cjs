// Who is at the screen: the kiosk's sessions, the admin lock, and the
// on-screen keyboard under a real tap.
//
//   node tools/test-sessions.cjs
//
// The Phase 13 read found that the boundaries the earlier phases built held at
// the front door and leaked at the edges -- a borrower's half-finished return
// that the next person could answer, a session nobody ended, a dialog that
// outlived the lock it was under, a Cancel that led past the lock, a keyboard
// that scrambled the phone number it was typing. Each is driven here through
// the real page, on a fresh profile, with the timers shortened rather than
// waited out.

const fs = require("fs");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..", "web");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8803;
const PIN = "1234";

const ALICE = "4165551234";
// The number the scrambled entry used to produce: (165) 123-4554.
const OTHER = "1651234554";
const CARL = "4165550300";

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
    if (!file.startsWith(ROOT + path.sep)) return void res.writeHead(403).end("forbidden");
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

// The two idle timers are minutes long. Rather than add a test hook to the app,
// the page's own setTimeout is wrapped: a delay equal to one of those constants
// is shortened, but only while the test has asked for it -- the rest of the run
// sees the real values.
const FAST_TIMERS = () => {
  const real = window.setTimeout;
  window.setTimeout = function (fn, ms, ...rest) {
    const f = window.__fast;
    if (f && ms === 9e4 && f.kiosk) ms = f.kiosk;
    if (f && ms === 3e5 && f.admin) ms = f.admin;
    return real.call(this, fn, ms, ...rest);
  };
};

const SEED = ({ ALICE, OTHER, CARL }) =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open("frontdesk");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(["items", "borrowers", "loans"], "readwrite");
      const now = Date.now();
      const item = (id, name) => ({
        id, name, nameLower: name.toLowerCase(), category: "Other", location: "", condition: "good",
        notes: "", timesCheckedOut: 1, isArchived: false, createdAt: now
      });
      const person = (id, name, phone) => ({
        id, name, nameLower: name.toLowerCase(), phone,
        phoneFormatted: `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`,
        contact2: "", notes: "", timesCheckedOut: 1, lastSeenAt: now, isArchived: false, createdAt: now
      });
      const loan = (id, itemId, itemName, b, extra) => Object.assign({
        id, itemId, itemNameSnapshot: itemName, borrowerId: b.id, borrowerNameSnapshot: b.name,
        borrowerPhoneSnapshot: b.phone, checkedOutAt: now - 3600e3, dueAt: now + 3600e3,
        returnedAt: null, isOpen: "open", conditionOut: "good", conditionIn: null, notes: "", recordedBy: "test"
      }, extra || {});
      const items = tx.objectStore("items");
      const borrowers = tx.objectStore("borrowers");
      const loans = tx.objectStore("loans");
      const alice = person(1, "Alice Able", ALICE);
      const other = person(2, "Other Person", OTHER);
      const carl = person(3, "Carl Cole", CARL);
      [item(1, "Projector Remote"), item(2, "Room 4 Key"), item(3, "Laptop Charger")].forEach((x) => items.put(x));
      [alice, other, carl].forEach((x) => borrowers.put(x));
      loans.put(loan(1, 1, "Projector Remote", alice));
      const report = (note) => ({ returnRequestedAt: now - 60e3, returnRequestedCondition: "damaged", returnRequestedNote: note });
      loans.put(loan(2, 2, "Room 4 Key", carl, report("battery cover missing")));
      loans.put(loan(3, 3, "Laptop Charger", carl, report("frayed cable")));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
  });

const READ = (store, id) =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open("frontdesk");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const r = req.result.transaction([store]).objectStore(store).get(id);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    };
  });

(async () => {
  console.log("\nSessions, the lock, and the keyboard\n");

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
    await page.setViewport({ width: 1024, height: 1100 });
    // These checks drive the app's own on-screen keyboard, which a browser only
    // shows when this device has asked for it (the Windows app always does).
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem("frontdesk.keyboard", "on");
      } catch (_) {}
    });
    await page.evaluateOnNewDocument(FAST_TIMERS);

    const url = `http://127.0.0.1:${PORT}/index.html`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 30000 });
    await page.evaluate(SEED, { ALICE, OTHER, CARL });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 30000 });
    await page.addStyleTag({
      content: "*, *::before, *::after { transition: none !important; animation: none !important; }"
    });

    const screen = () =>
      page.evaluate(() => {
        const el = document.querySelector(".screen:not(.hidden)");
        return el ? el.id : null;
      });
    const clickIn = (screenId, sel) =>
      page.evaluate(
        ({ screenId, sel }) => {
          const root = document.getElementById(screenId);
          const el = root && root.querySelector(sel);
          if (!el) return "no element: " + sel;
          el.scrollIntoView({ block: "center", behavior: "instant" });
          el.click();
          return "ok";
        },
        { screenId, sel }
      );
    const clickText = (sel, re) =>
      page.evaluate(
        ({ sel, src }) => {
          const el = Array.from(document.querySelectorAll(sel)).find((x) => x.offsetParent !== null && new RegExp(src).test(x.textContent));
          if (!el) return "none";
          el.click();
          return "ok";
        },
        { sel, src: re.source }
      );
    const read = (store, id) => page.evaluate(READ, store, id);
    const dialogOpen = () =>
      page.evaluate(() => {
        const d = document.getElementById("dialog");
        return !!d && !d.classList.contains("hidden") && d.children.length > 0;
      });

    const signIn = async () => {
      await page.evaluate(() => window.app.showAdminLogin());
      await page.waitForSelector("#screen-admin-login:not(.hidden)", { timeout: 8000 });
      await page.evaluate((pin) => {
        document.querySelector("#screen-admin-login .pin-input").value = pin;
        document.querySelector("#screen-admin-login .pin-submit").click();
      }, PIN);
      await page.waitForSelector("#screen-admin:not(.hidden)", { timeout: 12000 });
    };

    // ── 1. the phone number typed on the keys is the phone number ────────────
    // The field reformats itself on every keystroke, "4" into "(4". The keyboard
    // then put the caret back where it would have been in the unformatted text,
    // so every later digit went in the wrong place: 4165551234 came out as
    // (165) 123-4554, which is somebody else's number.
    check("the kiosk offers a return", (await clickIn("screen-welcome", ".btn-kiosk-return")) === "ok");
    await page.waitForSelector("#screen-kiosk-return-phone:not(.hidden)", { timeout: 8000 });
    await page.click("#kiosk-return-phone");
    await page.waitForFunction(() => document.getElementById("keyboard").classList.contains("visible"), { timeout: 8000 });
    for (const d of ALICE) await page.click(`#keyboard .kbd[data-key="${d}"]`);
    const typed = await page.$eval("#kiosk-return-phone", (el) => el.value);
    check("ten digits tapped on the keys read back in order", typed === "(416) 555-1234", typed);

    await clickIn("screen-kiosk-return-phone", '[data-action="kiosk-return-phone-continue"]');
    await page.waitForSelector("#screen-kiosk-return-items:not(.hidden)", { timeout: 8000 });
    const greeted = await page.$eval("#screen-kiosk-return-items .kiosk-step-title", (el) => el.textContent);
    check("and sign in the person who owns them", /Alice Able/.test(greeted), greeted);

    // ── 2. a half-finished return does not carry over ───────────────────────
    await page.waitForSelector("#kiosk-return-list .kiosk-return-item", { timeout: 8000 });
    await page.evaluate(() => document.querySelector("#kiosk-return-list .kiosk-return-item").click());
    await page.waitForSelector('.kiosk-condition-actions [data-cond="good"]', { timeout: 8000 });
    // Alice walks away from the condition question.
    await clickIn("screen-kiosk-return-items", '[data-action="kiosk-back-home"]');
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 8000 });
    const leftover = await page.evaluate(() => document.querySelectorAll(".kiosk-signin-panel").length);
    check("leaving the kiosk session removes its open question", leftover === 0, `${leftover} panel(s) left`);

    await clickIn("screen-welcome", ".btn-kiosk-return");
    await page.waitForSelector("#screen-kiosk-return-phone:not(.hidden)", { timeout: 8000 });
    await page.evaluate((p) => {
      const el = document.getElementById("kiosk-return-phone");
      el.value = p;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, CARL);
    await clickIn("screen-kiosk-return-phone", '[data-action="kiosk-return-phone-continue"]');
    await page.waitForSelector("#screen-kiosk-return-items:not(.hidden)", { timeout: 8000 });
    await sleep(300);
    const carlSees = await page.$eval("#screen-kiosk-return-items", (el) => ({
      panels: el.querySelectorAll(".kiosk-signin-panel").length,
      projector: /Projector Remote/.test(el.textContent)
    }));
    check("the next borrower is not shown the last one's question", carlSees.panels === 0 && !carlSees.projector, JSON.stringify(carlSees));
    const aliceLoan = await read("loans", 1);
    check("and the last borrower's loan was not flagged as handed in", aliceLoan && !aliceLoan.returnRequestedAt, JSON.stringify(aliceLoan));

    // ── 3. a session nobody ends, ends ──────────────────────────────────────
    // Carl is signed in, with his name and phone on screen. He walks away.
    await page.evaluate(() => {
      window.__fast = { kiosk: 600 };
    });
    // Re-entering a screen re-arms the timer, now with the short delay.
    await clickIn("screen-kiosk-return-items", ".btn-back-kiosk");
    await page.waitForSelector("#screen-kiosk-return-phone:not(.hidden)", { timeout: 8000 });
    await page.evaluate((p) => {
      const el = document.getElementById("kiosk-return-phone");
      el.value = p;
    }, CARL);
    await sleep(1500);
    check("an idle kiosk session goes back to the welcome screen", (await screen()) === "screen-welcome", await screen());
    const phoneLeft = await page.$eval("#kiosk-return-phone", (el) => el.value);
    check("and takes the borrower's number with it", phoneLeft === "", phoneLeft);
    await page.evaluate(() => {
      window.__fast = null;
    });

    // ── 4. desk returns keep what the borrower reported ─────────────────────
    await signIn();
    await clickIn("screen-admin", '.tab[data-tab="currently-out"]');
    await page.waitForFunction(() => /Laptop Charger/.test((document.getElementById("tab-currently-out") || {}).textContent || ""), { timeout: 8000 });
    const ticked = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("#tab-currently-out .loan-item"));
      const row = rows.find((r) => /Laptop Charger/.test(r.textContent) && r.querySelector(".btn-success"));
      if (!row) return "no row";
      row.querySelector(".btn-success").click();
      return "ok";
    });
    check("Currently Out has a quick return for the reported item", ticked === "ok", ticked);
    await sleep(600);
    const charger = await read("loans", 3);
    check("the quick return keeps the borrower's 'damaged'", charger && charger.conditionIn === "damaged", JSON.stringify(charger));
    check("and their note", charger && /borrower reported: frayed cable/.test(charger.notes || ""), charger && charger.notes);

    await clickIn("screen-admin", '[data-action="admin-home"]');
    await page.waitForSelector("#screen-home:not(.hidden)", { timeout: 8000 });
    await page.evaluate(() => document.querySelector("#screen-home .btn-home-primary:nth-of-type(2)").click());
    await page.waitForSelector("#screen-checkin:not(.hidden)", { timeout: 8000 });
    await page.waitForFunction(() => /Room 4 Key/.test(document.getElementById("screen-checkin").textContent), { timeout: 8000 });
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("#screen-checkin .loan-item")).find((r) => /Room 4 Key/.test(r.textContent));
      row.click();
    });
    await page.waitForSelector("#screen-checkin-return:not(.hidden)", { timeout: 8000 });
    const report = await page.$eval("#screen-checkin-return .return-report", (el) => ({
      shown: !el.classList.contains("hidden") && el.offsetParent !== null,
      text: el.textContent
    }));
    check("the check-in screen shows what the borrower reported", report.shown && /battery cover missing/.test(report.text), JSON.stringify(report));
    await clickIn("screen-checkin-return", '[data-condition="good"]');
    await page.waitForSelector(".dialog-actions .btn", { timeout: 8000 });
    await clickText(".dialog-actions .btn", /Confirm Return/);
    await sleep(600);
    const key = await read("loans", 2);
    check("RETURNED OK still records the borrower's note", key && key.returnedAt && /borrower reported: battery cover missing/.test(key.notes || ""), JSON.stringify(key));

    // A loan with no report shows no report.
    await page.evaluate(() => window.__checkinFlow._renderReturn({ id: 99, itemId: 1, checkedOutAt: Date.now() }));
    const none = await page.$eval("#screen-checkin-return .return-report", (el) => el.classList.contains("hidden"));
    check("and shows nothing for a loan without one", none);

    // ── 5. the idle lock takes its dialog with it ───────────────────────────
    await page.evaluate(() => window.app.goToScreen("home"));
    await signIn();
    await clickIn("screen-admin", '.tab[data-tab="people"]');
    await page.waitForFunction(() => /Alice Able/.test(document.getElementById("screen-admin").textContent), { timeout: 8000 });
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("#screen-admin .admin-list-item")).find((r) => /Alice Able/.test(r.textContent));
      row.click();
    });
    await page.waitForSelector('#screen-admin-detail:not(.hidden) [data-action="edit-borrower"]', { timeout: 8000 });

    // Typing in the dialog counts as activity: with a 1.5s lock, two seconds of
    // steady keystrokes in the form must not trip it.
    await page.evaluate(() => {
      window.__fast = { admin: 1500 };
    });
    await clickIn("screen-admin-detail", '[data-action="edit-borrower"]');
    await page.waitForSelector('#dialog [data-f="name"]', { timeout: 8000 });
    for (let i = 0; i < 8; i++) {
      await page.focus('#dialog [data-f="notes"]');
      await page.keyboard.type("x");
      await sleep(250);
    }
    check("typing in a dialog keeps the admin session alive", (await screen()) === "screen-admin-detail" && (await dialogOpen()), await screen());

    await page.evaluate(() => {
      document.querySelector('#dialog [data-f="name"]').value = "Changed By Stranger";
    });
    await sleep(2500);
    check("the idle lock fires", (await screen()) === "screen-admin-login", await screen());
    await sleep(500);
    check("and closes the dialog that was open", !(await dialogOpen()));
    const saved = await clickText("#dialog .btn", /Save/);
    check("so there is no Save left to press", saved === "none", saved);
    const alice = await read("borrowers", 1);
    check("and the record is untouched", alice && alice.name === "Alice Able", alice && alice.name);
    check("the lock screen stays put", (await screen()) === "screen-admin-login", await screen());

    await page.evaluate(() => {
      window.__fast = null;
    });
    await page.evaluate(() => window.app.cancelAdminLogin());
    await sleep(300);
    check("Cancel on the lock screen goes to the kiosk, not the staff home", (await screen()) === "screen-welcome", await screen());

    // ── 6. the keyboard leaves non-text inputs alone ────────────────────────
    const kbd = await page.evaluate(async () => {
      const out = {};
      for (const type of ["radio", "checkbox", "date"]) {
        const el = document.createElement("input");
        el.type = type;
        el.value = type === "date" ? "2026-09-01" : "712";
        document.body.appendChild(el);
        el.focus();
        await new Promise((r) => setTimeout(r, 250));
        out[type] = document.getElementById("keyboard").classList.contains("visible");
        el.blur();
        el.remove();
        await new Promise((r) => setTimeout(r, 250));
      }
      return out;
    });
    check("the keyboard does not open on a radio, checkbox or date input", !kbd.radio && !kbd.checkbox && !kbd.date, JSON.stringify(kbd));

    const realErrors = errors.filter((e) => !/favicon/.test(e));
    check("no console errors through the whole run", realErrors.length === 0, realErrors.join(" | "));
  } finally {
    await browser.close();
    server.close();
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
