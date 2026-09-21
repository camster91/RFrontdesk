// Exercises the toast stack in web/js/app.js: dedup, the cap, and the timer.
//
//   node tools/test-toast.cjs
//
// The code under test is lifted out of the real source by marker, so this
// cannot drift from what ships. It needs a DOM, so there is a deliberately
// small one below -- just enough for createElement/appendChild/classList.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "web", "js", "app.js"), "utf8");

const from = src.indexOf("const _liveToasts = new Map();");
const to = src.indexOf("function animateSuccess(el)");
if (from < 0 || to < 0 || to < from) {
  console.error("FAIL: could not find the toast section in app.js");
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

// --- A DOM just barely big enough -----------------------------------------
class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this._classes = new Set();
    this.textContent = "";
    this.listeners = {};
    this.classList = {
      add: (...c) => c.forEach((x) => this._classes.add(x)),
      remove: (...c) => c.forEach((x) => this._classes.delete(x)),
      contains: (c) => this._classes.has(c)
    };
  }
  set className(v) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className() {
    return Array.from(this._classes).join(" ");
  }
  setAttribute(k, v) {
    this.attributes[k] = v;
  }
  getAttribute(k) {
    return this.attributes[k];
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  fire(type, ev) {
    for (const fn of this.listeners[type] || []) fn(ev || {});
  }
}

function makeSandbox() {
  const container = new El("div");
  // A fake clock. Running the timers as soon as they are set would make every
  // toast dismiss itself the instant it appeared, which is not what the real
  // page does and is not what these checks are about.
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  // A frame is delivered immediately by default, which is what every other
  // check here wants. One check needs to hold a frame open across a dismissal
  // -- the interval in which a toast can be dropped before its own fade-in
  // frame runs -- so it can be deferred on demand.
  const frames = [];
  let holdFrames = false;
  const sandbox = {
    console,
    JSON,
    Number,
    String,
    Error,
    Object,
    Promise,
    Map,
    Set,
    Array,
    document: {
      getElementById: (id) => (id === "toast" ? container : null),
      createElement: (tag) => new El(tag)
    },
    requestAnimationFrame: (fn) => {
      if (holdFrames) frames.push(fn);
      else fn();
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, due: now + (Number(ms) || 0) });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    }
  };
  sandbox.globalThis = sandbox;
  // Advance the clock, running whatever is due -- including timers that are
  // only scheduled while an earlier one runs (a dismissal schedules its own
  // slide-out cleanup).
  sandbox.__advance = (ms) => {
    now += ms;
    for (let pass = 0; pass < 50; pass++) {
      const due = Array.from(timers).filter(([, t]) => t.due <= now);
      if (due.length === 0) return;
      for (const [id, t] of due) {
        timers.delete(id);
        t.fn();
      }
    }
    throw new Error("timers did not settle");
  };
  vm.createContext(sandbox);
  vm.runInContext(section, sandbox);
  sandbox.__holdFrames = (on) => {
    holdFrames = on;
  };
  sandbox.__flushFrames = () => {
    const held = frames.splice(0);
    for (const fn of held) fn();
  };
  return { sandbox, container };
}

const msgs = (c) => c.children.map((t) => t.children[0].textContent);

console.log("\nToast stack\n");

// --- Dedup ----------------------------------------------------------------
{
  const { sandbox, container } = makeSandbox();
  sandbox.showToast("Please enter a 10-digit phone number", { type: "error" });
  sandbox.showToast("Please enter a 10-digit phone number", { type: "error" });
  sandbox.showToast("Please enter a 10-digit phone number", { type: "error" });
  check("repeating the same message keeps one toast", container.children.length === 1, container.children.length);
  ok("identical messages do not stack");

  sandbox.showToast("Please enter a 10-digit phone number", { type: "success" });
  check("the same text at a different severity is its own toast", container.children.length === 2, container.children.length);
  ok("severity is part of the identity");

  sandbox.showToast("Something else", { type: "error" });
  check("a different message is its own toast", container.children.length === 3, container.children.length);
  ok("different messages stay separate");
}

// --- Dedup restarts the clock --------------------------------------------
{
  const { sandbox, container } = makeSandbox();
  sandbox.showToast("Saved", { type: "success" });
  sandbox.__advance(2500); // 500ms short of the 3s default
  check("the toast is still up just before its timer", container.children.length === 1, container.children.length);
  sandbox.showToast("Saved", { type: "success" });
  sandbox.__advance(2500);
  check("a repeat pushes the dismissal back rather than letting it expire", container.children.length === 1, container.children.length);
  sandbox.__advance(1500); // past the restarted 3s timer
  check("the timer does still fire", container.children.length === 1, container.children.length);
  sandbox.__advance(700); // and the slide-out finishes
  check("and it does still go away afterwards", container.children.length === 0, container.children.length);
  ok("a repeated message stays on screen longer");
}

