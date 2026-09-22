// Layout at real widths, in a real browser, with real data in the tables.
//
//   node tools/test-responsive.cjs
//
// Every other suite drives behaviour. This one is about whether the thing is
// usable at the sizes it is actually used at: a phone at the front desk, a
// tablet on a stand, and a laptop. It measures rather than eyeballs, because
// "it looked fine in the screenshot" misses the element that starts one pixel
// past the fold on the one screen nobody opened.
//
// Three things this checks that a screenshot cannot:
//
//   * horizontal document scroll -- the whole page sliding sideways, which is
//     the failure people notice and the one that hides content behind the edge
//   * content past the viewport that is not inside a deliberate horizontal
//     scroller (the admin tab strip is one of those, and is left alone)
//   * tap targets below WCAG 2.2 SC 2.5.8's 24x24 CSS px minimum
//
// Worst-case data, not sample data: names at the length the forms allow, long
// categories, notes, and enough open/overdue/returned loans to fill every
// table. An empty database makes any layout look clean.

const fs = require("fs");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..", "web");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8798;

// WCAG 2.2 SC 2.5.8 (Target Size, Minimum) is 24x24 CSS px. The comfortable
// size most touch guidance asks for is 44. Between the two is worth reporting
// but is not a failure, so it does not turn the suite red.
const TAP_MIN = 24;
const TAP_COMFORTABLE = 44;

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
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

// Names at the length the forms allow, so the widest row the app can produce is
// the widest row it is measured against.
const SEED = `(() => new Promise((resolve, reject) => {
  const req = indexedDB.open("frontdesk", 3);
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction(["items", "borrowers", "loans"], "readwrite");
    const items = tx.objectStore("items");
    const borrowers = tx.objectStore("borrowers");
    const loans = tx.objectStore("loans");

    const NAMES = [
      "Logitech Spotlight Presentation Remote (wireless, USB-C, includes charging cable and carry pouch)",
      "Kensington Presenter Expert Green Laser Pointer with 2.4GHz receiver and hard travel case",
      "Anker 737 Power Bank 24000mAh 140W - for laptop charging at events and offsite workshops",
      "Blue Yeti USB Microphone with boom arm, shock mount, pop filter and XLR adapter cable",
      "HDMI 2.1 8K Cable 3m - braided, gold-plated, for the boardroom display and lectern setup",
      "Room 1050 master key (blue fob, do not duplicate - return to front desk immediately)"
    ];
    const CATS = ["Presentation & Audio-Visual Equipment", "Power & Charging", "Keys & Access", "Other"];
    const LOCS = ["Cabinet 3, second shelf, left-hand side near the window", "Front desk drawer (bottom right)", "AV closet, shelf B"];
    const PEOPLE = [
      "Alexandria Konstantinopoulos-Wren", "Bartholomew Fitzgerald-Smythe", "Priya Ranganathan-Nakamura",
      "Zbigniew Wisniewski-Okonkwo", "Maria-Jose de la Cruz Villanueva", "Oluwaseun Adedayo-Babatunde"
    ];

    const itemIds = [];
    const borrowerIds = [];
    let pending = 0;
    const done = () => { if (--pending === 0) finish(); };

    for (let i = 0; i < 36; i++) {
      pending++;
      const r = items.add({
        name: NAMES[i % NAMES.length] + (i > 5 ? " #" + (i + 1) : ""),
        nameLower: NAMES[i % NAMES.length].toLowerCase(),
        category: CATS[i % CATS.length],
        location: LOCS[i % LOCS.length],
        condition: i % 11 === 0 ? "damaged" : "good",
        notes: i % 5 === 0 ? "Checked after the conference; one cable missing, otherwise complete. See Cameron if it is needed for a session before it is replaced." : "",
        timesCheckedOut: i * 3,
        lastCheckedOutAt: Date.now() - i * 86400000,
        isArchived: false,
        createdAt: Date.now() - 30 * 86400000
      });
      r.onsuccess = () => { itemIds.push(r.result); done(); };
      r.onerror = () => reject(r.error);
    }

    for (let i = 0; i < 24; i++) {
      pending++;
      const nm = PEOPLE[i % PEOPLE.length] + (i > 5 ? " " + String.fromCharCode(65 + (i % 26)) + "." : "");
      const r = borrowers.add({
        phone: "416555" + String(1000 + i),
        phoneFormatted: "(416) 555-" + String(1000 + i),
        name: nm,
        nameLower: nm.toLowerCase(),
        contact2: i % 3 === 0 ? "a.very.long.email.address@rotman.utoronto.ca" : "",
        timesCheckedOut: i * 2,
        lastSeenAt: Date.now() - i * 3600000,
        notes: i % 4 === 0 ? "Faculty - prefers email. Keeps the clicker over the weekend when teaching." : "",
        isArchived: false,
        createdAt: Date.now() - 60 * 86400000
      });
      r.onsuccess = () => { borrowerIds.push(r.result); done(); };
      r.onerror = () => reject(r.error);
    }

    function finish() {
      // A third of each: open, overdue, returned.
      const now = Date.now();
      let n = 70;
      for (let i = 0; i < 70; i++) {
        pending++;
        const open = i % 3 === 0;
        const overdue = i % 3 === 1;
        const ii = i % itemIds.length;
        const bi = i % borrowerIds.length;
        const r = loans.add({
          itemId: itemIds[ii],
          itemNameSnapshot: NAMES[ii % NAMES.length] + (ii > 5 ? " #" + (ii + 1) : ""),
          borrowerId: borrowerIds[bi],
          borrowerPhoneSnapshot: "416555" + String(1000 + bi),
          borrowerNameSnapshot: PEOPLE[bi % PEOPLE.length],
          checkedOutAt: now - (i + 1) * 6 * 3600000,
          dueAt: overdue ? now - (i + 1) * 3600000 : now + (8 - (i % 8)) * 3600000,
          returnedAt: open || overdue ? null : now - i * 1800000,
          isOpen: open || overdue ? "open" : "closed",
          conditionOut: "good",
          conditionIn: open || overdue ? null : (i % 7 === 0 ? "damaged" : "good"),
          notes: i % 6 === 0 ? "Borrower called to say one item is being returned late because the session ran over." : "",
          recordedBy: "front desk"
        });
        r.onsuccess = () => { if (--n === 0) { tx.oncomplete = () => resolve({ items: itemIds.length, borrowers: borrowerIds.length, loans: 70 }); } };
        r.onerror = () => reject(r.error);
      }
    }
  };
}))()`;

