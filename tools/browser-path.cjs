// Hosted CI uses Edge. Local tests can explicitly select another Chromium binary.
module.exports = process.env.FRONTDESK_TEST_BROWSER ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
