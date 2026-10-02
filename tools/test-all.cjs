// Runs every check suite and reports one verdict.
//
//   node tools/test-all.cjs
//
// Each suite is a standalone script that exits non-zero on failure, so this is
// mostly about running them in order and summarising.

const { spawnSync } = require("child_process");
const path = require("path");

const SUITES = [
  ["host bridge", "test-bridge.cjs"],
  ["host flags and navigation", "test-host.cjs"],
  ["toast stack", "test-toast.cjs"],
  ["screen router", "test-router.cjs"],
  ["report aggregation", "test-report.cjs"],
  ["keyboard touch", "test-touch.cjs"],
  ["browser UI", "test-ui.cjs"],
  ["kiosk", "test-kiosk.cjs"],
  ["layout at real widths", "test-responsive.cjs"],
  ["backup round trip", "test-restore.cjs"],
  ["catalog at scale", "test-catalog.cjs"],
  ["sessions, lock and keyboard", "test-sessions.cjs"]
];

const results = [];
for (const [name, file] of SUITES) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: "inherit",
    cwd: path.join(__dirname, "..")
  });
  results.push([name, r.status === 0]);
}

console.log("\n=== summary ===");
let failed = 0;
for (const [name, passed] of results) {
  console.log(`  ${passed ? "pass" : "FAIL"}  ${name}`);
  if (!passed) failed++;
}
console.log("");
if (failed) {
  console.error(`${failed} suite(s) failed.\n`);
  process.exit(1);
}
console.log("everything passed\n");