// Everything the layout is judged on, for whatever is on screen right now.
//
// Deliberately not a screenshot diff: a pixel comparison cannot tell a clipped
// word from a wrapped one, and it breaks on every unrelated colour change.
const MEASURE = `(() => {
  const vw = window.innerWidth;
  const doc = document.documentElement;

  // An element inside a container that scrolls horizontally is not a page
  // overflow -- that is the container doing its job. The admin tab strip is
  // one of these on a phone, on purpose.
  const insideScroller = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true;
      p = p.parentElement;
    }
    return false;
  };

  const visible = (el) => {
    if (el.closest('.hidden')) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility();
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };

  const label = (el) => {
    let s = el.id ? '#' + el.id : el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean) : [];
    if (cls.length) s += '.' + cls.slice(0, 2).join('.');
    return s;
  };

  const over = [];
  const clipped = [];
  const smallTap = [];
  const cramped = [];
  const covered = [];
  const seenSmall = new Set();
  const seenCovered = new Set();

  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) continue;
    const tag = el.tagName.toLowerCase();

    if (r.right > vw + 1 && !insideScroller(el)) {
      over.push(label(el) + ' ' + Math.round(r.width) + 'w +' + Math.round(r.right - vw) + 'px');
    }

    // Leaf elements only: a wrapper with overflowing children is the children's
    // problem, and they are reported in their own right.
    if (cs.overflow === 'hidden' && el.children.length === 0 && el.scrollWidth > el.clientWidth + 2) {
      // text-overflow: ellipsis is truncation on purpose. scrollWidth is larger
      // than clientWidth whether or not the ellipsis is drawn, so without this
      // every deliberately-truncated row reports as a bug.
      if (cs.textOverflow !== 'ellipsis' && cs.textOverflow !== 'clip') {
        clipped.push(label(el) + ' needs ' + el.scrollWidth + ' has ' + el.clientWidth + ' "' + (el.textContent || '').trim().slice(0, 32) + '"');
      }
    }

    // WCAG 2.2 SC 2.5.8 exempts targets in a sentence, so inline links are not
    // measured -- only things that are controls in their own right.
    const isControl = tag === 'button' || tag === 'select' || tag === 'textarea' ||
      (tag === 'input' && el.type !== 'hidden') ||
      el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab';
    const isBlockLink = tag === 'a' && cs.display !== 'inline';
    if ((isControl || isBlockLink) && r.height > 0 && !el.disabled) {
      const key = label(el) + '|' + Math.round(r.width) + 'x' + Math.round(r.height);
      if (r.height < ${TAP_MIN} || r.width < ${TAP_MIN}) {
        if (!seenSmall.has(key)) { seenSmall.add(key); smallTap.push(label(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
      } else if ((r.height < ${TAP_COMFORTABLE} || r.width < ${TAP_COMFORTABLE}) && !seenSmall.has(key)) {
        seenSmall.add(key);
        cramped.push(label(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }

      // Can this be pressed at all?
      //
      // Every other check here reads the box: how big it is, where it sits,
      // whether its text fits. None of them notice that something else is on
      // top of it. The on-screen keypad is a fixed overlay and sits over the
      // bottom of the screen, so on the PIN screen LOGIN and Cancel were both
      // underneath it -- full size, in the right place, and impossible to
      // press, because a tap landed on a keycap. Every suite drove that screen
      // with el.click(), which skips hit-testing entirely and so never saw it.
      //
      // Only the centre is tested, and only when the centre is on screen: a
      // control below the fold is reached by scrolling, and calling that
      // "covered" would fail every long list in the app. Note this uses the
      // screen it is given, so a control inside a fixed overlay is judged where
      // it actually is.
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // pointer-events: none is an element saying it does not take taps --
      // the keypad between hiding and the end of its slide-out is the one that
      // matters here. It computes to none on the keys themselves, because the
      // property inherits.
      if (cs.pointerEvents === 'none') {
        // deliberately untappable; not a layout fault
      } else if (cx >= 0 && cx <= vw && cy >= 0 && cy <= window.innerHeight) {
        const hitEl = document.elementFromPoint(cx, cy);
        if (hitEl && hitEl !== el && !el.contains(hitEl) && !hitEl.contains(el)) {
          const key2 = label(el) + '|' + Math.round(r.width) + 'x' + Math.round(r.height);
          if (!seenCovered.has(key2)) {
            seenCovered.add(key2);
            covered.push(label(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' under ' + label(hitEl));
          }
        }
      }
    }
  }

  return {
    vw,
    hScroll: doc.scrollWidth > vw + 1,
    docW: doc.scrollWidth,
    over, clipped, smallTap, cramped, covered
  };
})()`;

