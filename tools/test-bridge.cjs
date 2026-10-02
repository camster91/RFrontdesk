// Exercises the Windows host bridge adapter as it exists in web/js/app.js.
//
//   node tools/test-bridge.cjs
//
// The adapter is lifted out of the real source by marker rather than copied, so
// this cannot drift from what ships. The hosted path is covered end to end by
// running the built exe; what this covers is the parsing and the browser
// fallback, which is where a silent mistake would hide.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "web", "js", "app.js"), "utf8");

const from = src.indexOf("// Windows host bridge");
const to = src.indexOf("// A crash inside the page");
if (from < 0 || to < 0 || to < from) {
  console.error("FAIL: could not find the bridge section in app.js");
  process.exit(1);
}
const section = src.slice(from, to);

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) return;
  failures++;
  console.error(`FAIL  ${name}${detail === undefined ? "" : "  -> " + detail}`);
};
const ok = (name) => console.log(`  ok  ${name}`);

function load(bridge) {
  const sandbox = { console, JSON, Number, String, Error, Object, Promise, setTimeout };
  sandbox.window = {};
  if (bridge) sandbox.window.chrome = { webview: { hostObjects: { frontDeskHost: bridge } } };
  sandbox.globalThis = sandbox;
  // The real dateStamp lives outside the extracted section; this is its
  // definition verbatim from app.js.
  sandbox.dateStamp = () => new Date().toISOString().slice(0, 10);
  // renderBuildInfo is the one thing in the section that touches the DOM. A
  // stub with a single .build-info node is enough to see what it writes.
  sandbox.__buildInfo = { textContent: "", title: "" };
  sandbox.document = { querySelector: (sel) => (sel === ".build-info" ? sandbox.__buildInfo : null) };
  vm.createContext(sandbox);
  vm.runInContext(section, sandbox);
  return sandbox;
}

