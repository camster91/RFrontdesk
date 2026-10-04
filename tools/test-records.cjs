// Records: merges, loans, imports, and the errors around them.
//
//   node tools/test-records.cjs
//
// The second half of the Phase 13 fixes. Most of them live in the data layer,
// where the only way to reach a function the UI wraps is to call it, so this
// suite serves the real bundle with one line appended before `bootstrap()` that
// hangs a handful of its own functions on `window.__t`. Nothing about the code
// under test changes; the line only names what already exists. The rest is
// driven through the page: the queue's "Not handed in", the checkout's Enter key,
// and the on-screen keys against a field's maxlength.

const fs = require("fs");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..", "web");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8807;
const PIN = "1234";

const EXPOSE = [
  "openDB", "get", "put", "runTx", "createItem", "upsertBorrower", "createLoan", "mergeItems",
  "unmergeItem", "importAll", "exportAll", "listItems", "listBorrowers", "getOpenLoanForItem",
  "requestLoanReturn"
];

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]);
    if (rel === "/favicon.ico") return void res.writeHead(204).end();
    const file = path.join(ROOT, rel === "/" ? "/index.html" : rel);
    if (!file.startsWith(ROOT + path.sep)) return void res.writeHead(403).end("forbidden");
    fs.readFile(file, (err, body) => {
      if (err) return void res.writeHead(404).end("not found");
      if (rel === "/js/app.js") {
        const src = body.toString("utf8");
        const at = src.lastIndexOf("\nbootstrap();");
        if (at < 0) return void res.writeHead(500).end("bootstrap() call not found in app.js");
        body = src.slice(0, at) + `\nwindow.__t = { ${EXPOSE.join(", ")} };` + src.slice(at);
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

(async () => {
  console.log("\nRecords: merges, loans, imports\n");
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
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 30000 });
    await page.waitForFunction(() => !!window.__t, { timeout: 10000 });
    await page.addStyleTag({
      content: "*, *::before, *::after { transition: none !important; animation: none !important; }"
    });

    // ── 1. a failed write says why ──────────────────────────────────────────
    // A request that fails inside runTx reaches the transaction's onerror before
    // transaction.error is set, so every caller used to get reject(null), and
    // `err.message` in its catch threw instead of showing the toast.
    const dup = await page.evaluate(async () => {
      const t = window.__t;
      await t.openDB();
      try {
        await t.runTx(["items"], "readwrite", async (s) => {
          const st = s.get("items");
          await s.req(st.add({ id: 900001, name: "Dup", nameLower: "dup" }));
          await s.req(st.add({ id: 900001, name: "Dup", nameLower: "dup" }));
        });
        return { threw: false };
      } catch (err) {
        return { threw: true, isError: err instanceof Error || (err && typeof err.message === "string"), name: err && err.name };
      }
    });
    check("a failed write rejects with a real error, not null", dup.threw && dup.isError, JSON.stringify(dup));

    // And a refusal after a write takes the write with it.
    const partial = await page.evaluate(async () => {
      const t = window.__t;
      let msg = "";
      try {
        await t.runTx(["items"], "readwrite", async (s) => {
          await s.req(s.get("items").put({ id: 900002, name: "Half", nameLower: "half" }));
          throw new Error("refused half-way");
        });
      } catch (err) {
        msg = err && err.message;
      }
      return { msg, left: !!(await t.get("items", 900002)) };
    });
    check("a callback that throws after writing is reported by its own message", partial.msg === "refused half-way", partial.msg);
    check("and its earlier write is rolled back", !partial.left, JSON.stringify(partial));

    // ── 2. merges and the loans that ride on them ───────────────────────────
    const chain = await page.evaluate(async () => {
      const t = window.__t;
      const a = await t.createItem({ name: "Chain Alpha Remote" });
      const b = await t.createItem({ name: "Chain Bravo Remote" });
      const d = await t.createItem({ name: "Chain Delta Remote" });
      const who = await t.upsertBorrower({ phone: "4165550901", name: "Chain Person" });
      await t.createLoan({ itemId: a.id, borrowerId: who.id, dueAt: Date.now() + 3600e3 });
      await t.mergeItems(b.id, a.id); // A into B
      await t.mergeItems(d.id, b.id); // B into D
      let refused = "";
      try {
        await t.unmergeItem(a.id);
      } catch (err) {
        refused = (err && err.message) || "";
      }
      const aAfter = await t.get("items", a.id);
      let secondOut = "";
      try {
        await t.createLoan({ itemId: a.id, borrowerId: who.id, dueAt: Date.now() + 3600e3 });
        secondOut = "accepted";
      } catch (err) {
        secondOut = (err && err.code) || (err && err.message) || "refused";
      }
      // Undone in order, it works.
      await t.unmergeItem(b.id);
      const back = await t.unmergeItem(a.id);
      const open = await t.getOpenLoanForItem(a.id);
      return { refused, aStillMerged: aAfter.mergedIntoId != null, secondOut, back, openOnA: !!open };
    });
    check("undoing a merge whose keeper was merged again is refused", /Undo that merge first/.test(chain.refused), chain.refused);
    check("and leaves the item merged", chain.aStillMerged);
    check("a checkout of the merged-away item lands on the live one, and is refused while it is out", chain.secondOut === "ALREADY_OUT", chain.secondOut);
    check("undone in order, the loan comes back to its item", chain.back && chain.back.loansMovedBack === 1 && chain.openOnA, JSON.stringify(chain.back));

    const archived = await page.evaluate(async () => {
      const t = window.__t;
      const it = await t.createItem({ name: "Retired Projector" });
      await t.put("items", Object.assign({}, await t.get("items", it.id), { isArchived: true }));
      const who = await t.upsertBorrower({ phone: "4165550902", name: "Archive Person" });
      try {
        await t.createLoan({ itemId: it.id, borrowerId: who.id, dueAt: Date.now() + 3600e3 });
        return "accepted";
      } catch (err) {
        return (err && err.code) || "refused";
      }
    });
    check("an archived item cannot be lent", archived === "ARCHIVED", archived);

    // ── 3. a backup that would break the desk is refused ────────────────────
    const imports = await page.evaluate(async () => {
      const t = window.__t;
      const base = await t.exportAll();
      const tryImport = async (mutate) => {
        const data = JSON.parse(JSON.stringify(base));
        mutate(data);
        try {
          await t.importAll(data, { mode: "replace" });
          return "accepted";
        } catch (err) {
          return (err && err.message) || "refused";
        }
      };
      const huge = await tryImport((d) => d.items.push({ id: 2 ** 53, name: "Huge", nameLower: "huge" }));
      const nameless = await tryImport((d) => d.items.push({ id: 777001 }));
      const namelessPerson = await tryImport((d) => d.borrowers.push({ id: 777002, phone: "4165550999" }));
      // Still works afterwards: a new item and a new loan.
      const it = await t.createItem({ name: "After Import Cable" });
      const who = await t.upsertBorrower({ phone: "4165550903", name: "After Person" });
      const loan = await t.createLoan({ itemId: it.id, borrowerId: who.id, dueAt: Date.now() + 3600e3 });
      const list = await t.listItems();
      return { huge, nameless, namelessPerson, newIds: !!(it.id && loan && loan.id), listed: list.length };
    });
    check("an id past 2^53 is refused before anything is written", /numeric id/.test(imports.huge), imports.huge);
    check("an item with no name is refused", /has no name/.test(imports.nameless), imports.nameless);
    check("so is a person with no name", /has no name/.test(imports.namelessPerson), imports.namelessPerson);
    check("and the desk can still add items and lend them", imports.newIds && imports.listed > 0, JSON.stringify(imports));

    // ── 4. "Not handed in", then Cancel ─────────────────────────────────────
    const loanId = await page.evaluate(async () => {
      const t = window.__t;
      const it = await t.createItem({ name: "Queue Test Clicker" });
      const who = await t.upsertBorrower({ phone: "4165550904", name: "Queue Person" });
      const loan = await t.createLoan({ itemId: it.id, borrowerId: who.id, dueAt: Date.now() + 3600e3 });
      await t.requestLoanReturn(loan.id, { conditionIn: "damaged", note: "lid cracked" });
      return loan.id;
    });
    await page.evaluate(() => window.app.showAdminLogin());
    await page.waitForSelector("#screen-admin-login:not(.hidden)", { timeout: 8000 });
    await page.evaluate((pin) => {
      document.querySelector("#screen-admin-login .pin-input").value = pin;
      document.querySelector("#screen-admin-login .pin-submit").click();
    }, PIN);
    await page.waitForSelector("#screen-admin:not(.hidden)", { timeout: 12000 });
    await page.evaluate(() => document.querySelector('#screen-admin .tab[data-tab="queue"]').click());
    await page.waitForSelector(`[data-action="deny-return"][data-loan-id="${loanId}"]`, { timeout: 8000 });
    await page.evaluate((id) => document.querySelector(`[data-action="deny-return"][data-loan-id="${id}"]`).click(), loanId);
    await page.waitForSelector(".dialog-actions .btn", { timeout: 8000 });
    await page.evaluate(() => Array.from(document.querySelectorAll(".dialog-actions .btn")).find((b) => /^Cancel$/.test(b.textContent.trim())).click());
    await sleep(700);
    const kept = await page.evaluate((id) => window.__t.get("loans", id), loanId);
    check("Cancel on \"Not handed in\" leaves the return request alone", kept && kept.returnRequestedAt && kept.returnRequestedNote === "lid cracked", JSON.stringify(kept && { at: kept.returnRequestedAt, note: kept.returnRequestedNote }));

    // OK with nothing typed still clears it -- that answer means "no reason".
    await page.evaluate((id) => document.querySelector(`[data-action="deny-return"][data-loan-id="${id}"]`).click(), loanId);
    await page.waitForSelector(".dialog-actions .btn", { timeout: 8000 });
    await page.evaluate(() => Array.from(document.querySelectorAll(".dialog-actions .btn")).find((b) => /^OK$/.test(b.textContent.trim())).click());
    await sleep(700);
    const cleared = await page.evaluate((id) => window.__t.get("loans", id), loanId);
    check("and OK with no reason still clears it", cleared && !cleared.returnRequestedAt, JSON.stringify(cleared && { at: cleared.returnRequestedAt }));

    // ── 5. the checkout's Enter key ─────────────────────────────────────────
    await page.evaluate(async () => {
      await window.__t.createItem({ name: "Key 112" });
    });
    await page.evaluate(() => document.querySelector('#screen-admin [data-action="admin-home"]').click());
    await page.waitForSelector("#screen-home:not(.hidden)", { timeout: 8000 });
    await page.evaluate(() => {
      try {
        sessionStorage.removeItem("frontdesk.draft");
      } catch (_) {}
      window.dispatchEvent(new Event("frontdesk:checkout-start"));
    });
    await page.waitForSelector("#screen-checkout:not(.hidden)", { timeout: 15000 });
    const stepVisible = (s) =>
      page.waitForFunction((sel) => {
        const el = document.querySelector("#screen-checkout " + sel);
        return !!el && !el.classList.contains("hidden");
      }, { timeout: 15000 }, s);
    await stepVisible(".step-phone");
    await page.type("#screen-checkout .step-phone .input", "4165550905");
    await page.evaluate(() => document.querySelector("#screen-checkout .step-phone .step-continue").click());
    await stepVisible(".step-name");
    await page.type("#screen-checkout .step-name .input", "Enter Person");
    await page.evaluate(() => document.querySelector("#screen-checkout .step-name .step-continue").click());
    await stepVisible(".step-items");
    await sleep(500);
    await page.evaluate(() => {
      const el = document.querySelector("#screen-checkout .step-items .search-input");
      el.focus();
      el.value = "Key 12";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForSelector("#screen-checkout .all-items .add-new-row", { timeout: 8000 }).catch(() => {});
    const addOffered = await page.evaluate(() => {
      const b = document.querySelector("#screen-checkout .all-items .add-new-row");
      return b ? b.textContent.trim() : null;
    });
    check("typing \"Key 12\" next to \"Key 112\" offers to add it", /Add "Key 12"/.test(addOffered || ""), addOffered);
    await page.evaluate(() => {
      const el = document.querySelector("#screen-checkout .step-items .search-input");
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await sleep(1200);
    const picked = await page.evaluate(() => (window.__checkoutFlow.state.items || []).map((i) => i.name));
    check("and Enter adds \"Key 12\" rather than taking \"Key 112\"", picked.includes("Key 12") && !picked.includes("Key 112"), JSON.stringify(picked));

    // ── 6. the on-screen keys honour maxlength ──────────────────────────────
    await page.evaluate(() => window.app.goToScreen("home"));
    await page.evaluate(() => window.app.showAdminLogin());
    await page.waitForSelector("#screen-admin-login:not(.hidden)", { timeout: 8000 });
    await page.click("#screen-admin-login .pin-input");
    await page.waitForFunction(() => document.getElementById("keyboard").classList.contains("visible"), { timeout: 8000 });
    for (const d of "123456789012") await page.click(`#keyboard .kbd[data-key="${d}"]`);
    const pinLen = await page.$eval("#screen-admin-login .pin-input", (el) => el.value.length);
    check("the keypad stops at the PIN field's 8 characters", pinLen === 8, pinLen);

    // ── 7. a phone number with a digit too many ──────────────────────────────
    // The kiosk kept the last ten digits of whatever was typed, so a doubled
    // digit at the end was a different, valid number -- and the loan went to
    // whoever owned it.
    await page.evaluate(async () => {
      await window.__t.upsertBorrower({ phone: "1655512344", name: "Shifted Owner" });
    });
    await page.evaluate(() => window.app.cancelAdminLogin());
    await page.evaluate(() => window.app.goToScreen("home"));
    await page.evaluate(() => document.getElementById("btn-to-kiosk").click());
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 8000 });
    await page.evaluate(() => document.querySelector("#screen-welcome .btn-kiosk-borrow").click());
    await page.waitForSelector("#screen-kiosk-borrow-phone:not(.hidden)", { timeout: 8000 });
    await page.evaluate(() => {
      const el = document.getElementById("kiosk-phone");
      el.value = "41655512344";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await sleep(800);
    const where = await page.evaluate(() => ({
      screen: document.querySelector(".screen:not(.hidden)").id,
      greeting: (document.getElementById("kiosk-greeting-name") || {}).textContent || ""
    }));
    check("eleven digits at the kiosk are refused, not shortened to someone's number", where.screen === "screen-kiosk-borrow-phone" && !/Shifted Owner/.test(where.greeting), JSON.stringify(where));

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