// `touch` is not decoration: the stylesheet has a whole `pointer: coarse`
// block that grows .btn, .input and .tab to 64-80px, so a phone and a tablet
// lay out differently from a laptop at the same width. The desk tablet is the
// main touch device this runs on, so 768 and 1024 are measured as touch, and
// the two desktop widths as a mouse -- which is what they are.
const BREAKPOINTS = [
  { name: "phone-375", w: 375, h: 667, touch: true },
  { name: "phone-412", w: 412, h: 915, touch: true },
  { name: "tablet-768", w: 768, h: 1024, touch: true },
  { name: "tablet-1024", w: 1024, h: 768, touch: true },
  { name: "laptop-1280", w: 1280, h: 800, touch: false },
  { name: "desktop-1440", w: 1440, h: 900, touch: false }
];

// Screens reached by toggling the class directly. They are the kiosk flow,
// which by design refuses to be navigated out of, and the splash, which is
// already gone by the time a test can look at it. Behaviour on these screens is
// covered by test-kiosk.cjs; here it is only their layout that is at stake, and
// forcing one on screen measures it without a press-and-hold to escape with.
const FORCED = [
  "screen-splash",
  "screen-kiosk-borrow-phone",
  "screen-kiosk-borrow-name",
  "screen-kiosk-borrow-need",
  "screen-kiosk-borrow-done",
  "screen-kiosk-return-phone",
  "screen-kiosk-return-items",
  "screen-admin-login"
];