// --- Cap ------------------------------------------------------------------
// Dismissal slides the toast out over ~600ms before the node leaves, so the
// count is taken after that has elapsed -- which is what a person sees too.
{
  const { sandbox, container } = makeSandbox();
  for (const m of ["one", "two", "three", "four", "five"]) {
    sandbox.showToast(m, { type: "info" });
  }
  sandbox.__advance(700);
  check("the stack is capped at three", container.children.length === 3, container.children.length);
  check("the oldest are the ones dropped", msgs(container).join(",") === "three,four,five", msgs(container).join(","));
  ok("five taps leave the three newest on screen");
}

// --- Dismissal clears the slot so the message can come back ---------------
{
  const { sandbox, container } = makeSandbox();
  const t = sandbox.showToast("Returned OK", { type: "success" });
  sandbox.dismissToast(t);
  sandbox.__advance(600);
  check("a dismissed toast leaves the stack", container.children.length === 0, container.children.length);
  sandbox.showToast("Returned OK", { type: "success" });
  check("the same message can be shown again after dismissal", container.children.length === 1, container.children.length);
  ok("dismissal frees the message for reuse");
}

// --- A frame delivered after dismissal must not re-show the toast ---------
// showToast fades a toast in by adding `show` on the next frame, so a
// dismissal can land in a later task but before that frame runs -- the undo
// button, a re-show of the same message, an eviction at the cap. Before the
// guard, the stale frame made a toast the app had already dropped visible
// again, and a .toast carries pointer-events: auto, so it also swallowed a tap
// landing where it sat.
{
  const { sandbox, container } = makeSandbox();
  sandbox.__holdFrames(true);
  const t = sandbox.showToast("Saved", { type: "success" });
  check("the toast is attached while its fade-in frame is held", container.children.length === 1, container.children.length);
  check("and is not visible yet", !t.classList.contains("show"), t.className);

  sandbox.dismissToast(t);
  sandbox.__flushFrames();
  check("a frame delivered after dismissal does not show the toast again", !t.classList.contains("show"), t.className);

  sandbox.__advance(700);
  check("and the dismissed toast still leaves the stack", container.children.length === 0, container.children.length);
  ok("a dropped toast is not made visible again by its own fade-in frame");
}

// --- A toast removed from the DOM behind the code's back ------------------
// The eviction loop walks _liveToasts looking for something to drop. If a
// toast that is no longer on the page kept its slot, the loop would find only
// stale entries and never reach the cap -- this is the case that made the
// eviction spin before the entry was deleted unconditionally.
{
  const { sandbox, container } = makeSandbox();
  const t = sandbox.showToast("Gone", { type: "info" });
  container.removeChild(t); // as a teardown elsewhere might
  let threw = "";
  try {
    for (const m of ["a", "b", "c", "d", "e", "f"]) sandbox.showToast(m, { type: "info" });
  } catch (err) {
    threw = err.message;
  }
  check("a detached toast does not stall the cap", threw === "", threw);
  sandbox.__advance(700);
  check("and the cap still holds", container.children.length === 3, container.children.length);
  ok("a toast pulled out of the DOM still frees its slot");
}

// --- Undo action still wired ---------------------------------------------
{
  const { sandbox, container } = makeSandbox();
  let undone = 0;
  const t = sandbox.showToast("Deleted 2 items", {
    type: "undo",
    action: { label: "UNDO", onClick: () => { undone++; } }
  });
  const btn = t.children[1];
  check("the undo button is present", !!btn && btn.textContent === "UNDO", btn && btn.textContent);
  btn.fire("click");
  check("tapping undo runs the handler", undone === 1, undone);
  sandbox.__advance(600);
  check("tapping undo removes the toast", container.children.length === 0, container.children.length);
  ok("the undo affordance survives the dedup change");
}

// --- Undo toasts are not deduped away -------------------------------------
{
  const { sandbox, container } = makeSandbox();
  let which = [];
  sandbox.showUndo("Deleted A", () => which.push("A"));
  sandbox.showUndo("Deleted B", () => which.push("B"));
  check("two different undos both stay on screen", container.children.length === 2, container.children.length);
  container.children[0].children[1].fire("click");
  container.children[1].children[1].fire("click");
  check("each undo runs its own handler", which.join(",") === "A,B", which.join(","));
  ok("separate undo offers are not merged");
}

// --- No container ---------------------------------------------------------
{
  const { sandbox } = makeSandbox();
  sandbox.document.getElementById = () => null;
  let r;
  try {
    r = sandbox.showToast("nowhere to go", { type: "info" });
  } catch (err) {
    check("a missing #toast container does not throw", false, err.message);
  }
  check("a missing #toast container returns null", r === null, r);
  ok("a missing toast container is survivable");
}

console.log("");
if (failures) {
  console.error(`${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log("all checks passed\n");
