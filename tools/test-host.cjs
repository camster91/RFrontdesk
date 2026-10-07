// Compiles the host's checks against the shipping host source and runs them.
//
//   node tools/test-host.cjs
//
// The host is the one part of this project with no test coverage at all, and the
// first real regression found in it -- an autostart entry that dropped
// --no-devtools and quietly re-enabled DevTools on a kiosk after a reboot -- was
// exactly the kind of thing a check would have caught. So this compiles
// tools\HostTests.cs together with host\FrontDesk.cs, using the same in-box
// compiler the build uses and the same references, and runs the result.
//
// Five runs, because two of the checks are about a process's own command line:
//
//   --mode=parse           the command-line parser and the URL decision table
//   --mode=plain  --minimized         an ordinary install
//   --mode=kiosk  --minimized --no-devtools   a locked-down kiosk install
//   --mode=files           installing over an old copy, and the log, in a temp folder
//   --mode=registry        write/read/remove in a unique non-logon registry key
//
// Nothing here starts a window, changes logon settings, or opens a socket. The
// disposable registry key is outside Windows Run keys and is removed in finally.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const hostDir = path.join(root, "host");

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function findCompiler() {
  const candidates = [
    path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  fail("no C# compiler found; this check needs the in-box .NET Framework compiler");
}

const csc = findCompiler();

// A fresh folder per run, so a stale exe can never be what passes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "frontdesk-hosttest-"));
const exe = path.join(work, "HostTests.exe");

// The WebView2 assemblies are referenced by FrontDesk.cs and copied beside the
// test exe. Nothing in the checks uses a WebView2 type, but the runtime resolves
// references when a method is first JITted and a missing file there reads as a
// test failure rather than a missing-file problem.
const refs = [
  path.join(hostDir, "lib", "Microsoft.Web.WebView2.Core.dll"),
  path.join(hostDir, "lib", "Microsoft.Web.WebView2.WinForms.dll"),
  "System.dll",
  "System.Core.dll",
  "System.Drawing.dll",
  "System.Windows.Forms.dll"
];

const args = [
  "/nologo",
  "/target:exe",
  "/platform:x64",
  "/langversion:5",
  "/optimize+",
  `/out:${exe}`,
  "/main:FrontDeskHost.HostTests"
];
for (const r of refs) args.push(`/reference:${r}`);
args.push(path.join(hostDir, "FrontDesk.cs"));
args.push(path.join(__dirname, "HostTests.cs"));

console.log("  compiling the host's checks against host/FrontDesk.cs");
const built = spawnSync(csc, args, { encoding: "utf8" });
if (built.status !== 0) {
  console.error((built.stdout || "") + (built.stderr || ""));
  fail("the host did not compile");
}

for (const f of ["Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll"]) {
  const from = path.join(hostDir, "lib", f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(work, f));
}

const RUNS = [
  { mode: "parse", extra: [] },
  { mode: "plain", extra: ["--minimized"] },
  { mode: "kiosk", extra: ["--minimized", "--no-devtools"] },
  { mode: "files", extra: [] },
  { mode: "registry", extra: [] }
];

let failures = 0;
let checks = 0;
for (const run of RUNS) {
  console.log(`  --- mode ${run.mode} ---`);
  const r = spawnSync(exe, [`--mode=${run.mode}`].concat(run.extra), { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  process.stdout.write(out.endsWith("\n") || out === "" ? out : out + "\n");
  const m = /(\d+) checks in mode/.exec(out);
  if (m) checks += Number(m[1]);
  if (r.status !== 0) failures++;
}

try {
  fs.rmSync(work, { recursive: true, force: true });
} catch {
  // A temp folder that will not delete is not a test failure.
}

console.log("");
if (failures) {
  console.error(`${failures} host run(s) failed.\n`);
  process.exit(1);
}
console.log(`the host's ${checks} checks passed\n`);