// Screens reached through the app's own router, so their onEnter hooks run and
// they hold real rows. These names are the router's, not the DOM ids: the map
// is keyed without the "screen-" prefix.
const ROUTED = ["home", "checkout", "checkin", "checkin-return"];

const TABS = ["queue", "currently-out", "overdue", "all-loans", "items", "people", "reports", "settings"];

// A layout suite that measures empty screens reports every width as clean, so
// it has to prove it was looking at a full one. This says the seeded rows
// reached the DOM: a list showing a name only the seed could have produced,
// and a Home status bar counting the seeded loans.
//
// The Home count is also a check in its own right. Nothing about goToScreen
// used to refresh that bar, so it was right only because every caller
// remembered to refresh it by hand; the onEnter hook is what makes it hold.
const FULL_LIST = "Fitzgerald-Smythe";

const RENDERED = (selector, needle) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const txt = el ? el.textContent : '';
  return {
    found: txt.includes(${JSON.stringify(needle)}),
    chars: txt.length
  };
})()`;

const HOME_COUNTS = `(() => {
  const t = (sel) => ((document.querySelector(sel) || {}).textContent || '').trim();
  return { out: t('#home-stat-out'), overdue: t('#home-stat-overdue') };
})()`;

(async () => {
  console.log("\nLayout at real widths\n");

  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ["--no-first-run", "--disable-gpu", "--disable-extensions"]
  });

  const problems = [];
  const record = (bp, where, m) => {
    const bad = m.hScroll || m.over.length || m.clipped.length || m.smallTap.length || m.covered.length;
    const bits = [];
    if (m.hScroll) bits.push(`page scrolls sideways (${m.docW} > ${m.vw})`);
    m.over.forEach((o) => bits.push("past the edge: " + o));
    m.clipped.forEach((o) => bits.push("clipped: " + o));
    m.smallTap.forEach((o) => bits.push("tap target under " + TAP_MIN + "px: " + o));
    m.covered.forEach((o) => bits.push("cannot be pressed: " + o));
    if (bad) {
      problems.push(`${bp} ${where}: ${bits.join("; ")}`);
      console.error(`FAIL  ${bp} ${where}`);
      bits.forEach((b) => console.error(`        ${b}`));
    } else {
      // Named, not just counted: a number tells you there is something to look
      // at and nothing about where to look.
      const cramped = m.cramped.length ? `  (under ${TAP_COMFORTABLE}px: ${m.cramped.join(", ")})` : "";
      console.log(`  ok  ${bp} ${where}${cramped}`);
    }
  };

  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => {
      failures++;
      console.error(`FAIL  page error: ${e.message}`);
    });

    // Seed once at a comfortable width, then reload per breakpoint. The seed
    // writes into the same origin the app uses, so every later load has data.
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 30000 });
    const seeded = await page.evaluate(SEED);
    console.log(`  ok  seeded ${seeded.items} items, ${seeded.borrowers} borrowers, ${seeded.loans} loans\n`);

    for (const bp of BREAKPOINTS) {
      await page.setViewport({
        width: bp.w,
        height: bp.h,
        isMobile: bp.touch,
        hasTouch: bp.touch,
        deviceScaleFactor: 1
      });
      await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 30000 });
      record(bp.name, "welcome", await page.evaluate(MEASURE));

      for (const id of FORCED) {
        await page.evaluate((sid) => {
          document.querySelectorAll("section.screen").forEach((s) => s.classList.add("hidden"));
          const el = document.getElementById(sid);
          if (el) el.classList.remove("hidden");
        }, id);
        await new Promise((r) => setTimeout(r, 120));
        record(bp.name, id, await page.evaluate(MEASURE));
      }

      // Back to a clean load so the login below is a real one.
      await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 30000 });
      await page.evaluate(() => window.app.showAdminLogin());
      await page.waitForSelector("#screen-admin-login:not(.hidden)", { timeout: 10000 });

      // The PIN screen as the app actually presents it. The field takes focus
      // on arrival and focus opens the on-screen keypad, which is fixed across
      // the bottom -- so this, not the bare screen, is the thing to measure.
      // The forced pass above toggles the class and shows the screen with no
      // keypad, which is a state no person ever sees.
      await page
        .waitForFunction(() => document.getElementById("keyboard").classList.contains("visible"), { timeout: 10000 })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 600));
      record(bp.name, "admin-login (keypad up)", await page.evaluate(MEASURE));

      await page.type("#screen-admin-login .pin-input", "1234");
      await page.click("#screen-admin-login .pin-submit");
      await page.waitForSelector("#screen-admin:not(.hidden)", { timeout: 15000 });
      record(bp.name, "admin", await page.evaluate(MEASURE));

      // The counts in the admin header, read as a row of one line each.
      //
      // They used to be a column squeezed beside the title, which broke
      // "Overdue:" away from its number and made the header 183px tall on a
      // 375px screen. Nothing in the overflow or clipping checks notices a
      // wrapped label -- the text is there, it is simply hard to read -- so
      // this measures the thing that was actually wrong: a stat that has gone
      // onto two lines.
      await page.waitForFunction(
        () => document.querySelectorAll("#screen-admin .admin-stats .stat").length >= 2,
        { timeout: 10000 });
      const statLines = await page.evaluate(`(() => {
        const stats = [...document.querySelectorAll("#screen-admin .admin-stats .stat")];
        return stats.map((s) => Math.round(s.getBoundingClientRect().height));
      })()`);
      check(
        `${bp.name}: the admin counts sit on one line each`,
        statLines.length >= 2 && statLines.every((h) => h <= 24),
        `heights ${JSON.stringify(statLines)}`);

      for (const tab of TABS) {
        // The toast sits top-centre over the page and takes the click if it is
        // still up, so it is emptied first.
        await page.evaluate(() => {
          const to = document.getElementById("toast");
          if (to) to.textContent = "";
        });
        const clicked = await page.evaluate((t) => {
          const el = document.querySelector(`.tab[data-tab="${t}"]`);
          if (!el) return false;
          el.scrollIntoView({ block: "center", behavior: "instant" });
          el.click();
          return true;
        }, tab);
        if (!clicked) {
          failures++;
          console.error(`FAIL  no admin tab named "${tab}"`);
          continue;
        }
        await new Promise((r) => setTimeout(r, 700));
        record(bp.name, "tab:" + tab, await page.evaluate(MEASURE));

        // "currently-out" lists every open loan, so a seeded borrower surname
        // in it is proof the tables the other tabs draw are not empty.
        if (tab === "currently-out" && bp.name === BREAKPOINTS[0].name) {
          const r = await page.evaluate(RENDERED("#tab-currently-out", FULL_LIST));
          check("the seeded loans reached the admin lists", r.found, `no "${FULL_LIST}" in #tab-currently-out (${r.chars} chars)`);
        }
      }

      for (const screen of ROUTED) {
        const went = await page.evaluate((s) => {
          const r = window.app.goToScreen(s);
          return r !== null && r !== undefined;
        }, screen);
        if (!went) {
          failures++;
          console.error(`FAIL  the router refused to open "${screen}"`);
          continue;
        }
        await new Promise((r) => setTimeout(r, 600));
        const m = await page.evaluate(MEASURE);
        record(bp.name, screen, m);

        // Reaching Home through the router alone has to leave the status bar
        // counting, not showing whatever it said last.
        if (screen === "home") {
          const c = await page.evaluate(HOME_COUNTS);
          check(
            `${bp.name}: Home counts the loans that exist`,
            Number(c.out) > 0 && Number(c.overdue) > 0,
            `out=${c.out} overdue=${c.overdue} with 70 seeded loans`
          );
        }
      }

      console.log("");
    }
  } finally {
    await browser.close();
    server.close();
  }

  check(`no layout problem at any width (${problems.length} found)`, problems.length === 0);
  console.log("");
  if (failures) {
    console.error(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("all checks passed\n");
})().catch((e) => {
  console.error("run failed:", e.message);
  process.exit(1);
});