(async () => {
  console.log("\nWindows host bridge\n");

  // --- No host (the plain-browser case) -----------------------------------
  {
    const s = load(null);
    check("isHosted is false with no chrome.webview", s.isHosted() === false, s.isHosted());
    check("hostObject is null with no chrome.webview", s.hostObject() === null);
    check("hostInfo resolves null when not hosted", (await s.hostInfo()) === null);
    ok("browser fallback: isHosted/hostObject/hostInfo all degrade quietly");

    let threw = "";
    try {
      await s.hostCall("GetInfo");
    } catch (err) {
      threw = err.message;
    }
    check("hostCall throws a readable error when not hosted", /Not running/.test(threw), threw);
    ok("browser fallback: hostCall fails loudly rather than silently");
  }

  // --- chrome.webview present but no host object registered ---------------
  {
    const s = load(null);
    s.window.chrome = { webview: {} };
    check("isHosted survives chrome.webview without hostObjects", s.isHosted() === false);
    ok("browser fallback: partial chrome.webview does not throw");
  }

  // --- Hosted --------------------------------------------------------------
  {
    const calls = [];
    const bridge = {
      GetInfo: async () => JSON.stringify({ ok: true, version: "1.0.0", keepBackups: 30, portable: true }),
      SaveBackup: async (json, name) => {
        calls.push({ json, name });
        return JSON.stringify({ ok: false, verified: false, error: "The file on disk does not match what was written." });
      },
      Boom: async () => "not json at all",
      Empty: async () => "",
      Explode: async () => {
        throw new Error("transport died");
      }
    };
    const s = load(bridge);

    check("isHosted is true with a host object", s.isHosted() === true);

    const info = await s.hostInfo();
    check("hostInfo returns the parsed info", info && info.version === "1.0.0", JSON.stringify(info));
    check("hostInfo is cached after the first call", info === (await s.hostInfo()));
    ok("hosted: hostInfo parses and caches");

    // SaveBackup answering ok:false must NOT throw -- "written but did not
    // verify" is a result the operator has to be told about, and an exception
    // here would be swallowed by the caller's catch and turn into a misleading
    // "saved to your Downloads folder".
    const saved = await s.hostSaveBackup({ items: [] });
    check("hostSaveBackup returns ok:false instead of throwing", saved.ok === false, JSON.stringify(saved));
    check("hostSaveBackup surfaces the bridge's own error text", /does not match/.test(saved.error || ""));
    check("hostSaveBackup sends pretty-printed JSON", calls[0].json.includes("\n"));
    check("hostSaveBackup names the file with today's date", /^frontdesk-backup-\d{4}-\d{2}-\d{2}\.json$/.test(calls[0].name), calls[0].name);
    ok("hosted: an unverified backup is reported, not thrown");

    let threw = "";
    try {
      await s.hostCall("SaveBackup", "{}", "x.json");
    } catch (err) {
      threw = err.message;
    }
    check("hostCall still throws on ok:false", /does not match/.test(threw), threw);
    ok("hosted: hostCall converts a failed reply into an error");

    for (const [method, what] of [["Boom", "unreadable"], ["Empty", "empty"]]) {
      let msg = "";
      try {
        await s.hostCall(method);
      } catch (err) {
        msg = err.message;
      }
      check(`${method} (${what} reply) gives a readable error`, /unreadable|nothing usable/.test(msg), msg);
    }
    let transport = "";
    try {
      await s.hostCall("Explode");
    } catch (err) {
      transport = err.message;
    }
    check("a transport failure propagates its own message", transport === "transport died", transport);
    ok("hosted: malformed and failed replies all produce readable errors");

    check("formatBytes: bytes", s.formatBytes(0) === "0 B", s.formatBytes(0));
    check("formatBytes: KB", s.formatBytes(4096) === "4.0 KB", s.formatBytes(4096));
    check("formatBytes: MB", s.formatBytes(1.5 * 1024 * 1024) === "1.50 MB", s.formatBytes(1.5 * 1024 * 1024));
    check("formatBytes survives junk", s.formatBytes(undefined) === "0 B", s.formatBytes(undefined));
    ok("formatBytes covers all three magnitudes and junk input");
  }

  // --- A failed backup is retried, not recorded as done --------------------
  //
  // autoBackup used to write lastBackupAt whether or not the host's read-back
  // check passed, so one failed backup meant none for the next 24 hours -- and
  // a desk that starts minimised never sees the toast saying so. A forced run
  // ("Back up now") also zeroed the record first, so a failed one left it
  // saying no backup had ever been made.
  {
    const run = async (verified, opts) => {
      let settings = { lastBackupAt: 1000 };
      const writes = [];
      const toasts = [];
      const s = load({
        SaveBackup: async () =>
          JSON.stringify(verified
            ? { ok: true, verified: true, bytes: 10, kept: 3, path: "x" }
            : { ok: false, error: "The backup did not read back intact, so it was not kept." })
      });
      s.BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1e3;
      s.getSettings = async () => Object.assign({}, settings);
      s.updateSettings = async (u) => {
        writes.push(u);
        settings = Object.assign({}, settings, u);
      };
      s.exportAll = async () => ({ items: [] });
      s.showToast = (m, o) => toasts.push({ m, type: o && o.type });
      s.logToHost = () => {};
      s.console = Object.assign({}, console, { error: () => {}, warn: () => {} });
      const result = opts === "now" ? await s.runBackupNow() : await s.autoBackup({ force: true });
      return { result, settings, writes, toasts };
    };

    const bad = await run(false, "now");
    check("a failed backup reports ok:false", bad.result.ok === false, JSON.stringify(bad.result));
    check("a failed backup does not record lastBackupAt", bad.settings.lastBackupAt === 1000, JSON.stringify(bad.writes));
    check("and says so in a toast", bad.toasts.some((t) => t.type === "error" && /not kept/.test(t.m)), JSON.stringify(bad.toasts));

    const good = await run(true, "now");
    check("a verified backup records lastBackupAt", good.settings.lastBackupAt > 1000, JSON.stringify(good.writes));
    check("Back up now no longer zeroes the record first", !good.writes.some((w) => w.lastBackupAt === 0), JSON.stringify(good.writes));
    ok("autoBackup: only a verified backup counts, and a failed one is retried");
  }

  // --- The version shown in the corner (H: three files must agree) ---------
  //
  // web/js/app.js (WEB_VERSION), host/FrontDesk.cs (Build.Version) and
  // host/AssemblyInfo.cs (AssemblyVersion) all state the product version, and
  // the corner of every screen shows it. They drifted once already -- the UI
  // said v0.1 while the exe said 1.0.0 -- so rather than trust three files to
  // be edited together, read all three and compare.
  {
    const root = path.join(__dirname, "..");
    const web = /const WEB_VERSION = "([^"]+)"/.exec(src);
    const cs = /public const string Version = "([^"]+)"/.exec(
      fs.readFileSync(path.join(root, "host", "FrontDesk.cs"), "utf8"));
    // AssemblyVersion is four parts; the product version is the first three.
    const asm = /AssemblyVersion\("(\d+\.\d+\.\d+)/.exec(
      fs.readFileSync(path.join(root, "host", "AssemblyInfo.cs"), "utf8"));

    check("WEB_VERSION is declared", web !== null);
    check("Build.Version is declared in host/FrontDesk.cs", cs !== null);
    check("AssemblyVersion is declared in host/AssemblyInfo.cs", asm !== null);
    if (web && cs && asm) {
      check("the web bundle and the host agree on the version",
        web[1] === cs[1], `${web[1]} vs ${cs[1]}`);
      check("the web bundle and the assembly agree on the version",
        web[1] === asm[1], `${web[1]} vs ${asm[1]}`);
    }
    ok("one product version across the bundle, the host and the assembly");

    // And the corner renders what the host reports, not what the file assumes.
    const s = load({ GetInfo: () => JSON.stringify({ ok: true, version: "9.8.7", hosted: true }), Ping: () => "pong" });
    await s.renderBuildInfo();
    check("the corner shows the host's version when hosted",
      s.__buildInfo.textContent === "v9.8.7 \xB7 Front Desk", s.__buildInfo.textContent);
    check("and titles itself with it", s.__buildInfo.title === "Front Desk 9.8.7", s.__buildInfo.title);

    const plain = load(null);
    await plain.renderBuildInfo();
    check("and falls back to the bundle's own version in a browser",
      plain.__buildInfo.textContent === "v" + web[1] + " \xB7 Front Desk", plain.__buildInfo.textContent);

    const broken = load({ GetInfo: () => JSON.stringify({ ok: false, error: "no" }) });
    // The bridge logs the failed call, which is the behaviour under test; it is
    // not this suite's job to print the stack in the middle of a passing run.
    broken.console = Object.assign({}, console, { error: () => {}, warn: () => {} });
    await broken.renderBuildInfo();
    check("a host that cannot answer still leaves a version on screen",
      /^v\d/.test(broken.__buildInfo.textContent), broken.__buildInfo.textContent);
    ok("build-info renders the running version in all three cases");
  }

  console.log("");
  if (failures) {
    console.error(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("all checks passed\n");
})();
