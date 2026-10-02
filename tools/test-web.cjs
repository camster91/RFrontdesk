// The web build: deploy/desk-worker.js serving web/ at /desk/, as it does at
// https://rotmanav.ca/desk/.
//
//   node tools/test-web.cjs
//
// The Worker is the shipping module, imported as is. Cloudflare's asset layer is
// stood in for by a few lines that do what it does for these files (serve them,
// redirect /index.html to /, give an ETag). Then the page is driven through it in
// headless Edge with every Content-Security-Policy violation recorded: the policy
// is built from the page's own inline scripts and handlers, and the check that
// matters is that it blocks nothing the app does.

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..", "web");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8806;
const PIN = "1234";

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

// What Workers static assets does for this directory, near enough.
const ASSETS = {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/index.html") return new Response(null, { status: 307, headers: { location: "/" } });
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return new Response("not found", { status: 404 });
    }
    const body = fs.readFileSync(file);
    const etag = `"${crypto.createHash("sha1").update(body).digest("hex")}"`;
    return new Response(body, {
      status: 200,
      headers: { "content-type": TYPES[path.extname(file)] || "application/octet-stream", etag }
    });
  }
};

(async () => {
  console.log("\nThe web build at /desk/\n");
  const worker = (await import(pathToFileURL(path.join(__dirname, "..", "deploy", "desk-worker.js")).href)).default;
  // As Cloudflare hands requests to the Worker: HTTPS, on the real host.
  const call = (p, init) => worker.fetch(new Request(`https://rotmanav.ca${p}`, init), { ASSETS });

  // ── 1. routes ────────────────────────────────────────────────────────────
  {
    const plain = await worker.fetch(new Request("http://rotmanav.ca/desk/js/app.js?x=1"), { ASSETS });
    check("plain HTTP goes to HTTPS, path and query kept", plain.status === 301 && plain.headers.get("location") === "https://rotmanav.ca/desk/js/app.js?x=1", `${plain.status} ${plain.headers.get("location")}`);
    const bare = await call("/desk");
    check("/desk redirects to /desk/, where relative URLs resolve", bare.status === 301 && new URL(bare.headers.get("location")).pathname === "/desk/", `${bare.status} ${bare.headers.get("location")}`);
    const index = await call("/desk/index.html");
    check("/desk/index.html stays inside the prefix", index.status === 307 && index.headers.get("location") === "/desk/", `${index.status} ${index.headers.get("location")}`);
    const other = await call("/desktop");
    check("the route's wildcard does not serve /desktop", other.status === 404, other.status);
    const escape = await call("/desk/../deploy/desk-worker.js");
    check("nothing outside web/ is reachable", escape.status === 404, escape.status);
    const post = await call("/desk/", { method: "POST", body: "x" });
    check("only GET and HEAD", post.status === 405, post.status);
    const missing = await call("/desk/nope.js");
    check("a missing file is a 404", missing.status === 404, missing.status);

    // A HEAD first, as a monitor or a curl -I would send. The policy is built
    // from the page's body and cached; built from a HEAD's empty body, it used
    // to carry no script hashes and block the page for every GET after it.
    const head = await call("/desk/", { method: "HEAD" });
    check("a HEAD is answered without a body", head.status === 200 && (await head.text()) === "", head.status);
    const page = await call("/desk/");
    const csp = page.headers.get("content-security-policy") || "";
    const inlineScripts = [...fs.readFileSync(path.join(ROOT, "index.html"), "utf8").matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)].length;
    check("and does not poison the policy for the GET after it", (csp.match(/'sha256-/g) || []).length > inlineScripts, csp.slice(0, 160));
    check("the HEAD carries the same policy as the GET", head.headers.get("content-security-policy") === csp);
    check("the page is served", page.status === 200 && /text\/html/.test(page.headers.get("content-type")), page.status);
    check("with a CSP that allows no inline script but its own", /script-src 'self' 'unsafe-hashes' 'sha256-/.test(csp) && !/script-src[^;]*'unsafe-inline'/.test(csp), csp);
    check("and is never framed", /frame-ancestors 'none'/.test(csp) && page.headers.get("x-frame-options") === "DENY");
    check("and always revalidated, so a deploy reaches the tablet", page.headers.get("cache-control") === "no-cache");
    check("and pinned to HTTPS", /max-age=\d{8}/.test(page.headers.get("strict-transport-security") || ""), page.headers.get("strict-transport-security"));
    check("and kept out of search results", /noindex/.test(page.headers.get("x-robots-tag") || ""));
    const js = await call("/desk/js/app.js");
    check("the script is served with the same headers", js.status === 200 && js.headers.get("x-content-type-options") === "nosniff", js.status);
  }

  // ── 2. the page under its policy ──────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await worker.fetch(
      // TLS ends at Cloudflare's edge, so the Worker always sees https. This
      // local server is plain http; say https to the Worker, and turn any
      // absolute redirect it gives back into one this server can answer.
      new Request(`https://127.0.0.1:${PORT}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks)
      }),
      { ASSETS }
    );
    const headers = Object.fromEntries(r.headers);
    if (headers.location) headers.location = headers.location.replace(/^https:\/\/127\.0\.0\.1:/, "http://127.0.0.1:");
    delete headers["strict-transport-security"];
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
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
    await page.evaluateOnNewDocument(() => {
      window.__violations = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__violations.push(`${e.violatedDirective}: ${e.blockedURI || "inline"} ${e.sample || ""}`.trim());
      });
    });
    await page.setViewport({ width: 1024, height: 1100 });
    await page.goto(`http://127.0.0.1:${PORT}/desk`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#screen-welcome:not(.hidden)", { timeout: 30000 });
    check("/desk loads the app on its kiosk screen", page.url().endsWith("/desk/"), page.url());
    const logo = await page.evaluate(() => {
      const img = document.querySelector("#screen-welcome img[data-logo]");
      return !!img && /^data:image\/svg/.test(img.getAttribute("src") || "");
    });
    check("the inline logo script ran under the policy", logo);

    // The PIN screen's Cancel is an inline onclick that nothing rebinds, so it
    // only works if its hash is in the policy.
    await page.evaluate(() => window.app.showAdminLogin());
    await page.waitForSelector("#screen-admin-login:not(.hidden)", { timeout: 8000 });
    // Dispatched on the element rather than at its coordinates: what is under
    // test is whether the inline handler may run, and the keypad sliding up
    // under a coordinate click made that depend on timing.
    await page.$eval("#screen-admin-login .btn-ghost", (el) => el.click());
    await sleep(400);
    const back = await page.evaluate(() => document.querySelector(".screen:not(.hidden)").id);
    check("an inline onclick still works (PIN screen Cancel)", back === "screen-welcome", back);

    await page.evaluate(() => window.app.showAdminLogin());
    await page.waitForSelector("#screen-admin-login:not(.hidden)", { timeout: 8000 });
    await page.type("#screen-admin-login .pin-input", PIN);
    await page.click("#screen-admin-login .pin-submit");
    await page.waitForSelector("#screen-admin:not(.hidden)", { timeout: 12000 });
    check("the PIN gets into the admin panel", true);
    for (const tab of ["currently-out", "items", "people", "reports", "settings"]) {
      await page.evaluate((t) => document.querySelector(`#screen-admin .tab[data-tab="${t}"]`).click(), tab);
      await sleep(250);
    }
    check("every admin tab renders", (await page.evaluate(() => document.querySelector(".screen:not(.hidden)").id)) === "screen-admin");

    const violations = await page.evaluate(() => window.__violations);
    check("the policy blocked nothing the app did", violations.length === 0, violations.join(" | "));
    const real = errors.filter((e) => !/favicon/.test(e));
    check("no console errors", real.length === 0, real.join(" | "));
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
