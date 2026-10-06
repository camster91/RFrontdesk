// Drives the real page in a real browser: the browser build of the app, the
// Settings screen, and the dialog focus behaviour.
//
//   node tools/test-ui.cjs
//
// Chromium comes from the Edge that is already on the machine -- no browser
// download, no network. The page is served over http so it gets a real origin
// and IndexedDB works; file:// would be an opaque origin with no storage.

const fs = require("fs");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..", "web");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8792;

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
      // The app has no favicon. Answering here keeps the browser's own 404 out
      // of the console so a real error cannot hide behind it.
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
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

(async () => {
  console.log("\nFront Desk in a browser\n");

  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ["--no-first-run", "--disable-gpu", "--disable-extensions"]
  });

  try {
    const page = await browser.newPage();
    // Tall enough that the Settings panel's controls are on screen. The app
    // scrolls an inner .screen-body rather than the window, so a control below
    // the fold gets a click at coordinates that land on nothing.
    await page.setViewport({ width: 1280, height: 1100 });

    // Scroll a control to the middle of its scroller before clicking it.
    const clickOn = async (selector) => {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
      }, selector);
      await page.click(selector);
    };

    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push("console: " + m.text());
    });

    // These checks drive the app's own on-screen keyboard, which a browser only
    // shows when this device has asked for it (the Windows app always does).
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem("frontdesk.keyboard", "on");
      } catch (_) {}
    });
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });
    // __appReady is set at the end of the bundle, before bootstrap() has built
    // the screens, so waiting on it alone races the app. The welcome screen is
    // the first thing bootstrap settles on.
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 30000 });

    // Nothing but the favicon is expected; a favicon route is served, so any
    // error here means the bundle broke.
    const realErrors = errors.filter((e) => !/favicon/.test(e));
    check("the page loads with no errors", realErrors.length === 0, realErrors.join(" | "));

    const hosted = await page.evaluate(() => window.app.isHosted());
    check("the browser build knows it is not hosted", hosted === false, hosted);
    check("hostInfo resolves null outside the app", (await page.evaluate(() => window.app.hostInfo())) === null);

    const showing = await page.evaluate(
      () => Array.from(document.querySelectorAll(".screen:not(.hidden)")).map((s) => s.id)
    );
    check("exactly one screen is showing", showing.length === 1, JSON.stringify(showing));
    check("and it is the welcome screen", showing[0] === "screen-welcome", JSON.stringify(showing));

    // --- Admin, and the Windows-app section of Settings --------------------
    // showAdminLogin is also the one place the kiosk exit is granted, so this
    // exercises that path too: it is called from the welcome screen.
    await page.evaluate(() => window.app.showAdminLogin());
    await page.waitForSelector("#screen-admin-login:not(.hidden)", { timeout: 10000 });
    check("the login screen opens from the kiosk welcome screen", true);
    await page.type("#screen-admin-login .pin-input", "1234");
    // The precondition for the check after the login: typing raises the
    // keyboard, so its absence on the next screen means something put it away
    // rather than that it never came up.
    const kbdUpWhileTyping = await page
      .waitForSelector("#keyboard.visible", { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    check("typing into the PIN field raises the on-screen keyboard", kbdUpWhileTyping);
    check("and while it is up it can take taps", await page.evaluate(
      () => getComputedStyle(document.getElementById("keyboard")).pointerEvents !== "none"
    ));
    await page.click("#screen-admin-login .pin-submit");
    await page.waitForSelector("#screen-admin:not(.hidden)", { timeout: 15000 });
    check("the admin panel opens with the factory PIN", true);

    // The keyboard is a full-width overlay across the bottom of the screen at
    // z-index 100. It used to arrive on the admin panel with the login screen:
    // display:none does not fire focusout, so nothing put it away, and the new
    // panel was dead to every tap along its bottom edge -- the export and wipe
    // buttons among them. It is checked from here rather than from the keyboard's
    // own state machine because what matters is the screen underneath.
    const kbdAfterLogin = await page.evaluate(() => {
      const k = document.getElementById("keyboard");
      return {
        visible: k.classList.contains("visible"),
        inert: k.inert,
        pointerEvents: getComputedStyle(k).pointerEvents
      };
    });
    check("logging in puts the on-screen keyboard away", !kbdAfterLogin.visible, JSON.stringify(kbdAfterLogin));
    check("and it cannot swallow a tap on its way out", kbdAfterLogin.pointerEvents === "none", JSON.stringify(kbdAfterLogin));

    // The strip that announces a recent kiosk self-checkout sits above the tab
    // bar and is hidden by adding `hidden` to it. It sets display:flex, so it
    // needed its own hidden rule -- the generic .hidden is deliberately weak and
    // loses on source order. Without one, an empty 26px magenta bar painted
    // under the header on every admin tab, in both themes, and was hit-testable
    // over that 26px of screen.
    const kioskStrip = await page.evaluate(() => {
      const el = document.getElementById("admin-recent-kiosk");
      const cs = getComputedStyle(el);
      return {
        hidden: el.classList.contains("hidden"),
        display: cs.display,
        height: el.getBoundingClientRect().height
      };
    });
    check("the recent-kiosk strip is not painted while it is hidden",
      !kioskStrip.hidden || kioskStrip.display === "none", JSON.stringify(kioskStrip));
    check("and it takes up no room", kioskStrip.height === 0, JSON.stringify(kioskStrip));

    await page.click('.tab[data-tab="settings"]');
    // .settings-panel is static markup; renderSettings fills it asynchronously,
    // so waiting on the element alone races the render.
    await page.waitForSelector('#tab-settings [data-action="save-settings"]', { timeout: 15000 });
    await page.waitForSelector("#host-settings > *", { timeout: 15000 });

    // The button the restore suite could not click. It sits at the bottom of the
    // panel, where the keyboard was parked, so hit-testing it is the end-to-end
    // version of "the panel underneath is reachable".
    await page.evaluate(() => document.querySelector('#tab-settings [data-action="export-json"]').scrollIntoView({ block: "center", behavior: "instant" }));
    const exportHit = await page.evaluate(() => {
      const btn = document.querySelector('#tab-settings [data-action="export-json"]');
      const r = btn.getBoundingClientRect();
      const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return { hits: at === btn || btn.contains(at), at: at ? (at.id || at.tagName) + "." + (at.className || "") : null };
    });
    check("nothing is covering the settings panel's own buttons", exportHit.hits, JSON.stringify(exportHit));

    const hostSection = await page.evaluate(() => {
      const el = document.querySelector("#host-settings");
      return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
    });
    check("the host section renders in the browser build", hostSection !== null, hostSection);
    check(
      "and explains the backup folder rather than showing a dead panel",
      /RotmanFrontDesk\.exe/.test(hostSection || ""),
      hostSection
    );
    check("no host-only buttons leak into the browser build", await page.evaluate(
      () => document.querySelectorAll('#host-settings [data-action="open-folder"], #host-settings [data-action="backup-now"]').length === 0
    ));

    // The rest of Settings must still be intact.
    for (const action of ["export-json", "export-csv-overdue", "import", "wipe", "save-settings"]) {
      const present = await page.evaluate(
        (a) => !!document.querySelector(`#tab-settings [data-action="${a}"]`),
        action
      );
      check(`Settings still has "${action}"`, present);
    }

    // --- Theme toggle ------------------------------------------------------
    // Toasts sit top-centre with pointer-events:auto (the Undo button needs
    // them), so one landing over a control swallows a coordinate click. That is
    // a test-harness problem, not an app one -- clear them between steps.
    const clearToasts = () => page.evaluate(() => {
      const c = document.getElementById("toast");
      if (c) c.textContent = "";
    });

    await clearToasts();
    // Read the theme's own tokens rather than the class. The class was always
    // applied -- app.js has put `light` on <body> all along -- so a check on it
    // passed for as long as styles.css had no light rules at all and the control
    // did visibly nothing. Custom properties are not animatable, so unlike a
    // background-color these reads are not at the mercy of the transition.
    const themeTokens = () => page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      return {
        bg: cs.getPropertyValue("--bg").trim(),
        text: cs.getPropertyValue("--text").trim()
      };
    });
    // "#rrggbb" -> relative luminance, so "is this actually light?" is a
    // question the test can answer instead of a human looking at a screenshot.
    const luminance = (hex) => {
      const m = /^#([0-9a-f]{6})$/i.exec(hex);
      if (!m) return null;
      const [r, g, b] = [0, 2, 4].map((i) => {
        const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    const darkTokens = await themeTokens();

    await page.evaluate(() => document.querySelector('#tab-settings select[data-setting="theme"]').scrollIntoView({ block: "center", behavior: "instant" }));
    await page.select('#tab-settings select[data-setting="theme"]', "light");
    await clickOn('#tab-settings [data-action="save-settings"]');
    await page.waitForFunction(() => document.body.classList.contains("light"), { timeout: 8000 });
    check("choosing Light actually applies it", true);

    const lightTokens = await themeTokens();
    check("and the light theme's tokens are the ones that resolve", lightTokens.bg !== darkTokens.bg,
      `--bg is ${lightTokens.bg} in both themes`);
    const lightBg = luminance(lightTokens.bg);
    const darkBg = luminance(darkTokens.bg);
    check("the light background is light", lightBg !== null && lightBg > 0.5, `${lightTokens.bg} -> ${lightBg}`);
    check("the dark background is dark", darkBg !== null && darkBg < 0.2, `${darkTokens.bg} -> ${darkBg}`);
    // Inverting the background without inverting the text is the failure mode
    // that makes a theme unreadable rather than merely absent.
    check("light text is dark and dark text is light",
      luminance(lightTokens.text) < luminance(darkTokens.text),
      `light text ${lightTokens.text}, dark text ${darkTokens.text}`);

    await clearToasts();
    await page.evaluate(() => document.querySelector('#tab-settings select[data-setting="theme"]').scrollIntoView({ block: "center", behavior: "instant" }));
    await page.select('#tab-settings select[data-setting="theme"]', "dark");
    await clickOn('#tab-settings [data-action="save-settings"]');
    await page.waitForFunction(() => !document.body.classList.contains("light"), { timeout: 8000 });
    check("and switching back to Dark does too", true);

    // --- Dialog focus (G9) -------------------------------------------------
    // Driven through the app's own "Wipe all data" confirm, which is the only
    // dialog reachable from Settings without a file picker. Only Escape is
    // pressed; its cancel path is `choice !== "wipe"` -> return, so nothing is
    // deleted by running this.
    await clearToasts();
    await page.evaluate(() => document.querySelector('#tab-settings [data-action="wipe"]').scrollIntoView({ block: "center", behavior: "instant" }));
    await page.focus('#tab-settings [data-action="wipe"]');
    await clickOn('#tab-settings [data-action="wipe"]');
    await page.waitForSelector("#dialog .dialog-card", { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 250)); // let the focus-in timer run

    const focus = await page.evaluate(() => {
      const card = document.querySelector("#dialog .dialog-card");
      const active = document.activeElement;
      const focusMovedIn = card.contains(active);
      const landedOnBodyInput = active && active.getAttribute("data-f") === "confirm";
      const tag = active ? active.tagName + (active.getAttribute("data-f") ? `[${active.getAttribute("data-f")}]` : "") : null;

      // Tab off the last control must wrap to the first, not leave the card.
      const items = Array.from(card.querySelectorAll("button")).filter((b) => b.offsetParent !== null);
      items[items.length - 1].focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      const afterTab = document.activeElement;

      // Shift+Tab off the first must wrap to the last.
      items[0].focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
      const afterShiftTab = document.activeElement;

      return {
        focusMovedIn,
        landedOnBodyInput,
        tag,
        tabWrapped: card.contains(afterTab),
        shiftTabWrapped: card.contains(afterShiftTab),
        escapedTo: afterTab ? afterTab.tagName : null
      };
    });

    check("focus moves into the dialog", focus.focusMovedIn, focus.tag);
    check("and lands on the field the dialog is asking for", focus.landedOnBodyInput, focus.tag);
    check("Tab from the last control wraps inside the dialog", focus.tabWrapped, focus.escapedTo);
    check("Shift+Tab from the first wraps inside the dialog", focus.shiftTabWrapped);

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("dialog").classList.contains("hidden"), { timeout: 5000 });
    check("Escape closes the dialog", true);

    await new Promise((r) => setTimeout(r, 700)); // past the 400ms teardown
    const restored = await page.evaluate(() => {
      const btn = document.querySelector('#tab-settings [data-action="wipe"]');
      return {
        onOpener: document.activeElement === btn,
        onScreen: document.body.contains(btn),
        dialogHidden: document.getElementById("dialog").classList.contains("hidden")
      };
    });
    check("focus returns to the button that opened it", restored.onOpener, JSON.stringify(restored));
    check("the wipe button is still there", restored.onScreen);

    // --- A late frame must not resurrect a closed dialog ---------------------
    // The dialog fades in by dropping `hidden` now and adding `show` on the next
    // frame; the deferral is what lets the opacity transition run. So a frame
    // can still be outstanding when the dialog closes -- an Escape, a backdrop
    // tap, or a programmatic close within ~16ms of opening, and far longer
    // whenever the browser throttles frames because the window is minimised.
    // Holding frames here reproduces that interval deterministically; every
    // callback is delivered afterwards, so the app's own code runs unmodified.
    //
    // Before the open path guarded on `closed`, that late frame added `show`
    // back to a container cleanup had already emptied and marked `hidden`, and
    // `.dialog-container` overrides `.hidden` (same specificity, declared
    // later), so the result was an empty full-screen overlay with
    // pointer-events:auto: an invisible shield that ate every tap until the
    // next dialog happened to open.
    await clearToasts();
    await page.evaluate(() => {
      const btn = document.querySelector('#tab-settings [data-action="wipe"]');
      btn.scrollIntoView({ block: "center", behavior: "instant" });
      btn.focus();
      window.__rafQ = [];
      window.__rafReal = window.requestAnimationFrame;
      window.requestAnimationFrame = (cb) => {
        window.__rafQ.push(cb);
        return 0;
      };
    });
    await page.click('#tab-settings [data-action="wipe"]');

    // Polled by hand, not with waitForSelector: that polls on rAF, which is
    // exactly what is being held.
    let heldOpen = false;
    for (let i = 0; i < 40 && !heldOpen; i++) {
      heldOpen = await page.evaluate(() => !!document.querySelector("#dialog .dialog-card"));
      if (!heldOpen) await new Promise((r) => setTimeout(r, 100));
    }
    check("the dialog opens while frames are held back", heldOpen);

    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 800)); // past the 400ms teardown

    const beforeLate = await page.evaluate(() => ({
      held: window.__rafQ.length,
      show: document.getElementById("dialog").classList.contains("show"),
      empty: document.getElementById("dialog").innerHTML === ""
    }));
    check("closing it empties the container before the held frame arrives", beforeLate.empty && !beforeLate.show, JSON.stringify(beforeLate));

    // Deliver the frame that was outstanding when the dialog closed.
    await page.evaluate(() => {
      const queued = window.__rafQ;
      window.__rafQ = [];
      window.requestAnimationFrame = window.__rafReal;
      for (const cb of queued) {
        try {
          cb(performance.now());
        } catch (_) {
        }
      }
    });

    const afterLate = await page.evaluate(() => {
      const el = document.getElementById("dialog");
      const cs = getComputedStyle(el);
      const at = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
      return {
        cls: el.className,
        show: el.classList.contains("show"),
        pointerEvents: cs.pointerEvents,
        blocks: !!at && (at === el || el.contains(at)),
        atPoint: at ? at.className || at.tagName : null
      };
    });
    check("a frame delivered after close does not re-show the dialog", !afterLate.show, JSON.stringify(afterLate));
    check("and leaves nothing covering the screen", !afterLate.blocks, JSON.stringify(afterLate));
    check("the dialog is still inert, as the teardown left it", afterLate.pointerEvents === "none", afterLate.pointerEvents);

    // The real consequence: a tap afterwards has to land on the app.
    await page.click('#tab-settings [data-action="wipe"]');
    const reopened = await page.evaluate(() => !!document.querySelector("#dialog .dialog-card"));
    check("and the app still responds to a click afterwards", reopened);
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 700));
    await page.waitForFunction(() => document.getElementById("dialog").classList.contains("hidden"), { timeout: 5000 });

    // --- Reports -----------------------------------------------------------
    // Before any loan exists, so the honest empty state is what is on screen.
    await page.click('.tab[data-tab="reports"]');
    await page.waitForSelector("#tab-reports .report-periods", { timeout: 15000 });

    const reportShell = await page.evaluate(() => {
      const panel = document.querySelector("#tab-reports .reports-panel");
      const periods = Array.from(panel.querySelectorAll(".report-period"));
      return {
        periodLabels: periods.map((p) => p.textContent.trim()),
        activeCount: periods.filter((p) => p.classList.contains("active")).length,
        tiles: panel.querySelectorAll(".report-tile").length,
        hasCsv: !!panel.querySelector('[data-action="report-csv"]'),
        text: panel.textContent.replace(/\s+/g, " ").trim().slice(0, 400)
      };
    });
    check("the Reports tab has a period switch", reportShell.periodLabels.length === 4, JSON.stringify(reportShell.periodLabels));
    check("with exactly one period selected", reportShell.activeCount === 1, reportShell.activeCount);
    check("it renders summary tiles", reportShell.tiles === 8, reportShell.tiles);
    check("and an export button", reportShell.hasCsv);
    check(
      "an empty desk is told the period is empty rather than shown a wall of zeroes",
      /No loans in this period/.test(reportShell.text),
      reportShell.text.slice(0, 200)
    );

    await clearToasts();
    await page.evaluate(() => document.querySelector('#tab-reports .report-period[data-period="all"]').scrollIntoView({ block: "center", behavior: "instant" }));
    await page.click('#tab-reports .report-period[data-period="all"]');
    // The panel is emptied and rebuilt while the report is computed, so the
    // button is briefly absent -- a bare querySelector here would throw and
    // fail the wait instead of retrying.
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('#tab-reports .report-period[data-period="all"]');
        return !!btn && btn.classList.contains("active");
      },
      { timeout: 15000 }
    );
    check("choosing another period re-renders without a reload", true);
    check(
      "and the choice is remembered",
      (await page.evaluate(() => localStorage.getItem("frontdesk.reportPeriod"))) === "all"
    );

    // --- The checkout pick-list is actually on screen ----------------------
    // The catalog list existed but sat inside a container with an inline
    // `display:none` that nothing ever cleared, so a borrower saw an empty text
    // box while the app built cards nobody could tap. This is the guard.
    await clearToasts();
    // Enter through the same event the home screen fires: it builds the flow and
    // calls _wireDom. Navigating to the screen directly leaves every button on
    // it unwired, since only start() attaches the handlers.
    await page.evaluate(() => window.dispatchEvent(new Event("frontdesk:checkout-start")));
    await page.waitForSelector("#screen-checkout:not(.hidden)", { timeout: 10000 });
    await page.waitForFunction(() => !!window.__checkoutFlow && window.__checkoutFlow._wireOnce, { timeout: 10000 });

    // Walk the real flow: phone -> name -> items.
    await page.type("#screen-checkout .step-phone .input", "4165550123");
    await page.click("#screen-checkout .step-phone .step-continue");
    await page.waitForFunction(
      () => !document.querySelector("#screen-checkout .step-name").classList.contains("hidden"),
      { timeout: 15000 }
    );
    check("a new phone number asks for a name", true);
    await page.type("#screen-checkout .step-name .input", "Probe Person");
    await page.click("#screen-checkout .step-name .step-continue");
    await page.waitForFunction(
      () => !document.querySelector("#screen-checkout .step-items").classList.contains("hidden"),
      { timeout: 15000 }
    );

    const pickList = await page.evaluate(() => {
      const sections = document.querySelector("#screen-checkout .item-sections");
      const all = document.querySelector("#screen-checkout .all-items");
      const suggest = document.querySelector("#screen-checkout .item-section:nth-of-type(1)");
      const search = document.querySelector("#screen-checkout .step-items .search-input");
      return {
        display: getComputedStyle(sections).display,
        onScreen: sections.offsetParent !== null,
        cards: all.children.length,
        suggestionsHidden: suggest.classList.contains("hidden"),
        searchVisible: search.offsetParent !== null,
        searchAboveList: !!(search.compareDocumentPosition(sections) & Node.DOCUMENT_POSITION_FOLLOWING)
      };
    });
    check("the item pick-list is visible on the item step", pickList.onScreen, JSON.stringify(pickList));
    check("and is not hidden by an inline style", pickList.display !== "none", pickList.display);
    check("the search box stays above it", pickList.searchVisible && pickList.searchAboveList, JSON.stringify(pickList));
    check(
      "an empty catalog says so instead of showing an empty grid",
      pickList.cards === 1 && /catalog is empty/i.test(await page.evaluate(() => document.querySelector("#screen-checkout .all-items").textContent)),
      pickList.cards
    );
    check("and the empty SUGGESTIONS heading hides itself", pickList.suggestionsHidden, JSON.stringify(pickList));

    // Add an item through the app's own affordance, then find it in the list.
    await page.type("#screen-checkout .step-items .search-input", "HDMI dongle");
    await page.waitForSelector("#screen-checkout .all-items .add-new-row", { timeout: 15000 });
    await page.click("#screen-checkout .all-items .add-new-row");
    await page.waitForFunction(
      () => document.querySelectorAll("#screen-checkout .all-items .item-card").length === 1,
      { timeout: 15000 }
    );
    const afterAdd = await page.evaluate(() => {
      const card = document.querySelector("#screen-checkout .all-items .item-card");
      const cards = document.querySelectorAll("#screen-checkout .all-items .item-card").length;
      const heading = document.querySelector("#screen-checkout .item-section:nth-of-type(2) .section-title").textContent.trim();
      const counted = Number((/\((\d+)\)/.exec(heading) || [])[1]);
      return {
        name: card ? card.querySelector(".item-name").textContent : null,
        selected: card ? card.classList.contains("selected") : false,
        continueLabel: document.querySelector("#screen-checkout .step-items .step-continue").textContent.trim(),
        heading,
        counted,
        cards
      };
    });
    check("adding an item puts it in the tap-list", (afterAdd.name || "").toLowerCase() === "hdmi dongle", afterAdd.name);
    check("the new item is already selected, so the tap is not needed twice", afterAdd.selected);
    // The app sentence-cases names typed into the catalog, so "HDMI dongle"
    // is stored as "Hdmi Dongle". Pinned here so a change in that behaviour
    // shows up rather than passing unnoticed.
    check("typed names are normalised to sentence case", afterAdd.name === "Hdmi Dongle", afterAdd.name);
    check("the count on the heading matches the cards under it", afterAdd.counted === afterAdd.cards, JSON.stringify({ heading: afterAdd.heading, cards: afterAdd.cards }));
    check("and Continue counts what is chosen", /1 selected/.test(afterAdd.continueLabel), afterAdd.continueLabel);

    // --- Finish the checkout, then confirm Reports counted it --------------
    // These two taps are driven with an in-page click that first reports what
    // is actually at the button's coordinates. A coordinate click here is
    // timing-dependent -- a toast or the on-screen keyboard can land over the
    // button -- and a swallowed click shows up as an unexplained 15s timeout.
    // This way it shows up as a named failure with the culprit.
    const tap = (selector) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { present: false };
        el.scrollIntoView({ block: "center", behavior: "instant" });
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const covered = !(at === el || el.contains(at) || (at && at.contains(el)));
        el.click();
        return {
          present: true,
          disabled: !!el.disabled,
          covered,
          covering: at ? at.className || at.tagName : null,
          onScreen: r.width > 0 && r.height > 0
        };
      }, selector);

    await clearToasts();
    const itemsTap = await tap("#screen-checkout .step-items .step-continue");
    check("the item step's Continue button is on screen and uncovered", itemsTap.present && itemsTap.onScreen && !itemsTap.covered && !itemsTap.disabled, JSON.stringify(itemsTap));
    await page.waitForFunction(
      () => !document.querySelector("#screen-checkout .step-confirm").classList.contains("hidden"),
      { timeout: 15000 }
    );
    await clearToasts();
    const checkoutTap = await tap("#screen-checkout .step-confirm .btn-checkout");
    check("and so is Check out", checkoutTap.present && checkoutTap.onScreen && !checkoutTap.covered && !checkoutTap.disabled, JSON.stringify(checkoutTap));
    await page.waitForFunction(
      () => document.getElementById("screen-checkout").classList.contains("hidden"),
      { timeout: 20000 }
    );
    check("a checkout completes and leaves the screen", true);

    await page.evaluate(() => window.app.goToScreen("admin"));
    await page.click('.tab[data-tab="reports"]');
    await page.waitForFunction(
      () => {
        const tiles = document.querySelectorAll("#tab-reports .report-tile");
        return tiles.length > 0 && !/Building report/.test(document.querySelector("#tab-reports .reports-panel").textContent);
      },
      { timeout: 15000 }
    );
    const afterLoan = await page.evaluate(() => {
      const panel = document.querySelector("#tab-reports .reports-panel");
      const tiles = Array.from(panel.querySelectorAll(".report-tile")).map((t) => ({
        label: t.querySelector(".report-tile-label").textContent,
        value: t.querySelector(".report-tile-value").textContent
      }));
      const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t.value]));
      return {
        byLabel,
        rows: panel.querySelectorAll(".report-row").length,
        idle: panel.querySelectorAll(".report-idle-chip").length,
        emptyNotice: /No loans/.test(panel.textContent),
        chartBars: panel.querySelectorAll(".report-bar").length,
        span: panel.querySelector(".report-span").textContent.replace(/\s+/g, " ").trim()
      };
    });
    check("the report counts the loan that was just made", afterLoan.byLabel["Loans"] === "1", JSON.stringify(afterLoan.byLabel));
    check("and the person behind it", afterLoan.byLabel["People"] === "1", JSON.stringify(afterLoan.byLabel));
    check("and the item", afterLoan.byLabel["Items used"] === "1", JSON.stringify(afterLoan.byLabel));
    check("something is still out", afterLoan.byLabel["Still out"] === "1", JSON.stringify(afterLoan.byLabel));
    check("the empty notice is gone", !afterLoan.emptyNotice);
    check("the chart has a bar to draw", afterLoan.chartBars > 0, afterLoan.chartBars);
    check("items and people are ranked", afterLoan.rows >= 2, afterLoan.rows);
    check("nothing is idle now that the only item has moved", afterLoan.idle === 0, afterLoan.idle);
    check("a count of one reads as a person, not \"1 people\"", /1 person on file/.test(afterLoan.span), afterLoan.span);
    check("and a single loan reads as a loan, not \"1 loans\"", /1 loan\b/.test(afterLoan.span), afterLoan.span);

    // --- A return records the condition the staff member actually chose -----
    // The three buttons on the return screen are the only place staff say what
    // came back, and the confirmation dialog prints its summary from the same
    // value the loan gets written with. None of the buttons carried a
    // data-condition, and the handler reads `dataset.condition || "good"` -- so
    // all three meant "good". Tapping DAMAGED, or LOST, recorded a
    // good-condition return and then said so in the dialog the staff member
    // confirmed. Everything below those buttons always understood four
    // conditions; only the markup never said which one each button meant.
    const returnConditions = await page.$$eval("#screen-checkin-return .btn-return", (els) =>
      els.map((e) => e.dataset.condition || null)
    );
    check(
      "the return buttons name the conditions they record",
      JSON.stringify(returnConditions) === JSON.stringify(["good", "damaged", "lost"]),
      JSON.stringify(returnConditions)
    );

    const loansInDb = () =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const req = indexedDB.open("frontdesk");
            req.onsuccess = () => {
              const all = req.result.transaction("loans", "readonly").objectStore("loans").getAll();
              all.onsuccess = () =>
                resolve(all.result.map((l) => ({ id: l.id, isOpen: l.isOpen, conditionIn: l.conditionIn })));
              all.onerror = () => resolve(null);
            };
            req.onerror = () => resolve(null);
          })
      );

    await clearToasts();

    // --- the check-in search actually filters ------------------------------
    // This box did nothing at all, for the whole life of the app. The element
    // carried `search-input-lg`; CheckinFlow._wireDom asks for `.search-input`
    // (app.js:4221), matched nothing, logged nothing, and set `_wireOnce = true`
    // anyway -- so no listener was ever attached and the screen looked wired.
    // Measured before the fix, on 750 open loans: every query, including
    // "zzz", left 750 rows on screen.
    //
    // A second loan, so "filters" means the list narrowed rather than merely
    // emptied. Its id is far above anything autoIncrement has handed out, and
    // it is checked out three hours ago so it sorts after the loan the flow
    // below returns.
    await page.evaluate(
      () =>
        new Promise((res, rej) => {
          const q = indexedDB.open("frontdesk");
          q.onerror = () => rej(q.error);
          q.onsuccess = () => {
            const db = q.result;
            const now = Date.now();
            const tx = db.transaction(["items", "borrowers", "loans"], "readwrite");
            tx.oncomplete = () => res(true);
            tx.onerror = () => rej(tx.error);
            tx.objectStore("items").put({
              id: 9001, name: "Second Widget", nameLower: "second widget", isArchived: "no",
              timesCheckedOut: 0, createdAt: now, updatedAt: now
            });
            tx.objectStore("borrowers").put({
              id: 9001, name: "Zed Borrower", nameLower: "zed borrower", phone: "4169998888",
              phoneFormatted: "(416) 999-8888", lastSeenAt: now, createdAt: now
            });
            tx.objectStore("loans").put({
              id: 9001, itemId: 9001, borrowerId: 9001, isOpen: "open",
              checkedOutAt: now - 3 * 3600000, dueAt: now + 7200000,
              itemNameSnapshot: "Second Widget", borrowerNameSnapshot: "Zed Borrower",
              borrowerPhoneSnapshot: "4169998888", createdAt: now - 3 * 3600000
            });
          };
        })
    );

    // Typed into by position in the container, not by the class CheckinFlow
    // happens to query: if the wiring breaks again the checks below fail with
    // "the list did not narrow", which says what is wrong, instead of the run
    // dying on a null selector.
    const SEARCH = "#screen-checkin .search-container input";
    const checkinRows = () => page.$$eval("#screen-checkin .loan-item", (els) => els.map((e) => e.textContent.trim()));
    const searchCheckin = async (text) => {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) {
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }, SEARCH);
      await new Promise((r) => setTimeout(r, 300));
      if (text) await page.type(SEARCH, text, { delay: 15 });
      await new Promise((r) => setTimeout(r, 400));
      return checkinRows();
    };

    // The list is built by CheckinFlow, which starts on the event the home
    // screen's button dispatches -- goToScreen alone leaves it empty.
    await page.evaluate(() => window.app.goToScreen("home"));
    await page.waitForSelector("#screen-home:not(.hidden)", { timeout: 15000 });
    await clickOn("#screen-home .btn-home-primary:nth-of-type(2)");
    await page.waitForSelector("#screen-checkin .loan-item", { timeout: 15000 });

    const allRows = await checkinRows();
    check("the check-in list draws both open loans", allRows.length === 2, `${allRows.length} rows`);

    const byItem = await searchCheckin("second widget");
    check("typing an item name narrows the list to it", byItem.length === 1 && /Second Widget/.test(byItem[0]), JSON.stringify(byItem));

    const byPerson = await searchCheckin("zed");
    check("and typing a borrower's name narrows it too", byPerson.length === 1 && /Second Widget/.test(byPerson[0]), JSON.stringify(byPerson));

    // The regression this exists for: the phone is shown as "(416) 999-8888"
    // and typed as digits. Before the fix the digits form found nothing.
    const byDigits = await searchCheckin("9998888");
    check("and typing a phone number as digits finds it", byDigits.length === 1 && /Second Widget/.test(byDigits[0]), JSON.stringify(byDigits));

    const byFormat = await searchCheckin("999-8888");
    check("and the formatted form still works", byFormat.length === 1, JSON.stringify(byFormat));

    const none = await searchCheckin("zzzz");
    check("a query that matches nothing empties the list", none.length === 0, JSON.stringify(none));
    const notice = await page.evaluate(() => {
      const el = document.querySelector("#screen-checkin .loans-empty");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { text: el.textContent.trim(), visible: r.width > 0 && r.height > 0 };
    });
    check("and says so, rather than leaving a blank screen", !!notice && notice.visible && /zzzz/.test(notice.text), JSON.stringify(notice));

    const cleared = await searchCheckin("");
    check("clearing the box brings the whole list back", cleared.length === 2, JSON.stringify(cleared));
    const noticeGone = await page.evaluate(() => {
      const el = document.querySelector("#screen-checkin .loans-empty");
      return el ? el.getBoundingClientRect().height > 0 : null;
    });
    check("and the notice goes away with it", noticeGone === false, String(noticeGone));

    // --- the colours that carry meaning, and whether they can be read -------
    // The block further down measures the three return buttons and stops there.
    // These are the rest of the app's coloured text, and every one of them was
    // wrong:
    //   .badge-overdue     white on the dark theme's red        3.76:1
    //   .badge-today       white on the dark theme's blue       3.68:1
    //   .badge-due-soon    black on the light theme's amber     4.18:1
    //   .timing-value.due  --error on the row's own red tint    4.21:1
    //   .overdue-count/-label  --warning on its own amber tint  3.93:1
    //   .toast-success     --success on its own green tint      4.27:1
    //   .toast-undo-btn:hover  white on the dark theme's blue   3.68:1
    // One pattern: an accent used as ink on a surface tinted with that same
    // hue, which moves the background toward the text and eats the margin the
    // colour had on the plain page. The fix is a --*-text token per accent.
    //
    // Two measurement rules this needs, both of which hid the worst of it. A
    // container's `opacity` composites its text with it -- the overdue chip
    // animated opacity down to 0.3, so at the bottom of every two-second cycle
    // its number was drawn at 30%, 1.86:1 on the light theme -- so the walk
    // below multiplies ancestor opacity in and reports it. And a gradient fill
    // paints over `background-color`, which stays transparent, so a fill has to
    // be read from background-image when there is one.
    const inkOf = (selectors) =>
      page.evaluate((sels) => {
        const parse = (c) => {
          const m = String(c).match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const q = m[1].split(",").map(Number);
          return { r: q[0], g: q[1], b: q[2], a: q.length > 3 ? q[3] : 1 };
        };
        const over = (f, g) => ({
          r: f.r * f.a + g.r * (1 - f.a),
          g: f.g * f.a + g.g * (1 - f.a),
          b: f.b * f.a + g.b * (1 - f.a),
          a: 1
        });
        const lum = (c) => {
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
          return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
        };
        const ratio = (a, b) => {
          const l1 = lum(a), l2 = lum(b);
          return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        };
        const bodyBg = parse(getComputedStyle(document.body).backgroundColor) || { r: 10, g: 10, b: 11, a: 1 };
        return sels.map((sel) => {
          const el = document.querySelector(sel);
          if (!el) return { sel, missing: true };
          const cs = getComputedStyle(el);
          // The surface the element's own opacity group is composited over.
          let back = null;
          for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
            const p = getComputedStyle(n);
            const c = parse(p.backgroundColor);
            if (c && c.a > 0 && parseFloat(p.opacity) === 1) { back = back ? over(back, c) : c; if (back.a >= 1) break; }
          }
          back = back ? over(back, bodyBg) : bodyBg;
          // Everything painted between the text and the group's edge, and the
          // product of the group's own opacity.
          let fill = null, alpha = 1;
          for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
            const p = getComputedStyle(n);
            const op = parseFloat(p.opacity);
            if (!Number.isNaN(op) && op < 1) alpha *= op;
            const c = parse(p.backgroundColor);
            if (c && c.a > 0) fill = fill ? over(fill, c) : c;
            if (fill && fill.a >= 1) break;
          }
          const bg = fill ? over({ ...fill, a: fill.a * alpha }, back) : back;
          const fg = parse(cs.color);
          const ink = alpha === 1 ? fg : {
            r: fg.r * alpha + back.r * (1 - alpha),
            g: fg.g * alpha + back.g * (1 - alpha),
            b: fg.b * alpha + back.b * (1 - alpha),
            a: 1
          };
          const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
          const needs = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
          // A gradient paints over `background-color`, which a gradient leaves
          // transparent -- so for a button that is filled with one, the surface
          // is its stops and the worst is whichever sits closest in luminance
          // to the ink. Only the element's own gradient counts. An ancestor's
          // counts for nothing: the body wears a radial magenta wash at 8%
          // alpha, and reading that as a surface painted a tint over the tint
          // and moved the overdue row from 5.06:1 to a phantom 4.46 -- and it
          // would depend on where the row happened to have been scrolled to.
          const ownGradient = cs.backgroundImage && cs.backgroundImage.indexOf("gradient") >= 0 ? cs.backgroundImage : null;
          const stops = ownGradient
            ? (String(ownGradient).match(/rgba?\([^)]+\)/g) || []).map(parse).filter(Boolean).map((s) => over(s, back))
            : [bg];
          const worst = stops.reduce((min, s) => Math.min(min, ratio(over(ink, s), s)), Infinity);
          return {
            sel,
            text: (el.textContent || "").trim().slice(0, 22),
            color: cs.color, size: cs.fontSize, needs, gradient: !!ownGradient,
            opacity: Math.round(alpha * 100) / 100,
            ratio: Math.round(worst * 100) / 100
          };
        });
      }, selectors);

    const rowInk = (r, theme) =>
      r.missing
        ? `not on screen (${r.sel})`
        : `${r.ratio}:1 for ${r.size} text that needs ${r.needs}, ink ${r.color}${r.opacity < 1 ? ` at ${r.opacity} opacity` : ""}${r.gradient ? " on a gradient" : ""} in the ${theme} theme`;

    // --- the brand mark ----------------------------------------------------
    // The mark is an <img>, not text, so `color` says nothing about it: it is
    // one shared white-on-transparent SVG -- the data URI in index.html's
    // __ROT_LOGO is fill="none" on its root and fill="#fff" on its only group --
    // painted into nine placements, recoloured only by whatever `filter` the
    // theme applies. The general audit reads `color` on it and so reported the
    // inherited text colour, which is why this went unnoticed: every one of the
    // nine is on --surface or --bg, both near-white once the light theme is on,
    // and white artwork on a white header is not faint, it is absent. Measured
    // 1:1 on the two headers and 1.09:1 on the splash; a screenshot of the light
    // home screen had no mark in it at all.
    //
    // Hidden screens are measured too. Their <img> has a zero box, but the
    // header that paints behind it paints the same colour whether or not the
    // screen is open, so the placement's contrast is real either way -- and
    // measuring all nine means a sixth kiosk screen added later is covered
    // without anyone remembering to add it here.
    const logoInks = () =>
      page.evaluate(() => {
        const parse = (c) => {
          const m = String(c).match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const q = m[1].split(",").map(Number);
          return { r: q[0], g: q[1], b: q[2], a: q.length > 3 ? q[3] : 1 };
        };
        const over = (f, g) => ({
          r: f.r * f.a + g.r * (1 - f.a),
          g: f.g * f.a + g.g * (1 - f.a),
          b: f.b * f.a + g.b * (1 - f.a),
          a: 1
        });
        const lum = (c) => {
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
          return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
        };
        const ratio = (a, b) => {
          const l1 = lum(a), l2 = lum(b);
          return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        };
        const rgb = (c) => `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
        const WHITE = { r: 255, g: 255, b: 255, a: 1 };
        // The artwork's colour once the filter has had it. `invert(p)` maps each
        // channel c -> c*(1-p) + (255-c)*p, so white becomes 255*(1-p) on every
        // channel. Only invert is handled -- it is the only function the
        // stylesheet applies to the mark -- and an unhandled filter leaves the
        // ink white, which fails loudly rather than passing quietly.
        const inkFor = (filter) => {
          const m = filter && String(filter).match(/invert\(\s*([\d.]+)\s*(%?)\s*\)/);
          if (!m) return WHITE;
          const p = m[2] ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
          const v = Math.round(255 * (1 - p));
          return { r: v, g: v, b: v, a: 1 };
        };
        const bodyBg = parse(getComputedStyle(document.body).backgroundColor) || { r: 10, g: 10, b: 11, a: 1 };

        return Array.prototype.map.call(document.querySelectorAll("img[data-logo]"), (el) => {
          const cs = getComputedStyle(el);
          const filter = cs.filter && cs.filter !== "none" ? cs.filter : null;
          const ink = inkFor(filter);
          // The nearest ancestor that paints an opaque colour: the header's
          // --surface, or the screen's --bg.
          let n = el.parentElement, acc = null;
          while (n && n !== document.documentElement) {
            const c = parse(getComputedStyle(n).backgroundColor);
            if (c && c.a > 0) { acc = acc ? over(c, acc) : c; if (acc.a >= 1) break; }
            n = n.parentElement;
          }
          const back = acc ? over(acc, bodyBg) : bodyBg;
          const host = el.closest(".screen");
          const box = el.getBoundingClientRect();
          return {
            cls: el.className, screen: host ? host.id : "(no screen)",
            open: !!(host && !host.classList.contains("hidden")),
            filter, ink: rgb(ink), bg: rgb(back),
            size: `${Math.round(box.width)}x${Math.round(box.height)}`,
            ratio: Math.round(ratio(ink, back) * 100) / 100
          };
        });
      });

    // WCAG 1.4.11, non-text contrast: a graphic that carries meaning needs 3:1.
    const logoRow = (r, theme) =>
      `${r.ratio}:1 for the mark on ${r.screen}${r.open ? "" : " (screen closed)"}, ` +
      `ink ${r.ink} on ${r.bg}, filter ${r.filter || "none"}, ${r.size} in the ${theme} theme`;

    // Three loans, because one badge colour per row is all a row has: overdue,
    // inside the two-hour due-soon window, and out with days to go.
    const badgeNow = Date.now();
    const tempLoan = (id, dueAt, checkedOutAt) => ({
      id, itemId: 9001, borrowerId: 9001, isOpen: "open",
      checkedOutAt, dueAt, itemNameSnapshot: "Second Widget",
      borrowerNameSnapshot: "Zed Borrower", borrowerPhoneSnapshot: "4169998888",
      createdAt: checkedOutAt
    });
    const OVERDUE_LOAN = tempLoan(9101, badgeNow - 86400000, badgeNow - 4 * 86400000);
    const putLoans = (rows) =>
      page.evaluate((list) => new Promise((res, rej) => {
        const q = indexedDB.open("frontdesk");
        q.onerror = () => rej(q.error);
        q.onsuccess = () => {
          const tx = q.result.transaction(["loans"], "readwrite");
          tx.oncomplete = () => res(true);
          tx.onerror = () => rej(tx.error);
          for (const r of list) tx.objectStore("loans").put(r);
        };
      }), rows);
    const dropLoans = (ids) =>
      page.evaluate((list) => new Promise((res, rej) => {
        const q = indexedDB.open("frontdesk");
        q.onerror = () => rej(q.error);
        q.onsuccess = () => {
          const tx = q.result.transaction(["loans"], "readwrite");
          tx.oncomplete = () => res(true);
          tx.onerror = () => rej(tx.error);
          for (const id of list) tx.objectStore("loans").delete(id);
        };
      }), ids);

    await putLoans([
      OVERDUE_LOAN,
      tempLoan(9102, badgeNow + 3600000, badgeNow - 3600000),
      tempLoan(9103, badgeNow + 3 * 86400000, badgeNow - 7200000)
    ]);
    // The check-in list is built by CheckinFlow, which starts on this event --
    // goToScreen alone leaves it empty. Entered by event rather than by clicking
    // the home tile, because this block is about colour and not about routing,
    // and the tile is not reachable while a checkout flow is open.
    const startCheckin = async () => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("frontdesk:checkin-start")));
      await page.waitForSelector("#screen-checkin .loan-item", { timeout: 15000 });
      await new Promise((r) => setTimeout(r, 300));
    };
    await startCheckin();

    const ROW_INKS = [
      [".badge-overdue", "the OVERDUE badge"],
      [".badge-due-soon", "the due-soon badge"],
      [".badge-today", "the out-since badge"],
      [".loan-item.overdue .timing-value.due", "the overdue-by line"]
    ];
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => document.body.classList.toggle("light", t === "light"), theme);
      await new Promise((r) => setTimeout(r, 300));
      const rows = await inkOf(ROW_INKS.map(([s]) => s));
      rows.forEach((r, i) => {
        check(
          `${ROW_INKS[i][1]} is readable in the ${theme} theme`,
          !r.missing && r.ratio >= r.needs,
          rowInk(r, theme)
        );
      });
    }
    await page.evaluate(() => document.body.classList.remove("light"));

    // --- the home chips, in both of their states ---------------------------
    // The chip with nothing overdue is the one that used to be dimmed to 30%,
    // so both states are measured and the zero state is reached by removing the
    // overdue loan rather than by writing data-count by hand.
    const CHIP_INKS = [
      [".overdue-count", "the overdue count"],
      [".overdue-label", "the word OVERDUE"],
      ["#home-overdue-chip .status-num", "the status chip's number"],
      ["#home-overdue-chip .status-label", "the status chip's label"]
    ];
    for (const state of ["live", "zero"]) {
      if (state === "zero") await dropLoans([9101]);
      await page.evaluate(() => window.app.goToScreen("home"));
      await new Promise((r) => setTimeout(r, 500));
      for (const theme of ["dark", "light"]) {
        await page.evaluate((t) => document.body.classList.toggle("light", t === "light"), theme);
        await new Promise((r) => setTimeout(r, 300));
        const rows = await inkOf(CHIP_INKS.map(([s]) => s));
        const shown = await page.evaluate(() => (document.querySelector(".overdue-badge") || {}).dataset?.count);
        rows.forEach((r, i) => {
          check(
            `${CHIP_INKS[i][1]} is readable with ${state === "zero" ? "nothing" : "something"} overdue in the ${theme} theme`,
            !r.missing && r.ratio >= r.needs,
            `${rowInk(r, theme)} (chip reads ${shown})`
          );
        });
      }
    }

    // --- the brand gradient, measured at its stops -------------------------
    // The general audit reads `background-color`, which a gradient leaves
    // transparent, so every .btn-primary in the app came back as 1.09:1 against
    // the page behind it. That looks like the worst failure in the app and is
    // really the audit measuring the wrong surface -- these are the most-used
    // controls there are: the two home tiles, every CONTINUE, and admin LOGIN.
    // White on this gradient is correct and cannot become --on-accent, which
    // comes out at 4.34:1 on magenta; the margin is thin on the dark theme, and
    // this is what holds it.
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => document.body.classList.toggle("light", t === "light"), theme);
      await new Promise((r) => setTimeout(r, 300));
      const [tile] = await inkOf(["#screen-home .btn-home-primary"]);
      check(
        `the home tile's text is readable on the brand gradient in the ${theme} theme`,
        !tile.missing && tile.ratio >= tile.needs,
        rowInk(tile, theme)
      );
    }
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("frontdesk:checkout-start")));
    await page.waitForSelector("#screen-checkout:not(.hidden)", { timeout: 15000 });
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => document.body.classList.toggle("light", t === "light"), theme);
      await new Promise((r) => setTimeout(r, 300));
      const [btn] = await inkOf(["#screen-checkout .btn-primary"]);
      check(
        `and the CONTINUE button's on the same gradient in the ${theme} theme`,
        !btn.missing && btn.ratio >= btn.needs,
        rowInk(btn, theme)
      );
    }
    await page.evaluate(() => document.body.classList.remove("light"));

    // --- the brand mark, in both themes ------------------------------------
    // Every placement, measured against the surface behind it -- not against a
    // token, because the bug was that the token and the surface had drifted
    // apart. The count check comes first: it is what fails if someone adds a
    // tenth placement, or if the inline script at index.html:17 stops filling
    // in `src` and there is nothing left to measure.
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => document.body.classList.toggle("light", t === "light"), theme);
      await new Promise((r) => setTimeout(r, 300));
      const logos = await logoInks();
      check(
        `the brand mark has all nine of its placements in the ${theme} theme`,
        logos.length === 9,
        `found ${logos.length}: ${logos.map((l) => l.cls).join(", ")}`
      );
      for (const r of logos) {
        check(
          `the ${r.cls} mark is drawn on ${r.screen} in the ${theme} theme`,
          r.ratio >= 3,
          logoRow(r, theme)
        );
      }
    }
    await page.evaluate(() => document.body.classList.remove("light"));

    // Back to the two loans the rest of the run expects, and back on the
    // check-in screen, since the block below clicks its first row.
    await dropLoans([9102, 9103]);
    await startCheckin();

    await clickOn("#screen-checkin .loan-item");
    await page.waitForSelector("#screen-checkin-return:not(.hidden)", { timeout: 15000 });

    // --- the two failure colours, and what is printed on them --------------
    // These three buttons are the only place the app paints text on a solid
    // semantic fill, and they were wrong: `color: #fff` measured 2.54:1 on the
    // green and 3.76:1 on the red, both under AA for 18px/600 text, in the dark
    // theme alone. The fix was an ink that follows the theme (--on-accent), and
    // per-theme hover tokens, because the old fixed hover hexes went the wrong
    // way on the light theme: hovering made the fill lighter and took the text
    // to 3.46 / 2.92 / 4.43. This measures the colour computed against the
    // colour actually painted, in both themes, at rest and under the mouse.
    const contrastOf = () =>
      page.evaluate(() => {
        const parse = (c) => {
          const m = String(c).match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const q = m[1].split(",").map(Number);
          return { r: q[0], g: q[1], b: q[2], a: q.length > 3 ? q[3] : 1 };
        };
        const over = (f, g) => ({
          r: f.r * f.a + g.r * (1 - f.a),
          g: f.g * f.a + g.g * (1 - f.a),
          b: f.b * f.a + g.b * (1 - f.a),
          a: 1
        });
        const lum = (c) => {
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
          return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
        };
        return [...document.querySelectorAll("#screen-checkin-return .btn-return")].map((el) => {
          const cs = getComputedStyle(el);
          const fg = parse(cs.color);
          let acc = null, n = el;
          while (n && n !== document.documentElement) {
            const c = parse(getComputedStyle(n).backgroundColor);
            if (c && c.a > 0) { acc = acc ? over(acc, c) : c; if (acc.a >= 1) break; }
            n = n.parentElement;
          }
          const body = parse(getComputedStyle(document.body).backgroundColor) || { r: 0, g: 0, b: 0, a: 1 };
          const bg = acc ? over(acc, body) : body;
          const l1 = lum(over(fg, bg)), l2 = lum(bg);
          const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
          return {
            text: (el.textContent || "").trim(),
            theme: document.body.classList.contains("light") ? "light" : "dark",
            fill: cs.backgroundColor,
            ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100,
            needs: size >= 24 || (bold && size >= 18.66) ? 3 : 4.5
          };
        });
      });

    const returnBtns = await page.$$("#screen-checkin-return .btn-return");
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => document.body.classList.toggle("light", t === "light"), theme);
      await new Promise((r) => setTimeout(r, 250));
      for (let i = 0; i < returnBtns.length; i++) {
        await page.mouse.move(5, 5);
        await new Promise((r) => setTimeout(r, 150));
        const rest = (await contrastOf())[i];
        await returnBtns[i].hover(); // a real mouse move, so a real :hover
        await new Promise((r) => setTimeout(r, 200));
        const hover = (await contrastOf())[i];
        check(
          `${rest.text} is readable on its fill in the ${theme} theme`,
          rest.ratio >= rest.needs,
          `${rest.ratio}:1 on ${rest.fill}, needs ${rest.needs}`
        );
        check(
          `and stays readable while hovered in the ${theme} theme`,
          hover.ratio >= hover.needs,
          `${hover.ratio}:1 on ${hover.fill}, needs ${hover.needs}`
        );
      }
    }
    // Back to the theme the app boots in before anything downstream measures it.
    await page.evaluate(() => document.body.classList.remove("light"));
    await page.mouse.move(5, 5);
    await new Promise((r) => setTimeout(r, 250));

    await clickOn('#screen-checkin-return .btn-return[data-condition="damaged"]');
    await page.waitForSelector("#dialog .dialog-card", { timeout: 5000 });

    const dialogCondition = await page.evaluate(() => {
      const el = document.querySelector("#dialog .summary-condition");
      return el ? { cls: el.className, text: el.textContent.trim() } : null;
    });
    check(
      "and the dialog tells the staff member it is damaged, not good",
      !!dialogCondition && dialogCondition.cls.includes("damaged"),
      JSON.stringify(dialogCondition)
    );

    await page.evaluate(() => {
      const card = document.querySelector("#dialog .dialog-card");
      const buttons = Array.from(card.querySelectorAll("button"));
      const confirm = buttons.find((b) => b.textContent.includes("Confirm Return")) || buttons[buttons.length - 1];
      confirm.click();
    });
    await page.waitForFunction(() => document.getElementById("dialog").classList.contains("hidden"), { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 1200)); // past the return + re-render

    const afterReturn = await loansInDb();
    const returned = Array.isArray(afterReturn) ? afterReturn.find((l) => l.isOpen !== "open") : null;
    check("the loan is closed by the return", !!returned, JSON.stringify(afterReturn));
    check("and it is recorded as damaged, which is what was tapped", !!returned && returned.conditionIn === "damaged", JSON.stringify(returned));

    // --- On a narrow screen the period labels must not be ellipsised -------
    // Four of them side by side at tablet-in-portrait width leaves each one
    // showing "Last 3…", which is worse than no label at all.
    //
    // Back to the Reports tab first: the checks above drove the return flow,
    // which left the panel behind, and the period buttons this measures only
    // exist while that tab is rendered.
    await page.evaluate(() => window.app.goToScreen("admin"));
    await page.click('.tab[data-tab="reports"]');
    await page.waitForFunction(() => document.querySelectorAll("#tab-reports .report-period").length > 0, { timeout: 15000 });
    await page.setViewport({ width: 480, height: 900 });
    await new Promise((r) => setTimeout(r, 250));
    const narrow = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("#tab-reports .report-period"));
      return {
        rows: new Set(btns.map((b) => b.offsetTop)).size,
        allLabelsFit: btns.every((b) => b.scrollWidth <= b.clientWidth + 1),
        widest: Math.max(...btns.map((b) => b.scrollWidth - b.clientWidth)),
        toolbarWraps: document.querySelector(".report-toolbar").getBoundingClientRect().height
      };
    });
    check("at 480px the period switch wraps instead of squashing", narrow.rows === 2, JSON.stringify(narrow));
    check("and every period label is readable, not ellipsised", narrow.allLabelsFit, `overflow ${narrow.widest}px`);
    await page.setViewport({ width: 1280, height: 1100 });

    // ── accessibility, on the real screens ────────────────────────────────
    // Not a general audit -- a browser engine is the wrong tool for that. These
    // are the four things a hand-written single-page app gets wrong when nobody
    // checks: a control with no name, a field whose only label is a placeholder,
    // a heading level skipped, and a screen with no heading at all. Each was
    // found by measuring and then fixed; these keep them fixed.
    const a11yOf = () => {
      const screen = document.querySelector(".screen:not(.hidden)");
      const vis = (el) => {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const mine = (el) => !screen || screen.contains(el);
      const unnamed = [];
      for (const el of document.querySelectorAll("button, a[href], [role=button]")) {
        if (!vis(el) || !mine(el)) continue;
        const aria = el.getAttribute("aria-label");
        const by = el.getAttribute("aria-labelledby");
        const lab = by ? by.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || "").join(" ") : "";
        if (!(aria && aria.trim()) && !(lab && lab.trim()) && !(el.textContent || "").trim()) {
          unnamed.push(el.tagName + "." + String(el.className).slice(0, 30));
        }
      }
      const unlabelled = [];
      for (const el of document.querySelectorAll("input, select, textarea")) {
        if (!vis(el) || !mine(el) || el.type === "hidden") continue;
        const hasFor = el.id && document.querySelector(`label[for="${el.id}"]`);
        const aria = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
        if (!hasFor && !el.closest("label") && !aria) {
          unlabelled.push(el.tagName + "." + String(el.className).slice(0, 26));
        }
      }
      const hs = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter((h) => vis(h) && mine(h)).map((h) => +h.tagName[1]);
      const jumps = [];
      let prev = 0;
      for (const lvl of hs) {
        if (prev && lvl > prev + 1) jumps.push(`h${prev}->h${lvl}`);
        prev = lvl;
      }
      return {
        screen: screen ? screen.id : "(none)",
        unnamed, unlabelled, jumps,
        h1: [...document.querySelectorAll("h1")].filter((h) => vis(h) && mine(h)).length,
        first: hs.length ? hs[0] : null
      };
    };

    const a11yRoutes = [
      ["welcome", () => {}],
      ["admin-login", () => window.app.showAdminLogin()],
      ["home", () => window.app.goToScreen("home")],
      ["checkout", () => window.dispatchEvent(new CustomEvent("frontdesk:checkout-start"))],
      ["checkin", () => window.dispatchEvent(new CustomEvent("frontdesk:checkin-start"))],
      ["admin", () => window.app.goToScreen("admin")]
    ];
    for (const [label, go] of a11yRoutes) {
      await page.evaluate(go);
      await new Promise((r) => setTimeout(r, 700));
      const a = await page.evaluate(a11yOf);
      check(`every control on ${label} has a name`, a.unnamed.length === 0, JSON.stringify(a.unnamed));
      check(`every field on ${label} has a label, not just a placeholder`, a.unlabelled.length === 0, JSON.stringify(a.unlabelled));
      check(`no heading level is skipped on ${label}`, a.jumps.length === 0, JSON.stringify(a.jumps));
      check(`${label} has exactly one h1, and it comes first`, a.h1 === 1 && a.first === 1, `h1=${a.h1} first=${a.first}`);
    }

    const lateErrors = errors.filter((e) => !/favicon/.test(e));
    check("still no errors after exercising the UI", lateErrors.length === 0, lateErrors.join(" | "));

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
  console.error("\nThe run itself failed:", err && err.message);
  process.exit(1);
});
