// Exercises the screen router in web/js/app.js -- specifically goBack.
//
//   node tools/test-router.cjs
//
// goBack popped the previous screen and then goToScreen pushed the screen being
// left straight back on, so Back never emptied the stack and every Back/forward
// pair added another entry. That is what these checks pin down.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "web", "js", "app.js"), "utf8");

const from = src.indexOf("var screens = /* @__PURE__ */ new Map();");
const to = src.indexOf("async function refreshHome()");
if (from < 0 || to < 0 || to < from) {
  console.error("FAIL: could not find the router section in app.js");
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

class El {
  constructor(id) {
    this.id = id;
    this._c = new Set(["hidden"]);
    this.classList = {
      add: (...x) => x.forEach((y) => this._c.add(y)),
      remove: (...x) => x.forEach((y) => this._c.delete(y)),
      contains: (x) => this._c.has(x)
    };
  }
  querySelector() {
    return null;
  }
}

const NAMES = [
  "splash", "welcome", "home", "checkout", "checkin", "checkin-return",
  "admin", "admin-detail", "admin-login",
  "kiosk-borrow-phone", "kiosk-borrow-name", "kiosk-borrow-done"
];

function makeSandbox() {
  const els = new Map(NAMES.map((n) => [n, new El(n)]));
  // The keyboard is built during bootstrap() and hung on `window`, which is
  // always there in a browser. goToScreen asks it to put itself away, so the
  // sandbox has to have one -- and counting the calls is how the check below
  // knows it was asked.
  const keyboard = {
    hides: 0,
    hide() {
      this.hides += 1;
    }
  };
  const sandbox = {
    console,
    Map,
    Set,
    Array,
    Object,
    Error,
    window: {},
    // Not under test; the real one lives in the admin module.
    endAdminSession: () => {
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.window.__keyboard = keyboard;
  vm.runInContext(section, sandbox);
  sandbox.screens = els;
  return { sandbox, els, keyboard };
}

console.log("\nScreen router\n");

// --- Back walks the history back, once per press --------------------------
{
  const { sandbox } = makeSandbox();
  sandbox.goToScreen("home");
  sandbox.goToScreen("checkout");
  check("history has one entry after one move", sandbox.historyStack.length === 1, JSON.stringify(sandbox.historyStack));
  sandbox.goBack();
  check("Back lands on the screen we came from", sandbox.getCurrentScreen() === "home", sandbox.getCurrentScreen());
  check("and does not push the screen it left", sandbox.historyStack.length === 0, JSON.stringify(sandbox.historyStack));
  ok("Back returns to the previous screen and empties the stack");
}

// --- The round trip does not accumulate -----------------------------------
{
  const { sandbox } = makeSandbox();
  sandbox.goToScreen("home");
  for (let i = 0; i < 5; i++) {
    sandbox.goToScreen("checkout");
    sandbox.goBack();
  }
  check("five Back/forward rounds leave nothing behind", sandbox.historyStack.length === 0, JSON.stringify(sandbox.historyStack));
  check("and we are back where we started", sandbox.getCurrentScreen() === "home", sandbox.getCurrentScreen());
  ok("repeated Back/forward no longer grows the stack");
}

// --- A real depth still unwinds in order ----------------------------------
{
  const { sandbox } = makeSandbox();
  sandbox.goToScreen("home");
  sandbox.goToScreen("admin");
  sandbox.goToScreen("admin-detail");
  check("depth is tracked", sandbox.historyStack.join(",") === "home,admin", sandbox.historyStack.join(","));
  sandbox.goBack();
  check("first Back reaches admin", sandbox.getCurrentScreen() === "admin", sandbox.getCurrentScreen());
  check("one entry left", sandbox.historyStack.join(",") === "home", sandbox.historyStack.join(","));
  sandbox.goBack();
  check("second Back reaches home", sandbox.getCurrentScreen() === "home", sandbox.getCurrentScreen());
  check("stack empty", sandbox.historyStack.length === 0, JSON.stringify(sandbox.historyStack));
  ok("a three-deep stack unwinds one screen at a time");
}

// --- Back from nothing goes home ------------------------------------------
{
  const { sandbox } = makeSandbox();
  sandbox.goToScreen("home");
  sandbox.historyStack.length = 0;
  sandbox.goBack();
  check("Back from an empty stack falls back to home", sandbox.getCurrentScreen() === "home", sandbox.getCurrentScreen());
  check("and still does not push anything", sandbox.historyStack.length === 0, JSON.stringify(sandbox.historyStack));
  ok("Back from an empty stack goes home without side effects");
}

// --- Re-entering the same screen is not a move ----------------------------
{
  const { sandbox } = makeSandbox();
  sandbox.goToScreen("home");
  sandbox.goToScreen("home");
  check("navigating to the screen you are on adds no history", sandbox.historyStack.length === 0, JSON.stringify(sandbox.historyStack));
  ok("a no-op navigation stays a no-op");
}

// --- Kiosk containment still holds ----------------------------------------
{
  const { sandbox } = makeSandbox();
  sandbox.goToScreen("welcome");
  const result = sandbox.goToScreen("home");
  check("the kiosk still refuses to leave for a staff screen", result === null, result);
  check("and stays put", sandbox.getCurrentScreen() === "welcome", sandbox.getCurrentScreen());
  check("a refused navigation adds no history", sandbox.historyStack.length === 0, JSON.stringify(sandbox.historyStack));
  ok("kiosk containment is untouched by the history change");
}

// --- A screen change puts the on-screen keyboard away ---------------------
// Nothing can be typed into across a screen change, and the keyboard's own
// focusout path is 150ms plus a slide-out behind one. Without this the screen
// that replaced a field spent its first moments with a full-width, z-index 100
// keyboard across the bottom of it, taking every tap that landed there.
{
  const { sandbox, keyboard } = makeSandbox();
  sandbox.goToScreen("home");
  check("the first navigation asks the keyboard to hide", keyboard.hides === 1, keyboard.hides);
  sandbox.goToScreen("checkout");
  check("and so does the next", keyboard.hides === 2, keyboard.hides);
  ok("every screen change puts the keyboard away");
}

// --- Unknown screens ------------------------------------------------------
{
  const { sandbox } = makeSandbox();
  sandbox.goToScreen("home");
  const result = sandbox.goToScreen("nope");
  check("an unknown screen is refused", result === null, result);
  check("and leaves the stack alone", sandbox.historyStack.length === 0, JSON.stringify(sandbox.historyStack));
  ok("an unknown screen name changes nothing");
}

console.log("");
if (failures) {
  console.error(`${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log("all checks passed\n");
