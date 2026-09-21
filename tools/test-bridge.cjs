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

  console.log("");
  if (failures) {
    console.error(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("all checks passed\n");
})();
