// Exercise release-version extraction without building or publishing anything.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.join(__dirname, "read-version.ps1");
const powershell = path.join(process.env.SystemRoot || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "frontdesk-version-"));

function read(source) {
  const args = ["-NoProfile", "-File", script];
  if (source) args.push("-HostSource", source);
  const result = spawnSync(powershell, args, { encoding: "utf8" });
  assert.ifError(result.error);
  return result;
}

try {
  const current = read();
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout.trim(), /^\d+\.\d+\.\d+$/);

  const fixture = path.join(temp, "Host.cs");
  fs.writeFileSync(fixture, 'public const string Version = "2.3.4";');
  const valid = read(fixture);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout.trim(), "2.3.4");

  for (const source of [
    'public const string Other = "2.3.4";',
    'public const string Version = "../2.3.4";',
    'public const string Version = "2.3";',
    'public const string Version = "2.3.4"; public const string Version = "9.9.9";'
  ]) {
    fs.writeFileSync(fixture, source);
    assert.notEqual(read(fixture).status, 0, `Must refuse: ${source}`);
  }
  assert.notEqual(read(path.join(temp, "missing.cs")).status, 0);
  console.log("release version: 7 scenarios passed");
} finally {
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  assert.match(path.basename(temp), /^frontdesk-version-/);
  fs.rmSync(temp, { recursive: true, force: true });
}
