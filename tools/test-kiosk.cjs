// The kiosk: the unattended public surface, and the one with no other coverage.
//
//   node tools/test-kiosk.cjs
//
// This is where the worst findings in the review lived (D1-D7) -- a stranger
// could reach the staff screens, close their own loan, invent catalog items, or
// see other people's borrowing. Each of those is pinned below, end to end and
// through the real UI, on a fresh profile with an empty database.
//
// It seeds the catalog the only way the app allows (a staff member adds items),
// so it also exercises the staff-side entry: press-and-hold the logo, then PIN.

const fs = require("fs");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..", "web");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8798;
const PIN = "1234";
// The staff-seeded borrower (exists, has nothing out), the kiosk borrower, and
// a number this device has never seen.
const SEED_PHONE = "4165550100";
const KIOSK_PHONE = "4165550177";
const STRANGER_PHONE = "4165550188";

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

(async () => {
  console.log("\nThe kiosk\n");

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

    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 30000 });

    // Headless never finishes a CSS transition, so anything measured mid-slide
    // is measured wrong. Nothing here asserts on animation, but removing them
    // keeps hit-testing honest.
    await page.addStyleTag({
      content: "*, *::before, *::after { transition: none !important; animation: none !important; }"
    });

    const screen = () =>
      page.evaluate(() => {
        const el = document.querySelector(".screen:not(.hidden)");
        return el ? el.id : null;
      });

    // Scoped to a screen: two screens carry [data-action="kiosk-back-home"], so
    // a document-wide querySelector would happily click the hidden one.
    const clickIn = (screenId, sel) =>
      page.evaluate(
        ({ screenId, sel }) => {
          const root = document.getElementById(screenId);
          const el = root && root.querySelector(sel);
          if (!el) return el === null ? "no element: " + sel : "no screen";
          el.scrollIntoView({ block: "center", behavior: "instant" });
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

    const toastText = () => page.evaluate(() => (document.getElementById("toast") || {}).textContent || "");
    // A stale toast would make a "the app refused it" check pass on the previous
    // message, so clear it before each assertion that reads one.
    const clearToasts = () =>
      page.evaluate(() => {
        const c = document.getElementById("toast");
        if (c) c.textContent = "";
      });
    const waitToast = (re) => page.waitForFunction((src) => new RegExp(src).test((document.getElementById("toast") || {}).textContent || ""), { timeout: 8000 }, re.source);

    const fill = (sel, value) =>
      page.evaluate(
        ({ sel, value }) => {
          const el = document.querySelector(sel);
          el.focus();
          el.value = value;
          try {
            el.setSelectionRange(value.length, value.length);
          } catch (_) {}
          el.dispatchEvent(new Event("input", { bubbles: true }));
        },
        { sel, value }
      );

    const gotoWelcome = () => page.evaluate(() => window.app.goToScreen("welcome"));

    const logoPoint = () =>
      page.evaluate(() => {
        const el = document.querySelector("#screen-welcome .kiosk-logo");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const at = document.elementFromPoint(x, y);
        return {
          x,
          y,
          hits: !!at && (at === el || el.contains(at) || at.contains(el)),
          atPoint: at ? at.className || at.tagName : null
        };
      });

    // A toast sits top-centre with pointer-events: auto and will happily swallow
    // the press, so the hold silently never starts. Clear them, and check the
    // point really is the logo, so a miss is reported rather than timing out.
    const holdLogo = async () => {
      await clearToasts();
      const p = await logoPoint();
      // The logo only measures correctly while the welcome screen is the visible
      // one; on any other screen the rect is all zeros and the press lands in the
      // corner, which shows up as a bare timeout. Say so instead.
      if (!p || !p.hits) {
        throw new Error(`the logo is not reachable from ${await screen()}: ${JSON.stringify(p)}`);
      }
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await sleep(2400);
      await page.mouse.up();
      return p;
    };

    // ── 1. the kiosk cannot be navigated out of ───────────────────────────
    for (const target of ["home", "checkout", "admin-login", "checkin"]) {
      const reached = await page.evaluate(async (t) => {
        window.app.goToScreen(t);
        await new Promise((r) => setTimeout(r, 200));
        const el = document.querySelector(".screen:not(.hidden)");
        return el ? el.id : null;
      }, target);
      check(`goToScreen("${target}") from the kiosk is refused`, reached === "screen-welcome", `ended on ${reached}`);
    }

    const staffLinkOnKiosk = await page.evaluate(() => {
      const w = document.getElementById("screen-welcome");
      const links = w.querySelectorAll(".btn-admin-link, [onclick*='admin']");
      const visible = Array.from(links).filter((l) => l.offsetParent !== null);
      return { total: links.length, visible: visible.length };
    });
    check(
      "the welcome screen carries no visible staff link",
      staffLinkOnKiosk.visible === 0,
      JSON.stringify(staffLinkOnKiosk)
    );

    // ── 2. staff entry is a deliberate hold, not a tap ────────────────────
    // Every hold below depends on the press reaching the logo, so assert that
    // once, by name, instead of letting a miss show up as a timeout.
    const firstPoint = await logoPoint();
    check("the logo is reachable on the welcome screen", !!firstPoint && firstPoint.hits, JSON.stringify(firstPoint));

    await page.mouse.click(firstPoint.x, firstPoint.y);
    await sleep(400);
    check("a quick tap on the logo does not open the staff login", (await screen()) === "screen-welcome", await screen());

    await holdLogo();
    await page.waitForSelector("#screen-admin-login:not(.hidden)", { timeout: 8000 });
    check("a two-second hold on the logo opens the staff login", true);

    // Cancelling must go back to the kiosk, never to the staff home screen.
    await clickIn("screen-admin-login", ".pin-cancel, [data-action='cancel']");
    await sleep(300);
    let afterCancel = await screen();
    if (afterCancel === "screen-admin-login") {
      // Fall back to the app's own cancel if the selector above missed.
      await page.evaluate(() => window.app.cancelAdminLogin());
      await sleep(300);
      afterCancel = await screen();
    }
    check("cancelling the login returns to the kiosk, not the staff home", afterCancel === "screen-welcome", afterCancel);

    // ── 3. get in, and seed the catalog ───────────────────────────────────
    await holdLogo();
    await page.waitForSelector("#screen-admin-login:not(.hidden)", { timeout: 8000 });
    await page.type("#screen-admin-login .pin-input", PIN);
    await clickIn("screen-admin-login", ".pin-submit");
    await page.waitForSelector("#screen-admin:not(.hidden)", { timeout: 15000 });
    check("the PIN opens the admin panel", true);

    // The catalog is filled from the staff side here. The kiosk *can* add to it
    // now, but only behind an explicit tap on its own Add control -- see
    // `tools/test-catalog.cjs` for that policy. D5's point still stands for this
    // suite: typing a name and pressing Done never invents anything.
    await page.evaluate(() => window.dispatchEvent(new Event("frontdesk:checkout-start")));
    await page.waitForSelector("#screen-checkout:not(.hidden)", { timeout: 10000 });
    await page.waitForFunction(() => !!window.__checkoutFlow && window.__checkoutFlow._wireOnce, { timeout: 10000 });

    await page.type("#screen-checkout .step-phone .input", "4165550100");
    await clickIn("screen-checkout", ".step-phone .step-continue");
    await page.waitForFunction(() => !document.querySelector("#screen-checkout .step-name").classList.contains("hidden"), { timeout: 15000 });
    await page.type("#screen-checkout .step-name .input", "Seed Person");
    await clickIn("screen-checkout", ".step-name .step-continue");
    await page.waitForFunction(() => !document.querySelector("#screen-checkout .step-items").classList.contains("hidden"), { timeout: 15000 });

    for (const name of ["Clicker", "HDMI dongle"]) {
      await fill("#screen-checkout .step-items .search-input", name);
      await page.waitForSelector("#screen-checkout .all-items .add-new-row", { timeout: 15000 });
      await clickIn("screen-checkout", ".all-items .add-new-row");
      await page.waitForFunction((n) => document.querySelectorAll("#screen-checkout .all-items .item-card").length === n, { timeout: 15000 }, ["Clicker", "HDMI dongle"].indexOf(name) + 1);
    }
    const catalogCount = await page.evaluate(() => document.querySelectorAll("#screen-checkout .all-items .item-card").length);
    check("two items are in the catalog", catalogCount === 2, catalogCount);

    // Leave without committing, so both items stay on the shelf.
    await gotoWelcome();
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 8000 });

    // ── 4. a borrower borrows ─────────────────────────────────────────────
    await clickIn("screen-welcome", ".btn-kiosk-borrow");
    await page.waitForSelector("#screen-kiosk-borrow-phone:not(.hidden)", { timeout: 8000 });
    check("Borrow something opens the phone step", true);

    await fill("#kiosk-phone", KIOSK_PHONE);
    await clickIn("screen-kiosk-borrow-phone", '[data-action="kiosk-phone-continue"]');
    await page.waitForSelector("#screen-kiosk-borrow-name:not(.hidden)", { timeout: 8000 });
    check("an unknown number is asked for a name", true);

    await fill("#kiosk-name", "Kiosk Person");
    await clickIn("screen-kiosk-borrow-name", '[data-action="kiosk-name-continue"]');
    await page.waitForSelector("#screen-kiosk-borrow-need:not(.hidden)", { timeout: 8000 });
    check("the item step greets the borrower by name", (await textIn("screen-kiosk-borrow-need", "#kiosk-greeting-name")) === "Kiosk Person");

    await fill("#kiosk-need", "Clicker");
    await page.waitForSelector("#kiosk-need-suggestions .kiosk-suggestion", { timeout: 8000 });
    const picks = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("#kiosk-need-suggestions .kiosk-suggestion")).map((b) => ({
          text: (b.querySelector("span") || {}).textContent || "",
          disabled: !!b.disabled,
          unavailable: b.classList.contains("is-unavailable")
        }))
      );
    const clickerPick = (await picks()).find((p) => p.text.toLowerCase() === "clicker");
    check("the item list offers the catalog item", !!clickerPick && !clickerPick.disabled, JSON.stringify(await picks()));

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("#kiosk-need-suggestions .kiosk-suggestion")).find((x) => ((x.querySelector("span") || {}).textContent || "").toLowerCase() === "clicker");
      if (b) b.click();
    });
    await page.waitForSelector("#screen-kiosk-borrow-done:not(.hidden)", { timeout: 15000 });
    check("tapping it completes the checkout", true);
    check("and the confirmation names the item", (await textIn("screen-kiosk-borrow-done", "#kiosk-done-text")) === "Clicker", await textIn("screen-kiosk-borrow-done", "#kiosk-done-text"));
    await clickIn("screen-kiosk-borrow-done", '[data-action="kiosk-back-home"]');
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 8000 });

    // ── 5. typing a name and pressing Done invents nothing ────────────────
    // The policy changed here: the kiosk may add an item, but only through its
    // own Add control, and never as a side effect of confirming. So the assertion
    // is not "nothing was created" but "the borrower is refused, told why, and
    // left where they were" -- with the add offer made below the box instead.
    await clickIn("screen-welcome", ".btn-kiosk-borrow");
    await page.waitForSelector("#screen-kiosk-borrow-phone:not(.hidden)", { timeout: 8000 });
    await fill("#kiosk-phone", KIOSK_PHONE);
    await clickIn("screen-kiosk-borrow-phone", '[data-action="kiosk-phone-continue"]');
    // A known number goes straight to the item step -- no name asked again.
    await page.waitForSelector("#screen-kiosk-borrow-need:not(.hidden)", { timeout: 8000 });
    check("a returning borrower is not asked for their name again", true);

    await fill("#kiosk-need", "Squeaky Rubber Duck");
    await clearToasts();
    await page.waitForSelector('#kiosk-need-suggestions [data-action="kiosk-add-new"]', { timeout: 8000 });
    // Read straight from the store rather than through the app, so a cached
    // catalog cannot make this pass by agreeing with itself.
    const catalogCount2 = () =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const req = indexedDB.open("frontdesk");
            req.onsuccess = () => {
              const all = req.result.transaction("items", "readonly").objectStore("items").getAll();
              all.onsuccess = () => resolve(all.result.length);
              all.onerror = () => resolve(-1);
            };
            req.onerror = () => resolve(-1);
          })
      );
    const offered = await catalogCount2();
    check("a novel name is offered as an add rather than silently created", offered === 2, `${offered} items`);
    // The main button names the add, so the button a borrower reaches for works.
    const borrowLabel = () => page.$eval('[data-action="kiosk-confirm-pick"]', (b) => b.textContent.trim());
    check("the main button says it will add and borrow the new name",
      /^Add "Squeaky Rubber Duck" and borrow it$/.test(await borrowLabel()), await borrowLabel());

    // Enter is still never an add: a stray key must not write a catalog row.
    await page.focus("#kiosk-need");
    await page.keyboard.press("Enter");
    await waitToast(/not on the list/i);
    check("pressing Enter on free text does not create a catalog item", /not on the list/i.test(await toastText()), await toastText());
    const afterEnter = await catalogCount2();
    check("and the catalog is untouched by it", afterEnter === 2, `${afterEnter} items`);
    check("and the borrower stays on the item step", (await screen()) === "screen-kiosk-borrow-need", await screen());

    // Tapping the button is the deliberate act, and it does what it says.
    await clickIn("screen-kiosk-borrow-need", '[data-action="kiosk-confirm-pick"]');
    await page.waitForSelector("#screen-kiosk-borrow-done:not(.hidden)", { timeout: 15000 });
    check("tapping it adds the item and lends it", (await textIn("screen-kiosk-borrow-done", "#kiosk-done-text")) === "Squeaky Rubber Duck",
      await textIn("screen-kiosk-borrow-done", "#kiosk-done-text"));
    const afterAdd = await catalogCount2();
    check("and the catalog has the one new item", afterAdd === 3, `${afterAdd} items`);
    const staleToast = await page.evaluate(() => (document.getElementById("toast") || {}).textContent || "");
    check("the earlier 'not on the list' message is gone once it worked", !/not on the list/i.test(staleToast), staleToast);

    // One more thing, same person: no phone number again.
    await clickIn("screen-kiosk-borrow-done", '[data-action="kiosk-borrow-another"]');
    await page.waitForSelector("#screen-kiosk-borrow-need:not(.hidden)", { timeout: 8000 });
    const again = await page.evaluate(() => ({
      name: document.getElementById("kiosk-greeting-name").textContent,
      box: document.getElementById("kiosk-need").value,
      label: document.querySelector('[data-action="kiosk-confirm-pick"]').textContent.trim()
    }));
    check("Borrow something else goes back to the item step for the same person",
      again.name === "Kiosk Person" && again.box === "" && again.label === "Borrow it", JSON.stringify(again));

    // ── 6. an item that is already out cannot be taken twice ──────────────
    await fill("#kiosk-need", "Clicker");
    await page.waitForFunction(() => {
      const b = Array.from(document.querySelectorAll("#kiosk-need-suggestions .kiosk-suggestion")).find((x) => ((x.querySelector("span") || {}).textContent || "").toLowerCase() === "clicker");
      return !!b && b.disabled;
    }, { timeout: 8000 });
    const outPick = (await picks()).find((p) => p.text.toLowerCase() === "clicker");
    check("an item that is already out is shown disabled", !!outPick && outPick.disabled && outPick.unavailable, JSON.stringify(outPick));

    await clearToasts();
    await clickIn("screen-kiosk-borrow-need", '[data-action="kiosk-confirm-pick"]');
    await waitToast(/already out/i);
    check("and taking it by name is refused too", /already out/i.test(await toastText()), await toastText());
    check("still on the item step", (await screen()) === "screen-kiosk-borrow-need", await screen());

    await gotoWelcome();
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 8000 });

    // ── 7. returns: your own records, and never a false "all clear" ───────
    // A number this device has never seen must not be told "You're all clear" --
    // that would be a lie about a record it simply does not have.
    await clickIn("screen-welcome", ".btn-kiosk-return");
    await page.waitForSelector("#screen-kiosk-return-phone:not(.hidden)", { timeout: 8000 });
    await fill("#kiosk-return-phone", STRANGER_PHONE);
    await clickIn("screen-kiosk-return-phone", '[data-action="kiosk-return-phone-continue"]');
    await page.waitForSelector("#screen-kiosk-return-phone .kiosk-signin-panel", { timeout: 10000 });
    check("an unknown number is asked to check it, rather than shown an empty list", true);
    check("and never reaches the item list", (await screen()) === "screen-kiosk-return-phone", await screen());

    await gotoWelcome();
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 8000 });

    // The seeded borrower is real and has nothing out. Their list must be empty,
    // and must not contain the other borrower's item.
    await clickIn("screen-welcome", ".btn-kiosk-return");
    await page.waitForSelector("#screen-kiosk-return-phone:not(.hidden)", { timeout: 8000 });
    await fill("#kiosk-return-phone", SEED_PHONE);
    await clickIn("screen-kiosk-return-phone", '[data-action="kiosk-return-phone-continue"]');
    await page.waitForSelector("#screen-kiosk-return-items .kiosk-return-empty", { timeout: 10000 });
    const seedPanel = await textIn("screen-kiosk-return-items", "#kiosk-return-list");
    check("a borrower with nothing out sees an empty list", /all clear/i.test(seedPanel || ""), seedPanel);
    check("and it does not show another borrower's item", !/Clicker/.test(seedPanel || ""), seedPanel);

    await gotoWelcome();
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 8000 });
    await clickIn("screen-welcome", ".btn-kiosk-return");
    await page.waitForSelector("#screen-kiosk-return-phone:not(.hidden)", { timeout: 8000 });
    await fill("#kiosk-return-phone", KIOSK_PHONE);
    await clickIn("screen-kiosk-return-phone", '[data-action="kiosk-return-phone-continue"]');
    await page.waitForSelector("#kiosk-return-list .kiosk-return-item", { timeout: 10000 });
    const ownRows = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#kiosk-return-list .kiosk-return-item")).map((r) => (r.querySelector(".kiosk-return-item-name") || {}).textContent || "")
    );
    // Two: the Clicker, and the duck added and borrowed in step 5.
    check("the borrower's own loans are listed", ownRows.length === 2 && ownRows.some((r) => /Clicker/.test(r)) && ownRows.some((r) => /Squeaky Rubber Duck/.test(r)), JSON.stringify(ownRows));

    // ── 8. a return is a request, not a close ─────────────────────────────
    await page.evaluate(() => {
      const row = document.querySelector("#kiosk-return-list .kiosk-return-item");
      if (row) row.click();
    });

    // Handing something back is still a deliberate answer, not a stray tap --
    // but one question, over the screen. It used to be a dialog and then a
    // second question *below* the screen's Done button, and tapping Done there
    // lost the return without a word.
    await page.waitForSelector('.kiosk-modal .kiosk-condition-actions [data-cond="good"]', { timeout: 10000 });
    check("tapping to return asks one question: is it in good shape", true);
    const doneReachable = await page.evaluate(() => {
      const done = document.querySelector('#screen-kiosk-return-items [data-action="kiosk-back-home"]');
      const r = done.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === done || done.contains(hit);
    });
    check("and the screen's Done button cannot be pressed until it is answered", !doneReachable);
    const dialogOpen = await page.evaluate(() => !!document.querySelector("#dialog:not(.hidden) .dialog-actions"));
    check("with no separate confirmation dialog first", !dialogOpen);

    await page.evaluate(() => document.querySelector('[data-cond="good"]').click());
    await page.waitForFunction(() => {
      const row = document.querySelector("#kiosk-return-list .kiosk-return-item");
      return !!row && row.classList.contains("is-pending");
    }, { timeout: 10000 });
    check("reporting a return marks it pending", true);

    const pendingAfter = await page.evaluate(() => document.querySelectorAll("#kiosk-return-list .kiosk-return-item.is-pending").length);
    await page.evaluate(() => {
      const row = document.querySelector("#kiosk-return-list .kiosk-return-item");
      if (row) row.click();
    });
    await sleep(400);
    const pendingAfter2 = await page.evaluate(() => document.querySelectorAll("#kiosk-return-list .kiosk-return-item.is-pending").length);
    check("tapping it again does not double-report", pendingAfter === 1 && pendingAfter2 === 1, `${pendingAfter} -> ${pendingAfter2}`);

    // The loan must still be open: if the borrower's tap had closed it, the item
    // would be back on the shelf and pickable again.
    await gotoWelcome();
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 8000 });
    await clickIn("screen-welcome", ".btn-kiosk-borrow");
    await page.waitForSelector("#screen-kiosk-borrow-phone:not(.hidden)", { timeout: 8000 });
    await fill("#kiosk-phone", KIOSK_PHONE);
    await clickIn("screen-kiosk-borrow-phone", '[data-action="kiosk-phone-continue"]');
    await page.waitForSelector("#screen-kiosk-borrow-need:not(.hidden)", { timeout: 8000 });
    await fill("#kiosk-need", "Clicker");
    await page.waitForFunction(() => {
      const b = Array.from(document.querySelectorAll("#kiosk-need-suggestions .kiosk-suggestion")).find((x) => ((x.querySelector("span") || {}).textContent || "").toLowerCase() === "clicker");
      return !!b && b.disabled;
    }, { timeout: 8000 });
    check("the loan is still open, so the item is still not pickable", true);
    await gotoWelcome();
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 8000 });

    // ── 9. staff confirm closes it ────────────────────────────────────────
    await holdLogo();
    await page.waitForSelector("#screen-admin-login:not(.hidden)", { timeout: 8000 });
    await page.type("#screen-admin-login .pin-input", PIN);
    await clickIn("screen-admin-login", ".pin-submit");
    await page.waitForSelector("#screen-admin:not(.hidden)", { timeout: 15000 });

    await clickIn("screen-admin", '.tab[data-tab="queue"]');
    await page.waitForSelector('#screen-admin [data-action="confirm-return"]', { timeout: 15000 });
    check("the queue lists the return to confirm", true);
    await clickIn("screen-admin", '[data-action="confirm-return"]');
    await page.waitForFunction(() => !document.querySelector('#screen-admin [data-action="confirm-return"]'), { timeout: 15000 });
    check("confirming it clears it from the queue", true);

    await gotoWelcome();
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 8000 });
    await clickIn("screen-welcome", ".btn-kiosk-borrow");
    await page.waitForSelector("#screen-kiosk-borrow-phone:not(.hidden)", { timeout: 8000 });
    await fill("#kiosk-phone", KIOSK_PHONE);
    await clickIn("screen-kiosk-borrow-phone", '[data-action="kiosk-phone-continue"]');
    await page.waitForSelector("#screen-kiosk-borrow-need:not(.hidden)", { timeout: 8000 });
    await fill("#kiosk-need", "Clicker");
    await page.waitForSelector("#kiosk-need-suggestions .kiosk-suggestion", { timeout: 8000 });
    const backOnShelf = (await picks()).find((p) => p.text.toLowerCase() === "clicker");
    check("once staff confirm, the item is pickable again", !!backOnShelf && !backOnShelf.disabled, JSON.stringify(backOnShelf));

    // ── 10. a damaged report survives all the way to the staff queue ──────
    // The page is already on the item step from the check above.
    await fill("#kiosk-need", "HDMI dongle");
    await page.waitForSelector("#kiosk-need-suggestions .kiosk-suggestion", { timeout: 8000 });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("#kiosk-need-suggestions .kiosk-suggestion")).find((x) => ((x.querySelector("span") || {}).textContent || "").toLowerCase() === "hdmi dongle");
      if (b) b.click();
    });
    await page.waitForSelector("#screen-kiosk-borrow-done:not(.hidden)", { timeout: 15000 });
    const doneName = (await textIn("screen-kiosk-borrow-done", "#kiosk-done-text")) || "";
    // The app sentence-cases catalog names, so this is stored as "Hdmi Dongle".
    check("the second item can be borrowed", doneName.toLowerCase() === "hdmi dongle", doneName);
    await clickIn("screen-kiosk-borrow-done", '[data-action="kiosk-back-home"]');
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 8000 });

    await clickIn("screen-welcome", ".btn-kiosk-return");
    await page.waitForSelector("#screen-kiosk-return-phone:not(.hidden)", { timeout: 8000 });
    await fill("#kiosk-return-phone", KIOSK_PHONE);
    await clickIn("screen-kiosk-return-phone", '[data-action="kiosk-return-phone-continue"]');
    await page.waitForSelector("#kiosk-return-list .kiosk-return-item", { timeout: 10000 });
    await page.evaluate(() => {
      const row = document.querySelector("#kiosk-return-list .kiosk-return-item");
      if (row) row.click();
    });
    await page.waitForSelector('[data-cond="damaged"]', { timeout: 10000 });
    await page.evaluate(() => document.querySelector('[data-cond="damaged"]').click());
    await page.waitForSelector('.kiosk-condition-note[data-role="note-wrap"]:not(.hidden)', { timeout: 8000 });
    check("choosing Something's wrong asks for a note", true);

    // An empty note must not be accepted; capturing what is actually wrong is
    // the entire reason this step exists.
    await clearToasts();
    await page.evaluate(() => document.querySelector('[data-role="note-submit"]').click());
    await waitToast(/what's wrong/i);
    check("an empty note is refused", /what's wrong/i.test(await toastText()), await toastText());
    const panelStays = await page.evaluate(() => !!document.querySelector('[data-role="note-wrap"]:not(.hidden)'));
    check("and the panel stays open until something is said", panelStays);

    await fill('[data-role="note"]', "one key is bent");
    await page.evaluate(() => document.querySelector('[data-role="note-submit"]').click());
    await page.waitForFunction(() => {
      const row = document.querySelector("#kiosk-return-list .kiosk-return-item");
      return !!row && row.classList.contains("is-pending");
    }, { timeout: 10000 });
    check("sending the note marks it pending", true);

    // Back to the kiosk first: the staff hold reads the welcome logo's position,
    // and the tablet sits idle on the kiosk between borrowers anyway.
    await gotoWelcome();
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 8000 });
    await holdLogo();
    await page.waitForSelector("#screen-admin-login:not(.hidden)", { timeout: 8000 });
    await page.type("#screen-admin-login .pin-input", PIN);
    await clickIn("screen-admin-login", ".pin-submit");
    await page.waitForSelector("#screen-admin:not(.hidden)", { timeout: 15000 });
    await clickIn("screen-admin", '.tab[data-tab="queue"]');
    await page.waitForFunction(() => /one key is bent/.test(document.querySelector("#screen-admin").textContent), { timeout: 15000 });
    const queueRow = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("#screen-admin .queue-row")).find((r) => /one key is bent/.test(r.textContent));
      return row
        ? { note: /one key is bent/.test(row.textContent), label: (row.querySelector('[data-action="confirm-return"]') || {}).textContent || "" }
        : null;
    });
    check("the borrower's note reaches the staff queue", !!queueRow && queueRow.note, JSON.stringify(queueRow));
    check("and the button says it is accepting damage, not good condition", !!queueRow && /damaged/i.test(queueRow.label), JSON.stringify(queueRow));

    // ── 9. the way across the boundary, and back ──────────────────────────
    // The hold leads to the PIN, the PIN led to the admin panel, and the admin
    // panel's only exit led back to the kiosk. So on a tablet -- no Escape key,
    // and a 400ms window on the splash at launch -- the staff home, where
    // checkout and check-in live, could not be reached at all. The panel now
    // carries a way to it, and the home screen carries a way back.
    check("the admin panel offers a way to the desk", (await clickIn("screen-admin", '[data-action="admin-home"]')) === "ok");
    await sleep(600);
    check("which lands on the staff home", (await screen()) === "screen-home", await screen());

    // Arriving there has to show the desk's real numbers, not three zeros --
    // nothing about the router used to refresh them.
    await page
      .waitForFunction(() => Number((document.getElementById("home-stat-out") || {}).textContent) > 0, { timeout: 8000 })
      .catch(() => {});
    const homeCounts = await page.evaluate(() => ({
      out: (document.getElementById("home-stat-out") || {}).textContent,
      overdue: (document.getElementById("home-stat-overdue") || {}).textContent
    }));
    check("with the counts filled in on arrival", Number(homeCounts.out) > 0, JSON.stringify(homeCounts));

    check("the staff home can hand the device back to the kiosk", (await clickIn("screen-home", "#btn-to-kiosk")) === "ok");
    await sleep(400);
    check("and does", (await screen()) === "screen-welcome", await screen());

    // The boundary still only opens one way: whoever is at the tablet cannot
    // walk from the public screen into the staff one without the hold and PIN.
    const stillRefused = await page.evaluate(async () => {
      window.app.goToScreen("home");
      await new Promise((r) => setTimeout(r, 200));
      const el = document.querySelector(".screen:not(.hidden)");
      return el ? el.id : null;
    });
    check("and the kiosk still refuses to leave on its own", stillRefused === "screen-welcome", `ended on ${stillRefused}`);

    // ── 10. back in through the front door ────────────────────────────────
    // The staff home has its own way into the panel now, and it has to lead to
    // a PIN screen that works. Every other route in this suite arrives at the
    // PIN through the hold gesture, which runs showAdminLogin() -- the function
    // that arms the LOGIN button, and it arms it once per document. So the case
    // that matters is a fresh page where the hold has never been used: the desk
    // button has to be enough on its own.
    //
    // A tap on the splash used to land on the staff home -- names, phone
    // numbers, checkout and check-in, with no PIN in front of them -- and the
    // splash is what every F5 or crash-reload at the public tablet shows. It now
    // goes where the splash's own timer goes: the kiosk.
    const splashTap = await page.evaluateOnNewDocument(() => {
      const t = setInterval(() => {
        const s = document.getElementById("screen-splash");
        if (s && !s.classList.contains("hidden")) {
          clearInterval(t);
          s.click();
        }
      }, 10);
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 15000 });
    await sleep(300);
    check("a tap on the splash lands on the kiosk, not the staff home", (await screen()) === "screen-welcome", await screen());
    await page.removeScriptToEvaluateOnNewDocument(splashTap.identifier);

    // Every real route to the staff home now passes the PIN, which arms LOGIN as
    // a side effect. The case this section exists for is a document where that
    // never happened, so it is reached by navigating from the splash in-page --
    // the one non-kiosk screen a fresh document starts on.
    await page.evaluateOnNewDocument(() => {
      const t = setInterval(() => {
        const s = document.getElementById("screen-splash");
        if (s && !s.classList.contains("hidden") && window.app && window.app.goToScreen) {
          clearInterval(t);
          window.app.goToScreen("home");
        }
      }, 10);
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#screen-home:not(.hidden)", { timeout: 15000 });
    check("a fresh page can be put on the desk screen", (await screen()) === "screen-home", await screen());

    check("and the desk has its own way into the panel", (await clickIn("screen-home", "#btn-to-admin")) === "ok");
    await page.waitForSelector("#screen-admin-login:not(.hidden)", { timeout: 8000 });
    check("which opens the PIN screen", true);
    await page.type("#screen-admin-login .pin-input", PIN);
    await clickIn("screen-admin-login", ".pin-submit");
    const gotIn = await page
      .waitForSelector("#screen-admin:not(.hidden)", { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    check("and LOGIN works on a document where the hold was never used", gotIn);

    // Consume the creation allowance through Borrow something else, then Finish.
    await gotoWelcome();
    const startPerson = async (phone, name) => {
      await clickIn("screen-welcome", ".btn-kiosk-borrow");
      await page.waitForSelector("#screen-kiosk-borrow-phone:not(.hidden)");
      await fill("#kiosk-phone", phone);
      await clickIn("screen-kiosk-borrow-phone", '[data-action="kiosk-phone-continue"]');
      await page.waitForSelector("#screen-kiosk-borrow-name:not(.hidden)");
      await fill("#kiosk-name", name);
      await clickIn("screen-kiosk-borrow-name", '[data-action="kiosk-name-continue"]');
      await page.waitForSelector("#screen-kiosk-borrow-need:not(.hidden)");
    };
    const borrowThree = async (names) => {
      for (let i = 0; i < names.length; i++) {
        await fill("#kiosk-need", names[i]);
        await page.waitForSelector('#kiosk-need-suggestions [data-action="kiosk-add-new"]', { timeout: 10000 });
        await clickIn("screen-kiosk-borrow-need", '[data-action="kiosk-confirm-pick"]');
        await page.waitForSelector("#screen-kiosk-borrow-done:not(.hidden)", { timeout: 10000 });
        check(`session can add and borrow ${names[i]}`,
          (await textIn("screen-kiosk-borrow-done", "#kiosk-done-text")) === names[i]);
        if (i < names.length - 1) {
          await clickIn("screen-kiosk-borrow-done", '[data-action="kiosk-borrow-another"]');
          await page.waitForSelector("#screen-kiosk-borrow-need:not(.hidden)");
        }
      }
    };
    await startPerson("4165550991", "First Session Person");
    await borrowThree(["Cerulean Telescope", "Velvet Harpsichord", "Magenta Windmill"]);
    const finish = '#screen-kiosk-borrow-done [data-action="kiosk-back-home"]';
    const hit = await page.$eval(finish, (button) => {
      button.scrollIntoView({ block: "center", behavior: "instant" });
      const r = button.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return button.offsetParent !== null && (at === button || button.contains(at));
    });
    check("DONE's Finish button is visible and receives the tap", hit);
    await page.click(finish);
    await page.waitForSelector("#screen-welcome:not(.hidden)");
    const clean = await page.evaluate(() => ({
      fields: ["kiosk-phone", "kiosk-name", "kiosk-need"].map((id) => document.getElementById(id).value),
      draft: sessionStorage.getItem("frontdesk.draft"),
      welcome: document.getElementById("screen-welcome").textContent
    }));
    check("Finish clears the previous person's fields and leaves no checkout draft",
      clean.fields.every((value) => value === "") && clean.draft === null, JSON.stringify(clean.fields));
    check("the welcome screen carries no previous name or item",
      !/First Session Person|Magenta Windmill/.test(clean.welcome));
    await startPerson("4165550992", "Fresh Session Person");
    check("the next session greets its own borrower",
      (await textIn("screen-kiosk-borrow-need", "#kiosk-greeting-name")) === "Fresh Session Person");
    await borrowThree(["Fuchsia Origami", "Bronze Accordion", "Silver Hourglass"]);
    await page.click(finish);
    await page.waitForSelector("#screen-welcome:not(.hidden)");
    check("a fresh session gets the full three-item allowance after Finish", true);

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
