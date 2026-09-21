// The on-screen keyboard under a finger, which is how it is actually used.
//
//   node tools/test-touch.cjs
//
// Everything here is dispatched as real input through CDP (Input.dispatchTouchEvent
// and page.mouse), never as synthetic JS events, because the thing being tested
// is precisely how the browser turns a touch into the compatibility mouse
// events. A synthetic mousedown would pass whether or not the real gesture works.
//
// Two traps this suite guards against:
//   - Headless Chromium never finishes the keyboard's slide-in, so the bottom
//     row of keys hangs below the viewport and every touch lands on nothing.
//     Transitions are disabled, and a check asserts the key is genuinely
//     hittable so the suite cannot go green vacuously.
//   - The mouse path must keep working. Pointer events were adopted to fix
//     touch, not to replace the mouse.

const fs = require("fs");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..", "web");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8795;

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
  console.log("\nOn-screen keyboard, by touch and by mouse\n");

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
    await page.setViewport({ width: 900, height: 1000 });

    const cdp = await page.createCDPSession();
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });

    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle2" });

    // See the header: without this the keyboard sits part-way off the bottom of
    // the screen and nothing below can be trusted.
    await page.addStyleTag({
      content: "*, *::before, *::after { transition: none !important; animation: none !important; }"
    });

    // ── bring up the keyboard over a plain input ──────────────────────────
    await page.waitForSelector(".btn-kiosk-borrow", { timeout: 15000 });
    await page.click(".btn-kiosk-borrow");
    await page.waitForSelector("#screen-kiosk-borrow-phone:not(.hidden)", { timeout: 15000 });
    await page.click("#kiosk-phone");
    await page.waitForFunction(
      () => {
        const k = document.querySelector(".keyboard");
        return !!k && k.classList.contains("visible");
      },
      { timeout: 15000 }
    );
    check("tapping the phone box brings up the keyboard", true);

    const value = () => page.$eval("#kiosk-phone", (el) => el.value);

    // page.type appends, and a bare `.value =` leaves the caret at 0, where
    // _backspace deletes nothing (it only fires when start === end and start > 0).
    // Set the value and park the caret at the end, as typing would.
    const fill = (text) =>
      page.evaluate((t) => {
        const el = document.querySelector("#kiosk-phone");
        el.focus();
        el.value = t;
        el.setSelectionRange(t.length, t.length);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, text);

    // The key is rebuilt whenever the keyboard re-renders, so re-measure it
    // before every interaction rather than caching a coordinate.
    const keyBox = () =>
      page.evaluate(() => {
        const el = document.querySelector(".kbd.backspace");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const at = document.elementFromPoint(x, y);
        return {
          x,
          y,
          onScreen: r.top >= 0 && r.bottom <= window.innerHeight,
          hits: !!at && (at === el || el.contains(at)),
          atPoint: at ? at.className || at.tagName : null
        };
      });

    // ── the guard ─────────────────────────────────────────────────────────
    await fill("5551234");
    const box = await keyBox();
    check(
      "the backspace key is on screen and a touch at its centre hits it",
      !!box && box.onScreen && box.hits,
      JSON.stringify(box)
    );

    const touch = async (type, point) => {
      await cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x: point.x, y: point.y, id: 1 }]
      });
    };

    // ── a tap is still a tap ──────────────────────────────────────────────
    await touch("touchStart", box);
    await sleep(60);
    await touch("touchEnd", box);
    await sleep(200);
    check("a touch tap removes exactly one character", (await value()) === "555123", await value());

    // ── press and hold clears ─────────────────────────────────────────────
    await fill("5551234");
    check("the field is filled again before the hold", (await value()) === "5551234", await value());

    const box2 = await keyBox();
    await touch("touchStart", box2);
    await sleep(900);
    const duringHold = await value();
    check("holding backspace clears the field while the finger is still down", duringHold === "", duringHold);

    await touch("touchEnd", box2);
    await sleep(250);
    const afterRelease = await value();
    check("and lifting the finger does not put it back", afterRelease === "", afterRelease);

    // The compat click that follows a long press must not delete a second time;
    // there is nothing left to delete here, so type one character and hold, then
    // confirm release leaves exactly that one character gone and no more.
    await fill("9");
    const box3 = await keyBox();
    await touch("touchStart", box3);
    await sleep(900);
    await touch("touchEnd", box3);
    await sleep(250);
    check("a long press followed by its compatibility click deletes once, not twice", (await value()) === "", await value());

    // ── the mouse path still works ────────────────────────────────────────
    await fill("5551234");
    const box4 = await keyBox();
    await page.mouse.move(box4.x, box4.y);
    await page.mouse.down();
    await sleep(900);
    const mouseDuring = await value();
    await page.mouse.up();
    await sleep(200);
    check("a mouse press-and-hold still clears the field", mouseDuring === "", mouseDuring);
    check("and releasing the mouse leaves it clear", (await value()) === "", await value());

    await fill("5551234");
    const box5 = await keyBox();
    await page.mouse.click(box5.x, box5.y);
    await sleep(200);
    check("a mouse click removes exactly one character", (await value()) === "555123", await value());

    // A mouse press held briefly must not clear -- the threshold has to hold on
    // this path too, or every ordinary tap would wipe the field.
    await fill("5551234");
    const box6 = await keyBox();
    await page.mouse.move(box6.x, box6.y);
    await page.mouse.down();
    await sleep(120);
    await page.mouse.up();
    await sleep(200);
    check("a quick mouse click does not clear the whole field", (await value()) === "555123", await value());

    // ── no context menu over the keyboard ─────────────────────────────────
    // Press-and-hold is right-click on Windows touch, so the menu would appear
    // at the same moment the clear fires.
    const menuSuppressed = await page.evaluate(() => {
      const el = document.querySelector(".kbd.backspace");
      if (!el) return "no key";
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      const notCancelled = el.dispatchEvent(ev);
      return notCancelled ? "not suppressed" : "suppressed";
    });
    check("the keyboard suppresses the context menu", menuSuppressed === "suppressed", menuSuppressed);

    // ── a late frame must not slide the keyboard back up ──────────────────
    // The keyboard fades in by dropping `hidden`/`visible` now and adding
    // `visible` on the next frame, so a frame can still be outstanding when
    // hide() runs -- hide() is only ever a task away (the Done key, or a
    // focusout plus 150ms), and a main thread busy with an IndexedDB write is
    // enough to delay the frame past it. A stale frame then re-showed a
    // keyboard hide() had already made inert: on screen, sliding up over the
    // entry, and dead to every tap. Holding frames here reproduces that
    // interval deterministically; every callback is delivered afterwards, so
    // the app's own code is what is under test.
    const kbdState = () =>
      page.evaluate(() => {
        const el = document.querySelector("#keyboard");
        return {
          visible: el.classList.contains("visible"),
          hidden: el.classList.contains("hidden"),
          inert: el.inert === true
        };
      });

    // Start from hidden, so the show() below is a real transition.
    await page.evaluate(() => document.activeElement.blur());
    await sleep(400);
    check("blurring the field puts the keyboard away", !(await kbdState()).visible, JSON.stringify(await kbdState()));

    await page.evaluate(() => {
      window.__rafQ = [];
      window.__rafReal = window.requestAnimationFrame;
      window.requestAnimationFrame = (cb) => {
        window.__rafQ.push(cb);
        return 0;
      };
    });
    await page.click("#kiosk-phone");
    await sleep(200);

    // show() has run -- it is not inert and not hidden -- but its frame is
    // still held, which is the state the bug needs.
    const midShow = await kbdState();
    check("show() runs while its fade-in frame is held back", !midShow.inert && !midShow.hidden, JSON.stringify(midShow));
    check("so the keyboard is not visible yet", !midShow.visible, JSON.stringify(midShow));

    // Now hide it, with the frame still outstanding.
    await page.evaluate(() => document.activeElement.blur());
    await sleep(400);
    const afterHide = await kbdState();
    check("hide() runs and the keyboard is not visible", !afterHide.visible, JSON.stringify(afterHide));

    const queued = await page.evaluate(() => window.__rafQ.length);
    check("the fade-in frame was still queued when hide() ran", queued > 0, `queued=${queued}`);

    await page.evaluate(() => {
      const held = window.__rafQ;
      window.__rafQ = [];
      window.requestAnimationFrame = window.__rafReal;
      for (const cb of held) {
        try {
          cb(performance.now());
        } catch (_) {
        }
      }
    });

    const afterLate = await kbdState();
    check("a frame delivered after hide() does not slide the keyboard back up", !afterLate.visible, JSON.stringify(afterLate));
    check("and it stays inert, as hide() left it", afterLate.inert, JSON.stringify(afterLate));

    // ── a screen change must not carry the keyboard with it ───────────────
    // The keyboard is otherwise put away by a focusout plus 150ms, and the field
    // it was typed into is still document.activeElement for part of that. So the
    // screen that replaced it spent its first moments with a full-width,
    // z-index 100 keyboard across the bottom of it, taking every tap that landed
    // there -- the Settings panel's own buttons among them. goToScreen puts it
    // away itself now, and the check is taken inside the 150ms because that is
    // the window the focusout path cannot cover.
    await page.click("#kiosk-phone");
    await sleep(400);
    check("the keyboard is up for the kiosk phone field", (await kbdState()).visible, JSON.stringify(await kbdState()));
    await page.click('.btn-back-kiosk[data-back="welcome"]');
    await sleep(120);
    const afterNav = await kbdState();
    check("navigating away puts the keyboard away at once", !afterNav.visible, JSON.stringify(afterNav));
    check("and it is inert from that moment", afterNav.inert, JSON.stringify(afterNav));

    const realErrors = errors.filter((e) => !/favicon/.test(e));
    check("no console errors during any of it", realErrors.length === 0, realErrors.join(" | "));
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
