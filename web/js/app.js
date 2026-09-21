(function(){
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../frontdesk/modules/db.js
async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      fn(val);
    };
    const timeoutId = setTimeout(() => {
      settle(reject, new Error("Database is locked by another tab/window. Close other Front Desk tabs and reload."));
    }, 5e3);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Holds what was read out of a mismatched database so it can be put back
    // after the recreate, instead of being discarded with the old file.
    let salvagedFrom = null;
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (e.oldVersion < 1) {
        const items = db.createObjectStore("items", {
          keyPath: "id",
          autoIncrement: true
        });
        items.createIndex("name", "name", {
          unique: false
        });
        items.createIndex("nameLower", "nameLower", {
          unique: false
        });
        items.createIndex("isArchived", "isArchived", {
          unique: false
        });
        items.createIndex("timesCheckedOut", "timesCheckedOut", {
          unique: false
        });
        const borrowers = db.createObjectStore("borrowers", {
          keyPath: "id",
          autoIncrement: true
        });
        borrowers.createIndex("phone", "phone", {
          unique: false
        });
        borrowers.createIndex("nameLower", "nameLower", {
          unique: false
        });
        borrowers.createIndex("lastSeenAt", "lastSeenAt", {
          unique: false
        });
        const loans = db.createObjectStore("loans", {
          keyPath: "id",
          autoIncrement: true
        });
        loans.createIndex("itemId", "itemId", {
          unique: false
        });
        loans.createIndex("borrowerId", "borrowerId", {
          unique: false
        });
        loans.createIndex("isOpen", "isOpen", {
          unique: false
        });
        loans.createIndex("checkedOutAt", "checkedOutAt", {
          unique: false
        });
        loans.createIndex("dueAt", "dueAt", {
          unique: false
        });
        db.createObjectStore("settings", {
          keyPath: "id"
        });
      }
      if (e.oldVersion < 3) {
        const requests = db.createObjectStore("requests", {
          keyPath: "id",
          autoIncrement: true
        });
        requests.createIndex("status", "status", {
          unique: false
        });
        requests.createIndex("createdAt", "createdAt", {
          unique: false
        });
        requests.createIndex("borrowerId", "borrowerId", {
          unique: false
        });
      }
    };
    req.onsuccess = async () => {
      _db = req.result;
      const expected = new Set(STORES);
      const actual = new Set(Array.from(_db.objectStoreNames));
      const missing = [
        ...expected
      ].filter((s) => !actual.has(s));
      if (missing.length) {
        salvagedFrom = await _salvageStores(_db);
        console.warn(`[db] schema mismatch: missing stores ${missing.join(", ")}; recreating database`);
        _db.close();
        _db = null;
        const req2 = indexedDB.deleteDatabase(DB_NAME);
        req2.onsuccess = async () => {
          try {
            await openDB();
            const report = await _restoreSalvage(salvagedFrom);
            _recordRecoveryReport(report, missing);
            settle(resolve, _db);
          } catch (err) {
            settle(reject, err);
          }
        };
        req2.onerror = () => settle(reject, req2.error);
        req2.onblocked = () => settle(reject, new Error("Cannot recreate database \u2014 another tab is holding it open. Close all Front Desk tabs and reload."));
        return;
      }
      // Close on versionchange so another tab (or this app after a future schema
      // bump) can actually upgrade or delete. Nulling the reference instead left
      // the connection open, which blocked the very recovery path above.
      _db.onversionchange = () => {
        try {
          _db.close();
        } catch (_) {
        }
        _db = null;
      };
      _db.onclose = () => {
        _db = null;
      };
      settle(resolve, _db);
    };
    req.onerror = () => settle(reject, req.error);
    req.onblocked = () => settle(reject, new Error("Database open blocked by another connection. Close other Front Desk tabs and reload."));
  });
}
// ── Schema-mismatch salvage ───────────────────────────────────────────────────
//
// openDB() recreates the database when the stores it finds don't match this
// build. That cannot happen in a build that migrates properly, but the old code
// just deleted everything with a console warning, so any future schema drift (or
// a database left behind by a different build) silently destroyed the user's
// records. Read what is actually there first, then put it back into the fresh
// database, and leave a report the UI can surface.

/** Read every object store the open connection has, as {storeName: records[]}. */
function _salvageStores(db) {
  return new Promise((resolve) => {
    const names = Array.from(db.objectStoreNames);
    if (!names.length) {
      resolve({});
      return;
    }
    const out = {};
    let t;
    try {
      t = db.transaction(names, "readonly");
    } catch (_) {
      resolve({});
      return;
    }
    for (const name of names) {
      try {
        const req = t.objectStore(name).getAll();
        req.onsuccess = () => {
          out[name] = req.result || [];
        };
        req.onerror = () => {
          out[name] = [];
        };
      } catch (_) {
        out[name] = [];
      }
    }
    t.oncomplete = () => resolve(out);
    t.onerror = () => resolve(out);
    t.onabort = () => resolve(out);
  });
}

/**
 * Write a salvage snapshot into the freshly-created database. Records whose
 * store no longer exists, or whose shape the new schema rejects, are skipped
 * rather than allowed to fail the whole restore.
 */
function _restoreSalvage(snapshot) {
  return new Promise((resolve) => {
    const db = _db;
    if (!db) {
      resolve({
        restored: 0,
        skipped: 0,
        stores: []
      });
      return;
    }
    const names = Object.keys(snapshot || {}).filter((n) => db.objectStoreNames.contains(n) && (snapshot[n] || []).length > 0);
    const result = {
      restored: 0,
      skipped: 0,
      stores: names
    };
    if (!names.length) {
      resolve(result);
      return;
    }
    let t;
    try {
      t = db.transaction(names, "readwrite");
    } catch (_) {
      resolve(result);
      return;
    }
    for (const name of names) {
      const store = t.objectStore(name);
      for (const rec of snapshot[name]) {
        try {
          store.put(rec);
          result.restored++;
        } catch (_) {
          result.skipped++;
        }
      }
    }
    t.oncomplete = () => resolve(result);
    t.onerror = () => resolve(result);
    t.onabort = () => resolve(result);
  });
}

/** Persist what happened so a later screen can tell the user, not just the console. */
function _recordRecoveryReport(report, missing) {
  try {
    const payload = {
      at: Date.now(),
      missing: missing.slice(),
      salvaged: report.restored,
      skipped: report.skipped,
      stores: report.stores
    };
    localStorage.setItem("frontdesk.lastRecovery", JSON.stringify(payload));
  } catch (_) {
  }
}

/** The last schema-recovery report, or null. Cleared once it has been shown. */
function takeRecoveryReport() {
  try {
    const raw = localStorage.getItem("frontdesk.lastRecovery");
    if (!raw) return null;
    localStorage.removeItem("frontdesk.lastRecovery");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}
function tx(storeName, mode = "readonly") {
  return _db.transaction(storeName, mode).objectStore(storeName);
}
function asPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function runTx(storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    if (!_db) return reject(new Error("runTx: database not open"));
    const transaction = _db.transaction(storeNames, mode);
    const storeMap = {};
    for (const name of storeNames) storeMap[name] = transaction.objectStore(name);
    const stores = {
      req: (idbReq) => new Promise((res, rej) => {
        idbReq.onsuccess = () => res(idbReq.result);
        idbReq.onerror = () => rej(idbReq.error);
      }),
      get: (name) => storeMap[name]
    };
    let fnResult;
    let fnError;
    try {
      fnResult = fn(stores);
    } catch (e) {
      fnError = e;
    }
    if (fnError) {
      try {
        transaction.abort();
      } catch {
      }
      return reject(fnError);
    }
    transaction.oncomplete = () => {
      Promise.resolve(fnResult).then(resolve, reject);
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("transaction aborted"));
  });
}
async function getAll(store) {
  await openDB();
  return asPromise(tx(store).getAll());
}
async function get(store, id) {
  await openDB();
  return asPromise(tx(store).get(id));
}
async function put(store, value) {
  await openDB();
  return asPromise(tx(store, "readwrite").put(value));
}
async function del(store, id) {
  await openDB();
  return asPromise(tx(store, "readwrite").delete(id));
}
async function getByIndex(store, indexName, value) {
  await openDB();
  return asPromise(tx(store).index(indexName).get(value));
}
async function getAllByIndex(store, indexName, value) {
  await openDB();
  return asPromise(tx(store).index(indexName).getAll(value));
}
async function listItems({ includeArchived = false, sortBy = "name" } = {}) {
  await openDB();
  const allItems = await getAll("items");
  let items = includeArchived ? allItems : allItems.filter((item) => !item.isArchived);
  items.sort((a, b) => {
    if (sortBy === "timesCheckedOut") {
      return b.timesCheckedOut - a.timesCheckedOut;
    }
    return a.name.localeCompare(b.name, void 0, {
      numeric: true
    });
  });
  return items;
}
async function findItemByName(name) {
  if (!name) return null;
  await openDB();
  return getByIndex("items", "nameLower", name.toLowerCase().trim());
}
async function createItem({ name, category, location: location2, condition, notes }) {
  await openDB();
  const item = {
    name: name.trim(),
    nameLower: name.trim().toLowerCase(),
    category: category || "Other",
    location: location2 || "",
    condition: condition || "good",
    notes: notes || "",
    timesCheckedOut: 0,
    lastCheckedOutAt: null,
    isArchived: false,
    createdAt: Date.now()
  };
  const id = await put("items", item);
  return {
    ...item,
    id
  };
}
async function findBorrowerByPhone(phone) {
  if (!phone) return [];
  await openDB();
  const digits = String(phone).replace(/\D/g, "");
  const normalized = digits.length >= 10 ? digits.slice(-10) : digits;
  if (!normalized) return [];
  return getAllByIndex("borrowers", "phone", normalized);
}
async function findBorrowersByName(name) {
  if (!name) return [];
  await openDB();
  const lower = name.toLowerCase().trim();
  const all = await getAll("borrowers");
  return all.filter((b) => (b.nameLower || "").trim() === lower);
}
async function upsertBorrower({ phone, name, contact2 }) {
  if (!phone) throw new Error("upsertBorrower: phone is required");
  const digits = String(phone).replace(/\D/g, "");
  const normalizedPhone = digits.length >= 10 ? digits.slice(-10) : digits;
  if (!normalizedPhone) throw new Error("upsertBorrower: phone has no digits");
  const trimmedName = (name || "").trim();
  if (!trimmedName) throw new Error("upsertBorrower: name is required");
  await openDB();
  return runTx([
    "borrowers"
  ], "readwrite", async (s) => {
    const store = s.get("borrowers");
    const existing = await s.req(store.index("phone").getAll(normalizedPhone));
    if (existing.length > 1) {
      const err = new Error(`Multiple borrowers share this phone: ${existing.length} matches`);
      err.code = "DISAMBIGUATION_REQUIRED";
      err.matches = existing;
      throw err;
    }
    if (existing.length > 0) {
      const borrower2 = existing[0];
      borrower2.lastSeenAt = Date.now();
      if (contact2) borrower2.contact2 = contact2;
      await s.req(store.put(borrower2));
      return borrower2;
    }
    const borrower = {
      phone: normalizedPhone,
      phoneFormatted: "",
      name: trimmedName,
      nameLower: trimmedName.toLowerCase(),
      contact2: contact2 || "",
      timesCheckedOut: 0,
      lastSeenAt: Date.now(),
      notes: "",
      isArchived: false,
      createdAt: Date.now()
    };
    const id = await s.req(store.add(borrower));
    return {
      ...borrower,
      id
    };
  });
}
async function listBorrowers({ includeArchived = false, sortBy = "name" } = {}) {
  await openDB();
  const allBorrowers = await getAll("borrowers");
  let borrowers = includeArchived ? allBorrowers : allBorrowers.filter((b) => !b.isArchived);
  borrowers.sort((a, b) => {
    if (sortBy === "lastSeenAt") {
      return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
    }
    return a.name.localeCompare(b.name, void 0, {
      numeric: true
    });
  });
  return borrowers;
}
async function getBorrower(id) {
  return get("borrowers", id);
}
async function mergeBorrowers(keepId, mergeId) {
  await openDB();
  if (keepId === mergeId) throw new Error("Cannot merge a borrower into themselves");
  return runTx([
    "borrowers",
    "loans",
    "requests"
  ], "readwrite", async (s) => {
    const borrowersStore = s.get("borrowers");
    const loansStore = s.get("loans");
    const requestsStore = s.get("requests");
    const keep = await s.req(borrowersStore.get(keepId));
    const merge = await s.req(borrowersStore.get(mergeId));
    if (!keep) throw new Error(`Borrower ${keepId} not found`);
    if (!merge) throw new Error(`Borrower ${mergeId} not found`);
    const loansToUpdate = await s.req(loansStore.index("borrowerId").getAll(mergeId));
    for (const loan of loansToUpdate) {
      loan.borrowerId = keepId;
      await s.req(loansStore.put(loan));
    }
    const requestsToUpdate = await s.req(requestsStore.index("borrowerId").getAll(mergeId));
    for (const pending of requestsToUpdate) {
      pending.borrowerId = keepId;
      await s.req(requestsStore.put(pending));
    }
    keep.timesCheckedOut = (keep.timesCheckedOut || 0) + (merge.timesCheckedOut || 0);
    keep.lastSeenAt = Math.max(keep.lastSeenAt || 0, merge.lastSeenAt || 0) || null;
    if (merge.phone && merge.phone !== keep.phone) {
      const note = `Merged from ${merge.name || "unnamed"} (${merge.phoneFormatted || merge.phone})`;
      keep.notes = keep.notes ? `${keep.notes} | ${note}` : note;
    }
    await s.req(borrowersStore.put(keep));
    await s.req(borrowersStore.delete(mergeId));
    return {
      keepId,
      loansMoved: loansToUpdate.length,
      requestsMoved: requestsToUpdate.length
    };
  });
}
async function updateBorrowerPhone(borrowerId, newPhone) {
  await openDB();
  const borrower = await get("borrowers", borrowerId);
  if (!borrower) throw new Error(`Borrower ${borrowerId} not found`);
  borrower.phone = newPhone;
  borrower.lastSeenAt = Date.now();
  return put("borrowers", borrower);
}
async function createLoan({ itemId, borrowerId, checkedOutAt, dueAt, conditionOut, notes, recordedBy, customName }) {
  await openDB();
  return runTx([
    "loans",
    "items",
    "borrowers"
  ], "readwrite", async (s) => {
    let item = null;
    let itemName = "";
    if (itemId != null) {
      item = await s.req(s.get("items").get(itemId));
      if (!item) throw new Error(`Item ${itemId} not found`);
      itemName = item.name;
    } else if (customName) {
      itemName = String(customName).trim().slice(0, 200);
      if (!itemName) throw new Error("Either itemId or customName is required");
    } else {
      throw new Error("Either itemId or customName is required");
    }
    if (item) {
      const itemLoans = await s.req(s.get("loans").index("itemId").getAll(item.id));
      const stillOut = itemLoans.find((l) => l.isOpen === "open" && !l.returnedAt);
      if (stillOut) {
        const who = stillOut.borrowerNameSnapshot || "someone";
        const err = new Error(`${itemName} — already out to ${who}`);
        err.code = "ALREADY_OUT";
        err.holder = who;
        err.loanId = stillOut.id;
        throw err;
      }
    }
    let borrower = null;
    if (borrowerId != null) {
      borrower = await s.req(s.get("borrowers").get(borrowerId));
      if (!borrower) throw new Error(`Borrower ${borrowerId} not found`);
    } else if (!customName) {
      throw new Error("Walk-in borrowers require a customName for the loan");
    }
    const loan = {
      itemId: itemId || null,
      itemNameSnapshot: itemName,
      borrowerId: borrowerId || null,
      // For walk-ins, fall back to the borrower data passed in
      // (or just a placeholder) instead of crashing.
      borrowerPhoneSnapshot: borrower && borrower.phone || (notes && notes.startsWith("walk-in") ? "walk-in" : "") || "",
      borrowerNameSnapshot: borrower && borrower.name || (notes && notes.startsWith("walk-in") ? "(walk-in)" : ""),
      checkedOutAt: checkedOutAt || Date.now(),
      dueAt,
      returnedAt: null,
      isOpen: "open",
      conditionOut: conditionOut || "good",
      conditionIn: null,
      notes: notes || "",
      recordedBy: recordedBy || ""
    };
    const loanResult = await s.req(s.get("loans").add(loan));
    loan.id = loanResult;
    if (item) {
      item.timesCheckedOut = (item.timesCheckedOut || 0) + 1;
      item.lastCheckedOutAt = loan.checkedOutAt;
      await s.req(s.get("items").put(item));
    }
    if (borrower) {
      borrower.timesCheckedOut = (borrower.timesCheckedOut || 0) + 1;
      borrower.lastSeenAt = loan.checkedOutAt;
      await s.req(s.get("borrowers").put(borrower));
    }
    return loan;
  });
}
async function returnLoan(loanId, { returnedAt, conditionIn, notes } = {}) {
  await openDB();
  return runTx([
    "loans"
  ], "readwrite", async (s) => {
    const store = s.get("loans");
    const loan = await s.req(store.get(loanId));
    if (!loan) throw new Error(`Loan ${loanId} not found`);
    if (loan.returnedAt) throw new Error(`Loan ${loanId} already returned`);
    loan.returnedAt = returnedAt || Date.now();
    loan.isOpen = "closed";
    loan.conditionIn = conditionIn || "good";
    // The return is now real, so any kiosk request that asked for it is spent.
    delete loan.returnRequestedAt;
    delete loan.returnRequestedCondition;
    delete loan.returnRequestedNote;
    if (notes) {
      const addition = String(notes).trim();
      if (addition) {
        loan.notes = loan.notes ? `${loan.notes} | Check-in: ${addition}` : `Check-in: ${addition}`;
      }
    }
    await s.req(store.put(loan));
    return loan;
  });
}

// ── Kiosk returns: a request, not a return ────────────────────────────────────
//
// The kiosk is an anonymous surface -- a 10-digit phone number is the entire
// credential (see CODE_REVIEW D2). Closing the loan from there meant anyone who
// knew a phone number could clear that person's loans while the equipment was
// still in a bag, and it was always recorded `conditionIn: "good"`, so damage
// could never be captured (D7). The borrower now *asks* to return; the loan stays
// open, and shows as open, until a staff member confirms the item is physically
// back and checks its condition.

/** Borrower-side: flag an open loan as handed back, pending staff confirmation. */
async function requestLoanReturn(loanId, { conditionIn, note } = {}) {
  await openDB();
  return runTx([
    "loans"
  ], "readwrite", async (s) => {
    const store = s.get("loans");
    const loan = await s.req(store.get(loanId));
    if (!loan) throw new Error(`Loan ${loanId} not found`);
    if (loan.returnedAt || loan.isOpen !== "open") {
      throw new Error("That item is already back in the system.");
    }
    if (loan.returnRequestedAt) {
      // Already asked for -- tapping twice must not overwrite the note the
      // borrower already left for the desk.
      return loan;
    }
    loan.returnRequestedAt = Date.now();
    loan.returnRequestedCondition = conditionIn === "damaged" ? "damaged" : "good";
    loan.returnRequestedNote = String(note || "").trim().slice(0, 300);
    await s.req(store.put(loan));
    return loan;
  });
}

/** Staff-side: the item is physically back. Closes the loan with the reported condition. */
async function confirmRequestedReturn(loanId, { conditionIn, note } = {}) {
  await openDB();
  const loan = await get("loans", loanId);
  if (!loan) throw new Error(`Loan ${loanId} not found`);
  const cond = conditionIn || loan.returnRequestedCondition || "good";
  const staffNote = [
    loan.returnRequestedNote ? `borrower reported: ${loan.returnRequestedNote}` : "",
    note || ""
  ].filter(Boolean).join(" | ");
  return returnLoan(loanId, {
    conditionIn: cond,
    notes: staffNote || "kiosk return confirmed at the desk"
  });
}

/** Staff-side: the item did not come back. Clears the request, loan stays open. */
async function denyRequestedReturn(loanId, { reason } = {}) {
  await openDB();
  return runTx([
    "loans"
  ], "readwrite", async (s) => {
    const store = s.get("loans");
    const loan = await s.req(store.get(loanId));
    if (!loan) throw new Error(`Loan ${loanId} not found`);
    delete loan.returnRequestedAt;
    delete loan.returnRequestedCondition;
    delete loan.returnRequestedNote;
    if (reason) {
      loan.notes = loan.notes ? `${loan.notes} | Not returned: ${reason}` : `Not returned: ${reason}`;
    }
    await s.req(store.put(loan));
    return loan;
  });
}

/** Open loans the borrower has flagged as handed back, oldest request first. */
async function getPendingReturns() {
  await openDB();
  const openLoans = await getAllByIndex("loans", "isOpen", "open");
  return openLoans
    .filter((loan) => loan.returnRequestedAt)
    .sort((a, b) => a.returnRequestedAt - b.returnRequestedAt);
}

async function undoLoansAtomic(loans) {
  await openDB();
  if (!Array.isArray(loans) || loans.length === 0) {
    return {
      undone: 0,
      errors: []
    };
  }
  return runTx([
    "loans",
    "items",
    "borrowers"
  ], "readwrite", async (s) => {
    const loansStore = s.get("loans");
    const itemsStore = s.get("items");
    const borrowersStore = s.get("borrowers");
    const errors = [];
    let undone = 0;
    for (const loan of loans) {
      if (!loan || loan.id == null) continue;
      const live = await s.req(loansStore.get(loan.id));
      if (!live) {
        // Already undone — the undo button was tapped twice, or the loan was
        // removed elsewhere. Decrementing again would corrupt the counters.
        continue;
      }
      if (loan.itemId != null) {
        const item = await s.req(itemsStore.get(loan.itemId));
        if (item) {
          item.timesCheckedOut = Math.max(0, (item.timesCheckedOut || 0) - 1);
          const siblings = await s.req(loansStore.index("itemId").getAll(loan.itemId));
          const newest = siblings.reduce((max, l) => l.id === loan.id ? max : Math.max(max, l.checkedOutAt || 0), 0);
          item.lastCheckedOutAt = newest || null;
          await s.req(itemsStore.put(item));
        }
      }
      if (loan.borrowerId != null) {
        const borrower = await s.req(borrowersStore.get(loan.borrowerId));
        if (borrower) {
          borrower.timesCheckedOut = Math.max(0, (borrower.timesCheckedOut || 0) - 1);
          const siblings = await s.req(loansStore.index("borrowerId").getAll(loan.borrowerId));
          const newest = siblings.reduce((max, l) => l.id === loan.id ? max : Math.max(max, l.checkedOutAt || 0), 0);
          borrower.lastSeenAt = newest || null;
          await s.req(borrowersStore.put(borrower));
        }
      }
      await s.req(loansStore.delete(loan.id));
      undone++;
    }
    return {
      undone,
      errors
    };
  });
}
// `isOpen` is the string "open" / "closed", not a boolean -- and "closed" is
// truthy, so `if (loan.isOpen)` is true for returned loans. Always use this.
function isLoanOpen(loan) {
  return !!loan && loan.isOpen === "open" && !loan.returnedAt;
}
async function getOpenLoans() {
  await openDB();
  const openLoans = await getAllByIndex("loans", "isOpen", "open");
  return openLoans.sort((a, b) => (a.dueAt || Infinity) - (b.dueAt || Infinity));
}
async function getOpenLoanForItem(itemId) {
  await openDB();
  const itemLoans = await getAllByIndex("loans", "itemId", itemId);
  return itemLoans.find((loan) => loan.isOpen === "open") || null;
}
async function getLoansForItem(itemId) {
  await openDB();
  const loans = await getAllByIndex("loans", "itemId", itemId);
  return loans.sort((a, b) => b.checkedOutAt - a.checkedOutAt);
}
async function getLoansForBorrower(borrowerId) {
  await openDB();
  const loans = await getAllByIndex("loans", "borrowerId", borrowerId);
  return loans.sort((a, b) => b.checkedOutAt - a.checkedOutAt);
}
async function getOverdueLoans() {
  await openDB();
  const openLoans = await getOpenLoans();
  const now = Date.now();
  return openLoans.filter((loan) => loan.dueAt && loan.dueAt < now);
}
async function getAllLoans({ limit = 500, offset = 0 } = {}) {
  await openDB();
  const allLoans = await getAll("loans");
  const sorted = allLoans.sort((a, b) => b.checkedOutAt - a.checkedOutAt);
  // Honour the caller's limit exactly. A hidden 2,000-row ceiling used to
  // truncate the CSV export, the date-range filter and the Settings totals
  // without telling anyone.
  const end = limit == null ? sorted.length : Math.min(offset + limit, sorted.length);
  return sorted.slice(offset, end);
}
async function countLoansByStatus() {
  await openDB();
  const allLoans = await getAll("loans");
  const now = Date.now();
  const todayStart = (/* @__PURE__ */ new Date()).setHours(0, 0, 0, 0);
  const weekAgo = now - 7 * 24 * 60 * 60 * 1e3;
  const counts = {
    out: 0,
    overdue: 0,
    total: allLoans.length,
    returnedToday: 0,
    returnedThisWeek: 0
  };
  for (const loan of allLoans) {
    if (loan.isOpen === "open") {
      counts.out++;
      if (loan.dueAt && loan.dueAt < now) {
        counts.overdue++;
      }
    } else if (loan.returnedAt) {
      if (loan.returnedAt >= todayStart) {
        counts.returnedToday++;
      }
      if (loan.returnedAt >= weekAgo) {
        counts.returnedThisWeek++;
      }
    }
  }
  return counts;
}
async function getSettings() {
  await openDB();
  let settings = await get("settings", 1);
  if (!settings) {
    // Settings live under the key 1, but a database can hold a real settings
    // record under some other key: an older build with a different scheme, or
    // one rebuilt by the schema-mismatch salvage in openDB(). Creating the
    // default here would silently revert the staff PIN, loan duration and theme
    // while the user's actual settings sat unread in the same store.
    const existing = await getAll("settings");
    const adopted = existing.find((s) => s && s.pin) || existing[0];
    if (adopted) {
      settings = Object.assign({}, adopted, {
        id: 1
      });
      await put("settings", settings);
      for (const other of existing) {
        if (other && other.id !== 1) await del("settings", other.id).catch(() => {
        });
      }
      return settings;
    }
    settings = {
      id: 1,
      pin: "1234",
      defaultLoanHours: 8,
      // Hour of day (0-23, local time) that self-service kiosk checkouts
      // are due back by. The kiosk computes dueAt = next occurrence of
      // this hour (today if it's still in the future, else tomorrow).
      // Default 17 = 5pm. Staff-set via Admin → Settings.
      endOfDayHour: 17,
      theme: "dark",
      lastBackupAt: null,
      // Wrong-PIN throttle, persisted so a reload cannot clear a lockout.
      pinFailures: 0,
      pinLockedUntil: 0,
      schemaVersion: 1
    };
    await put("settings", settings);
  }
  return settings;
}
async function getKioskDueAt() {
  const settings = await getSettings();
  const hour = settings.endOfDayHour ?? 17;
  const now = /* @__PURE__ */ new Date();
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (due.getTime() <= now.getTime()) {
    due.setDate(due.getDate() + 1);
  }
  return due.getTime();
}
async function updateSettings(updates) {
  await openDB();
  const settings = await getSettings();
  Object.assign(settings, updates);
  await put("settings", settings);
  return settings;
}
async function mergeItems(keepId, mergeId, { allowBothOpen = false } = {}) {
  if (keepId === mergeId) throw new Error("Cannot merge an item into itself");
  await openDB();
  return runTx([
    "items",
    "loans"
  ], "readwrite", async (s) => {
    const itemsStore = s.get("items");
    const loansStore = s.get("loans");
    const keep = await s.req(itemsStore.get(keepId));
    const merge = await s.req(itemsStore.get(mergeId));
    if (!keep) throw new Error(`Item ${keepId} not found`);
    if (!merge) throw new Error(`Item ${mergeId} not found`);
    const keepOpen = (await s.req(loansStore.index("itemId").getAll(keepId))).filter((l) => l.isOpen === "open" && !l.returnedAt);
    const mergeOpen = (await s.req(loansStore.index("itemId").getAll(mergeId))).filter((l) => l.isOpen === "open" && !l.returnedAt);
    if (!allowBothOpen && keepOpen.length > 0 && mergeOpen.length > 0) {
      const err = new Error(`Both entries are checked out (to ${keepOpen[0].borrowerNameSnapshot || "someone"} and ${mergeOpen[0].borrowerNameSnapshot || "someone"}). Check one in before merging, otherwise one item ends up with two open loans.`);
      err.code = "BOTH_OPEN";
      throw err;
    }
    const mergeLoans = await s.req(loansStore.index("itemId").getAll(mergeId));
    for (const loan of mergeLoans) {
      loan.itemId = keepId;
      loan.itemNameSnapshot = keep.name;
      await s.req(loansStore.put(loan));
    }
    keep.timesCheckedOut = (keep.timesCheckedOut || 0) + (merge.timesCheckedOut || 0);
    keep.lastCheckedOutAt = Math.max(keep.lastCheckedOutAt || 0, merge.lastCheckedOutAt || 0) || null;
    await s.req(itemsStore.put(keep));
    merge.timesCheckedOut = 0;
    merge.lastCheckedOutAt = null;
    merge.isArchived = true;
    merge.mergedIntoId = keepId;
    await s.req(itemsStore.put(merge));
    return {
      keepId,
      mergedId: mergeId,
      loansMoved: mergeLoans.length
    };
  });
}
async function findDuplicateItems() {
  await openDB();
  const all = await getAll("items");
  const live = all.filter((item) => !item.isArchived);
  const groups = /* @__PURE__ */ new Map();
  for (const item of live) {
    const key = (item.nameLower || item.name || "").trim().toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const duplicates = [];
  for (const [, items] of groups) {
    if (items.length < 2) continue;
    items.sort((a, b) => (b.timesCheckedOut || 0) - (a.timesCheckedOut || 0) || (a.createdAt || 0) - (b.createdAt || 0));
    duplicates.push(items);
  }
  duplicates.sort((a, b) => b.length - a.length);
  return {
    duplicates,
    scanned: live.length,
    itemCount: duplicates.reduce((n, g) => n + g.length, 0)
  };
}
async function runDailyDedup() {
  // Detection only. This used to merge automatically, which was destructive:
  // the app deliberately lets the desk add a second item with the same name
  // (two physical "HDMI Cable" units are not duplicates), and the merge also
  // re-ran against already-archived victims, compounding their counters upward
  // on every launch. Duplicates are now surfaced for a human to resolve.
  const { duplicates, scanned, itemCount } = await findDuplicateItems();
  if (duplicates.length > 0) {
    console.warn(`[dedup] ${duplicates.length} duplicate name group(s), ${itemCount} items. Not merging automatically — resolve in Admin → Items → Duplicates.`);
  }
  return {
    merged: 0,
    scanned,
    duplicateGroups: duplicates.length,
    duplicateItems: itemCount
  };
}

/**
 * Identity for "this duplicate group has been looked at and left alone".
 *
 * Keyed on the group's exact membership rather than on its name. Two physical
 * "HDMI Cable" units are a legitimate state, so a human needs a way to say so --
 * but keying that acknowledgement on the name alone would hide every *future*
 * duplicate of that name too. Adding a third cable, or archiving one of the two,
 * changes the signature and brings the group back for a fresh decision.
 */
function _dedupSignature(items) {
  return items.map((it) => it.id).sort((a, b) => a - b).join(",");
}

/**
 * The duplicate groups a human should still be shown: unacknowledged, and not
 * silently acknowledged by a stale signature.
 */
async function findUnreviewedDuplicates() {
  const { duplicates, scanned, itemCount } = await findDuplicateItems();
  const settings = await getSettings();
  const seen = settings.dedupAcknowledged && typeof settings.dedupAcknowledged === "object"
    ? settings.dedupAcknowledged
    : {};
  const pending = duplicates.filter((group) => {
    const nameKey = (group[0].nameLower || group[0].name || "").trim().toLowerCase();
    return seen[nameKey] !== _dedupSignature(group);
  });
  return {
    groups: pending,
    scanned,
    itemCount: pending.reduce((n, g) => n + g.length, 0),
    // Counts across *all* groups, acknowledged or not, so the banner can say
    // "you have already looked at the rest" rather than hiding the work.
    totalGroups: duplicates.length
  };
}

/** Record a group as known-and-fine, or clear that record when `signature` is null. */
async function setDedupAcknowledged(nameKey, signature) {
  const settings = await getSettings();
  const map = Object.assign({}, settings.dedupAcknowledged || {});
  if (signature == null) delete map[nameKey];
  else map[nameKey] = signature;
  await updateSettings({
    dedupAcknowledged: map
  });
  return map;
}

/**
 * How many members of each duplicate group are physically out right now.
 *
 * `mergeItems` refuses when two entries are both checked out (you would end up
 * with one item carrying two open loans), so the review screen needs to know
 * this *before* offering the merge, not as an error thrown afterwards. One pass
 * over the open loans rather than one query per item.
 */
async function _openCountsByItem() {
  const openLoans = await getOpenLoans();
  const counts = /* @__PURE__ */ new Map();
  for (const loan of openLoans) {
    counts.set(loan.itemId, (counts.get(loan.itemId) || 0) + 1);
  }
  return counts;
}
async function getRequests({ status } = {}) {
  await openDB();
  if (status) {
    return getAllByIndex("requests", "status", status);
  }
  return getAll("requests");
}
async function fulfillRequest(requestId, { itemId, loanId } = {}) {
  await openDB();
  const tx2 = _db.transaction("requests", "readwrite");
  const store = tx2.objectStore("requests");
  return new Promise((resolve, reject) => {
    const getReq = store.get(requestId);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) {
        reject(new Error(`Request ${requestId} not found`));
        return;
      }
      rec.status = "fulfilled";
      rec.fulfilledAt = Date.now();
      if (itemId != null) rec.fulfilledItemId = itemId;
      if (loanId != null) rec.fulfilledLoanId = loanId;
      const putReq = store.put(rec);
      putReq.onsuccess = () => resolve(rec);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
    tx2.onerror = () => reject(tx2.error);
  });
}
async function cancelRequest(requestId) {
  await openDB();
  const tx2 = _db.transaction("requests", "readwrite");
  const store = tx2.objectStore("requests");
  return new Promise((resolve, reject) => {
    const getReq = store.get(requestId);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) {
        reject(new Error(`Request ${requestId} not found`));
        return;
      }
      rec.status = "cancelled";
      rec.cancelledAt = Date.now();
      const putReq = store.put(rec);
      putReq.onsuccess = () => resolve(rec);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
    tx2.onerror = () => reject(tx2.error);
  });
}
async function exportAll({ includeSecrets = false } = {}) {
  await openDB();
  const [items, borrowers, loans, settings, requests] = await Promise.all([
    getAll("items"),
    getAll("borrowers"),
    getAll("loans"),
    getAll("settings"),
    getAll("requests")
  ]);
  const safeSettings = (settings || []).map((record) => {
    if (includeSecrets) return record;
    const { pin, ...rest } = record;
    return {
      ...rest,
      pinOmitted: true
    };
  });
  return {
    items,
    borrowers,
    loans,
    settings: safeSettings,
    requests: requests || [],
    exportedAt: Date.now(),
    schemaVersion: DB_VERSION
  };
}
function validateImportRecord(storeName, record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return `a "${storeName}" entry is not an object`;
  }
  if (storeName === "settings") {
    return record.id === 1 ? null : `a "settings" entry has id ${JSON.stringify(record.id)}, expected 1`;
  }
  if (!Number.isInteger(record.id)) {
    return `a "${storeName}" entry is missing a numeric id`;
  }
  return null;
}
async function importAll(data, { mode = "replace", restoreSettings = true } = {}) {
  await openDB();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("That file is not a Front Desk backup.");
  }
  const problems = [];
  for (const storeName of STORES) {
    const records = data[storeName];
    if (records == null) continue;
    if (!Array.isArray(records)) {
      problems.push(`"${storeName}" is not a list`);
      continue;
    }
    for (const record of records) {
      const problem = validateImportRecord(storeName, record);
      if (problem) {
        problems.push(problem);
        break;
      }
    }
  }
  if (problems.length) {
    throw new Error(`Backup failed validation (${problems.join("; ")}). Nothing was changed.`);
  }
  return runTx(STORES, "readwrite", async (s) => {
    for (const storeName of STORES) {
      const records = data[storeName];
      if (records == null) continue;
      const store = s.get(storeName);
      if (storeName === "settings") {
        if (!restoreSettings) continue;
        const current = await s.req(store.get(1));
        const incoming = records.find((r) => r && r.id === 1);
        if (!incoming) continue;
        await s.req(store.put(Object.assign({}, incoming, {
          id: 1,
          // A backup file is not a credential. Importing one used to reset the
          // admin PIN to the factory default; the device's own PIN stays in force.
          pin: current && current.pin ? current.pin : incoming.pin || "1234"
        })));
        continue;
      }
      if (mode === "replace") {
        await s.req(store.clear());
      }
      for (const record of records) {
        if (mode === "merge") {
          const existing = await s.req(store.get(record.id));
          if (existing) continue;
        }
        await s.req(store.put(record));
      }
    }
  });
}
var DB_NAME, DB_VERSION, STORES, _db;
var init_db = __esm({
  "../frontdesk/modules/db.js"() {
    DB_NAME = "frontdesk";
    DB_VERSION = 3;
    STORES = [
      "items",
      "borrowers",
      "loans",
      "settings",
      "requests"
    ];
    _db = null;
  }
});

// ../frontdesk/modules/ui.js
var ui_exports = {};
__export(ui_exports, {
  animateSuccess: () => animateSuccess,
  closeDialog: () => closeDialog,
  confirm: () => confirmDialog,
  drawCheckmark: () => drawCheckmark,
  formatAbsoluteTime: () => formatAbsoluteTime,
  formatDueLabel: () => formatDueLabel,
  formatDueTime: () => formatDueTime,
  formatRelativeTime: () => formatRelativeTime,
  formatTimeAgo: () => formatTimeAgo,
  hideDialog: () => hideDialog,
  hideToast: () => hideToast,
  playSound: () => playSound,
  prompt: () => prompt,
  pulse: () => pulse,
  sentenceCase: () => sentenceCase,
  showDialog: () => showDialog,
  showError: () => showError,
  showInfo: () => showInfo,
  showSuccess: () => showSuccess,
  showToast: () => showToast,
  showUndo: () => showUndo,
  showUndoToast: () => showUndoToast,
  slideIn: () => slideIn,
  vibrate: () => vibrate
});
/**
 * Live toasts, keyed by type+message, oldest first.
 *
 * Tapping CONTINUE five times on a bad phone number used to stack five
 * identical 400px toasts over the middle of the form, hiding the very field
 * that needed fixing. A repeated message now refreshes the toast that is
 * already there -- which also reads as acknowledgement, because the toast
 * stays up longer -- and only the newest few are ever on screen.
 */
const _liveToasts = new Map();
const TOAST_MAX = 3;
function _toastKey(message, type) {
  return type + "\u0000" + message;
}
function _forgetToast(toast) {
  for (const [key, entry] of _liveToasts) {
    if (entry.toast === toast) {
      if (entry.timer) clearTimeout(entry.timer);
      _liveToasts.delete(key);
      return;
    }
  }
}
function _evictOldestToast(exceptKey) {
  for (const [key, entry] of _liveToasts) {
    if (key === exceptKey) continue;
    dismissToast(entry.toast);
    // dismissing normally clears the entry, but a toast that was already
    // detached from the DOM returns early -- deleting here as well is what
    // guarantees the caller's eviction loop makes progress.
    _liveToasts.delete(key);
    return;
  }
}
function showToast(message, opts = {}) {
  const { type = "info", duration = type === "undo" ? 5e3 : 3e3, action = null } = opts;
  const container = document.getElementById("toast");
  if (!container) {
    console.warn("showToast: no #toast container in DOM");
    return null;
  }
  const key = _toastKey(message, type);
  const existing = _liveToasts.get(key);
  if (existing && existing.toast.parentNode) {
    // Same message again: keep the one on screen, restart its clock.
    if (existing.timer) clearTimeout(existing.timer);
    existing.timer = duration > 0 ? setTimeout(() => dismissToast(existing.toast), duration) : null;
    return existing.toast;
  }
  while (_liveToasts.size >= TOAST_MAX) _evictOldestToast(key);
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = message;
  toast.appendChild(text);
  if (action && action.label) {
    const btn = document.createElement("button");
    btn.className = "toast-undo-btn";
    btn.type = "button";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      try {
        action.onClick && action.onClick();
      } finally {
        dismissToast(toast);
      }
    });
    toast.appendChild(btn);
  }
  container.appendChild(toast);
  // Deferred so the toast's own transition runs on the frame after it is
  // attached. Guarded, for the same reason the dialog is: a toast can be
  // dismissed in a later task but before this frame -- the undo button, a
  // re-show of the same message, an eviction at the cap -- and _liveToasts is
  // what "still a toast" means. Without the check a dropped toast was made
  // visible again on the way out, and a .toast carries pointer-events: auto, so
  // it also swallowed a tap landing where it sat.
  requestAnimationFrame(() => {
    let live = false;
    for (const entry of _liveToasts.values()) {
      if (entry.toast === toast) {
        live = true;
        break;
      }
    }
    if (live) toast.classList.add("show");
  });
  const timer = duration > 0 ? setTimeout(() => dismissToast(toast), duration) : null;
  _liveToasts.set(key, {
    toast,
    timer
  });
  return toast;
}
function dismissToast(toast) {
  if (!toast) return;
  // Before the parentNode check: a toast that was already taken out of the DOM
  // still has to give up its slot in _liveToasts, or the same message could
  // never be shown again and the cap would count a toast nobody can see.
  _forgetToast(toast);
  if (!toast.parentNode) return;
  toast.classList.remove("show");
  const cleanup = () => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  };
  toast.addEventListener("transitionend", cleanup, {
    once: true
  });
  setTimeout(cleanup, 600);
}
function showSuccess(message) {
  return showToast(message, {
    type: "success"
  });
}
function showError(message) {
  return showToast(message, {
    type: "error"
  });
}
function showInfo(message) {
  return showToast(message, {
    type: "info"
  });
}
function showUndo(message, onUndo) {
  return showToast(message, {
    type: "undo",
    action: {
      label: "Undo",
      onClick: onUndo
    }
  });
}
function showDialogImpl(opts) {
  const { title = "", body = "", buttons = [], dismissible = true } = opts;
  const container = document.getElementById("dialog");
  if (!container) {
    console.warn("showDialog: no #dialog container in DOM");
    return {
      close: () => {
      },
      onClose: () => {
      }
    };
  }
  const closeCallbacks = [];
  let closed = false;
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  const card = document.createElement("div");
  card.className = "dialog-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  if (title) card.setAttribute("aria-label", title);
  if (title) {
    const h = document.createElement("h2");
    h.className = "dialog-title";
    h.textContent = title;
    card.appendChild(h);
  }
  const bodyDiv = document.createElement("div");
  bodyDiv.className = "dialog-body";
  if (typeof body === "string") {
    bodyDiv.innerHTML = body;
  } else if (body instanceof HTMLElement) {
    bodyDiv.appendChild(body);
  }
  card.appendChild(bodyDiv);
  if (buttons.length > 0) {
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      if (b.primary) btn.classList.add("btn-primary");
      else if (b.danger) btn.classList.add("btn-danger");
      else btn.classList.add("btn-secondary");
      btn.textContent = b.label;
      btn.addEventListener("click", () => {
        try {
          b.onClick && b.onClick();
        } finally {
          close();
        }
      });
      actions.appendChild(btn);
    }
    card.appendChild(actions);
  }
  container.innerHTML = "";
  container.appendChild(backdrop);
  container.appendChild(card);
  container.classList.remove("hidden");
  // The frame deferral is what lets the opacity transition run (removing
  // `hidden` and adding `show` in one task would paint both at once and the
  // dialog would appear with no fade). But it must not outlive the dialog: if
  // close() lands before this frame -- an Escape, a backdrop tap, or any
  // programmatic close within ~16ms of opening, and far longer whenever rAF is
  // throttled because the window is minimised -- the callback was still adding
  // `show` to a container that cleanup had already emptied and marked `hidden`.
  // `.hidden` does not win on that element (same specificity as
  // `.dialog-container`, which is declared later), so the leftover `show` made
  // an empty full-screen overlay with pointer-events:auto: an invisible shield
  // that silently ate every tap until the next dialog happened to open.
  requestAnimationFrame(() => {
    if (!closed) container.classList.add("show");
  });
  // Ownership token for the shared #dialog container. A dialog's teardown is
  // scheduled 400ms after close (and again on transitionend), which is long
  // enough for the awaiting caller to open the NEXT dialog in the same
  // container -- the teardown then blanked it, so a two-step prompt like
  // "pick a borrower" -> "confirm merge" silently lost its second dialog and
  // hung forever. Only tear down if this dialog still owns the container.
  const generation = (Number(container.dataset.dialogGeneration) || 0) + 1;
  container.dataset.dialogGeneration = String(generation);
  // Focus. The card carries role="dialog" and aria-modal="true", but nothing
  // moved focus into it: the input that opened the dialog kept DOM focus behind
  // the backdrop, so typing -- including every key on the on-screen keyboard --
  // went to the screen underneath the dialog. Take focus in, keep Tab inside,
  // and hand it back to whatever had it when the dialog closes.
  const previouslyFocused = document.activeElement;
  card.tabIndex = -1;
  const focusableIn = () => Array.from(
    card.querySelectorAll('button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
  setTimeout(() => {
    if (closed) return;
    const preferred = card.querySelector('.dialog-body input:not([type="hidden"]), .dialog-body select, .dialog-body textarea');
    const target = preferred || focusableIn()[0] || card;
    try {
      target.focus();
    } catch (_) {
    }
  }, 30);
  function close() {
    if (closed) return;
    closed = true;
    container.classList.remove("show");
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (Number(container.dataset.dialogGeneration) === generation) {
        container.innerHTML = "";
        // Belt to the guard above's braces: whatever else happens, a container
        // this dialog has finished with must never be left in the blocking
        // state. Ownership of the visual state is one class, dropped here.
        container.classList.remove("show");
        container.classList.add("hidden");
      }
      document.removeEventListener("keydown", onKey);
      // Only if it is still on the page: the dialog may have navigated away.
      if (previouslyFocused && typeof previouslyFocused.focus === "function" && document.contains(previouslyFocused)) {
        try {
          previouslyFocused.focus();
        } catch (_) {
        }
      }
      for (const cb of closeCallbacks) {
        try {
          cb();
        } catch (_) {
        }
      }
    };
    container.addEventListener("transitionend", cleanup, {
      once: true
    });
    setTimeout(cleanup, 400);
  }
  if (dismissible) {
    backdrop.addEventListener("click", close);
  }
  const onKey = (e) => {
    if (e.key === "Escape" && dismissible) {
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusableIn();
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = card.contains(active);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", onKey);
  return {
    close,
    onClose(cb) {
      if (typeof cb === "function") closeCallbacks.push(cb);
    }
  };
}
function closeDialog() {
  const container = document.getElementById("dialog");
  if (!container) return;
  if (container.classList.contains("hidden")) return;
  container.classList.remove("show");
  setTimeout(() => {
    container.innerHTML = "";
    container.classList.add("hidden");
  }, 250);
}
// A confirm2() used to live here, built against the same button shape that
// prompt() used (onClick/primary). It had no callers, and showDialog would never
// have settled its promise -- use confirmDialog() below, which resolves.
/**
 * Yes/no confirmation, resolving false on cancel, Escape or a backdrop tap.
 *
 * Replaces a bare `confirm(...)`: the native dialog blocks the whole webview, is
 * unstyled, and in this app is impossible to tell apart from a browser alert.
 * showDialog always permits a backdrop dismiss (its `dismissible` option is not
 * read), so there is deliberately no sticky variant here -- a destructive action
 * that must not be brushed off needs an inline panel, as the kiosk does.
 */
function confirmDialog(message, { title = "Confirm", danger = false, confirmLabel = "", cancelLabel = "Cancel" } = {}) {
  return showDialog({
    title,
    body: `<p class="dialog-message">${escapeHtml2(message)}</p>`,
    buttons: [
      {
        label: cancelLabel,
        value: false,
        variant: "ghost"
      },
      {
        label: confirmLabel || (danger ? "Delete" : "OK"),
        value: true,
        variant: danger ? "danger" : "primary"
      }
    ]
  }).then((v) => !!v);
}
function prompt(message, { title = "Enter", defaultValue = "", placeholder = "", type = "text" } = {}) {
  const wrap = document.createElement("div");
  const label = document.createElement("p");
  label.className = "dialog-message";
  label.textContent = message;
  wrap.appendChild(label);
  const input = document.createElement("input");
  input.className = "input input-lg";
  input.type = type;
  input.value = defaultValue;
  input.placeholder = placeholder;
  wrap.appendChild(input);
  requestAnimationFrame(() => {
    // Defensive, unlike the guards above: showDialog's own 30ms timer does the
    // real focus and already checks `closed`, so this frame is the earlier of
    // two attempts. If the dialog was torn down before it ran, the input is
    // detached and focusing it would do nothing -- but on a stale container it
    // would pull focus into a dialog on its way out, and focusin is what opens
    // the on-screen keyboard.
    if (!input.isConnected) return;
    input.focus();
    input.select();
  });
  // showDialog settles with the pressed button's `value`, and reads neither
  // `onClick` nor `primary` off a button. This used to pass both, so the promise
  // here never settled: the dialog appeared, and every caller hung on it forever
  // without an error. Read the field back in the continuation instead.
  return showDialog({
    title,
    body: wrap,
    buttons: [
      {
        label: "Cancel",
        value: false,
        variant: "ghost"
      },
      {
        label: "OK",
        value: true,
        variant: "primary"
      }
    ]
  }).then((ok) => ok ? input.value || null : null);
}
function pulse(element, duration = 2e3) {
  if (!element) return;
  if (prefersReducedMotion()) return;
  element.classList.add("pulsing");
  setTimeout(() => element.classList.remove("pulsing"), duration);
}
function drawCheckmark(svgElement) {
  if (!svgElement) return;
  if (prefersReducedMotion()) return;
  const path = svgElement.querySelector("path.checkmark-stroke") || svgElement.querySelector("path");
  if (!path) return;
  let length = 0;
  try {
    length = path.getTotalLength();
  } catch (_) {
    return;
  }
  if (!length || !isFinite(length)) return;
  path.style.strokeDasharray = String(length);
  path.style.strokeDashoffset = String(length);
  path.style.animation = "checkmark-draw 400ms var(--ease-out) forwards";
}
function slideIn(element, direction = "right") {
  if (!element) return;
  if (prefersReducedMotion()) return;
  const classMap = {
    left: "slide-in-left",
    right: "slide-in-right",
    up: "slide-in-up"
  };
  const cls = classMap[direction] || classMap.right;
  element.classList.add(cls);
  const cleanup = () => element.classList.remove(cls);
  element.addEventListener("animationend", cleanup, {
    once: true
  });
  setTimeout(cleanup, 600);
}
function vibrate(pattern = [
  10
]) {
  if (typeof navigator === "undefined") return;
  if (navigator.vibrate) {
    try {
      navigator.vibrate(pattern);
    } catch (_) {
    }
  }
}
function formatTimeAgo(timestamp) {
  if (!timestamp) return "";
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 0) {
    return formatAbsolute(timestamp);
  }
  const sec = Math.floor(diff / 1e3);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return formatAbsolute(timestamp);
}
function formatAbsolute(timestamp) {
  const d = new Date(timestamp);
  const sameYear = d.getFullYear() === (/* @__PURE__ */ new Date()).getFullYear();
  return sameYear ? `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}` : `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
function formatDueTime(timestamp) {
  if (!timestamp) return {
    label: "\u2014",
    severity: "normal"
  };
  const now = Date.now();
  const diff = timestamp - now;
  const d = new Date(timestamp);
  if (diff < 0) {
    const overdueMs = -diff;
    const min2 = Math.floor(overdueMs / 6e4);
    const hr2 = Math.floor(min2 / 60);
    const day = Math.floor(hr2 / 24);
    let label;
    if (min2 < 1) label = "just overdue";
    else if (min2 < 60) label = `${min2}m overdue`;
    else if (hr2 < 24) label = `${hr2}h overdue`;
    else label = `${day}d overdue`;
    return {
      label,
      severity: "overdue"
    };
  }
  const min = Math.floor(diff / 6e4);
  if (min < 60) {
    return {
      label: `in ${min}m`,
      severity: "soon"
    };
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return {
      label: `in ${hr}h`,
      severity: hr <= 2 ? "soon" : "normal"
    };
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.getDate() === tomorrow.getDate() && d.getMonth() === tomorrow.getMonth()) {
    const h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? "pm" : "am";
    const h12 = h % 12 || 12;
    const label = m === 0 ? `tomorrow ${h12}${ampm}` : `tomorrow ${h12}:${String(m).padStart(2, "0")}${ampm}`;
    return {
      label,
      severity: "normal"
    };
  }
  return {
    label: formatAbsolute(timestamp),
    severity: "normal"
  };
}
function playSound(name) {
  if (typeof window === "undefined") return;
  const enabled = typeof window.__SOUND_ON__ === "boolean" ? window.__SOUND_ON__ : false;
  if (!enabled) return;
  if (typeof window.AudioContext === "undefined" && typeof window.webkitAudioContext === "undefined") return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  try {
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const recipes = {
      success: [
        {
          f: 660,
          dur: 0.08
        },
        {
          f: 880,
          dur: 0.12
        }
      ],
      error: [
        {
          f: 220,
          dur: 0.18
        }
      ],
      click: [
        {
          f: 1e3,
          dur: 0.04
        }
      ],
      undo: [
        {
          f: 440,
          dur: 0.1
        },
        {
          f: 330,
          dur: 0.1
        }
      ]
    };
    const seq = recipes[name] || recipes.click;
    let t = ctx.currentTime;
    for (const note of seq) {
      osc.frequency.setValueAtTime(note.f, t);
      gain.gain.setValueAtTime(1e-4, t);
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(1e-4, t + note.dur);
      t += note.dur;
    }
    osc.start(ctx.currentTime);
    osc.stop(t + 0.05);
  } catch (_) {
  }
}
function hideToast(toast) {
  if (!toast) return;
  _forgetToast(toast);
  toast.classList.remove("show");
  setTimeout(() => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, 300);
}
function hideDialog() {
  return closeDialog();
}
function showUndoToast(message, onUndo, opts = {}) {
  return showToast(message, {
    type: "undo",
    action: {
      label: "UNDO",
      onClick: onUndo
    },
    duration: opts.duration ?? 5e3
  });
}
function animateSuccess(el) {
  return pulse(el);
}
function showDialog(opts) {
  const { title, body, buttons = [] } = opts;
  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (v) => {
      if (!resolved) {
        resolved = true;
        resolve(v);
      }
    };
    const adapted = buttons.map((b) => ({
      label: b.label,
      primary: b.variant === "primary",
      danger: b.variant === "danger",
      onClick: () => {
        safeResolve(b.value);
      }
    }));
    const dlg = showDialogImpl({
      title,
      body,
      buttons: adapted,
      dismissible: true
    });
    dlg.onClose(() => safeResolve(void 0));
  });
}
function formatRelativeTime(ms) {
  if (ms == null) return "\u2014";
  const abs = Math.abs(ms);
  if (abs < 6e4) return "just now";
  const totalMin = Math.round(abs / 6e4);
  if (totalMin < 60) return `${totalMin}m`;
  const totalH = Math.round(totalMin / 60);
  if (totalH < 48) return `${totalH}h`;
  const totalD = Math.round(totalH / 24);
  return `${totalD}d`;
}
/**
 * formatRelativeTime already returns the bare words "just now" for anything
 * under a minute, so the many call sites that append " ago" produced "just now
 * ago" on every freshly-created loan. Use this wherever the sentence wants an
 * " ago" suffix.
 */
function agoLabel(ms) {
  const rel = formatRelativeTime(ms);
  return rel === "just now" || rel === "—" ? rel : rel + " ago";
}
function formatAbsoluteTime(ms) {
  if (ms == null) return "\u2014";
  return formatTimeAgo(ms) + " (" + new Date(ms).toLocaleString() + ")";
}
function formatDueLabel(ts) {
  if (ts == null) return "No due time";
  const r = formatDueTime(ts);
  return r.label;
}
function sentenceCase(s) {
  if (typeof s !== "string") return s;
  const t = s.trim().replace(/\s+/g, " ");
  if (!t) return t;
  return t.toLowerCase().split(" ").map((w) => w.length ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}
var prefersReducedMotion, MONTHS_SHORT;
var init_ui = __esm({
  "../frontdesk/modules/ui.js"() {
    prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    MONTHS_SHORT = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec"
    ];
  }
});

// ../frontdesk/modules/search.js
function normalize(text) {
  if (text == null) return "";
  return String(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
}
function isWordBoundary(s, i) {
  if (i === 0) return true;
  const prev = s[i - 1];
  return prev === " " || prev === "-" || prev === "_" || prev === "/" || prev === ".";
}
function scoreMatch(q, c) {
  if (!q) return 0;
  if (!c) return 0;
  if (q === c) return 1e3;
  if (c.startsWith(q)) return 500;
  const subIdx = c.indexOf(q);
  if (subIdx !== -1) {
    return isWordBoundary(c, subIdx) ? 300 : 100;
  }
  const fuzzy = fuzzyMatch(q, c);
  if (fuzzy.matched) {
    let score = 50;
    if (fuzzy.allWordBoundary) score += 20;
    score -= fuzzy.mismatchPenalty;
    return score;
  }
  return 0;
}
function fuzzyMatch(q, c) {
  let qi = 0;
  let lastBoundary = true;
  let allBoundary = true;
  let penalty = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      const atBoundary = isWordBoundary(c, ci);
      if (!atBoundary) allBoundary = false;
      lastBoundary = atBoundary;
      qi++;
    } else {
      const stripped = c[ci].normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (stripped === q[qi]) {
        penalty += 10;
        const atBoundary = isWordBoundary(c, ci);
        if (!atBoundary) allBoundary = false;
        lastBoundary = atBoundary;
        qi++;
      }
    }
  }
  return {
    matched: qi === q.length,
    allWordBoundary: allBoundary && lastBoundary,
    mismatchPenalty: penalty
  };
}
async function searchItems(query, { limit = 30 } = {}) {
  const all = await listItems({
    includeArchived: false
  });
  const q = normalize(query);
  if (!q) {
    return all.sort((a, b) => (b.timesCheckedOut || 0) - (a.timesCheckedOut || 0)).slice(0, limit).map((item) => ({
      item,
      score: 0,
      matchedAs: "frequent"
    }));
  }
  const scored = [];
  for (const item of all) {
    const score = scoreMatch(q, normalize(item.name));
    if (score > 0) {
      scored.push({
        item,
        score,
        matchedAs: "name"
      });
    }
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.item.timesCheckedOut || 0) - (a.item.timesCheckedOut || 0);
  });
  return scored.slice(0, limit);
}
var init_search = __esm({
  "../frontdesk/modules/search.js"() {
    init_db();
  }
});

// ../frontdesk/modules/keyboard.js
var keyboard_exports = {};
__export(keyboard_exports, {
  OnScreenKeyboard: () => OnScreenKeyboard,
  initKeyboard: () => initKeyboard
});
function initKeyboard(container) {
  const kbd = new OnScreenKeyboard(container);
  kbd.init();
  return kbd;
}
var LAYOUTS, KEY_DISPLAY, LAYOUT_TOGGLE, DEFAULT_OPTS, OnScreenKeyboard;
var init_keyboard = __esm({
  "../frontdesk/modules/keyboard.js"() {
    LAYOUTS = {
      "numeric-phone": [
        [
          "1",
          "2",
          "3"
        ],
        [
          "4",
          "5",
          "6"
        ],
        [
          "7",
          "8",
          "9"
        ],
        [
          "clear",
          "0",
          "backspace"
        ],
        [
          "done"
        ]
      ],
      "numeric": [
        [
          "1",
          "2",
          "3"
        ],
        [
          "4",
          "5",
          "6"
        ],
        [
          "7",
          "8",
          "9"
        ],
        [
          ".",
          "-",
          "backspace"
        ]
      ],
      // Standard QWERTY. The bottom row has a 'layout-toggle' key on the left
      // that switches to the alphanumeric layout (digits added). The spacebar
      // is full-width for easy thumb-presses. The 'done' key dismisses the
      // keyboard and triggers the next action (CONTINUE on the active step).
      "alpha": [
        [
          "q",
          "w",
          "e",
          "r",
          "t",
          "y",
          "u",
          "i",
          "o",
          "p"
        ],
        [
          "a",
          "s",
          "d",
          "f",
          "g",
          "h",
          "j",
          "k",
          "l"
        ],
        [
          "shift",
          "z",
          "x",
          "c",
          "v",
          "b",
          "n",
          "m",
          "backspace"
        ],
        [
          "layout-toggle",
          "space",
          "done"
        ]
      ],
      // QWERTY + a dedicated digits row. For item names like "Key to Room 1050"
      // or "HDMI Dongle #3" — no layout switch needed mid-word.
      "alphanumeric": [
        [
          "q",
          "w",
          "e",
          "r",
          "t",
          "y",
          "u",
          "i",
          "o",
          "p"
        ],
        [
          "a",
          "s",
          "d",
          "f",
          "g",
          "h",
          "j",
          "k",
          "l"
        ],
        [
          "shift",
          "z",
          "x",
          "c",
          "v",
          "b",
          "n",
          "m",
          "backspace"
        ],
        [
          "1",
          "2",
          "3",
          "4",
          "5",
          "6",
          "7",
          "8",
          "9",
          "0"
        ],
        [
          "layout-toggle",
          "space",
          "done"
        ]
      ],
      "email": [
        [
          "1",
          "2",
          "3",
          "4",
          "5",
          "6",
          "7",
          "8",
          "9",
          "0"
        ],
        [
          "q",
          "w",
          "e",
          "r",
          "t",
          "y",
          "u",
          "i",
          "o",
          "p"
        ],
        [
          "a",
          "s",
          "d",
          "f",
          "g",
          "h",
          "j",
          "k",
          "l",
          "@"
        ],
        [
          "shift",
          "z",
          "x",
          "c",
          "v",
          "b",
          "n",
          "m",
          ".",
          "backspace"
        ],
        [
          "space"
        ]
      ]
    };
    KEY_DISPLAY = {
      backspace: "\u232B",
      clear: "CLR",
      shift: "\u21E7",
      space: "space",
      done: "Done \u2713",
      // The label is the LAYOUT you'll switch TO. In alpha layout, tap to go to alphanumeric.
      "layout-toggle": null
    };
    LAYOUT_TOGGLE = {
      alpha: "alphanumeric",
      alphanumeric: "alpha"
    };
    DEFAULT_OPTS = {
      // When tapping a key, what to do. Default: dispatch input events on the
      // currently focused element. The flow classes manage focus separately.
      onKey: null
    };
    OnScreenKeyboard = class {
      /**
       * @param {HTMLElement} container - the #keyboard element from index.html
       */
      constructor(container) {
        this.container = container;
        this.opts = {
          ...DEFAULT_OPTS
        };
        this.layout = "alpha";
        this.targetInput = null;
        this.suggestions = [];
        this.isShifted = false;
        this.bound = false;
        this._longPress = {
          timer: null,
          interval: null,
          key: null,
          didFire: false
        };
      }
      /**
       * Mount the keyboard, attach document listeners.
       */
      init() {
        if (!this.container) {
          console.warn("OnScreenKeyboard: no container element");
          return;
        }
        this._render();
        this._attachListeners();
      }
      /**
       * Show the keyboard for a specific input. Layout is auto-selected by input
       * type if not provided. Suggestions (optional) are rendered above the keys.
       * @param {string} [layout] - one of the LAYOUTS keys; auto-detected if omitted
       * @param {Object} [opts]
       * @param {HTMLElement} [opts.target] - input to type into (defaults to activeElement)
       * @param {string[]} [opts.suggestions] - word-suggestion chips
       * @param {(key: string, value: string) => void} [opts.onKey] - custom key handler
       */
      show(layout, opts = {}) {
        if (!this.container) return;
        this.targetInput = opts.target || document.activeElement;
        this.suggestions = Array.isArray(opts.suggestions) ? opts.suggestions : [];
        this.opts.onKey = opts.onKey || null;
        if (!layout) {
          layout = this._inferLayout(this.targetInput);
        }
        this.layout = LAYOUTS[layout] ? layout : "alpha";
        this.isShifted = false;
        this._render();
        this.container.classList.remove("hidden", "visible");
        this._setInert(false);
        // Deferred so the slide-in transition actually runs. Guarded by a token
        // because hide() -- or a second show() -- can land before this frame
        // does: both are only ever a task away (a [data-kbd-toggle] click, a
        // focusout plus 150ms, the Done key), and a frame delayed past them by a
        // busy main thread is enough. A stale frame would then re-show a
        // keyboard hide() had already made inert -- on screen, sliding up over
        // the entry, and dead to every tap, because inert is what hide() set.
        const showToken = this._showToken = (this._showToken || 0) + 1;
        requestAnimationFrame(() => {
          if (this._showToken !== showToken) return;
          this.container.classList.add("visible");
          const kbdHeight = this.container.offsetHeight || 360;
          // Published on the document as well as applied to the active screen's
          // body. The body padding lets a scrolling screen push its form above
          // the keyboard; this lets a screen that has no .screen-body -- the
          // PIN screen, whose card is centred in a full-height container --
          // reserve the same space in CSS. Without one of the two, the keyboard
          // simply lay on top of that card: at every size measured, LOGIN and
          // Cancel were underneath it, and a real click on either landed on a
          // keycap. The PIN screen could not be logged into or backed out of.
          document.documentElement.style.setProperty("--keyboard-height", kbdHeight + "px");
          // A marker for the stylesheet, because CSS cannot read the value of a
          // custom property. Screens that reserve space do it with the variable;
          // the PIN screen has to change its shape, and that needs a selector.
          document.documentElement.classList.add("kbd-open");
          const screen = document.querySelector(".screen:not(.hidden)");
          if (screen) {
            const body = screen.querySelector(".screen-body");
            if (body) body.style.paddingBottom = kbdHeight + "px";
          }
        });
        this._scrollTargetIntoView();
      }
      /**
       * Hide the keyboard.
       */
      hide() {
        if (!this.container) return;
        // Invalidate any show() frame still in flight, so it cannot slide the
        // keyboard back up over a screen that has already put it away.
        this._showToken = (this._showToken || 0) + 1;
        this.container.classList.remove("visible");
        this._setInert(true);
        this.suggestions = [];
        this.targetInput = null;
        this._endLongPress();
        document.documentElement.style.removeProperty("--keyboard-height");
        document.documentElement.classList.remove("kbd-open");
        const screen = document.querySelector(".screen:not(.hidden)");
        if (screen) {
          const body = screen.querySelector(".screen-body");
          if (body) body.style.paddingBottom = "";
        }
      }
      /**
       * Take the keyboard out of the tab order and the accessibility tree while
       * it is off-screen. The container is only moved by transform, so without
       * this all ~40 keys stayed focusable and Tab walked through an invisible
       * keyboard. `inert` is used rather than `visibility:hidden` because
       * visibility is inherited and animated, which kept the keys invisible for
       * the whole slide-in.
       */
      _setInert(on) {
        try {
          this.container.inert = on;
        } catch (_) {
          // Older engines: fall back to aria-hidden for the accessibility tree.
        }
        if (on) this.container.setAttribute("aria-hidden", "true");
        else this.container.removeAttribute("aria-hidden");
      }
      /**
       * Update the visible suggestion chips without re-rendering everything.
       * @param {string[]} suggestions
       */
      setSuggestions(suggestions) {
        this.suggestions = Array.isArray(suggestions) ? suggestions : [];
        this._renderSuggestions();
      }
      /**
       * Detach event listeners (e.g. on logout). Render is left in place.
       */
      detach() {
        if (!this.bound) return;
        document.removeEventListener("focusin", this._onFocusIn);
        document.removeEventListener("focusout", this._onFocusOut);
        document.removeEventListener("click", this._onDocClick);
        if (this._onContainerMouseDown) {
          this.container.removeEventListener("mousedown", this._onContainerMouseDown);
        }
        if (this._onContainerContextMenu) {
          this.container.removeEventListener("contextmenu", this._onContainerContextMenu);
        }
        this.bound = false;
      }
      // ── internals ─────────────────────────────────────────────────────────
      _inferLayout(input) {
        if (!input) return "alpha";
        const type = (input.getAttribute("type") || "").toLowerCase();
        const inputmode = (input.getAttribute("inputmode") || "").toLowerCase();
        const explicit = input.dataset.kbd;
        if (explicit && LAYOUTS[explicit]) return explicit;
        if (type === "tel" || inputmode === "tel" || inputmode === "numeric") {
          return "numeric-phone";
        }
        if (type === "email") {
          return "email";
        }
        if (type === "number") {
          return "numeric";
        }
        const haystack = (input.placeholder || input.name || input.id || "").toLowerCase();
        if (/(item|search|select)/.test(haystack)) {
          return "alphanumeric";
        }
        return "alpha";
      }
      _attachListeners() {
        if (this.bound) return;
        this._onFocusIn = (e) => {
          const t = e.target;
          if (!(t instanceof HTMLElement)) return;
          if (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA") return;
          if (t.dataset.kbd === "off") return;
          const layout = this._inferLayout(t);
          this.show(layout, {
            target: t
          });
        };
        this._onFocusOut = (e) => {
          setTimeout(() => {
            const active = document.activeElement;
            if (active instanceof HTMLElement && this.container.contains(active)) return;
            if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
            this.hide();
          }, 150);
        };
        this._onDocClick = (e) => {
          const toggleEl = e.target instanceof Element ? e.target.closest("[data-kbd-toggle]") : null;
          if (toggleEl) {
            e.preventDefault();
            this.hide();
          }
        };
        document.addEventListener("focusin", this._onFocusIn);
        document.addEventListener("focusout", this._onFocusOut);
        document.addEventListener("click", this._onDocClick);
        // Keep DOM focus on the input while the keyboard is being tapped.
        //
        // Without this, tapping a key button focused the button, which fired
        // focusout -> focusin and re-entered show(). show() rebuilds every key and
        // resets isShifted and the layout, so Shift was cancelled a frame after it
        // was tapped and the 123/ABC toggle reverted to whatever _inferLayout
        // guessed from the input. It also meant a tap in the padding between key
        // rows focused <body>, and 150ms later the keyboard hid itself mid-entry.
        //
        // preventDefault on mousedown suppresses the focus change and text
        // selection but not the :active style, so the keys still visibly depress.
        this._onContainerMouseDown = (e) => {
          if (!this.container.classList.contains("visible")) return;
          if (e.target instanceof Element && e.target.closest("input, textarea")) return;
          e.preventDefault();
        };
        this.container.addEventListener("mousedown", this._onContainerMouseDown);
        // Press-and-hold is right-click on Windows touch, so holding backspace to
        // clear popped the context menu over the keyboard at the moment the clear
        // fired. Nothing in the keyboard is worth a context menu.
        this._onContainerContextMenu = (e) => {
          if (!this.container.classList.contains("visible")) return;
          e.preventDefault();
        };
        this.container.addEventListener("contextmenu", this._onContainerContextMenu);
        this.bound = true;
      }
      _render() {
        if (!this.container) return;
        this.container.innerHTML = "";
        if (this.suggestions.length > 0) {
          const sugRow = document.createElement("div");
          sugRow.className = "kbd-suggestions";
          for (const s of this.suggestions) {
            const chip = document.createElement("button");
            chip.className = "suggestion-chip";
            chip.type = "button";
            chip.textContent = s;
            chip.onclick = (e) => {
              e.preventDefault();
              this._handleSuggestionTap(s);
            };
            sugRow.appendChild(chip);
          }
          this.container.appendChild(sugRow);
        }
        const rows = LAYOUTS[this.layout] || LAYOUTS.alpha;
        for (const row of rows) {
          const rowEl = document.createElement("div");
          rowEl.className = "kbd-row";
          for (const key of row) {
            const kbdKey = document.createElement("button");
            kbdKey.type = "button";
            kbdKey.className = "kbd";
            kbdKey.dataset.key = key;
            if (key === "space") {
              kbdKey.classList.add("space");
              kbdKey.textContent = KEY_DISPLAY.space;
            } else if (key === "layout-toggle") {
              const target = LAYOUT_TOGGLE[this.layout];
              kbdKey.classList.add("layout-toggle");
              kbdKey.textContent = target === "alphanumeric" ? "123" : "ABC";
              kbdKey.title = target === "alphanumeric" ? "Add numbers" : "Letters only";
            } else if (KEY_DISPLAY[key]) {
              if (key === "backspace" || key === "clear") {
                kbdKey.classList.add(key);
              }
              kbdKey.textContent = KEY_DISPLAY[key];
            } else {
              kbdKey.textContent = this.isShifted ? key.toUpperCase() : key;
            }
            kbdKey.onclick = (e) => {
              e.preventDefault();
              if (key === "backspace" && this._longPress.didFire) {
                this._longPress.didFire = false;
                return;
              }
              this._handleKey(key);
              // No focus restore here. It used to re-focus the input and then force
              // the caret to the end of the value -- so tapping a key to fix a typo
              // mid-string put the caret back at the end and every later tap
              // appended. _insertAtCursor/_backspace already place the caret
              // correctly, and the container's mousedown handler below stops the
              // button from stealing focus in the first place, so the input keeps
              // both focus and its own selection.
            };
            if (key === "backspace") {
              // Pointer events, not mouse + touch. On a touchscreen the
              // compatibility mousedown/mouseup pair arrives together at
              // touchend -- the finger has already lifted -- so a timer armed in
              // mousedown was armed and cancelled microseconds apart and this
              // never fired at all on a tablet. A pointerdown is issued once, at
              // the moment the finger lands, which is what the 500ms wants.
              kbdKey.addEventListener("pointerdown", (e) => {
                this._longPress.key = kbdKey;
                this._longPress.didFire = false;
                clearTimeout(this._longPress.timer);
                clearInterval(this._longPress.interval);
                this._longPress.timer = setTimeout(() => {
                  this._longPress.didFire = true;
                  const target = this.targetInput;
                  if (target) {
                    this._setValue(target, "");
                    this._longPress.interval = setInterval(() => {
                      if (this.targetInput && this.targetInput.value) {
                        this._backspace(this.targetInput);
                      } else {
                        this._endLongPress();
                      }
                    }, 30);
                  }
                }, 500);
              });
              const endPress = (e) => {
                const didLongPress = this._longPress.didFire;
                this._endLongPress();
                if (didLongPress && e) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              };
              kbdKey.addEventListener("pointerup", endPress);
              kbdKey.addEventListener("pointercancel", endPress);
              kbdKey.addEventListener("pointerleave", endPress);
            }
            rowEl.appendChild(kbdKey);
          }
          this.container.appendChild(rowEl);
        }
      }
      _renderSuggestions() {
        if (!this.container) return;
        const existing = this.container.querySelector(".kbd-suggestions");
        if (existing) existing.remove();
        if (this.suggestions.length === 0) return;
        const sugRow = document.createElement("div");
        sugRow.className = "kbd-suggestions";
        for (const s of this.suggestions) {
          const chip = document.createElement("button");
          chip.className = "suggestion-chip";
          chip.type = "button";
          chip.textContent = s;
          chip.onclick = (e) => {
            e.preventDefault();
            this._handleSuggestionTap(s);
          };
          sugRow.appendChild(chip);
        }
        this.container.insertBefore(sugRow, this.container.firstChild);
      }
      _handleKey(key) {
        if (typeof this.opts.onKey === "function") {
          const handled = this.opts.onKey(key, this._keyValue(key));
          if (handled === true) return;
        }
        const target = this.targetInput;
        if (!target || target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") return;
        if (key === "backspace") {
          this._backspace(target);
          return;
        }
        if (key === "clear") {
          this._setValue(target, "");
          return;
        }
        if (key === "shift") {
          this.isShifted = !this.isShifted;
          this._render();
          return;
        }
        if (key === "layout-toggle") {
          const target_layout = LAYOUT_TOGGLE[this.layout];
          if (target_layout) {
            this.layout = target_layout;
            this.isShifted = false;
            this._render();
          }
          return;
        }
        if (key === "space") {
          this._insertAtCursor(target, " ");
          return;
        }
        if (key === "done") {
          this.hide();
          // Scoped to the screen on show, not to the document. A document-wide
          // query for .step.active matches the checkout screen's step even
          // while checkout is hidden, so on any other screen with a field --
          // the PIN screen above all -- Done took the checkout branch, clicked
          // a Continue button nobody could see, and returned without ever
          // pressing Enter in the field the person had just typed into. The
          // keypad closed and nothing else happened: measured on the PIN
          // screen, with the correct PIN, at 1280x800 and 375x667.
          const visibleScreen = document.querySelector(".screen:not(.hidden)");
          const activeStep = visibleScreen ? visibleScreen.querySelector(".step.active") : null;
          if (activeStep) {
            const continueBtn = activeStep.querySelector(".step-continue");
            if (continueBtn && !continueBtn.disabled) {
              setTimeout(() => continueBtn.click(), 50);
            }
            return;
          }
          if (visibleScreen) {
            const focused = document.activeElement;
            if (focused && visibleScreen.contains(focused) && focused.tagName === "INPUT") {
              setTimeout(() => {
                focused.dispatchEvent(new KeyboardEvent("keydown", {
                  key: "Enter",
                  code: "Enter",
                  keyCode: 13,
                  bubbles: true,
                  cancelable: true
                }));
              }, 50);
            }
          }
          return;
        }
        const value = this.isShifted ? key.toUpperCase() : key;
        this._insertAtCursor(target, value);
        if (this.isShifted && this.layout === "alpha") {
          this.isShifted = false;
          this._render();
        }
      }
      _handleSuggestionTap(suggestion) {
        const target = this.targetInput;
        if (!target) return;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
          const current = target.value || "";
          let i = current.length;
          while (i > 0 && !/\s/.test(current[i - 1])) i--;
          const prefix = current.slice(0, i);
          const sep = i > 0 && !/\s$/.test(prefix) ? " " : "";
          const next = prefix + sep + suggestion;
          this._setValue(target, next);
        }
        if (typeof this.opts.onKey === "function") {
          this.opts.onKey("suggestion", suggestion);
        }
      }
      _keyValue(key) {
        if (key === "backspace") return "\u232B";
        if (key === "clear") return "";
        if (key === "space") return " ";
        if (key === "shift") return "\u21E7";
        if (key === "layout-toggle") {
          return LAYOUT_TOGGLE[this.layout] || "";
        }
        return this.isShifted ? key.toUpperCase() : key;
      }
      _insertAtCursor(input, text) {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        const current = input.value || "";
        const next = current.slice(0, start) + text + current.slice(end);
        this._setValue(input, next);
        const caret = start + text.length;
        try {
          input.setSelectionRange(caret, caret);
        } catch (_) {
        }
      }
      _backspace(input) {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        const current = input.value || "";
        if (start === end && start > 0) {
          const next = current.slice(0, start - 1) + current.slice(end);
          this._setValue(input, next);
          try {
            input.setSelectionRange(start - 1, start - 1);
          } catch (_) {
          }
        } else if (start !== end) {
          const next = current.slice(0, start) + current.slice(end);
          this._setValue(input, next);
          try {
            input.setSelectionRange(start, start);
          } catch (_) {
          }
        }
      }
      _endLongPress() {
        clearTimeout(this._longPress.timer);
        clearInterval(this._longPress.interval);
        this._longPress.timer = null;
        this._longPress.interval = null;
      }
      _setValue(input, value) {
        input.value = value;
        input.dispatchEvent(new Event("input", {
          bubbles: true
        }));
      }
      _scrollTargetIntoView() {
        if (!this.targetInput) return;
        const kbdHeight = this.container.getBoundingClientRect().height || 320;
        const rect = this.targetInput.getBoundingClientRect();
        const target = this.targetInput.closest(".screen") || this.targetInput.closest(".step");
        if (target) {
          const body = target.querySelector(".screen-body") || target;
          const bodyRect = body.getBoundingClientRect();
          const inputFromBodyTop = rect.top - bodyRect.top;
          const visibleBottom = bodyRect.height - kbdHeight;
          if (inputFromBodyTop > visibleBottom) {
            body.scrollTop += inputFromBodyTop - visibleBottom + 20;
          }
        }
      }
    };
  }
});

// ../frontdesk/app.js
init_db();

// ../frontdesk/modules/screens.js
init_db();
var screens = /* @__PURE__ */ new Map();
var currentScreen = "splash";
var onEnterHooks = /* @__PURE__ */ new Map();
var historyStack = [];
// Set while goBack is navigating. Without it, goBack popped the previous screen
// and then goToScreen pushed the screen being left straight back on, so Back
// never emptied the stack: Home → Checkout → Back → Checkout → Back grew it
// forever, and Back meant "the last screen I happened to visit" rather than
// "the one I came from".
var _navigatingBack = false;
var _kioskExitGranted = false;
function goToScreen(name, opts = {}) {
  // Containment. The kiosk is an unattended public surface, and it lives in the
  // same document as the staff screens -- "kiosk mode" was never a real mode, and
  // several links led straight out of it. Refuse to leave unless a deliberate
  // action (the press-and-hold on the welcome logo) has explicitly granted it.
  if (isKioskScreen(currentScreen) && !isKioskScreen(name)) {
    if (!_kioskExitGranted) {
      console.warn(`goToScreen: refused "${name}" while on kiosk screen "${currentScreen}"`);
      return null;
    }
    _kioskExitGranted = false;
  }
  const el = screens.get(name);
  if (!el) {
    console.warn(`goToScreen: unknown screen "${name}"`);
    return null;
  }
  if (!_navigatingBack && currentScreen && currentScreen !== name && currentScreen !== "splash") {
    historyStack.push(currentScreen);
  }
  // Nothing can be typed into across a screen change, so this is the one place
  // that can put the on-screen keyboard away without guessing whether somebody
  // is still typing. It used to be left to the focusout path, which is 150ms
  // plus a slide-out away, and the screen change is not.
  putKeyboardAway();
  for (const [n, otherEl] of screens) {
    if (n === name) continue;
    otherEl.classList.add("hidden");
    otherEl.classList.remove("slide-in-left", "slide-in-right");
  }
  el.classList.remove("hidden", "slide-in-left", "slide-in-right");
  if (opts.slide === "left") el.classList.add("slide-in-left");
  else if (opts.slide === "right") el.classList.add("slide-in-right");
  currentScreen = name;
  // Leaving the admin screens ends the idle-lock timer. Without this the timer
  // stayed armed after the user was already out, and could fire later and drag
  // them from an unrelated screen back to the login prompt.
  if (name !== "admin" && name !== "admin-detail") endAdminSession();
  const hook = onEnterHooks.get(name);
  if (hook) {
    try {
      const ret = hook(opts);
      if (ret && typeof ret.catch === "function") {
        ret.catch((err) => {
          console.error(`onEnter(${name}) failed:`, err);
        });
      }
    } catch (err) {
      console.error(`onEnter(${name}) threw:`, err);
    }
  }
  const body = el.querySelector(".screen-body");
  if (body) body.scrollTop = 0;
  return el;
}
function goBack(opts = {}) {
  const prev = historyStack.pop();
  _navigatingBack = true;
  try {
    goToScreen(prev || "home", {
      ...opts,
      slide: "right"
    });
  } finally {
    _navigatingBack = false;
  }
}
function getCurrentScreen() {
  return currentScreen;
}
/**
 * Put the on-screen keyboard away, wherever it is and whatever put it up.
 *
 * Every screen change calls this. The keyboard otherwise only knew how to put
 * itself away from a focusout plus 150ms, so for that window -- and then for the
 * whole slide-out, since being off-screen is a transform and not `display:none`
 * -- it sat across the bottom of the next screen at z-index 100, taking taps
 * meant for the buttons underneath. Staff logging in met this every time: the
 * PIN field's focusout is followed by a panel whose bottom edge is dead.
 *
 * A no-op before bootstrap has built the keyboard, and idempotent after, which
 * is what makes it safe to call from the one path all navigation shares.
 */
function putKeyboardAway() {
  const kbd = window.__keyboard;
  if (kbd && typeof kbd.hide === "function") kbd.hide();
}
// The kiosk is the public, unattended surface. Anything that reaches staff
// screens, the admin login, or staff-only shortcuts must be refused from here.
function isKioskScreen(name) {
  return name === "welcome" || typeof name === "string" && name.indexOf("kiosk-") === 0;
}
async function refreshHome() {
  try {
    const counts = await countLoansByStatus();
    const badge = document.querySelector(".overdue-badge");
    const countEl = document.querySelector(".overdue-count");
    if (badge && countEl) {
      badge.dataset.count = String(counts.overdue || 0);
      countEl.textContent = String(counts.overdue || 0);
    }
    const outEl = document.getElementById("home-stat-out");
    if (outEl) outEl.textContent = String(counts.out || 0);
    const overEl = document.getElementById("home-stat-overdue");
    if (overEl) overEl.textContent = String(counts.overdue || 0);
    const todayEl = document.getElementById("home-stat-today");
    if (todayEl) todayEl.textContent = String(counts.returnedToday || 0);
    const overdueChip = document.getElementById("home-overdue-chip");
    if (overdueChip) {
      overdueChip.classList.toggle("has-overdue", (counts.overdue || 0) > 0);
      overdueChip.onclick = (counts.overdue || 0) > 0 ? () => goToScreen("checkin") : null;
      overdueChip.style.cursor = (counts.overdue || 0) > 0 ? "pointer" : "default";
    }
  } catch (err) {
    console.warn("refreshHome: failed to load counts", err);
  }
}
function initHomeScreen() {
  const btnCheckout = document.querySelector("#screen-home .btn-home-primary:first-of-type");
  const btnCheckin = document.querySelector("#screen-home .btn-home-primary:nth-of-type(2)");
  const btnAdmin = document.getElementById("btn-to-admin");
  if (btnCheckout) {
    btnCheckout.onclick = null;
    btnCheckout.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("frontdesk:checkout-start"));
    });
  }
  if (btnCheckin) {
    btnCheckin.onclick = null;
    btnCheckin.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("frontdesk:checkin-start"));
    });
  }
  if (btnAdmin) {
    btnAdmin.onclick = null;
    btnAdmin.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("frontdesk:admin-start"));
    });
  }
  // Back to the public screen. The kiosk can be left for a staff screen only by
  // a deliberate grant, which is the hold gesture; going the other way is not a
  // boundary, it is putting the device back where borrowers expect it.
  const btnKiosk = document.getElementById("btn-to-kiosk");
  if (btnKiosk) {
    btnKiosk.onclick = () => goToScreen("welcome");
  }
}
function initScreens() {
  const sections = document.querySelectorAll("section.screen");
  for (const el of sections) {
    if (el.id) {
      const name = el.id.replace(/^screen-/, "");
      screens.set(name, el);
    }
  }
  bindStaticHandlers();
}
function bindStaticHandlers() {
  const inlineTargets = document.querySelectorAll('[onclick*="app.goToScreen"]');
  for (const el of inlineTargets) {
    const m = el.getAttribute("onclick")?.match(/app\.goToScreen\(['"]([^'"]+)['"]\)/);
    if (m) {
      const target = m[1];
      el.onclick = (e) => {
        e.preventDefault();
        goToScreen(target);
      };
    }
  }
  const backTargets = document.querySelectorAll('[onclick*="app.goBack"]');
  for (const el of backTargets) {
    el.onclick = (e) => {
      e.preventDefault();
      goBack();
    };
  }
  const hideDialogTargets = document.querySelectorAll('[onclick*="app.hideDialog"]');
  for (const el of hideDialogTargets) {
    el.onclick = (e) => {
      e.preventDefault();
      Promise.resolve().then(() => (init_ui(), ui_exports)).then((m) => m.hideDialog());
    };
  }
}

// ../frontdesk/modules/flows.js
init_db();

// ../frontdesk/modules/phone.js
function normalizePhone(input) {
  if (!input) return "";
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}
function formatPhone(digits) {
  const d = normalizePhone(digits);
  if (d.length === 0) return "";
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
}
function isValidPhone(input) {
  const d = normalizePhone(input);
  return d.length === 10;
}
function telUri(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized || normalized.length !== 10) return "";
  return `tel:+1${normalized}`;
}
function smsUri(phone, body) {
  const normalized = normalizePhone(phone);
  if (!normalized || normalized.length !== 10) return "";
  const baseUri = `sms:+1${normalized}`;
  if (!body) return baseUri;
  const encodedBody = encodeURIComponent(body);
  return `${baseUri}?body=${encodedBody}`;
}

// ../frontdesk/modules/flows.js
init_search();

// ../frontdesk/modules/suggestions.js
init_db();
var wordFreq = /* @__PURE__ */ new Map();
function learnWord(word) {
  if (!word) return;
  const w = String(word).trim().toLowerCase();
  if (!w) return;
  if (w.length > 40) return;
  if (!/[a-z0-9]/.test(w)) return;
  wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
}
function learnWords(words) {
  if (!Array.isArray(words)) return;
  for (const w of words) learnWord(w);
}
function tokensFromName(name) {
  if (!name) return [];
  const tokens = [];
  for (const part of String(name).split(/\s+/)) {
    const cleaned = part.trim();
    if (cleaned) tokens.push(cleaned);
    if (/[-']/.test(cleaned)) {
      for (const sub of cleaned.split(/[-']/)) {
        if (sub) tokens.push(sub);
      }
    }
  }
  return tokens;
}
function getSuggestions(prefix, n = 3) {
  const p = String(prefix || "").trim().toLowerCase();
  if (!p) return [];
  const matches = [];
  for (const [word, freq] of wordFreq) {
    if (word.startsWith(p)) {
      matches.push({
        word,
        freq
      });
    }
  }
  matches.sort((a, b) => {
    if (b.freq !== a.freq) return b.freq - a.freq;
    return a.word.localeCompare(b.word);
  });
  return matches.slice(0, n).map((m) => m.word);
}
async function getFrequentItems(n = 8) {
  const all = await listItems({
    includeArchived: false
  });
  return all.filter((item) => (item.timesCheckedOut || 0) > 0).sort((a, b) => (b.timesCheckedOut || 0) - (a.timesCheckedOut || 0)).slice(0, n);
}
async function getRecentBorrowers(n = 3) {
  const all = await listBorrowers({
    includeArchived: false
  });
  const sorted = all.filter((b) => b.lastSeenAt).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  const seenPhones = /* @__PURE__ */ new Set();
  const out = [];
  for (const b of sorted) {
    if (seenPhones.has(b.phone)) continue;
    seenPhones.add(b.phone);
    out.push(b);
    if (out.length >= n) break;
  }
  return out;
}

// ../frontdesk/modules/flows.js
init_ui();
var DRAFT_KEY = "frontdesk.draft";
var RECENT_KEY = "frontdesk.recentPhones";
var HOME_EVENT = "frontdesk:home";
var CheckoutFlow = class {
  constructor() {
    this.state = {
      step: 1,
      phone: null,
      borrower: null,
      items: [],
      dueAt: null,
      isResumed: false
    };
    this._wireOnce = false;
    this._searchDebounce = null;
  }
  // ── lifecycle ──────────────────────────────────────────────────────
  /**
   * Begin a check-out. Shows the screen, then either prompts to resume
   * a draft or starts at step 1.
   */
  async start() {
    goToScreen("checkout", {
      data: {
        flow: "checkout"
      }
    });
    this._wireDom();
    const draft = this._loadDraft();
    if (draft && draft.step >= 2 && draft.phone) {
      const resume = await showDialog({
        title: "Resume checkout?",
        body: `<p>You have a checkout in progress for <strong>${escapeHtml(formatPhone(draft.phone))}</strong>${draft.borrowerName ? ` (${escapeHtml(draft.borrowerName)})` : ""}.</p>`,
        buttons: [
          {
            label: "Resume",
            value: "resume",
            variant: "primary"
          },
          {
            label: "Discard",
            value: "discard",
            variant: "danger"
          }
        ]
      });
      if (resume === "resume") {
        const savedBorrowerId = draft.borrowerId;
        this.state = {
          ...this.state,
          ...draft,
          isResumed: true
        };
        if (savedBorrowerId != null) {
          // Restore the exact borrower that was chosen. Re-deriving from the
          // phone used to pick the wrong person when a number is shared, or
          // leave borrower null and silently book the loan as a walk-in.
          this.state.borrower = await get("borrowers", savedBorrowerId) || null;
        } else {
          // null means "walk-in" or "not resolved yet". Do not guess: a phone
          // that happens to match one borrower must not capture a walk-in.
          this.state.borrower = null;
        }
        if (Array.isArray(this.state.itemIds) && this.state.itemIds.length > 0) {
          this.state.items = [];
          for (const id of this.state.itemIds) {
            const it = await get("items", id);
            if (it) this.state.items.push(it);
          }
        }
        this._gotoStep(this.state.step);
        this._renderCurrentStep();
        return;
      }
      this._clearDraft();
    }
    this.state = {
      step: 1,
      phone: null,
      borrower: null,
      items: [],
      dueAt: null,
      isResumed: false
    };
    this._gotoStep(1);
    this._renderCurrentStep();
  }
  /**
   * Cancel the flow, discarding the draft. Returns to home.
   */
  cancel() {
    this._clearDraft();
    this.state = {
      step: 1,
      phone: null,
      borrower: null,
      items: [],
      dueAt: null,
      isResumed: false
    };
    goToScreen("home");
    refreshHome();
  }
  // ── step handlers ──────────────────────────────────────────────────
  /**
   * Handle the phone input's CONTINUE. Looks up the borrower, then jumps
   * to the appropriate next step.
   * @param {string} phone
   */
  async handlePhone(phone) {
    const normalized = normalizePhone(phone);
    if (!isValidPhone(normalized)) {
      showToast("Please enter a 10-digit phone number", {
        type: "error"
      });
      return;
    }
    this.state.phone = normalized;
    this._saveDraft();
    const matches = await findBorrowerByPhone(normalized);
    if (matches.length === 1) {
      this.state.borrower = matches[0];
      this._saveDraft();
      this._gotoStep(3);
      this._renderCurrentStep();
      return;
    }
    if (matches.length > 1) {
      const buttons = matches.map((b) => ({
        label: `${b.name}  \xB7  ${formatPhone(b.phone)}`,
        value: b,
        variant: "secondary"
      }));
      buttons.push({
        label: "Cancel",
        value: null,
        variant: "ghost",
        dismiss: true
      });
      const choice = await showDialog({
        title: "Which person?",
        body: '<p style="margin-bottom:12px; color:var(--text-secondary);">Multiple people have used this phone. Which one?</p>',
        buttons
      });
      if (choice) {
        this.state.borrower = choice;
        this._saveDraft();
        this._gotoStep(3);
        this._renderCurrentStep();
      }
      return;
    }
    this._gotoStep(2);
    this._renderCurrentStep();
  }
  /**
   * Handle the name input's CONTINUE. Creates or updates the borrower.
   * @param {string} name
   * @param {boolean} [isWalkIn=false] - true if the receptionist clicked
   *   the "Walk-in" button instead of typing a name. Treated like the
   *   legacy "?" string for backward compatibility.
   */
  async handleName(name, isWalkIn = false) {
    const trimmed = sentenceCase(String(name || "").trim());
    if (!trimmed && !isWalkIn) {
      showToast("Please enter a name", {
        type: "error"
      });
      return;
    }
    if (isWalkIn || trimmed === "?") {
      this.state.borrower = null;
      this._saveDraft();
      this._gotoStep(3);
      this._renderCurrentStep();
      return;
    }
    const nameMatches = await findBorrowersByName(trimmed);
    const otherPhoneMatches = nameMatches.filter((b) => b.phone !== this.state.phone);
    if (otherPhoneMatches.length === 1) {
      const nameMatch = otherPhoneMatches[0];
      const choice = await showDialog({
        title: "Is this you?",
        body: `<p>We found <strong>${escapeHtml(nameMatch.name)}</strong> with phone <strong>${escapeHtml(formatPhone(nameMatch.phone))}</strong>.</p><p>Is the new number yours, or are you a different person?</p>`,
        buttons: [
          {
            label: "Yes, update my number",
            value: "update",
            variant: "primary"
          },
          {
            label: "Different person",
            value: "new",
            variant: "secondary"
          }
        ]
      });
      if (choice === "update") {
        await updateBorrowerPhone(nameMatch.id, this.state.phone);
        this.state.borrower = await getBorrower(nameMatch.id);
        learnWords(tokensFromName(trimmed));
        this._saveDraft();
        this._gotoStep(3);
        this._renderCurrentStep();
        return;
      }
    } else if (otherPhoneMatches.length > 1) {
      const buttons = otherPhoneMatches.map((b) => ({
        label: `${b.name}  \xB7  ${formatPhone(b.phone)}`,
        value: b,
        variant: "secondary"
      }));
      buttons.push({
        label: "New person",
        value: "new",
        variant: "ghost"
      });
      const choice = await showDialog({
        title: "Which person?",
        body: `<p>${otherPhoneMatches.length} people named <strong>${escapeHtml(trimmed)}</strong> have different phone numbers. Which one is checking out?</p>`,
        buttons
      });
      if (choice && choice !== "new") {
        await updateBorrowerPhone(choice.id, this.state.phone);
        this.state.borrower = await getBorrower(choice.id);
        learnWords(tokensFromName(trimmed));
        this._saveDraft();
        this._gotoStep(3);
        this._renderCurrentStep();
        return;
      }
    }
    const borrower = await upsertBorrower({
      phone: this.state.phone,
      name: trimmed
    });
    borrower.phoneFormatted = formatPhone(borrower.phone);
    this.state.borrower = borrower;
    learnWords(tokensFromName(trimmed));
    this._saveDraft();
    this._gotoStep(3);
    this._renderCurrentStep();
  }
  /**
   * Toggle an item in the selection. Re-renders the items step to reflect
   * the new selection state.
   * @param {any} item
   * @param {boolean} selected
   */
  async handleItemSelect(item, selected) {
    if (selected) {
      if (!this.state.items.find((i) => i.id === item.id)) {
        this.state.items.push(item);
      }
    } else {
      this.state.items = this.state.items.filter((i) => i.id !== item.id);
    }
    this._saveDraft();
    this._renderItemsStep();
  }
  /**
   * Handle the new-item creation from the items step.
   * @param {string} name
   * @param {string} [category]
   * @param {Object} [opts]
   * @param {boolean} [opts.skipDialog] - if true and a duplicate exists,
   *   return the existing item instead of prompting. Used for the
   *   frictionless "Add to catalog" button.
   */
  async handleNewItem(name, category = "Other", opts = {}) {
    const trimmed = sentenceCase(String(name || "").trim());
    if (!trimmed) {
      showToast("Please enter an item name", {
        type: "error"
      });
      return null;
    }
    const existing = await findItemByName(trimmed);
    if (existing) {
      if (opts.skipDialog) {
        return existing;
      }
      const choice = await showDialog({
        title: "Item already exists",
        body: `<p>An item named <strong>${escapeHtml(existing.name)}</strong> already exists (${existing.timesCheckedOut || 0} check-outs).</p><p>Add another with the same name?</p>`,
        buttons: [
          {
            label: "Use existing",
            value: "existing",
            variant: "primary"
          },
          {
            label: "Add new anyway",
            value: "new",
            variant: "secondary"
          },
          {
            label: "Cancel",
            value: null,
            variant: "ghost"
          }
        ]
      });
      if (choice === "existing") return existing;
      if (choice !== "new") return null;
    }
    const created = await createItem({
      name: trimmed,
      category
    });
    return created;
  }
  /**
   * Commit all selected items as loans. Shows success toast with Undo,
   * saves recent-phone entry, returns to home.
   */
  async handleConfirm() {
    if (this.state.items.length === 0) {
      showToast("Pick at least one item to check out", {
        type: "error"
      });
      return;
    }
    const settings = await getSettings();
    const dueAt = Date.now() + (settings.defaultLoanHours || 8) * 3600 * 1e3;
    const created = [];
    const errors = [];
    const alreadyOut = [];
    const toCheckOut = [];
    for (const item of this.state.items) {
      const open = await getOpenLoanForItem(item.id);
      if (open) {
        alreadyOut.push({
          item,
          open
        });
      } else {
        toCheckOut.push(item);
      }
    }
    if (alreadyOut.length > 0) {
      const lines = alreadyOut.map(({ item, open }) => {
        const taker = open.borrowerNameSnapshot || "someone";
        return `${item.name} \u2014 already out to ${taker}`;
      }).join("\n");
      showToast(`${alreadyOut.length} item(s) already out: ${lines}`, {
        type: "error",
        duration: 5e3
      });
      if (toCheckOut.length === 0) return;
    }
    for (const item of toCheckOut) {
      try {
        const loan = await createLoan({
          itemId: item.id,
          borrowerId: this.state.borrower ? this.state.borrower.id : null,
          checkedOutAt: Date.now(),
          dueAt,
          conditionOut: "good"
        });
        created.push({
          loan,
          item
        });
        learnWords([
          item.name
        ]);
      } catch (err) {
        console.error("createLoan failed for", item.name, err);
        errors.push({
          item,
          error: err
        });
      }
    }
    if (created.length === 0) {
      showToast("Checkout failed: " + (errors[0]?.error?.message || "unknown error"), {
        type: "error"
      });
      return;
    }
    if (this.state.borrower && this.state.phone) {
      this._addRecentPhone({
        phone: this.state.phone,
        name: this.state.borrower.name,
        ts: Date.now()
      });
    }
    const undo = async () => {
      try {
        const result = await undoLoansAtomic(created.map((c) => c.loan));
        if (result.errors && result.errors.length > 0) {
          console.warn("undo: partial errors", result.errors);
        }
        showToast("Checkout undone", {
          type: "info",
          duration: 2e3
        });
      } catch (err) {
        console.error("undo: failed to clean up loans", err);
        showToast("Undo failed: " + (err.message || "unknown error"), {
          type: "error"
        });
      }
      window.dispatchEvent(new CustomEvent(HOME_EVENT));
    };
    const summary = created.length === 1 ? `Checked out: ${created[0].item.name}` : `Checked out ${created.length} items`;
    showUndoToast(summary, undo, {
      duration: 5e3
    });
    if (errors.length > 0) {
      showToast(`${errors.length} item(s) failed \u2014 see console`, {
        type: "error",
        duration: 4e3
      });
    }
    const root = document.getElementById("screen-checkout");
    const printBtn = root?.querySelector(".btn-print-receipt");
    if (printBtn?.dataset?.on === "1") {
      try {
        this._printReceipt(created, this.state.borrower, this.state.phone, dueAt);
      } catch (e) {
        console.warn("print receipt failed:", e);
      }
    }
    this._clearDraft();
    this.state = {
      step: 1,
      phone: null,
      borrower: null,
      items: [],
      dueAt: null,
      isResumed: false
    };
    goToScreen("home");
    refreshHome();
  }
  /**
   * Build a small printable receipt for the just-completed checkout and
   * trigger the browser print dialog. The receipt is rendered into the
   * hidden #print-receipt div, then @media print stylesheet hides the
   * rest of the UI when window.print() is called.
   * @param {Array<{loan, item}>} created
   * @param {object|null} borrower
   * @param {string} phone
   * @param {number} dueAt
   */
  _printReceipt(created, borrower, phone, dueAt) {
    const target = document.getElementById("print-receipt");
    if (!target) return;
    const name = borrower?.name || "(walk-in)";
    const phoneFmt = phone ? formatPhone(phone) : "";
    const dueStr = new Date(dueAt).toLocaleString();
    const now = (/* @__PURE__ */ new Date()).toLocaleString();
    const itemsHtml = created.map((c) => `<div class="receipt-item">${escapeHtml(c.item.name)}</div>`).join("");
    target.innerHTML = `
      <div class="print-receipt-content">
        <div class="receipt-title">FRONT DESK LOAN RECEIPT</div>
        <div class="receipt-row"><span class="label">Borrower</span><span>${escapeHtml(name)}</span></div>
        <div class="receipt-row"><span class="label">Phone</span><span>${escapeHtml(phoneFmt)}</span></div>
        <div class="receipt-row"><span class="label">Checked out</span><span>${escapeHtml(now)}</span></div>
        <div class="receipt-row"><span class="label">Due back</span><span>${escapeHtml(dueStr)}</span></div>
        <div style="margin-top:10px;font-weight:700;">Items:</div>
        ${itemsHtml}
        <div class="receipt-footer">
          Please return by the due date above. Bring this slip when returning.
        </div>
      </div>
    `;
    setTimeout(() => {
      window.print();
      setTimeout(() => {
        target.innerHTML = "";
      }, 1e3);
    }, 100);
  }
  // ── DOM wiring ─────────────────────────────────────────────────────
  /**
   * One-time wiring of the static elements inside #screen-checkout.
   */
  _wireDom() {
    if (this._wireOnce) return;
    const root = document.getElementById("screen-checkout");
    if (!root) return;
    const phoneInput = root.querySelector(".step-phone .input");
    const phoneContinue = root.querySelector(".step-phone .step-continue");
    if (phoneInput) {
      phoneInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.handlePhone(phoneInput.value);
      });
    }
    if (phoneContinue) {
      phoneContinue.onclick = () => this.handlePhone(phoneInput?.value || "");
    }
    const nameInput = root.querySelector(".step-name .input");
    const nameContinue = root.querySelector(".step-name .step-continue");
    if (nameInput) {
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.handleName(nameInput.value);
      });
    }
    if (nameContinue) {
      nameContinue.onclick = () => this.handleName(nameInput?.value || "");
    }
    const itemsSearch = root.querySelector(".step-items .search-input");
    if (itemsSearch) {
      itemsSearch.addEventListener("input", (e) => {
        clearTimeout(this._searchDebounce);
        this._searchDebounce = setTimeout(() => this._renderItemsList(e.target.value), 100);
      });
      itemsSearch.addEventListener("keydown", async (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const query = (itemsSearch.value || "").trim();
        if (!query) return;
        const exact = await findItemByName(query);
        if (exact) {
          this.handleItemSelect(exact, true);
          showToast(`Selected "${exact.name}"`, {
            type: "success",
            duration: 1500
          });
          itemsSearch.value = "";
          this._renderItemsList("");
          return;
        }
        const results = await searchItems(query, {
          limit: 1
        });
        if (results.length > 0) {
          this.handleItemSelect(results[0].item, true);
          showToast(`Selected "${results[0].item.name}"`, {
            type: "success",
            duration: 1500
          });
          itemsSearch.value = "";
          this._renderItemsList("");
          return;
        }
        const newItem = await this.handleNewItem(query, "Other", {
          skipDialog: true
        });
        if (newItem) {
          this.handleItemSelect(newItem, true);
          showToast(`Added "${newItem.name}"`, {
            type: "success",
            duration: 1500
          });
          itemsSearch.value = "";
          this._renderItemsList("");
        }
      });
    }
    const itemsContinue = root.querySelector(".step-items .step-continue");
    if (itemsContinue) {
      itemsContinue.onclick = () => {
        if (this.state.items.length === 0) {
          showToast("Pick at least one item", {
            type: "error"
          });
          return;
        }
        this._gotoStep(4);
        this._renderConfirmStep();
      };
    }
    const confirmBtn = root.querySelector(".step-confirm .btn-checkout");
    if (confirmBtn) {
      confirmBtn.onclick = () => this.handleConfirm();
    }
    const back = root.querySelector(".btn-back");
    if (back) {
      back.onclick = () => {
        if (this.state.step > 1) {
          this._gotoStep(this.state.step - 1);
          this._renderCurrentStep();
        } else {
          this.cancel();
        }
      };
    }
    this._wireOnce = true;
  }
  /**
   * Show only the requested step and update the step indicator dots.
   * @param {number} step - 1..4
   */
  _gotoStep(step) {
    this.state.step = step;
    this._saveDraft();
    const root = document.getElementById("screen-checkout");
    if (!root) return;
    for (const el of root.querySelectorAll(".step")) {
      el.classList.add("hidden");
      el.classList.remove("active");
    }
    const target = root.querySelector(`.step-${stepName(step)}`);
    if (target) {
      target.classList.remove("hidden");
      target.classList.add("active");
    }
    const dots = root.querySelectorAll(".dot");
    dots.forEach((d, i) => {
      d.classList.toggle("active", i < step);
    });
    const stepLabel = root.querySelector(".step-label");
    if (stepLabel) stepLabel.textContent = `Step ${step} of 4`;
  }
  /**
   * Render the contents of the current step. Called after every transition.
   */
  _renderCurrentStep() {
    if (this.state.step === 1) this._renderPhoneStep();
    else if (this.state.step === 2) this._renderNameStep();
    else if (this.state.step === 3) this._renderItemsStep();
    else if (this.state.step === 4) this._renderConfirmStep();
  }
  async _renderPhoneStep() {
    const root = document.getElementById("screen-checkout");
    if (!root) return;
    const phoneInput = root.querySelector(".step-phone .input");
    const continueBtn = root.querySelector(".step-phone .step-continue");
    if (phoneInput) {
      phoneInput.value = this.state.phone ? formatPhone(this.state.phone) : "";
      setTimeout(() => {
        try {
          phoneInput.focus({
            preventScroll: true
          });
        } catch (_) {
        }
      }, 50);
    }
    if (continueBtn) continueBtn.disabled = false;
    // Six rather than three: the row wraps, and each one is a whole step of the
    // flow skipped for a returning borrower.
    const recent = await getRecentBorrowers(6);
    const recentWrap = root.querySelector(".recent-phones");
    if (recentWrap) {
      recentWrap.innerHTML = "";
      if (recent.length > 0) {
        const heading = document.createElement("div");
        heading.className = "section-title";
        heading.textContent = "Recent";
        heading.style.marginBottom = "12px";
        recentWrap.appendChild(heading);
        const row = document.createElement("div");
        row.style.cssText = "display:flex; flex-wrap:wrap; gap:12px;";
        for (const b of recent) {
          const btn = document.createElement("button");
          btn.className = "btn btn-secondary";
          btn.style.cssText = "flex:1; min-width:200px; text-align:left; flex-direction:column; align-items:flex-start;";
          const name = document.createElement("div");
          name.style.cssText = "font-size:16px; font-weight:600;";
          name.textContent = b.name;
          const ph = document.createElement("div");
          ph.style.cssText = "font-size:14px; color:var(--text-secondary);";
          ph.textContent = formatPhone(b.phone);
          btn.appendChild(name);
          btn.appendChild(ph);
          btn.onclick = () => this.handlePhone(b.phone);
          row.appendChild(btn);
        }
        recentWrap.appendChild(row);
      }
    }
  }
  async _renderNameStep() {
    const root = document.getElementById("screen-checkout");
    if (!root) return;
    const nameInput = root.querySelector(".step-name .input");
    if (nameInput) {
      nameInput.value = "";
      setTimeout(() => {
        try {
          nameInput.focus({
            preventScroll: true
          });
        } catch (_) {
        }
      }, 50);
      if (!nameInput.dataset.suggestionsWired) {
        const updateSuggestions = () => {
          const kbd = window.__keyboard;
          if (!kbd) return;
          const v = nameInput.value || "";
          const m = v.match(/(\S+)$/);
          const lastWord = m ? m[1] : "";
          const suggestions = getSuggestions(lastWord, 3);
          kbd.setSuggestions(suggestions);
        };
        nameInput.addEventListener("input", updateSuggestions);
        nameInput._updateSuggestions = updateSuggestions;
        nameInput.dataset.suggestionsWired = "1";
      }
      nameInput._updateSuggestions();
    }
    const walkinBtn = root.querySelector(".step-name .step-walkin");
    if (walkinBtn && !walkinBtn.dataset.wired) {
      walkinBtn.onclick = () => {
        this.handleName("", true);
      };
      walkinBtn.dataset.wired = "1";
    }
    const title = root.querySelector(".step-name .step-title");
    if (title) {
      title.textContent = this.state.phone ? `\u{1F464} What's your name? (${formatPhone(this.state.phone)})` : "\u{1F464} What's your name?";
    }
  }
  async _renderItemsStep() {
    const root = document.getElementById("screen-checkout");
    if (!root) return;
    const searchInput = root.querySelector(".step-items .search-input");
    if (searchInput) {
      searchInput.value = "";
      setTimeout(() => {
        try {
          searchInput.focus({
            preventScroll: true
          });
        } catch (_) {
        }
      }, 50);
    }
    this._renderItemsList("");
  }
  /**
   * Render the frequent + all-items list, filtered by the given search query.
   * @param {string} query
   */
  async _renderItemsList(query) {
    const root = document.getElementById("screen-checkout");
    if (!root) return;
    const frequentWrap = root.querySelector(".frequent-items");
    const allWrap = root.querySelector(".all-items");
    const selectedWrap = root.querySelector(".selected-items");
    if (!frequentWrap || !allWrap) return;
    if (!query) {
      const frequent = await getFrequentItems(8);
      frequentWrap.innerHTML = "";
      for (const item of frequent) frequentWrap.appendChild(this._makeItemCard(item));
      // An empty SUGGESTIONS heading is just noise on a first run, before
      // anything has been borrowed often enough to be frequent.
      const suggestSection = root.querySelector(".item-section:nth-of-type(1)");
      if (suggestSection) suggestSection.classList.toggle("hidden", frequent.length === 0);
      const all = await listItems({
        includeArchived: false
      });
      const frequentIds = new Set(frequent.map((i) => i.id));
      const rest = all.filter((i) => !frequentIds.has(i.id));
      allWrap.innerHTML = "";
      const heading = root.querySelector(".item-section:nth-of-type(2) .section-title");
      if (heading) heading.textContent = `ALL ITEMS (${rest.length})`;
      for (const item of rest) allWrap.appendChild(this._makeItemCard(item));
      if (all.length === 0) {
        const empty = document.createElement("p");
        empty.className = "item-list-empty";
        empty.textContent = "The catalog is empty. Type what you need below and it will be added.";
        allWrap.appendChild(empty);
      }
    } else {
      const results = await searchItems(query, {
        limit: 60
      });
      frequentWrap.innerHTML = "";
      allWrap.innerHTML = "";
      const heading = root.querySelector(".item-section:nth-of-type(2) .section-title");
      if (heading) heading.textContent = `MATCHES (${results.length})`;
      for (const { item } of results) allWrap.appendChild(this._makeItemCard(item));
    }
    const typed = (query || "").trim();
    let showAddNew = false;
    if (typed) {
      const exactMatch = await findItemByName(typed);
      if (!exactMatch) {
        const results = await searchItems(typed, {
          limit: 1
        });
        if (results.length === 0) {
          showAddNew = true;
        }
      }
    }
    if (showAddNew) {
      const addNew = document.createElement("button");
      addNew.className = "btn btn-secondary add-new-row";
      addNew.style.cssText = "width:100%; margin-top:8px;";
      addNew.textContent = `+ Add "${typed}" to catalog`;
      addNew.onclick = async () => {
        addNew.disabled = true;
        addNew.textContent = "Adding...";
        try {
          const newItem = await this.handleNewItem(typed, "Other", {
            skipDialog: true
          });
          if (newItem) {
            this.handleItemSelect(newItem, true);
            showToast(`Added "${newItem.name}"`, {
              type: "success"
            });
          }
        } finally {
          addNew.disabled = false;
          addNew.textContent = `+ Add "${typed}" to catalog`;
        }
      };
      allWrap.appendChild(addNew);
    }
    this._renderSelectedStrip(selectedWrap);
    const continueBtn = root.querySelector(".step-items .step-continue");
    if (continueBtn) {
      continueBtn.disabled = this.state.items.length === 0;
      continueBtn.textContent = this.state.items.length > 0 ? `CONTINUE \u2192 (${this.state.items.length} selected)` : "CONTINUE \u2192";
    }
  }
  _makeItemCard(item) {
    const card = document.createElement("div");
    card.className = "item-card";
    if (this.state.items.find((i) => i.id === item.id)) card.classList.add("selected");
    const info = document.createElement("div");
    info.className = "item-info";
    const name = document.createElement("div");
    name.className = "item-name";
    name.textContent = item.name;
    info.appendChild(name);
    const cat = document.createElement("div");
    cat.className = "item-category";
    cat.textContent = item.category || "Other";
    info.appendChild(cat);
    card.appendChild(info);
    if (item.timesCheckedOut) {
      const count = document.createElement("div");
      count.className = "item-count";
      const same = this.state.items.filter((i) => i.name === item.name).length;
      const dup = same > 0 ? ` #${same + 1}` : "";
      count.textContent = `${item.timesCheckedOut}\xD7${dup}`;
      card.appendChild(count);
    }
    card.onclick = () => {
      const isSelected = !!this.state.items.find((i) => i.id === item.id);
      this.handleItemSelect(item, !isSelected);
    };
    return card;
  }
  _renderSelectedStrip(wrap) {
    if (!wrap) return;
    wrap.innerHTML = "";
    if (this.state.items.length === 0) return;
    const heading = document.createElement("div");
    heading.className = "section-title";
    heading.textContent = `SELECTED (${this.state.items.length})`;
    wrap.appendChild(heading);
    const list = document.createElement("div");
    list.style.cssText = "display:flex; flex-wrap:wrap; gap:8px; margin-top:8px;";
    for (const item of this.state.items) {
      const chip = document.createElement("button");
      chip.className = "suggestion-chip";
      chip.style.cssText = "background:var(--magenta); color:#fff; border-color:var(--magenta);";
      chip.textContent = `${item.name} \u2715`;
      chip.onclick = () => this.handleItemSelect(item, false);
      list.appendChild(chip);
    }
    wrap.appendChild(list);
  }
  async _promptNewItem(initial = "") {
    const form = document.createElement("div");
    form.innerHTML = `
      <p style="margin-bottom:12px; color:var(--text-secondary);">Add a new item to the catalog.</p>
      <input type="text" class="input input-lg" placeholder="Item name" value="${escapeAttr(initial || "")}" />
    `;
    const nameInput = form.querySelector("input");
    const result = await showDialog({
      title: "Add new item",
      body: form,
      buttons: [
        {
          label: "Cancel",
          value: null,
          variant: "ghost"
        },
        {
          label: "Add",
          value: "add",
          variant: "primary"
        }
      ]
    });
    if (result !== "add") return;
    const newItem = await this.handleNewItem(nameInput.value);
    if (newItem) {
      this.handleItemSelect(newItem, true);
    }
  }
  async _renderConfirmStep() {
    const root = document.getElementById("screen-checkout");
    if (!root) return;
    const phoneEl = root.querySelector(".confirm-phone");
    const nameEl = root.querySelector(".confirm-name");
    const itemsWrap = root.querySelector(".confirm-items");
    const currentLoansWrap = root.querySelector(".confirm-current-loans");
    const dueEl = root.querySelector(".due-time");
    if (phoneEl) phoneEl.textContent = formatPhone(this.state.phone || "");
    if (nameEl) nameEl.textContent = this.state.borrower ? this.state.borrower.name : "(walk-in)";
    if (itemsWrap) {
      itemsWrap.innerHTML = "";
      for (const item of this.state.items) {
        const row = document.createElement("div");
        row.style.cssText = "padding:6px 0; border-bottom:1px solid var(--border);";
        row.innerHTML = `<strong>${escapeHtml(item.name)}</strong> <span style="color:var(--text-muted);">\xD71</span>`;
        itemsWrap.appendChild(row);
      }
    }
    if (currentLoansWrap) {
      currentLoansWrap.innerHTML = "";
      if (this.state.borrower && this.state.borrower.id) {
        // Open loans only. getLoansForBorrower returns the borrower's whole
        // history, which used to render as "Already has 30 items out" listing
        // loans returned months ago, some of them flagged overdue.
        const openLoans = (await getLoansForBorrower(this.state.borrower.id)).filter(isLoanOpen);
        const myItems = this.state.items;
        const otherLoans = openLoans.filter((l) => !myItems.find((i) => i.id === l.itemId));
        if (otherLoans.length > 0) {
          const header = document.createElement("div");
          header.className = "current-loans-header";
          header.textContent = `Already has ${otherLoans.length} item${otherLoans.length === 1 ? "" : "s"} out:`;
          currentLoansWrap.appendChild(header);
          const list = document.createElement("div");
          list.className = "current-loans-list";
          for (const loan of otherLoans) {
            const item = await get("items", loan.itemId);
            const itemName = item?.name || loan.itemNameSnapshot || "?";
            const overdue = loan.dueAt && loan.dueAt < Date.now();
            const row = document.createElement("div");
            row.className = "current-loan-item" + (overdue ? " overdue" : "");
            const outText = formatRelativeTime(Date.now() - loan.checkedOutAt);
            row.innerHTML = `<span class="cli-name">${escapeHtml(itemName)}</span> <span class="cli-time">${outText}${overdue ? ' <span style="color:var(--error);font-weight:700;">\u26A0 overdue</span>' : ""}</span>`;
            list.appendChild(row);
          }
          currentLoansWrap.appendChild(list);
        }
      }
    }
    const settings = await getSettings();
    const dueAt = Date.now() + (settings.defaultLoanHours || 8) * 3600 * 1e3;
    this.state.dueAt = dueAt;
    if (dueEl) dueEl.textContent = formatDueLabel(dueAt) + ` (${new Date(dueAt).toLocaleString()})`;
    const printBtn = root.querySelector(".btn-print-receipt");
    if (printBtn) {
      printBtn.onclick = () => {
        const wasOn = printBtn.dataset.on === "1";
        const newOn = wasOn ? "0" : "1";
        printBtn.dataset.on = newOn;
        printBtn.textContent = newOn === "1" ? "\u{1F5A8}\uFE0F Will print after \u2713" : "\u{1F5A8}\uFE0F Print receipt after";
        printBtn.classList.toggle("btn-print-on", newOn === "1");
      };
    }
  }
  // ── draft persistence ─────────────────────────────────────────────
  _saveDraft() {
    try {
      const snapshot = {
        step: this.state.step,
        phone: this.state.phone,
        borrowerId: this.state.borrower ? this.state.borrower.id : null,
        borrowerName: this.state.borrower ? this.state.borrower.name : null,
        itemIds: this.state.items.map((i) => i.id),
        dueAt: this.state.dueAt
      };
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(snapshot));
    } catch (err) {
    }
  }
  _loadDraft() {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  _clearDraft() {
    try {
      sessionStorage.removeItem(DRAFT_KEY);
    } catch (_) {
    }
  }
  _addRecentPhone(entry) {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const list = raw ? JSON.parse(raw) : [];
      const filtered = list.filter((e) => e.phone !== entry.phone);
      filtered.unshift(entry);
      while (filtered.length > 5) filtered.pop();
      localStorage.setItem(RECENT_KEY, JSON.stringify(filtered));
    } catch (_) {
    }
  }
};
var CheckinFlow = class {
  constructor() {
    this.state = {
      query: "",
      allLoans: [],
      items: /* @__PURE__ */ new Map(),
      borrowers: /* @__PURE__ */ new Map(),
      selectedLoan: null
    };
    this._wireOnce = false;
    this._searchDebounce = null;
  }
  // ── lifecycle ──────────────────────────────────────────────────────
  /**
   * Begin the check-in flow: show screen, fetch open loans, render sections.
   */
  async start() {
    goToScreen("checkin");
    this._wireDom();
    await this._loadAndRender();
  }
  /**
   * Refresh the open loans list (called on entry and after a return).
   */
  async _loadAndRender() {
    const openLoans = await getOpenLoans();
    const items = await listItems({
      includeArchived: true
    });
    const borrowers = await listBorrowers({
      includeArchived: true
    });
    this.state.allLoans = openLoans;
    this.state.items = new Map(items.map((i) => [
      i.id,
      i
    ]));
    this.state.borrowers = new Map(borrowers.map((b) => [
      b.id,
      b
    ]));
    this._renderList();
  }
  // ── handlers ───────────────────────────────────────────────────────
  /**
   * Filter the visible list by the given query.
   * @param {string} query
   */
  async handleSearch(query) {
    this.state.query = query;
    clearTimeout(this._searchDebounce);
    this._searchDebounce = setTimeout(() => this._renderList(), 80);
  }
  /**
   * Open the return screen for a specific loan.
   * @param {any} loan
   */
  async handleSelectLoan(loan) {
    this.state.selectedLoan = loan;
    this._renderReturn(loan);
    goToScreen("checkin-return", {
      data: {
        loanId: loan.id
      }
    });
  }
  /**
   * Commit a return with the given condition + notes.
   * @param {'good'|'fair'|'damaged'|'lost'} condition
   * @param {string} notes
   */
  async _confirmAndReturn(condition, notes) {
    const loan = this.state.selectedLoan;
    if (!loan) return;
    const item = this.state.items.get(loan.itemId);
    const borrower = loan.borrowerId != null ? this.state.borrowers.get(loan.borrowerId) : null;
    const itemName = item?.name || loan.itemNameSnapshot || "?";
    const borrowerName = borrower?.name || loan.borrowerNameSnapshot || "(unknown)";
    const phone = borrower?.phoneFormatted || (loan.borrowerPhoneSnapshot ? formatPhone(loan.borrowerPhoneSnapshot) : "");
    const outAt = new Date(loan.checkedOutAt).toLocaleString();
    const dueAt = loan.dueAt ? new Date(loan.dueAt).toLocaleString() : "\u2014";
    const wasOverdue = loan.dueAt && loan.dueAt < Date.now();
    const conditionLabel = {
      good: "\u2713 Returned in good condition",
      fair: "~ Returned in fair condition",
      damaged: "\u26A0 Returned damaged",
      lost: "\u2717 Marked as LOST"
    }[condition] || condition;
    const confirmBody = `
      <div class="confirm-summary">
        <div class="summary-row">
          <span class="summary-label">Item</span>
          <span class="summary-value">${escapeHtml(itemName)}</span>
        </div>
        <div class="summary-row">
          <span class="summary-label">Borrower</span>
          <span class="summary-value">${escapeHtml(borrowerName)}${phone ? ' <span style="color:var(--text-muted);">\u2022 ' + escapeHtml(phone) + "</span>" : ""}</span>
        </div>
        <div class="summary-row">
          <span class="summary-label">Out at</span>
          <span class="summary-value">${escapeHtml(outAt)}</span>
        </div>
        <div class="summary-row">
          <span class="summary-label">Due back</span>
          <span class="summary-value">${escapeHtml(dueAt)}${wasOverdue ? ' <span style="color:var(--error);font-weight:700;">(overdue)</span>' : ""}</span>
        </div>
        <div class="summary-row">
          <span class="summary-label">Out for</span>
          <span class="summary-value">${formatRelativeTime(Date.now() - loan.checkedOutAt)}</span>
        </div>
        ${notes ? `<div class="summary-row"><span class="summary-label">Notes</span><span class="summary-value">${escapeHtml(notes)}</span></div>` : ""}
        <div class="summary-condition ${condition}">
          ${escapeHtml(conditionLabel)}
        </div>
      </div>
    `;
    const confirmed = await new Promise((resolve) => {
      showDialog({
        title: "Confirm return?",
        body: confirmBody,
        buttons: [
          {
            label: "Cancel",
            value: false,
            variant: "ghost"
          },
          {
            label: condition === "lost" ? "Mark as Lost" : "Confirm Return",
            value: true,
            variant: condition === "damaged" || condition === "lost" ? "danger" : "primary"
          }
        ]
      }).then((value) => resolve(value === true));
    });
    if (!confirmed) return;
    await this.handleReturn(condition, notes);
  }
  async handleReturn(condition, notes) {
    const loan = this.state.selectedLoan;
    if (!loan) {
      goToScreen("checkin");
      return;
    }
    try {
      const updated = await returnLoan(loan.id, {
        returnedAt: Date.now(),
        conditionIn: condition,
        notes: notes || ""
      });
      const conditionLabel = {
        good: "Returned OK",
        fair: "Returned (fair)",
        damaged: "Damaged",
        lost: "Lost"
      }[condition] || "Returned";
      showToast(conditionLabel, {
        type: condition === "good" || condition === "fair" ? "success" : "error"
      });
      this.state.selectedLoan = null;
      await this._loadAndRender();
      if (this.state.allLoans.length === 0) {
        setTimeout(() => {
          goToScreen("home");
          refreshHome();
        }, 800);
        return;
      }
      goToScreen("checkin");
    } catch (err) {
      console.error("return failed", err);
      showToast("Return failed: " + (err?.message || "unknown"), {
        type: "error"
      });
    }
  }
  cancel() {
    this.state.selectedLoan = null;
    goToScreen("home");
    refreshHome();
  }
  // ── DOM rendering ─────────────────────────────────────────────────
  _wireDom() {
    if (this._wireOnce) return;
    const root = document.getElementById("screen-checkin");
    if (!root) return;
    const searchInput = root.querySelector(".search-input");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => this.handleSearch(e.target.value));
    }
    const back = root.querySelector(".btn-back");
    if (back) {
      back.onclick = () => {
        this.cancel();
      };
    }
    const retRoot = document.getElementById("screen-checkin-return");
    if (retRoot) {
      const retBack = retRoot.querySelector(".btn-back");
      if (retBack) retBack.onclick = () => goToScreen("checkin");
      const buttons = retRoot.querySelectorAll(".btn-return");
      buttons.forEach((b) => {
        b.onclick = async () => {
          const condition = b.dataset.condition || "good";
          const notes = retRoot.querySelector(".notes-input")?.value || "";
          await this._confirmAndReturn(condition, notes);
        };
      });
    }
    this._wireOnce = true;
  }
  /**
   * Render the 3 sections (overdue, today, earlier) with current filter.
   */
  _renderList() {
    const root = document.getElementById("screen-checkin");
    if (!root) return;
    const overdueWrap = root.querySelector(".overdue-items");
    const todayWrap = root.querySelector(".today-items");
    const earlierWrap = root.querySelector(".earlier-items");
    const overdueSection = root.querySelector(".overdue-section");
    const todaySection = root.querySelector(".today-section");
    const earlierSection = root.querySelector(".earlier-section");
    if (!overdueWrap || !todayWrap || !earlierWrap) return;
    const q = normalize(this.state.query);
    let filtered = this.state.allLoans;
    if (q) {
      filtered = this.state.allLoans.filter((loan) => {
        const item = this.state.items.get(loan.itemId);
        const borrower = loan.borrowerId != null ? this.state.borrowers.get(loan.borrowerId) : null;
        const itemName = (item?.name || loan.itemNameSnapshot || "").toLowerCase();
        const borrowerName = (borrower?.name || loan.borrowerNameSnapshot || "").toLowerCase();
        const phone = (borrower?.phoneFormatted || loan.borrowerPhoneSnapshot || "").toLowerCase();
        return itemName.includes(q) || borrowerName.includes(q) || phone.includes(q);
      });
    }
    const now = Date.now();
    const todayStart = /* @__PURE__ */ new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartMs = todayStart.getTime();
    const overdue = [];
    const today = [];
    const earlier = [];
    for (const loan of filtered) {
      const isOverdue = loan.dueAt && loan.dueAt < now;
      if (isOverdue) {
        overdue.push(loan);
      } else if (loan.checkedOutAt >= todayStartMs) {
        today.push(loan);
      } else {
        earlier.push(loan);
      }
    }
    overdue.sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));
    today.sort((a, b) => b.checkedOutAt - a.checkedOutAt);
    earlier.sort((a, b) => b.checkedOutAt - a.checkedOutAt);
    overdueWrap.innerHTML = "";
    todayWrap.innerHTML = "";
    earlierWrap.innerHTML = "";
    for (const l of overdue) overdueWrap.appendChild(this._makeLoanRow(l, true));
    for (const l of today) todayWrap.appendChild(this._makeLoanRow(l, false));
    for (const l of earlier) earlierWrap.appendChild(this._makeLoanRow(l, false));
    if (overdueSection) overdueSection.style.display = overdue.length > 0 ? "" : "none";
    if (todaySection) todaySection.style.display = today.length > 0 ? "" : "none";
    if (earlierSection) earlierSection.style.display = earlier.length > 0 ? "" : "none";
    const overdueTitle = root.querySelector(".overdue-section .section-title");
    if (overdueTitle) overdueTitle.textContent = `OVERDUE (${overdue.length})`;
  }
  _makeLoanRow(loan, isOverdue) {
    const item = this.state.items.get(loan.itemId);
    const borrower = loan.borrowerId != null ? this.state.borrowers.get(loan.borrowerId) : null;
    const row = document.createElement("div");
    row.className = "loan-item";
    if (isOverdue) row.classList.add("overdue");
    const header = document.createElement("div");
    header.className = "loan-header";
    const itemName = item?.name || loan.itemNameSnapshot || "?";
    const itemEl = document.createElement("div");
    itemEl.className = "item-name";
    itemEl.textContent = itemName;
    header.appendChild(itemEl);
    const badge = document.createElement("div");
    const now = Date.now();
    if (isOverdue) {
      badge.className = "loan-badge badge-overdue";
      badge.textContent = `\u26A0 OVERDUE ${formatRelativeTime(now - (loan.dueAt || now))}`;
    } else if (loan.dueAt && loan.dueAt - now < 2 * 60 * 60 * 1e3) {
      badge.className = "loan-badge badge-due-soon";
      badge.textContent = `Due in ${formatRelativeTime(loan.dueAt - now)}`;
    } else {
      badge.className = "loan-badge badge-today";
      badge.textContent = formatRelativeTime(now - loan.checkedOutAt) + " out";
    }
    header.appendChild(badge);
    row.appendChild(header);
    const borrowerRow = document.createElement("div");
    borrowerRow.className = "loan-borrower";
    const name = borrower?.name || loan.borrowerNameSnapshot || "(unknown)";
    const phone = borrower?.phoneFormatted || (loan.borrowerPhoneSnapshot ? formatPhone(loan.borrowerPhoneSnapshot) : "");
    borrowerRow.innerHTML = `
      <span class="borrower-name">${escapeHtml(name)}</span>
      ${phone ? `<span class="borrower-phone">${escapeHtml(phone)}</span>` : ""}
    `;
    row.appendChild(borrowerRow);
    const timing = document.createElement("div");
    timing.className = "loan-timing";
    const outText = formatRelativeTime(now - loan.checkedOutAt);
    let dueText = "no due date";
    let dueClass = "";
    if (loan.dueAt) {
      if (loan.dueAt < now) {
        dueText = `Overdue by ${formatRelativeTime(now - loan.dueAt)}`;
        dueClass = "due";
      } else {
        dueText = `in ${formatRelativeTime(loan.dueAt - now)}`;
      }
    }
    const outAt = new Date(loan.checkedOutAt);
    const dueAt = loan.dueAt ? new Date(loan.dueAt) : null;
    timing.innerHTML = `
      <span><span class="timing-label">Out:</span> <span class="timing-value">${escapeHtml(outText)}</span> <span class="timing-label" style="font-size:11px;color:var(--text-muted);">(${outAt.toLocaleString()})</span></span>
      <span><span class="timing-label">Due:</span> <span class="timing-value ${dueClass}">${escapeHtml(dueText)}</span>${dueAt ? ` <span class="timing-label" style="font-size:11px;color:var(--text-muted);">(${dueAt.toLocaleString()})</span>` : ""}</span>
    `;
    row.appendChild(timing);
    row.onclick = () => this.handleSelectLoan(loan);
    return row;
  }
  _renderReturn(loan) {
    const root = document.getElementById("screen-checkin-return");
    if (!root) return;
    const item = this.state.items.get(loan.itemId);
    const borrower = loan.borrowerId != null ? this.state.borrowers.get(loan.borrowerId) : null;
    const nameEl = root.querySelector(".return-name");
    const phoneEl = root.querySelector(".return-phone");
    const itemNameEl = root.querySelector(".return-item .item-name");
    const loanTimeEl = root.querySelector(".loan-time");
    const notesEl = root.querySelector(".notes-input");
    if (nameEl) nameEl.textContent = borrower?.name || loan.borrowerNameSnapshot || "(unknown)";
    if (phoneEl) phoneEl.textContent = borrower?.phoneFormatted ? formatPhone(borrower.phoneFormatted) : loan.borrowerPhoneSnapshot ? formatPhone(loan.borrowerPhoneSnapshot) : "";
    if (itemNameEl) itemNameEl.textContent = item?.name || loan.itemNameSnapshot || "?";
    if (loanTimeEl) {
      const out = agoLabel(Date.now() - loan.checkedOutAt);
      const due = loan.dueAt ? loan.dueAt < Date.now() ? `Overdue by ${formatRelativeTime(Date.now() - loan.dueAt)}` : `Due in ${formatRelativeTime(loan.dueAt - Date.now())}` : "No due time";
      loanTimeEl.textContent = `Out ${out} \xB7 ${due}`;
    }
    if (notesEl) notesEl.value = "";
  }
};
function stepName(n) {
  return {
    1: "phone",
    2: "name",
    3: "items",
    4: "confirm"
  }[n] || "phone";
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}
function escapeAttr(s) {
  return escapeHtml(s);
}

// ../frontdesk/modules/admin.js
init_db();
init_ui();

// ../frontdesk/modules/backup.js
init_db();
init_ui();
var BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1e3;

// ---------------------------------------------------------------------------
// Windows host bridge
// ---------------------------------------------------------------------------
// The same file runs two ways: in a browser (frontdesk.html, served over http)
// and inside the Front Desk Windows host, which wraps it in a WebView2 window.
// When hosted, the page can reach a small native object for the things a
// browser cannot do properly -- write a backup into a real folder without a
// Save dialog on every launch, rotate old ones, and open a folder in Explorer.
//
// Every entry point below falls back to the browser behaviour when the bridge
// is absent, so nothing here is required for the app to work.

let _hostInfoCache = null;

// The version shown in the corner of every screen.
//
// The markup used to carry a hard-coded "v0.1" while the exe, the zip and the
// README all said 1.0.0, so the one place a staff member can read the version
// disagreed with the thing they installed. Prefer what the host actually
// reports -- it is the running build, not what this file believes it shipped
// with -- and fall back to this constant when the page is opened in a browser
// with no host to ask.
//
// Keep WEB_VERSION in step with Build.Version in host/FrontDesk.cs and
// AssemblyVersion in host/AssemblyInfo.cs; tools/test-host-bridge.cjs fails if
// they drift apart.
const WEB_VERSION = "1.0.0";
async function renderBuildInfo() {
  const el = document.querySelector(".build-info");
  if (!el) return;
  let version = WEB_VERSION;
  try {
    const info = await hostInfo();
    if (info && info.version) version = String(info.version);
  } catch (_) {
  }
  el.textContent = `v${version} \xB7 Front Desk`;
  el.title = `Front Desk ${version}`;
}

/** The native object, or null when running in a plain browser. */
function hostObject() {
  try {
    const wv = window.chrome && window.chrome.webview;
    if (!wv || !wv.hostObjects) return null;
    return wv.hostObjects.frontDeskHost || null;
  } catch (_) {
    return null;
  }
}
function isHosted() {
  return !!hostObject();
}

/**
 * Call a bridge method and parse its JSON reply.
 *
 * The bridge answers with {"ok":bool,...} and never throws across the COM
 * boundary, so a failure arrives as ordinary data. hostRaw hands that back
 * untouched; hostCall re-throws it so callers can use one try/catch whether the
 * failure was native or otherwise. Use hostRaw when a false "ok" carries
 * information you want to show rather than swallow -- an unverified backup, for
 * instance, still needs reporting as a backup problem, not as a crash.
 */
async function hostRaw(method, ...args) {
  const host = hostObject();
  if (!host) throw new Error("Not running in the Front Desk app");
  const raw = await host[method].apply(host, args);
  const text = typeof raw === "string" ? raw : String(raw == null ? "" : raw);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error(`${method} returned something unreadable`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${method} returned nothing usable`);
  }
  return parsed;
}
async function hostCall(method, ...args) {
  const parsed = await hostRaw(method, ...args);
  if (parsed.ok === false) throw new Error(parsed.error || `${method} failed`);
  return parsed;
}

/** Cached: the paths and version do not change while the app is open. */
async function hostInfo() {
  if (_hostInfoCache) return _hostInfoCache;
  if (!isHosted()) return null;
  try {
    _hostInfoCache = await hostCall("GetInfo");
  } catch (err) {
    console.warn("[host] GetInfo failed:", err);
    return null;
  }
  return _hostInfoCache;
}

/** Send a page-side failure to the same log file the host writes to. */
function logToHost(message) {
  const host = hostObject();
  if (!host) return;
  try {
    host.LogClientError(String(message));
  } catch (_) {
  }
}

function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Write a backup into the host's backup folder and rotate.
 *
 * This is the path that makes backups actually happen. The browser fallback
 * cannot: a download lands in Downloads, and the File System Access route
 * cannot re-acquire permission across launches, so it silently does nothing.
 *
 * Deliberately does not throw on ok:false -- "written but did not verify" is a
 * result the caller has to tell the operator about, not an exception to hide.
 */
async function hostSaveBackup(data) {
  return hostRaw("SaveBackup", JSON.stringify(data, null, 2), `frontdesk-backup-${dateStamp()}.json`);
}

/** Restore from a backup in the host's folder, by file name. */
async function hostRestoreBackup(fileName) {
  const res = await hostCall("ReadBackup", fileName);
  let data;
  try {
    data = JSON.parse(res.text);
  } catch (err) {
    throw new Error("That backup could not be read: " + err.message);
  }
  if (!data || typeof data !== "object" || !data.items || !data.borrowers || !data.loans) {
    throw new Error("That backup is missing required fields (items, borrowers, loans)");
  }
  await importAll(data, {
    mode: "replace"
  });
}

async function autoBackup() {
  try {
    const settings = await getSettings();
    const last = settings.lastBackupAt || 0;
    const now = Date.now();
    if (now - last < BACKUP_INTERVAL_MS && last > 0) {
      return {
        ok: true,
        triggered: false,
        reason: "recent"
      };
    }
    const data = await exportAll();
    if (isHosted()) {
      try {
        const result = await hostSaveBackup(data);
        await updateSettings({
          lastBackupAt: now
        });
        if (result.verified) {
          showToast(`Backup saved to the backup folder (${formatBytes(result.bytes)}). ${result.kept} kept.`, {
            type: "info",
            duration: 5e3
          });
        } else {
          // The file was written but did not read back the same. Say so loudly:
          // a backup you cannot trust is worse than none, because it is the one
          // you find out about when you need it.
          showToast(`Backup could not be verified: ${result.error || "the file on disk does not match"}. Check the backup folder.`, {
            type: "error",
            duration: 15e3
          });
        }
        return {
          ok: result.verified,
          triggered: true,
          reason: "host",
          path: result.path
        };
      } catch (err) {
        console.warn("[host] SaveBackup failed, falling back:", err);
        logToHost("autoBackup SaveBackup failed: " + err.message);
      }
    }
    if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
      try {
        const dirHandle = await getOrCreateBackupDir();
        if (dirHandle) {
          await writeBackupToDir(dirHandle, data);
          await updateSettings({
            lastBackupAt: now
          });
          return {
            ok: true,
            triggered: true,
            reason: "fsa"
          };
        }
      } catch (err) {
      }
    }
    triggerDownload(data, `frontdesk-backup-${dateStamp()}.json`);
    await updateSettings({
      lastBackupAt: now
    });
    showToast("Backup saved. Check your Downloads folder.", {
      type: "info",
      duration: 4e3
    });
    return {
      ok: true,
      triggered: true,
      reason: "download"
    };
  } catch (err) {
    console.warn("autoBackup failed:", err);
    logToHost("autoBackup failed: " + (err && err.message));
    return {
      ok: false,
      triggered: false,
      reason: err?.message || "error"
    };
  }
}
async function downloadExport() {
  const data = await exportAll();
  if (isHosted()) {
    try {
      // A real Windows Save dialog, defaulting to the backup folder.
      const res = await hostCall("ExportCopy", JSON.stringify(data, null, 2), `frontdesk-backup-${dateStamp()}.json`);
      if (res.cancelled) return;
      showToast("Backup saved to " + res.path, {
        type: "success"
      });
      return;
    } catch (err) {
      showToast("Could not save the file: " + err.message, {
        type: "error"
      });
      return;
    }
  }
  triggerDownload(data, `frontdesk-backup-${dateStamp()}.json`);
  showToast("Backup downloaded", {
    type: "success"
  });
}
/** Bound to the tray's "Back up now", and usable from the console. */
async function runBackupNow({ force = true } = {}) {
  if (force) {
    await updateSettings({
      lastBackupAt: 0
    });
  }
  return autoBackup();
}

// A crash inside the page would otherwise vanish into a devtools console that
// nobody at the desk has open. Forward the first few to the host's log file so
// a problem that happens on a Tuesday afternoon is still readable on Wednesday.
// The listeners go on unconditionally -- isHosted() is checked when one fires,
// not now, because the bridge object may not be injected yet at parse time.
{
  let reported = 0;
  const report = (what, detail) => {
    if (reported >= 20) return;
    reported += 1;
    logToHost(`${what}: ${detail}`);
  };  window.addEventListener("error", (e) => {
    report("Uncaught error", `${e.message} (${e.filename}:${e.lineno})`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    report("Unhandled rejection", r && r.message ? r.message : String(r));
  });
}
async function importFromFile(file) {
  if (!file) throw new Error("No file provided");
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error("Invalid JSON: " + err.message);
  }
  if (!data || typeof data !== "object" || !data.items || !data.borrowers || !data.loans) {
    throw new Error("Backup file is missing required fields (items, borrowers, loans)");
  }
  await importAll(data, {
    mode: "replace"
  });
}
function overdueToCsv(loans, borrowerById) {
  const headers = [
    "borrower",
    "phone",
    "item",
    "days_overdue",
    "condition"
  ];
  const rows = loans.map((loan) => {
    const borrower = borrowerById?.get(loan.borrowerId);
    const name = borrower?.name || loan.borrowerNameSnapshot || "";
    const phone = borrower?.phoneFormatted ? formatPhone(borrower.phone) : loan.borrowerPhoneSnapshot ? formatPhone(loan.borrowerPhoneSnapshot) : "";
    const item = loan.itemNameSnapshot || "";
    const overdueMs = loan.dueAt ? Date.now() - loan.dueAt : 0;
    const days = Math.max(0, Math.round(overdueMs / 864e5));
    const cond = loan.conditionOut || "good";
    return [
      name,
      phone,
      item,
      String(days),
      cond
    ];
  });
  const body = [
    headers,
    ...rows
  ].map((row) => row.map((c) => csvEscape(c)).join(",")).join("\n");
  return "\uFEFF" + body;
}
function dateStamp() {
  return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}
function triggerDownload(data, filename) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([
    json
  ], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
function csvEscape(s) {
  const str = String(s ?? "");
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
async function getOrCreateBackupDir() {
  let handle = await loadHandle();
  if (handle) {
    try {
      const perm = await handle.queryPermission({
        mode: "readwrite"
      });
      if (perm === "granted") return handle;
      const req = await handle.requestPermission({
        mode: "readwrite"
      });
      if (req === "granted") return handle;
    } catch (_) {
      handle = null;
    }
  }
  if (!handle) {
    handle = await window.showDirectoryPicker({
      id: "frontdesk-backups",
      mode: "readwrite"
    });
    if (handle) await saveHandle(handle);
  }
  return handle || null;
}
async function writeBackupToDir(dirHandle, data) {
  const filename = `frontdesk-backup-${dateStamp()}.json`;
  const fileHandle = await dirHandle.getFileHandle(filename, {
    create: true
  });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(data, null, 2));
  await writable.close();
}
async function saveHandle(handle) {
  try {
    const dbHandle = await openDB();
    const tx2 = dbHandle.transaction("settings", "readwrite");
    const store = tx2.objectStore("settings");
    const s = await new Promise((resolve, reject) => {
      const req = store.get(1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (s) {
      s._fsaHandle = true;
      store.put(s);
    }
  } catch (_) {
  }
  _liveHandle = handle;
}
async function loadHandle() {
  if (_liveHandle) return _liveHandle;
  return null;
}
var _liveHandle = null;

// ../frontdesk/modules/kiosk.js
init_db();
init_ui();
var state = {
  phone: null,
  borrower: null,
  isNew: false
};
var KIOSK_SCREENS = {
  // Short names — goToScreen strips the 'screen-' prefix when looking up.
  welcome: "welcome",
  borrowPhone: "kiosk-borrow-phone",
  borrowName: "kiosk-borrow-name",
  borrowNeed: "kiosk-borrow-need",
  borrowDone: "kiosk-borrow-done",
  returnPhone: "kiosk-return-phone",
  returnItems: "kiosk-return-items"
};
function initKiosk() {
  const welcome = document.getElementById("screen-welcome");
  if (!welcome) return;
  const borrowBtn = welcome.querySelector(".btn-kiosk-borrow");
  if (borrowBtn) {
    borrowBtn.onclick = () => {
      state.phone = null;
      state.borrower = null;
      state.isNew = false;
      const phoneInput2 = document.getElementById("kiosk-phone");
      if (phoneInput2) phoneInput2.value = "";
      const nameInput2 = document.getElementById("kiosk-name");
      if (nameInput2) nameInput2.value = "";
      const needInput2 = document.getElementById("kiosk-need");
      if (needInput2) needInput2.value = "";
      goToScreen(KIOSK_SCREENS.borrowPhone);
      setTimeout(() => {
        const input = document.getElementById("kiosk-phone");
        if (input) input.focus();
      }, 100);
    };
  }
  const returnBtn = welcome.querySelector(".btn-kiosk-return");
  if (returnBtn) {
    returnBtn.onclick = () => {
      const phoneInput2 = document.getElementById("kiosk-return-phone");
      if (phoneInput2) phoneInput2.value = "";
      const existingPicker = document.querySelector(".kiosk-borrower-picker");
      if (existingPicker) existingPicker.remove();
      const continueBtn = document.querySelector('[data-action="kiosk-return-phone-continue"]');
      if (continueBtn) continueBtn.style.display = "";
      goToScreen(KIOSK_SCREENS.returnPhone);
      setTimeout(() => {
        const input = document.getElementById("kiosk-return-phone");
        if (input) input.focus();
      }, 100);
    };
  }
  // Staff access is a deliberate press-and-hold on the welcome logo. It used to be
  // a labelled button, which put a PIN prompt in front of the public and let anyone
  // at the tablet sit and guess the 4-digit default.
  const holdTarget = welcome.querySelector(".kiosk-logo") || welcome.querySelector(".kiosk-header");
  if (holdTarget) {
    let holdTimer = null;
    const startHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        holdTimer = null;
        showAdminLogin();
      }, 2e3);
    };
    const cancelHold = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };
    holdTarget.addEventListener("pointerdown", startHold);
    holdTarget.addEventListener("pointerup", cancelHold);
    holdTarget.addEventListener("pointerleave", cancelHold);
    holdTarget.addEventListener("pointercancel", cancelHold);
    holdTarget.addEventListener("contextmenu", (e) => e.preventDefault());
    holdTarget.style.webkitUserSelect = "none";
    holdTarget.style.userSelect = "none";
    holdTarget.style.touchAction = "none";
  }
  document.querySelectorAll(".btn-back-kiosk").forEach((btn) => {
    btn.onclick = () => {
      const picker = document.querySelector(".kiosk-borrower-picker");
      if (picker) picker.remove();
      const signin = document.querySelector(".kiosk-signin-panel");
      if (signin) signin.remove();
      const continueBtn = document.querySelector('[data-action="kiosk-return-phone-continue"]');
      if (continueBtn) continueBtn.style.display = "";
      if (btn.dataset.back === "kiosk-return-phone" || btn.dataset.back === "welcome") {
        const returnInput = document.getElementById("kiosk-return-phone");
        if (returnInput) returnInput.value = "";
      }
      goToScreen(btn.dataset.back);
    };
  });
  const phoneContinue = document.querySelector('[data-action="kiosk-phone-continue"]');
  if (phoneContinue) {
    phoneContinue.onclick = () => handlePhoneSubmit();
  }
  const phoneInput = document.getElementById("kiosk-phone");
  if (phoneInput) {
    phoneInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handlePhoneSubmit();
    });
  }
  const nameContinue = document.querySelector('[data-action="kiosk-name-continue"]');
  if (nameContinue) {
    nameContinue.onclick = () => handleNameSubmit();
  }
  // There used to be a "Skip — no name" button here. It set isWalkIn, and
  // createLoan throws "Walk-in borrowers require a customName for the loan"
  // because no kiosk caller passes customName -- so every walk-in ended in a
  // failure toast, and the loan it was trying to make would have had a null
  // borrowerId, meaning the borrower could never return it at the kiosk either.
  // The kiosk now requires a name; anyone who won't give one is sent to the desk.
  const nameInput = document.getElementById("kiosk-name");
  if (nameInput) {
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleNameSubmit();
    });
  }
  const needInput = document.getElementById("kiosk-need");
  if (needInput) {
    needInput.addEventListener("input", () => _updateTypeahead());
    needInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        _handleCommit();
      }
    });
  }
  const confirmBtn = document.querySelector('[data-action="kiosk-confirm-pick"]');
  if (confirmBtn) {
    confirmBtn.onclick = () => _handleCommit();
  }
  const doneBtn = document.querySelector('[data-action="kiosk-back-home"]');
  if (doneBtn) {
    doneBtn.onclick = () => _kioskBackHome();
  }
  const returnPhoneContinue = document.querySelector('[data-action="kiosk-return-phone-continue"]');
  if (returnPhoneContinue) {
    returnPhoneContinue.onclick = () => handleReturnPhoneSubmit();
  }
  const returnPhoneInput = document.getElementById("kiosk-return-phone");
  if (returnPhoneInput) {
    // The value before this edit. Reformatting assigns .value, which destroys
    // the caret position and, worse, puts back any formatting character the
    // user just deleted -- so backspacing onto a ")" or "-" appeared to do
    // nothing at all. Comparing against the pre-edit value is what lets a
    // deletion of a formatting character also remove the digit behind it.
    let valueBefore = returnPhoneInput.value;
    returnPhoneInput.addEventListener("beforeinput", (e) => {
      valueBefore = e.target.value;
    });
    returnPhoneInput.addEventListener("input", (e) => {
      const before = normalizePhone(valueBefore).slice(-10);
      let digits = normalizePhone(e.target.value).slice(-10);
      if (e.inputType === "deleteContentBackward" && digits === before && before.length > 0) {
        digits = before.slice(0, -1);
      }
      const formatted = formatPhone(digits);
      valueBefore = formatted;
      if (e.target.value !== formatted) {
        e.target.value = formatted;
        // The on-screen keyboard only ever appends, so the caret belongs at the
        // end. setSelectionRange throws on some input types; the assignment
        // above already put the caret there in that case.
        try {
          e.target.setSelectionRange(formatted.length, formatted.length);
        } catch (_) {
        }
      }
    });
    returnPhoneInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleReturnPhoneSubmit();
    });
  }
}
async function handlePhoneSubmit() {
  const input = document.getElementById("kiosk-phone");
  if (!input) return;
  const raw = input.value.replace(/\D/g, "").slice(-10);
  if (raw.length !== 10) {
    showToast("Please enter a 10-digit phone number", {
      type: "error"
    });
    input.focus();
    return;
  }
  input.value = formatPhone(raw);
  state.phone = raw;
  await openDB();
  const matches = await findBorrowerByPhone(raw);
  if (matches.length === 1) {
    state.borrower = matches[0];
    state.isNew = false;
    const greetEl = document.getElementById("kiosk-greeting-name");
    if (greetEl) greetEl.textContent = matches[0].name;
    goToScreen(KIOSK_SCREENS.borrowNeed);
    setTimeout(() => {
      const need = document.getElementById("kiosk-need");
      if (need) need.focus();
    }, 100);
  } else if (matches.length > 1) {
    // Several people share this number (a family or an office line). Taking
    // matches[0] silently booked the loan against whichever record happened to
    // sort first; the return flow already asks, so the borrow flow does too.
    _showBorrowerPicker(matches, raw, KIOSK_SCREENS.borrowNeed);
  } else {
    state.isNew = true;
    goToScreen(KIOSK_SCREENS.borrowName);
    setTimeout(() => {
      const input2 = document.getElementById("kiosk-name");
      if (input2) input2.focus();
    }, 100);
  }
}
async function handleNameSubmit() {
  const input = document.getElementById("kiosk-name");
  if (!input) return;
  const name = sentenceCase(input.value.trim());
  if (!name) {
    showToast("Please enter your name", {
      type: "error"
    });
    input.focus();
    return;
  }
  await openDB();
  state.borrower = await upsertBorrower({
    phone: state.phone,
    name
  });
  state.isNew = false;
  const greetEl = document.getElementById("kiosk-greeting-name");
  if (greetEl) greetEl.textContent = name;
  goToScreen(KIOSK_SCREENS.borrowNeed);
  setTimeout(() => {
    const need = document.getElementById("kiosk-need");
    if (need) need.focus();
  }, 100);
}
var _allItemsCache = null;
async function getAllItems() {
  if (_allItemsCache) return _allItemsCache;
  _allItemsCache = await listItems({
    includeArchived: false
  });
  return _allItemsCache;
}
function invalidateItemsCache() {
  _allItemsCache = null;
}
/**
 * Items a borrower may actually take right now: in the catalog, not archived,
 * and not already out. Without the availability filter the kiosk happily tried to
 * check out an item that was already gone, which `createLoan` now refuses -- so
 * offering it would be offering a button that always fails.
 *
 * Returns [{ item, isOut }] so the picker can still show a taken item as
 * unavailable rather than making it look like it does not exist.
 */
async function getKioskPickableItems() {
  const items = await getAllItems();
  const openLoans = await getOpenLoans();
  const outItemIds = new Set();
  for (const loan of openLoans) {
    if (loan.itemId != null) outItemIds.add(loan.itemId);
  }
  return items.map((item) => ({
    item,
    isOut: outItemIds.has(item.id)
  }));
}
function _fuzzyScore(query, name) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const n = (name || "").toLowerCase();
  if (n === q) return 1e3;
  if (n.startsWith(q)) return 500;
  if (n.includes(q)) return 100;
  let i = 0;
  for (const c of n) if (c === q[i]) i++;
  return i === q.length ? 50 : 0;
}
function _renderSuggestions(matches, query) {
  const container = document.getElementById("kiosk-need-suggestions");
  if (!container) return;
  container.innerHTML = "";
  if (matches.length === 0) {
    if (!query) return;
    // Used to read `New item \u2014 press Enter to add "X"`, and pressing Enter
    // really did write a permanent row into the catalog with no confirmation,
    // no cap and no rate limit. The public surface no longer writes to the
    // catalog at all; anything not on the list is a job for the front desk.
    const empty = document.createElement("div");
    empty.className = "kiosk-suggestion-empty";
    empty.textContent = "Not on the list \u2014 please ask the front desk";
    container.appendChild(empty);
    return;
  }
  for (const entry of matches) {
    const item = entry.item || entry;
    const isOut = entry.isOut === true;
    const btn = document.createElement("button");
    btn.className = "kiosk-suggestion" + (isOut ? " is-unavailable" : "");
    btn.type = "button";
    btn.dataset.itemId = String(item.id);
    btn.disabled = isOut;
    btn.innerHTML = `<span>${escapeHtml2(item.name)}</span>` + (item.category ? `<span class="kiosk-suggestion-category">${escapeHtml2(item.category)}</span>` : "") + (isOut ? '<span class="kiosk-suggestion-category">already out</span>' : "");
    if (!isOut) btn.onclick = () => _checkout(item);
    container.appendChild(btn);
  }
}
async function _updateTypeahead() {
  const input = document.getElementById("kiosk-need");
  if (!input) return;
  const query = input.value.trim();
  if (!query) {
    _renderSuggestions([], "");
    return;
  }
  const pickable = await getKioskPickableItems();
  const scored = pickable.map((entry) => ({
    entry,
    score: _fuzzyScore(query, entry.item.nameLower || entry.item.name)
  })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || (a.entry.isOut ? 1 : 0) - (b.entry.isOut ? 1 : 0)).slice(0, 5).map((x) => x.entry);
  _renderSuggestions(scored, query);
}
async function _handleCommit() {
  const input = document.getElementById("kiosk-need");
  if (!input) return;
  const query = input.value.trim();
  if (!query) {
    showToast("Pick an item from the list", {
      type: "error"
    });
    input.focus();
    return;
  }
  await openDB();
  const pickable = await getKioskPickableItems();
  const q = query.toLowerCase();
  const nameOf = (e) => (e.item.nameLower || e.item.name || "").toLowerCase();
  // Exact first, then prefix -- but only among items that are actually on the
  // shelf. A taken item must not be silently checked out, and an unknown string
  // must not become a catalog row.
  const match = pickable.find((e) => !e.isOut && nameOf(e) === q) || pickable.find((e) => !e.isOut && nameOf(e).startsWith(q));
  if (match) {
    await _checkout(match.item);
    return;
  }
  const taken = pickable.find((e) => e.isOut && (nameOf(e) === q || nameOf(e).startsWith(q)));
  if (taken) {
    showToast(`${taken.item.name} is already out. Ask the front desk.`, {
      type: "error",
      duration: 4e3
    });
    return;
  }
  showToast("That item is not on the list. Please ask the front desk.", {
    type: "error",
    duration: 4e3
  });
}
async function _checkout(item) {
  if (!state.borrower || state.borrower.id == null) {
    showToast("Please enter your phone number first", {
      type: "error"
    });
    goToScreen(KIOSK_SCREENS.borrowPhone);
    return;
  }
  await openDB();
  const dueAt = await getKioskDueAt();
  try {
    await createLoan({
      itemId: item.id,
      borrowerId: state.borrower.id,
      checkedOutAt: Date.now(),
      dueAt,
      conditionOut: "good",
      notes: "kiosk self-checkout"
    });
    const doneText = document.getElementById("kiosk-done-text");
    if (doneText) doneText.textContent = item.name;
    goToScreen(KIOSK_SCREENS.borrowDone);
    _startDoneCountdown();
    state.phone = null;
    state.borrower = null;
    state.isNew = false;
    const input = document.getElementById("kiosk-need");
    if (input) input.value = "";
    const suggestEl = document.getElementById("kiosk-need-suggestions");
    if (suggestEl) suggestEl.innerHTML = "";
  } catch (err) {
    // Two people can be at the same item at once, so the availability filter
    // upstream is a hint, not a guarantee -- the transaction is the real guard.
    if (err && err.code === "ALREADY_OUT") {
      showToast(`${item.name} was just taken by someone else. Please ask the front desk.`, {
        type: "error",
        duration: 5e3
      });
      await _updateTypeahead();
      return;
    }
    showToast("Failed: " + err.message, {
      type: "error"
    });
  }
}
var KIOSK_DONE_TIMEOUT_MS = 3e4;
var _doneCountdownTick = null;
var _doneCountdownTimer = null;
function _startDoneCountdown() {
  _cancelDoneCountdown();
  const numEl = document.getElementById("kiosk-done-countdown-num");
  const containerEl = document.getElementById("kiosk-done-countdown");
  if (!numEl || !containerEl) return;
  let remaining = Math.ceil(KIOSK_DONE_TIMEOUT_MS / 1e3);
  numEl.textContent = String(remaining);
  containerEl.classList.remove("hidden");
  _doneCountdownTick = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      _cancelDoneCountdown();
      _kioskBackHome();
      return;
    }
    numEl.textContent = String(remaining);
  }, 1e3);
  _doneCountdownTimer = setTimeout(() => {
    _cancelDoneCountdown();
    _kioskBackHome();
  }, KIOSK_DONE_TIMEOUT_MS);
}
function _cancelDoneCountdown() {
  if (_doneCountdownTick) {
    clearInterval(_doneCountdownTick);
    _doneCountdownTick = null;
  }
  if (_doneCountdownTimer) {
    clearTimeout(_doneCountdownTimer);
    _doneCountdownTimer = null;
  }
  const containerEl = document.getElementById("kiosk-done-countdown");
  if (containerEl) containerEl.classList.add("hidden");
}
function _kioskBackHome() {
  _cancelDoneCountdown();
  state.phone = null;
  state.borrower = null;
  state.isNew = false;
  const ids = [
    "kiosk-phone",
    "kiosk-name",
    "kiosk-need",
    "kiosk-return-phone"
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  }
  const suggestEl = document.getElementById("kiosk-need-suggestions");
  if (suggestEl) suggestEl.innerHTML = "";
  goToScreen("welcome");
}
async function handleReturnPhoneSubmit() {
  const input = document.getElementById("kiosk-return-phone");
  if (!input) return;
  const raw = input.value.replace(/\D/g, "").slice(-10);
  if (raw.length !== 10) {
    showToast("Please enter a 10-digit phone number", {
      type: "error"
    });
    input.focus();
    return;
  }
  await openDB();
  const matches = await findBorrowerByPhone(raw);
  if (matches.length === 0) {
    _showSignInPrompt(raw);
    return;
  }
  if (matches.length > 1) {
    _showBorrowerPicker(matches, raw, KIOSK_SCREENS.returnItems);
    return;
  }
  state.borrower = matches[0];
  state.phone = raw;
  await _renderReturnList();
  goToScreen(KIOSK_SCREENS.returnItems);
}
window.__handleReturnPhoneSubmit = handleReturnPhoneSubmit;
function _showSignInPrompt(phone) {
  const continueBtn = document.querySelector('[data-action="kiosk-return-phone-continue"]');
  if (continueBtn) continueBtn.style.display = "none";
  const existingPicker = document.querySelector(".kiosk-borrower-picker");
  if (existingPicker) existingPicker.remove();
  const phoneScreen = document.getElementById("screen-kiosk-return-phone");
  if (!phoneScreen) return;
  const body = phoneScreen.querySelector(".kiosk-flow-body");
  if (!body) return;
  const panel = document.createElement("div");
  panel.className = "kiosk-signin-panel";
  panel.innerHTML = `
    <div class="kiosk-signin-card">
      <div class="kiosk-signin-icon">\u2753</div>
      <div class="kiosk-signin-title">We don't have an account for (${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6, 10)} on this device</div>
      <div class="kiosk-signin-sub">If you used the kiosk before, your data is on the device you used. Want to sign in here?</div>
      <input type="text" class="input input-xl kiosk-input" id="kiosk-signin-name" placeholder="Your name" maxlength="100" autocomplete="off" />
      <div class="kiosk-signin-actions">
        <button class="btn btn-primary btn-xl kiosk-cta" data-action="kiosk-signin-create">SIGN IN HERE</button>
        <button class="btn btn-ghost kiosk-cta-secondary" data-action="kiosk-signin-cancel">Cancel</button>
      </div>
    </div>
  `;
  body.appendChild(panel);
  panel.querySelector('[data-action="kiosk-signin-create"]').onclick = async () => {
    const nameInput2 = panel.querySelector("#kiosk-signin-name");
    const name = nameInput2?.value?.trim();
    if (!name) {
      showToast("Please enter your name", {
        type: "error"
      });
      nameInput2?.focus();
      return;
    }
    try {
      await openDB();
      const borrower = await upsertBorrower({
        phone,
        name
      });
      state.borrower = borrower;
      state.phone = phone;
      panel.remove();
      if (continueBtn) continueBtn.style.display = "";
      await _renderReturnList();
      goToScreen(KIOSK_SCREENS.returnItems);
      showToast(`Welcome, ${name}!`, {
        type: "success"
      });
    } catch (err) {
      showToast("Failed: " + err.message, {
        type: "error"
      });
    }
  };
  panel.querySelector('[data-action="kiosk-signin-cancel"]').onclick = () => {
    panel.remove();
    if (continueBtn) continueBtn.style.display = "";
    const phoneInput = document.getElementById("kiosk-return-phone");
    if (phoneInput) {
      phoneInput.value = "";
      phoneInput.focus();
    }
  };
  setTimeout(() => {
    const nameInput2 = panel.querySelector("#kiosk-signin-name");
    if (nameInput2) nameInput2.focus();
  }, 100);
  const nameInput = panel.querySelector("#kiosk-signin-name");
  if (nameInput) {
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        panel.querySelector('[data-action="kiosk-signin-create"]').click();
      }
    });
  }
}
async function _renderReturnList() {
  const now = Date.now();
  const greetEl = document.getElementById("kiosk-return-greeting-name");
  if (greetEl) greetEl.textContent = state.borrower.name;
  const listEl = document.getElementById("kiosk-return-list");
  if (!listEl) return;
  listEl.innerHTML = "";
  if (state.borrower.isWalkIn) {
    const empty = document.createElement("div");
    empty.className = "kiosk-return-empty";
    empty.innerHTML = `
      <div class="kiosk-return-empty-icon">\u{1F6CE}\uFE0F</div>
      <div class="kiosk-return-empty-title">Please ask staff for help</div>
      <div class="kiosk-return-empty-body">
        Walk-in returns can't be processed at the kiosk. A staff member will help you at the desk.
      </div>
    `;
    listEl.appendChild(empty);
    const subEl2 = document.querySelector("#screen-kiosk-return-items .kiosk-step-sub");
    if (subEl2) {
      const phone = state.phone || "";
      subEl2.textContent = `Signed in as ${state.borrower.name}${phone ? " \xB7 (" + phone.slice(0, 3) + ") " + phone.slice(3, 6) + "-" + phone.slice(6, 10) : ""}`;
    }
    return;
  }
  const allOpen = await getOpenLoans();
  const myLoans = allOpen.filter((l) => l.borrowerId === state.borrower.id);
  // Handed-back-but-unconfirmed first: those are the ones the borrower still has
  // to act on (hand to the desk), so they belong at the top of the list.
  myLoans.sort((a, b) => {
    const aPending = a.returnRequestedAt ? 1 : 0;
    const bPending = b.returnRequestedAt ? 1 : 0;
    if (aPending !== bPending) return bPending - aPending;
    const aOverdue = a.dueAt < now ? 1 : 0;
    const bOverdue = b.dueAt < now ? 1 : 0;
    if (aOverdue !== bOverdue) return bOverdue - aOverdue;
    return a.dueAt - b.dueAt;
  });
  const pendingCount = myLoans.filter((l) => l.returnRequestedAt).length;
  if (myLoans.length > 0) {
    const section = document.createElement("div");
    section.className = "kiosk-return-section-title";
    section.textContent = pendingCount > 0
      ? `TO RETURN (${myLoans.length - pendingCount}) \xB7 WAITING FOR STAFF (${pendingCount})`
      : `TO RETURN (${myLoans.length})`;
    listEl.appendChild(section);
    for (const loan of myLoans) {
      listEl.appendChild(_makeReturnRow(loan, now));
    }
  } else {
    const empty = document.createElement("div");
    empty.className = "kiosk-return-empty";
    empty.innerHTML = `
      <div class="kiosk-return-empty-icon">\u2705</div>
      <div class="kiosk-return-empty-title">You're all clear</div>
      <div class="kiosk-return-empty-body">
        You don't have any items checked out. Have a good one!
      </div>
    `;
    listEl.appendChild(empty);
  }
  const subEl = document.querySelector("#screen-kiosk-return-items .kiosk-step-sub");
  if (subEl) {
    const phone = state.phone || "";
    subEl.textContent = `Signed in as ${state.borrower.name} \xB7 (${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6, 10)} \xB7 hand items to the front desk`;
  }
}
function _showBorrowerPicker(matches, phone, thenScreen) {
  const listEl = document.getElementById("kiosk-return-list");
  if (!listEl) return;
  const continueBtn = document.querySelector('[data-action="kiosk-return-phone-continue"]');
  if (continueBtn) continueBtn.style.display = "none";
  listEl.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "kiosk-borrower-picker";
  wrap.innerHTML = `<div class="kiosk-picker-hint">We found multiple people on this phone. Which one are you?</div>`;
  for (const b of matches) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "kiosk-picker-card";
    card.innerHTML = `
      <div class="kiosk-picker-name">${escapeHtml2(b.name || "Unknown")}</div>
      <div class="kiosk-picker-meta">${b.timesCheckedOut || 0}\xD7 out${b.lastSeenAt ? " \xB7 last seen " + agoLabel(Date.now() - b.lastSeenAt) : ""}</div>
    `;
    card.onclick = async () => {
      state.borrower = b;
      state.phone = phone;
      state.isNew = false;
      if (continueBtn) continueBtn.style.display = "";
      wrap.remove();
      if (thenScreen === KIOSK_SCREENS.returnItems) {
        await _renderReturnList();
        goToScreen(KIOSK_SCREENS.returnItems);
      } else {
        const greetEl = document.getElementById("kiosk-greeting-name");
        if (greetEl) greetEl.textContent = b.name || "there";
        goToScreen(KIOSK_SCREENS.borrowNeed);
        setTimeout(() => {
          const need = document.getElementById("kiosk-need");
          if (need) need.focus();
        }, 100);
      }
    };
    wrap.appendChild(card);
  }
  // Mount on whichever screen is on top right now: the return list when the
  // return flow asks, the phone screen when the borrow flow does.
  listEl.appendChild(wrap);
  const host = document.querySelector(".screen:not(.hidden)");
  if (host && !host.contains(wrap)) {
    const body = host.querySelector(".kiosk-flow-body");
    if (body) body.appendChild(wrap);
  }
}
function _makeReturnRow(loan, now) {
  const row = document.createElement("div");
  const isOverdue = loan.dueAt < now;
  const isPending = !!loan.returnRequestedAt;
  row.className = "kiosk-return-item" + (isOverdue ? " is-overdue" : "") + (isPending ? " is-pending" : "");
  const outText = loan.checkedOutAt ? agoLabel(now - loan.checkedOutAt) : "";
  const dueText = loan.dueAt ? isOverdue ? `<span class="kiosk-return-item-overdue">Overdue by ${formatRelativeTime(loan.dueAt - now)}</span>` : `Due in ${formatRelativeTime(loan.dueAt - now)}` : "";
  if (isPending) {
    // Tapping again must not do anything: the request is already in the staff
    // queue, and letting it be re-sent would just overwrite the condition the
    // borrower reported.
    row.innerHTML = `
      <div class="kiosk-return-item-name">${escapeHtml2(loan.itemNameSnapshot || "Item")}</div>
      <div class="kiosk-return-item-meta">
        <span>Handed over ${escapeHtml2(agoLabel(Date.now() - loan.returnRequestedAt))}</span>
        <span class="kiosk-return-item-pending">Waiting for the front desk to confirm</span>
      </div>
    `;
    return row;
  }
  row.innerHTML = `
    <div class="kiosk-return-item-name">${escapeHtml2(loan.itemNameSnapshot || "Item")}</div>
    <div class="kiosk-return-item-meta">
      <span>Out ${escapeHtml2(outText)}</span>
      <span>${dueText}</span>
    </div>
  `;
  row.onclick = () => _confirmAndReturnLoan(loan);
  return row;
}
async function _confirmAndReturnLoan(loan) {
  const now = Date.now();
  const isOverdue = loan.dueAt && loan.dueAt < now;
  const overdueText = isOverdue ? `<div style="background:rgba(231,76,60,0.15); color:#e74c3c; padding:8px 12px; border-radius:6px; font-weight:600; margin-top:8px;">\u26A0\uFE0F Overdue by ${formatRelativeTime(loan.dueAt - now)}</div>` : "";
  const dueText = loan.dueAt && !isOverdue ? `<div>Due: ${new Date(loan.dueAt).toLocaleString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  })}</div>` : "";
  const confirmed = await _confirmDialog("Return this item?", `<div style="text-align:left; padding:4px 0;">
       <div style="font-size:22px; font-weight:700; margin-bottom:12px; color:var(--text);">${escapeHtml2(loan.itemNameSnapshot || "Item")}</div>
       <div style="color:var(--text-muted); font-size:14px; line-height:1.6;">
         <div><strong>Out:</strong> ${loan.checkedOutAt ? new Date(loan.checkedOutAt).toLocaleString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }) : "\u2014"}</div>
         ${dueText}
       </div>
       ${overdueText}
     </div>
     <div style="margin-top:12px; padding:10px; background:var(--bg-alt, rgba(255,255,255,0.05)); border-radius:6px; font-size:13px; color:var(--text-muted);">
       Hand it to the front desk and they will close it off. Nothing is marked returned until they do.
     </div>`, {
    danger: true,
    confirmLabel: "Yes, I'm handing it in"
  });
  if (!confirmed) return;
  // Condition is asked for, not assumed. This used to hardcode "good", so
  // "Damaged"/"Lost" could never be recorded from a kiosk return even though the
  // item detail screen counts them.
  const condition = await _askCondition(loan);
  if (!condition) return;
  try {
    await openDB();
    await requestLoanReturn(loan.id, condition);
    showToast("Thanks! Please hand it to the front desk to finish.", {
      type: "success",
      duration: 5e3
    });
    await _renderReturnList();
  } catch (err) {
    showToast("Failed: " + err.message, {
      type: "error"
    });
  }
}
/**
 * Ask how the item is coming back. Resolves to { conditionIn, note } or null if
 * the borrower backs out.
 *
 * Built as an inline panel on the kiosk screen rather than through the shared
 * dialog: the kiosk look is bigger and touch-first, and the two-step "something's
 * wrong -> say what" needs a dialog that stays open between steps, which the
 * promise adapter around showDialog cannot do (it closes on the first click).
 */
function _askCondition(loan) {
  return new Promise((resolve) => {
    const host = document.querySelector(".screen:not(.hidden)");
    const body = host && host.querySelector(".kiosk-flow-body");
    if (!body) {
      resolve(null);
      return;
    }
    const panel = document.createElement("div");
    panel.className = "kiosk-signin-panel";
    panel.innerHTML = `
      <div class="kiosk-signin-card">
        <div class="kiosk-condition-title">${escapeHtml2(loan.itemNameSnapshot || "Item")}</div>
        <div class="kiosk-signin-sub">Is it coming back in good shape?</div>
        <div class="kiosk-condition-actions">
          <button type="button" class="btn btn-primary btn-xl kiosk-cta" data-cond="good">All good</button>
          <button type="button" class="btn btn-secondary btn-xl kiosk-cta" data-cond="damaged">Something's wrong</button>
        </div>
        <div data-role="note-wrap" class="kiosk-condition-note hidden">
          <input type="text" class="input input-xl kiosk-input" data-role="note" maxlength="300" placeholder="e.g. one key is bent, cable missing" autocomplete="off" />
          <button type="button" class="btn btn-primary btn-xl kiosk-cta" data-role="note-submit">SEND TO FRONT DESK</button>
        </div>
        <button type="button" class="btn btn-ghost kiosk-cta-secondary" data-role="cancel">Cancel</button>
      </div>
    `;
    body.appendChild(panel);
    const done = (value) => {
      panel.remove();
      resolve(value);
    };
    const noteWrap = panel.querySelector('[data-role="note-wrap"]');
    const noteInput = panel.querySelector('[data-role="note"]');
    panel.querySelector('[data-cond="good"]').onclick = () => done({
      conditionIn: "good",
      note: ""
    });
    panel.querySelector('[data-cond="damaged"]').onclick = () => {
      noteWrap.classList.remove("hidden");
      noteInput.focus();
    };
    panel.querySelector('[data-role="note-submit"]').onclick = () => {
      const note = (noteInput.value || "").trim();
      if (!note) {
        showToast("Please say what's wrong, or tap All good.", {
          type: "error"
        });
        noteInput.focus();
        return;
      }
      done({
        conditionIn: "damaged",
        note
      });
    };
    panel.querySelector('[data-role="cancel"]').onclick = () => done(null);
  });
}
function _confirmDialog(title, bodyHtml, opts = {}) {
  const cancelLabel = opts.cancelLabel || "Cancel";
  const confirmLabel = opts.confirmLabel || (opts.danger ? "Confirm" : "OK");
  return new Promise((resolve) => {
    Promise.resolve().then(() => (init_ui(), ui_exports)).then(({ showDialog: showDialog2 }) => {
      showDialog2({
        title,
        body: bodyHtml,
        // Pass the buttons through with explicit labels. The default
        // dismissible=true lets the user tap the backdrop to cancel,
        // which is fine for confirmations — but for "return item" we
        // want them to commit to a choice. We pass dismissible: true
        // here too so they can back out if they tapped by accident.
        dismissible: !opts.sticky,
        buttons: [
          {
            label: cancelLabel,
            value: false,
            variant: "ghost"
          },
          {
            label: confirmLabel,
            value: true,
            variant: opts.danger ? "danger" : "primary"
          }
        ]
      }).then((v) => resolve(!!v));
    }).catch(() => resolve(false));
  });
}
function escapeHtml2(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

// ../frontdesk/modules/admin.js
var ACTIVE_TAB_KEY = "frontdesk.adminTab";
var _wiredOnce = false;
var adminLoginReturn = null;
var ADMIN_IDLE_MS = 5 * 60 * 1e3;
var _adminIdleTimer = null;
// Failed-PIN throttling. The default PIN is 4 digits, so an unattended tablet
// could be worked through by hand in a couple of minutes. Counters live in
// settings (not just memory) so a reload does not clear the lockout.
var _pinFailures = 0;
var _pinLockedUntil = 0;
var PIN_FREE_ATTEMPTS = 5;
var PIN_BASE_LOCK_MS = 30 * 1e3;
var PIN_MAX_LOCK_MS = 5 * 60 * 1e3;
// The admin session used to stay unlocked forever: staff could open the panel,
// walk away, and the next person at the tablet could read every name, phone
// number, note and loan in the system. Drop back to the login screen when idle.
function touchAdminSession() {
  if (getCurrentScreen() !== "admin" && getCurrentScreen() !== "admin-detail") return;
  if (_adminIdleTimer) clearTimeout(_adminIdleTimer);
  _adminIdleTimer = setTimeout(() => {
    if (getCurrentScreen() === "admin" || getCurrentScreen() === "admin-detail") {
      goToScreen("admin-login");
      Promise.resolve().then(() => (init_ui(), ui_exports)).then((m) => m.showInfo("Admin panel locked after 5 minutes of inactivity.")).catch(() => {
      });
    }
  }, ADMIN_IDLE_MS);
}
function endAdminSession() {
  if (_adminIdleTimer) {
    clearTimeout(_adminIdleTimer);
    _adminIdleTimer = null;
  }
}
function cancelAdminLogin() {
  // Return to wherever the login was opened from. This used to be a hard-coded
  // goToScreen("home"), so on the public kiosk "Staff: Admin Login" followed by
  // "Cancel" dropped an unattended stranger onto the unrestricted staff home
  // screen, one tap away from checking out and returning other people's items.
  const target = adminLoginReturn || "home";
  adminLoginReturn = null;
  const login = document.getElementById("screen-admin-login");
  const pinInput = login && login.querySelector(".pin-input");
  if (pinInput) pinInput.value = "";
  goToScreen(target);
  if (target === "home") refreshHome();
}
function showAdminLogin() {
  const from = getCurrentScreen();
  adminLoginReturn = from && from !== "admin-login" && from !== "splash" ? from : "home";
  // Leaving the kiosk is only ever granted here, from the deliberate hold gesture.
  if (isKioskScreen(from)) _kioskExitGranted = true;
  goToScreen("admin-login");
  const root = document.getElementById("screen-admin-login");
  if (!root) return;
  const pinInput = root.querySelector(".pin-input");
  const submit = root.querySelector(".pin-submit");
  if (pinInput) {
    setTimeout(() => {
      try {
        pinInput.focus();
      } catch (_) {
      }
    }, 50);
    pinInput.value = "";
    pinInput.onkeydown = (e) => {
      if (e.key === "Enter") submit?.click();
    };
  }
  if (submit && !submit.dataset.wired) {
    submit.onclick = () => verifyPin(pinInput.value);
    submit.dataset.wired = "1";
  }
}
async function verifyPin(pin) {
  const settings = await getSettings();
  // Rehydrate the lockout from settings on first use this session, so closing and
  // reopening the app is not a way to clear it.
  if (_pinFailures === 0 && _pinLockedUntil === 0) {
    _pinFailures = settings.pinFailures || 0;
    _pinLockedUntil = settings.pinLockedUntil || 0;
  }
  const now = Date.now();
  if (_pinLockedUntil > now) {
    const secs = Math.ceil((_pinLockedUntil - now) / 1e3);
    showToast(`Too many wrong PINs. Try again in ${secs}s.`, {
      type: "error",
      duration: 4e3
    });
    _clearPinField();
    return false;
  }
  if (String(pin).trim() === String(settings.pin)) {
    if (_pinFailures || _pinLockedUntil) {
      _pinFailures = 0;
      _pinLockedUntil = 0;
      await updateSettings({
        pinFailures: 0,
        pinLockedUntil: 0
      });
    }
    await showAdmin();
    return true;
  }
  _pinFailures += 1;
  const over = _pinFailures - PIN_FREE_ATTEMPTS;
  if (over >= 0) {
    // 30s, 60s, 2m, ... capped at 5 minutes. Escalating rather than fixed so a
    // determined guesser gets slower while a fat-fingered staff member is not
    // locked out for long.
    _pinLockedUntil = now + Math.min(PIN_BASE_LOCK_MS * 2 ** over, PIN_MAX_LOCK_MS);
    showToast(`Wrong PIN. Locked for ${Math.ceil((_pinLockedUntil - now) / 1e3)}s.`, {
      type: "error",
      duration: 5e3
    });
  } else {
    showToast(`Wrong PIN. ${PIN_FREE_ATTEMPTS - _pinFailures} attempt${PIN_FREE_ATTEMPTS - _pinFailures === 1 ? "" : "s"} left.`, {
      type: "error",
      duration: 4e3
    });
  }
  updateSettings({
    pinFailures: _pinFailures,
    pinLockedUntil: _pinLockedUntil
  }).catch(() => {
  });
  const root = document.getElementById("screen-admin-login");
  const pinInput = root?.querySelector(".pin-input");
  if (pinInput) {
    pinInput.classList.remove("animate-success");
    void pinInput.offsetWidth;
    pinInput.style.animation = "none";
    setTimeout(() => {
      pinInput.style.animation = "";
    }, 10);
    // Clear the field: leaving the rejected digits in place let the next tap
    // append to them rather than start over.
    pinInput.value = "";
  }
  return false;
}
// Shared by every failed-PIN path so the rejected digits never linger in the box.
function _clearPinField() {
  const root = document.getElementById("screen-admin-login");
  const pinInput = root?.querySelector(".pin-input");
  if (pinInput) pinInput.value = "";
}
async function showAdmin() {
  goToScreen("admin");
  _wireAdminChrome();
  _restoreActiveTab();
  touchAdminSession();
  await renderAdminStats();
  await renderRecentKiosk();
  await _renderActiveTab();
}
async function showItemDetail(itemId) {
  goToScreen("admin-detail", {
    data: {
      kind: "item",
      id: itemId
    }
  });
  const root = document.getElementById("screen-admin-detail");
  if (!root) return;
  const titleEl = root.querySelector(".detail-title");
  const content = root.querySelector(".detail-content");
  if (titleEl) titleEl.textContent = "Item";
  if (content) {
    content.innerHTML = '<p style="text-align:center; padding:32px;">Loading\u2026</p>';
  }
  try {
    const item = await get("items", itemId);
    if (!item) {
      if (content) content.innerHTML = "<p>Item not found.</p>";
      return;
    }
    if (titleEl) titleEl.textContent = item.name;
    const loans = await getLoansForItem(itemId);
    const openLoan = loans.find(isLoanOpen) || null;
    const closed = loans.filter((l) => !isLoanOpen(l));
    const durations = closed.map((l) => l.returnedAt && l.checkedOutAt ? l.returnedAt - l.checkedOutAt : 0).filter((d) => d > 0);
    const avgMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const damageCount = closed.filter((l) => l.conditionIn === "damaged").length;
    const lostCount = closed.filter((l) => l.conditionIn === "lost").length;
    content.innerHTML = `
      <div class="return-card">
        <div class="return-item">
          <div class="item-name" style="font-size:24px; margin-bottom:8px;">${escapeHtml3(item.name)}</div>
          <div class="loan-meta">${escapeHtml3(item.category || "Other")} \xB7 ${escapeHtml3(item.location || "no location")}</div>
          <div class="loan-meta" style="margin-top:8px;">Condition: <strong>${escapeHtml3(item.condition || "good")}</strong></div>
          <div class="loan-meta">Checked out <strong>${item.timesCheckedOut || 0}</strong> times total</div>
          ${item.lastCheckedOutAt ? `<div class="loan-meta">Last: ${formatAbsoluteTime(item.lastCheckedOutAt)}</div>` : ""}
          ${item.notes ? `<div class="loan-meta" style="margin-top:8px; font-style:italic;">${escapeHtml3(item.notes)}</div>` : ""}
        </div>
        <div style="display:flex; gap:12px; margin-top:16px; flex-wrap:wrap;">
          <button class="btn btn-secondary" data-action="edit-item">Edit</button>
          <button class="btn btn-ghost" data-action="archive-item">${item.isArchived ? "Unarchive" : "Archive"}</button>
        </div>
      </div>

      ${openLoan ? `
        <div class="loan-section">
          <h3 class="section-title">CURRENTLY OUT</h3>
          <div id="open-loan-row"></div>
        </div>
      ` : ""}

      <div class="loan-section">
        <h3 class="section-title">STATS</h3>
        <div class="return-card" style="display:flex; gap:24px; flex-wrap:wrap;">
          <div><div class="loan-meta">Avg duration</div><div style="font-size:20px; font-weight:600;">${formatRelativeTime(avgMs) || "\u2014"}</div></div>
          <div><div class="loan-meta">Damaged</div><div style="font-size:20px; font-weight:600; color:var(--warning);">${damageCount}</div></div>
          <div><div class="loan-meta">Lost</div><div style="font-size:20px; font-weight:600; color:var(--error);">${lostCount}</div></div>
        </div>
      </div>

      <div class="loan-section">
        <h3 class="section-title">ALL LOANS (${loans.length})</h3>
        <div class="admin-list" id="item-loans-list"></div>
      </div>
    `;
    if (openLoan) {
      const row = await _makeOpenLoanRow(openLoan);
      content.querySelector("#open-loan-row").appendChild(row);
    }
    const list = content.querySelector("#item-loans-list");
    for (const loan of closed) list.appendChild(_makeClosedLoanRow(loan));
    content.querySelector('[data-action="edit-item"]')?.addEventListener("click", () => _editItem(item));
    content.querySelector('[data-action="archive-item"]')?.addEventListener("click", () => _archiveItem(item));
  } catch (err) {
    if (content) content.innerHTML = `<p style="color:var(--error);">Error: ${escapeHtml3(err.message)}</p>`;
  }
}
async function showBorrowerDetail(borrowerId) {
  goToScreen("admin-detail", {
    data: {
      kind: "borrower",
      id: borrowerId
    }
  });
  const root = document.getElementById("screen-admin-detail");
  if (!root) return;
  const titleEl = root.querySelector(".detail-title");
  const content = root.querySelector(".detail-content");
  if (titleEl) titleEl.textContent = "Borrower";
  if (content) {
    content.innerHTML = '<p style="text-align:center; padding:32px;">Loading\u2026</p>';
  }
  try {
    const borrower = await getBorrower(borrowerId);
    if (!borrower) {
      if (content) content.innerHTML = "<p>Borrower not found.</p>";
      return;
    }
    if (titleEl) titleEl.textContent = borrower.name;
    const loans = await getLoansForBorrower(borrowerId);
    const openLoans = loans.filter(isLoanOpen);
    const closed = loans.filter((l) => !isLoanOpen(l));
    const allBorrowers = await listBorrowers({
      includeArchived: true
    });
    const phoneMatches = allBorrowers.filter((b) => b.phone === borrower.phone);
    const itemCounts = /* @__PURE__ */ new Map();
    for (const l of closed) {
      itemCounts.set(l.itemNameSnapshot, (itemCounts.get(l.itemNameSnapshot) || 0) + 1);
    }
    const topItems = [
      ...itemCounts.entries()
    ].sort((a, b) => b[1] - a[1]).slice(0, 5);
    content.innerHTML = `
      <div class="return-card">
        <div class="return-borrower">
          <div class="return-name" style="font-size:24px;">${escapeHtml3(borrower.name)}</div>
          <div class="return-phone">${escapeHtml3(formatPhone(borrower.phone))}</div>
          ${borrower.contact2 ? `<div class="return-phone">${escapeHtml3(borrower.contact2)}</div>` : ""}
        </div>
        <div class="loan-meta">Checked out <strong>${borrower.timesCheckedOut || 0}</strong> times</div>
        ${borrower.lastSeenAt ? `<div class="loan-meta">Last seen: ${formatAbsoluteTime(borrower.lastSeenAt)}</div>` : ""}
        ${borrower.notes ? `<div class="loan-meta" style="margin-top:8px; font-style:italic;">${escapeHtml3(borrower.notes)}</div>` : ""}
        <div style="display:flex; gap:12px; margin-top:16px; flex-wrap:wrap;">
          <button class="btn btn-secondary" data-action="edit-borrower">Edit</button>
          <button class="btn btn-secondary" data-action="merge-borrower">Merge with\u2026</button>
          <button class="btn btn-ghost" data-action="archive-borrower">${borrower.isArchived ? "Unarchive" : "Archive"}</button>
        </div>
      </div>

      ${openLoans.length > 0 ? `
        <div class="loan-section">
          <h3 class="section-title">CURRENTLY HELD (${openLoans.length})</h3>
          <div class="admin-list" id="open-loans-borrower"></div>
        </div>
      ` : ""}

      ${topItems.length > 0 ? `
        <div class="loan-section">
          <h3 class="section-title">TOP ITEMS</h3>
          <div class="admin-list">
            ${topItems.map(([name, count]) => `<div class="admin-list-item" style="cursor:default;"><div style="flex:1;">${escapeHtml3(name)}</div><div class="item-count">${count}\xD7</div></div>`).join("")}
          </div>
        </div>
      ` : ""}

      <div class="loan-section">
        <h3 class="section-title">ALL LOANS (${loans.length})</h3>
        <div class="admin-list" id="borrower-loans-list"></div>
      </div>

      ${phoneMatches.length > 1 ? `
        <div class="loan-section">
          <h3 class="section-title">SAME PHONE (${phoneMatches.length} borrowers)</h3>
          <div class="admin-list">
            ${phoneMatches.map((b) => `<div class="admin-list-item" data-borrower-id="${b.id}"><div style="flex:1;">${escapeHtml3(b.name)}</div><div class="loan-meta">${b.timesCheckedOut || 0}\xD7</div></div>`).join("")}
          </div>
        </div>
      ` : ""}
    `;
    const openWrap = content.querySelector("#open-loans-borrower");
    for (const loan of openLoans) openWrap.appendChild(await _makeOpenLoanRow(loan));
    const list = content.querySelector("#borrower-loans-list");
    for (const loan of closed.slice(0, 100)) list.appendChild(_makeClosedLoanRow(loan));
    if (closed.length > 100) {
      const more = document.createElement("div");
      more.className = "loan-meta";
      more.style.padding = "12px";
      more.textContent = `\u2026and ${closed.length - 100} more`;
      list.appendChild(more);
    }
    content.querySelector('[data-action="edit-borrower"]')?.addEventListener("click", () => _editBorrower(borrower));
    content.querySelector('[data-action="merge-borrower"]')?.addEventListener("click", () => _mergeBorrower(borrower));
    content.querySelector('[data-action="archive-borrower"]')?.addEventListener("click", () => _archiveBorrower(borrower));
    content.querySelectorAll("[data-borrower-id]").forEach((el) => {
      el.addEventListener("click", () => showBorrowerDetail(Number(el.dataset.borrowerId)));
    });
  } catch (err) {
    if (content) content.innerHTML = `<p style="color:var(--error);">Error: ${escapeHtml3(err.message)}</p>`;
  }
}
async function renderAdminStats() {
  const header = document.querySelector("#screen-admin .admin-stats");
  if (!header) return;
  try {
    const counts = await countLoansByStatus();
    const items = await listItems({
      includeArchived: true
    });
    const borrowers = await listBorrowers({
      includeArchived: true
    });
    const pendingReturns = await getPendingReturns();
    header.innerHTML = `
      <span class="stat">Out: <strong>${counts.out}</strong></span>
      <span class="stat overdue">Overdue: <strong>${counts.overdue}</strong></span>
      ${pendingReturns.length > 0 ? `<span class="stat" style="color:var(--info);">Returns to confirm: <strong>${pendingReturns.length}</strong></span>` : ""}
      <span class="stat">Items: <strong>${items.length}</strong></span>
      <span class="stat">People: <strong>${borrowers.length}</strong></span>
    `;
  } catch (err) {
    // Swallowing this left the last good counts on screen, or -- on a first
    // render -- an empty bar, either way with nothing to say the numbers are
    // not current. A staff member cannot tell a library with nothing overdue
    // from a database that did not answer, and the answer matters. Say so.
    console.error("renderAdminStats failed", err);
    header.innerHTML = '<span class="stat" style="color:var(--error);">Counts unavailable</span>';
  }
}
async function renderRecentKiosk() {
  const container = document.getElementById("admin-recent-kiosk");
  if (!container) return;
  try {
    const allLoans = await getOpenLoans();
    const tenMinAgo = Date.now() - 10 * 60 * 1e3;
    const recent = allLoans.filter((l) => l.notes === "kiosk self-checkout" && (l.checkedOutAt || 0) > tenMinAgo).sort((a, b) => (b.checkedOutAt || 0) - (a.checkedOutAt || 0));
    if (recent.length === 0) {
      container.classList.add("hidden");
      return;
    }
    const dismissedAt = parseInt(sessionStorage.getItem("admin-recent-kiosk-dismissed") || "0", 10);
    const newest = recent[0]?.checkedOutAt || 0;
    if (dismissedAt && dismissedAt >= newest) {
      container.classList.add("hidden");
      return;
    }
    const lines = recent.slice(0, 3).map((l) => {
      const ago = formatRelativeTime(Date.now() - (l.checkedOutAt || 0));
      const who = l.borrowerNameSnapshot || (l.borrowerPhoneSnapshot ? formatPhone(l.borrowerPhoneSnapshot) : "walk-in");
      return `<strong>${escapeHtml3(l.itemNameSnapshot || "?")}</strong> \u2192 ${escapeHtml3(who)} (${ago})`;
    });
    const more = recent.length > 3 ? ` <span style="color:var(--text-muted);">+${recent.length - 3} more</span>` : "";
    container.innerHTML = `
      <div class="admin-recent-kiosk-text">\u{1F4F2} Self-checkout: ${lines.join(" \xB7 ")}${more}</div>
      <button class="admin-recent-kiosk-dismiss" data-action="dismiss-recent-kiosk" aria-label="Dismiss">\xD7</button>
    `;
    container.classList.remove("hidden");
    const dismissBtn = container.querySelector('[data-action="dismiss-recent-kiosk"]');
    if (dismissBtn) {
      dismissBtn.onclick = () => {
        sessionStorage.setItem("admin-recent-kiosk-dismissed", String(Date.now()));
        container.classList.add("hidden");
      };
    }
  } catch (err) {
    // This banner says "someone just checked themselves out" and is only shown
    // for ten minutes, so a stale copy is worse than none -- it would keep
    // announcing a checkout that has aged out. Hide it and log.
    console.error("renderRecentKiosk failed", err);
    container.classList.add("hidden");
  }
}
async function renderQueue() {
  const panel = document.querySelector("#tab-queue .admin-list");
  if (!panel) return;
  const pending = await getRequests({
    status: "pending"
  });
  pending.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  panel.innerHTML = "";

  // Kiosk returns first. These are the only queue items with a borrower standing
  // at the desk waiting: they have already handed the item over and the loan is
  // still open, so until this is confirmed the system says they never returned
  // it. Oldest first.
  const pendingReturns = await getPendingReturns();
  if (pendingReturns.length > 0) {
    const section = document.createElement("div");
    section.className = "queue-section-title";
    section.textContent = `RETURNS TO CONFIRM (${pendingReturns.length})`;
    panel.appendChild(section);
    for (const loan of pendingReturns) {
      panel.appendChild(_makePendingReturnRow(loan));
    }
  }

  if (pending.length === 0 && pendingReturns.length === 0) {
    panel.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding:32px;">Queue is empty. Nothing waiting on the desk.</p>';
    const badge2 = document.getElementById("queue-count");
    if (badge2) {
      badge2.textContent = "0";
      badge2.style.display = "none";
    }
    return;
  }
  const badge = document.getElementById("queue-count");
  if (badge) {
    badge.textContent = String(pending.length + pendingReturns.length);
    badge.style.display = "";
  }
  if (pending.length > 0) {
    const section = document.createElement("div");
    section.className = "queue-section-title";
    section.textContent = `BORROWER REQUESTS (${pending.length})`;
    panel.appendChild(section);
  }
  for (const req of pending) {
    panel.appendChild(_makeQueueRow(req));
  }
}
function _makePendingReturnRow(loan) {
  const row = document.createElement("div");
  row.className = "admin-list-item queue-row";
  const age = agoLabel(Date.now() - (loan.returnRequestedAt || 0));
  const damaged = loan.returnRequestedCondition === "damaged";
  row.innerHTML = `
    <div class="queue-header">
      <div class="queue-borrower">
        <span class="queue-name">${escapeHtml3(loan.itemNameSnapshot || "Item")}</span>
        <span class="queue-phone">${escapeHtml3(loan.borrowerNameSnapshot || "Unknown")}</span>
        ${loan.borrowerPhoneSnapshot ? `<span class="queue-phone">${escapeHtml3(formatPhone(loan.borrowerPhoneSnapshot))}</span>` : ""}
      </div>
      <div class="queue-age">${age}</div>
    </div>
    ${damaged ? `<div class="queue-description" style="color:var(--warning);">⚠️ Borrower reports a problem${loan.returnRequestedNote ? `: ${escapeHtml3(loan.returnRequestedNote)}` : ""}</div>` : `<div class="queue-description">Borrower says it is in good shape.</div>`}
    <div class="queue-actions">
      <button class="btn btn-primary" data-action="confirm-return" data-loan-id="${loan.id}">${damaged ? "Accept as reported (damaged)" : "Confirm return"}</button>
      <button class="btn ${damaged ? "btn-danger" : "btn-secondary"}" data-action="confirm-return-damaged" data-loan-id="${loan.id}">Returned, damaged</button>
      <button class="btn btn-ghost" data-action="deny-return" data-loan-id="${loan.id}">Not handed in</button>
    </div>
  `;
  return row;
}
/**
 * Close out a borrower-reported return.
 *
 * `conditionIn` is the staff override and must stay optional: the default path
 * is to accept whatever the borrower reported. Passing a literal "good" here
 * silently discarded their report -- a borrower saying "one key is bent" ended
 * up recorded as good condition with the complaint left in the notes.
 */
async function _confirmPendingReturn(loanId, conditionIn) {
  try {
    const loan = await confirmRequestedReturn(loanId, conditionIn ? {
      conditionIn
    } : {});
    showToast(loan && loan.conditionIn === "damaged" ? "Closed as returned, damaged" : "Return confirmed", {
      type: "success"
    });
    await renderQueue();
    await renderAdminStats();
  } catch (err) {
    showToast("Failed: " + err.message, {
      type: "error"
    });
  }
}
async function _denyPendingReturn(loanId) {
  const reason = await prompt("Why is it not back? (optional — shown on the loan)", {
    title: "Not handed in",
    placeholder: "e.g. borrower kept it, will return tomorrow"
  });
  try {
    await denyRequestedReturn(loanId, {
      reason: reason ? String(reason).trim() : ""
    });
    showToast("Cleared. The loan is still open.", {
      type: "info"
    });
    await renderQueue();
    await renderAdminStats();
  } catch (err) {
    showToast("Failed: " + err.message, {
      type: "error"
    });
  }
}
function _makeQueueRow(req) {
  const row = document.createElement("div");
  row.className = "admin-list-item queue-row";
  const ageMs = Date.now() - (req.createdAt || 0);
  const ageText = ageMs < 6e4 ? "just now" : formatRelativeTime(ageMs);
  row.innerHTML = `
    <div class="queue-header">
      <div class="queue-borrower">
        <span class="queue-name">${escapeHtml3(req.borrowerName || "Unknown")}</span>
        <span class="queue-phone">${escapeHtml3(req.phone ? formatPhone(req.phone) : "")}</span>
      </div>
      <div class="queue-age">${ageText}</div>
    </div>
    <div class="queue-description">"${escapeHtml3(req.description || "(no description)")}"</div>
    <div class="queue-actions">
      <button class="btn btn-primary" data-action="fulfill-request" data-request-id="${Number(req.id)}">Fulfill (pick item)</button>
      <button class="btn btn-ghost" data-action="cancel-request" data-request-id="${Number(req.id)}">Cancel</button>
    </div>
  `;
  return row;
}
async function _fulfillRequestFlow(requestId) {
  const all = await getRequests();
  const req = all.find((r) => r.id === requestId);
  if (!req) {
    showToast("Request not found", {
      type: "error"
    });
    return;
  }
  const items = await listItems({
    includeArchived: false
  });
  if (items.length === 0) {
    showToast("No items in the catalog yet. Add items first.", {
      type: "error"
    });
    return;
  }
  const pickerBody = document.createElement("div");
  pickerBody.innerHTML = `
    <div class="queue-summary" style="margin-bottom:16px; padding:12px; background:var(--bg-alt); border-radius:8px;">
      <div style="font-weight:600; color:var(--text);">${escapeHtml3(req.borrowerName || "Unknown")} ${req.phone ? "\xB7 " + escapeHtml3(formatPhone(req.phone)) : ""}</div>
      <div style="color:var(--text-secondary); font-style:italic; margin-top:4px;">"${escapeHtml3(req.description || "")}"</div>
    </div>
    <input type="text" class="input" id="fulfill-search" placeholder="Search items..." style="margin-bottom:12px;" />
    <div id="fulfill-items" class="fulfill-items-list"></div>
  `;
  await new Promise((resolve) => {
    let chosen = null;
    let dialogEl = null;
    showDialog({
      title: "Pick item to give " + (req.borrowerName || "borrower"),
      body: pickerBody,
      buttons: [
        {
          label: "Cancel",
          value: null,
          variant: "ghost"
        },
        {
          label: "Give this item",
          value: "confirm",
          variant: "primary"
        }
      ]
    }).then((v) => {
      if (v === "confirm" && chosen) {
        resolve(chosen);
      } else {
        resolve(null);
      }
    });
    setTimeout(async () => {
      dialogEl = document.querySelector(".dialog-card");
      const searchInput = pickerBody.querySelector("#fulfill-search");
      const listEl = pickerBody.querySelector("#fulfill-items");
      const renderList = async (query) => {
        const q = (query || "").toLowerCase().trim();
        const filtered = q ? items.filter((i) => i.name.toLowerCase().includes(q) || (i.category || "").toLowerCase().includes(q)) : items;
        const sorted = filtered.sort((a, b) => (b.timesCheckedOut || 0) - (a.timesCheckedOut || 0)).slice(0, 30);
        listEl.innerHTML = "";
        for (const item of sorted) {
          const row = document.createElement("div");
          row.className = "fulfill-item-row";
          row.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:10px; border:1px solid var(--border); border-radius:8px; margin-bottom:6px; cursor:pointer;";
          row.innerHTML = `
            <div>
              <div style="font-weight:600; color:var(--text);">${escapeHtml3(item.name)}</div>
              <div style="color:var(--text-muted); font-size:13px;">${escapeHtml3(item.category || "Other")} \xB7 used ${item.timesCheckedOut || 0}\xD7</div>
            </div>
            <div class="fulfill-radio" style="width:20px; height:20px; border-radius:50%; border:2px solid var(--text-muted);"></div>
          `;
          row.onclick = () => {
            chosen = item;
            pickerBody.querySelectorAll(".fulfill-item-row").forEach((r) => {
              r.style.borderColor = "var(--border)";
              const radio2 = r.querySelector(".fulfill-radio");
              if (radio2) radio2.style.background = "transparent";
            });
            row.style.borderColor = "var(--magenta)";
            const radio = row.querySelector(".fulfill-radio");
            if (radio) radio.style.background = "var(--magenta)";
          };
          listEl.appendChild(row);
        }
        if (sorted.length === 0) {
          listEl.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:16px;">No items match</p>';
        }
      };
      renderList("");
      searchInput.addEventListener("input", () => renderList(searchInput.value));
      setTimeout(() => searchInput.focus(), 50);
    }, 50);
  }).then(async (item) => {
    if (!item) return;
    try {
      const settings = await getSettings();
      const dueAt = Date.now() + (settings.defaultLoanHours || 8) * 60 * 60 * 1e3;
      const loan = await createLoan({
        itemId: item.id,
        borrowerId: req.borrowerId,
        checkedOutAt: Date.now(),
        dueAt,
        conditionOut: "good",
        notes: `From kiosk request: "${req.description}"`
      });
      await fulfillRequest(requestId, {
        itemId: item.id,
        loanId: loan.id
      });
      showToast(`Given "${item.name}" to ${req.borrowerName}`, {
        type: "success"
      });
      renderQueue();
      renderAdminStats();
    } catch (err) {
      showToast("Failed: " + err.message, {
        type: "error"
      });
    }
  });
}
async function renderCurrentlyOut() {
  const panel = document.querySelector("#tab-currently-out .admin-list");
  if (!panel) return;
  const open = await getOpenLoans();
  open.sort((a, b) => {
    const ao = a.dueAt && a.dueAt < Date.now() ? 0 : 1;
    const bo = b.dueAt && b.dueAt < Date.now() ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return (a.dueAt || Infinity) - (b.dueAt || Infinity);
  });
  panel.innerHTML = "";
  if (open.length === 0) {
    panel.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding:32px;">No items out</p>';
    return;
  }
  for (const loan of open) panel.appendChild(await _makeOpenLoanRow(loan));
}
async function renderOverdue() {
  const panel = document.querySelector("#tab-overdue .admin-list");
  if (!panel) return;
  const overdue = await getOverdueLoans();
  overdue.sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));
  panel.innerHTML = "";
  if (overdue.length === 0) {
    panel.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding:32px;">Nothing overdue \u2014 nice work!</p>';
    return;
  }
  for (const loan of overdue) panel.appendChild(await _makeOverdueRow(loan));
}
async function renderAllLoans() {
  const panel = document.querySelector("#tab-all-loans .admin-list");
  if (!panel) return;
  panel.innerHTML = `
    <div style="display:flex; gap:12px; margin-bottom:16px; flex-wrap:wrap;">
      <input type="date" class="setting-input" data-filter="from" style="flex:1; min-width:160px;" />
      <input type="date" class="setting-input" data-filter="to" style="flex:1; min-width:160px;" />
      <button class="btn btn-secondary" data-action="apply-filter">Apply</button>
      <button class="btn btn-ghost" data-action="clear-filter">Clear</button>
      <button class="btn btn-secondary" data-action="export-csv">Export CSV</button>
    </div>
    <div id="all-loans-content"></div>
  `;
  const content = panel.querySelector("#all-loans-content");
  const dateInputs = panel.querySelectorAll('input[type="date"]');
  dateInputs.forEach((inp) => {
    inp.addEventListener("change", () => _renderAllLoansList(content));
  });
  panel.querySelector('[data-action="apply-filter"]').onclick = () => _renderAllLoansList(content);
  panel.querySelector('[data-action="clear-filter"]').onclick = () => {
    dateInputs.forEach((inp) => {
      inp.value = "";
    });
    _renderAllLoansList(content);
  };
  panel.querySelector('[data-action="export-csv"]').onclick = () => _exportAllLoansCsv(panel);
  await _renderAllLoansList(content);
}
/**
 * A `type="date"` input yields "YYYY-MM-DD", and `new Date("2026-09-01")` parses
 * that as *UTC* midnight. For a Toronto user that is Aug 31, 8pm local, so a
 * filter "from Sep 1" quietly included the previous evening's loans and "to
 * Sep 1" stopped at 8pm on the day they chose. Build the boundary from local
 * parts instead. `dayOffset` of 1 gives the start of the following local day,
 * which handles month ends and DST shifts that a fixed 86400000 would not.
 */
function _localDayStart(value, dayOffset = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + dayOffset, 0, 0, 0, 0).getTime();
}
async function _renderAllLoansList(content) {
  if (!content) return;
  const panel = content.closest(".admin-list");
  const from = panel?.querySelector('input[data-filter="from"]')?.value;
  const to = panel?.querySelector('input[data-filter="to"]')?.value;
  const fromMs = _localDayStart(from) ?? 0;
  const toMs = _localDayStart(to, 1) ?? Infinity;
  const all = await getAllLoans({
    limit: 1e3
  });
  const filtered = all.filter((l) => l.checkedOutAt >= fromMs && l.checkedOutAt < toMs);
  content.innerHTML = "";
  if (filtered.length === 0) {
    content.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding:32px;">No loans in this range</p>';
    return;
  }
  for (const loan of filtered.slice(0, 200)) {
    content.appendChild(_makeClosedLoanRow(loan));
  }
  if (filtered.length > 200) {
    const more = document.createElement("div");
    more.className = "loan-meta";
    more.style.padding = "12px";
    more.textContent = `\u2026and ${filtered.length - 200} more (use export for full list)`;
    content.appendChild(more);
  }
}
async function _exportAllLoansCsv(panel) {
  const from = panel.querySelector('input[data-filter="from"]')?.value;
  const to = panel.querySelector('input[data-filter="to"]')?.value;
  const fromMs = _localDayStart(from) ?? 0;
  const toMs = _localDayStart(to, 1) ?? Infinity;
  const all = await getAllLoans({
    limit: 1e5
  });
  const filtered = all.filter((l) => l.checkedOutAt >= fromMs && l.checkedOutAt < toMs);
  const csv = _loansToCsv(filtered);
  const blob = new Blob([
    csv
  ], {
    type: "text/csv;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `frontdesk-loans-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("CSV downloaded", {
    type: "success"
  });
}
function _loansToCsv(loans) {
  const headers = [
    "id",
    "item",
    "borrower",
    "phone",
    "checkedOutAt",
    "dueAt",
    "returnedAt",
    "conditionOut",
    "conditionIn",
    "notes"
  ];
  const rows = loans.map((l) => [
    l.id,
    l.itemNameSnapshot || "",
    l.borrowerNameSnapshot || "",
    l.borrowerPhoneSnapshot || "",
    l.checkedOutAt ? new Date(l.checkedOutAt).toISOString() : "",
    l.dueAt ? new Date(l.dueAt).toISOString() : "",
    l.returnedAt ? new Date(l.returnedAt).toISOString() : "",
    l.conditionOut || "",
    l.conditionIn || "",
    (l.notes || "").replace(/"/g, '""')
  ]);
  const bom = "\uFEFF";
  const csv = [
    headers,
    ...rows
  ].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  return bom + csv;
}
async function renderItems() {
  const panel = document.querySelector("#tab-items .admin-list");
  if (!panel) return;
  panel.innerHTML = `
    <div id="duplicates-panel"></div>
    <div style="display:flex; gap:12px; margin-bottom:16px; flex-wrap:wrap;">
      <input type="text" class="setting-input" placeholder="Search items..." data-filter="q" style="flex:2; min-width:200px;" />
      <select class="setting-input" data-filter="sort" style="flex:1; min-width:160px;">
        <option value="name">Name (A-Z)</option>
        <option value="timesCheckedOut">Most checked out</option>
        <option value="lastCheckedOutAt">Recently used</option>
        <option value="condition">Condition</option>
      </select>
      <button class="btn btn-ghost" data-action="review-dups-all">Duplicates</button>
      <button class="btn btn-primary" data-action="add-item">+ Add</button>
    </div>
    <div id="items-content"></div>
  `;
  const content = panel.querySelector("#items-content");
  const qInput = panel.querySelector('input[data-filter="q"]');
  const sortSelect = panel.querySelector('select[data-filter="sort"]');
  const refresh = () => _renderItemsList(content, qInput.value, sortSelect.value);
  qInput.addEventListener("input", refresh);
  sortSelect.addEventListener("change", refresh);
  panel.querySelector('[data-action="add-item"]').onclick = () => _promptAddItem(refresh);
  // A permanent way in. The banner disappears once every group has been resolved
  // or dismissed -- which would otherwise strand the review screen, and with it
  // the only undo for a group dismissed by mistake.
  panel.querySelector('[data-action="review-dups-all"]').onclick = () => _showDuplicatesReview();
  await Promise.all([refresh(), _renderDuplicatesBanner(panel.querySelector("#duplicates-panel"))]);
}

/**
 * The "possible duplicates" strip above the item list.
 *
 * `runDailyDedup` was made detection-only because two physical units sharing a
 * name is a legitimate state -- but detection with no way to resolve it left the
 * warning as a `console.warn` nobody would read. This is the other half: it
 * surfaces the groups, and the review screen lets a human resolve or dismiss
 * each one. Nothing is ever merged automatically.
 */
async function _renderDuplicatesBanner(container) {
  if (!container) return;
  let pending;
  try {
    pending = await findUnreviewedDuplicates();
  } catch (err) {
    console.error("[dedup] could not scan for duplicates:", err);
    container.innerHTML = "";
    return;
  }
  if (pending.groups.length === 0) {
    container.innerHTML = "";
    return;
  }
  const n = pending.groups.length;
  const reviewed = pending.totalGroups - n;
  container.innerHTML = `
    <div class="dedup-banner">
      <div class="dedup-banner-text">
        <div class="dedup-banner-title">${n} name${n === 1 ? "" : "s"} shared by more than one entry</div>
        <div class="loan-meta">
          ${pending.itemCount} entries share ${n} name${n === 1 ? "" : "s"}.
          Two physical units with the same name is normal — merge only when it is the same item entered twice.
          ${reviewed > 0 ? ` ${reviewed} other group${reviewed === 1 ? "" : "s"} already reviewed.` : ""}
        </div>
      </div>
      <button class="btn btn-secondary" data-action="review-dups">Review</button>
    </div>
  `;
  container.querySelector('[data-action="review-dups"]').onclick = () => _showDuplicatesReview();
}

/**
 * Admin → Items → Review duplicates.
 *
 * Shows each unreviewed group with its members, lets a human pick the survivor,
 * and merges only on a confirmation that names what will happen. A group can
 * also be dismissed as "genuinely separate units", which is recorded against the
 * group's exact membership so it only comes back if the list actually changes.
 */
async function _showDuplicatesReview() {
  goToScreen("admin-detail", {
    data: {
      kind: "duplicates"
    }
  });
  const root = document.getElementById("screen-admin-detail");
  if (!root) return;
  const titleEl = root.querySelector(".detail-title");
  const content = root.querySelector(".detail-content");
  if (titleEl) titleEl.textContent = "Duplicate items";
  if (content) content.innerHTML = '<p style="text-align:center; padding:32px;">Loading…</p>';
  const render = async () => {
    if (!content) return;
    let pending;
    let settings;
    try {
      pending = await findUnreviewedDuplicates();
      settings = await getSettings();
    } catch (err) {
      content.innerHTML = `<p style="color:var(--error);">Error: ${escapeHtml3(err.message)}</p>`;
      return;
    }
    const reviewedCount = Object.keys(settings.dedupAcknowledged || {}).length;
    const resetBtn = reviewedCount > 0
      ? `<button class="btn btn-ghost" data-action="reset-dups" style="margin-top:16px;">Show the ${reviewedCount} reviewed group${reviewedCount === 1 ? "" : "s"} again</button>`
      : "";
    if (pending.groups.length === 0) {
      content.innerHTML = `
        <div class="return-card">
          <div class="item-name" style="font-size:20px; margin-bottom:8px;">Nothing to review</div>
          <div class="loan-meta">Every repeated name has been dealt with. A group comes back on its own if its entries change.</div>
        </div>
        ${resetBtn}
      `;
      _wireDuplicatesReview(content, render);
      return;
    }
    const openCounts = await _openCountsByItem();
    const sections = pending.groups.map((group, gi) => {
      const groupOut = group.filter((it) => openCounts.get(it.id)).length;
      // mergeItems refuses when two entries are both out, because the survivor
      // would end up carrying two open loans. Say so up front and disable the
      // button, rather than letting the user trigger an error they cannot act on.
      const bothOut = groupOut > 1;
      const members = group.map((it, i) => {
        const outNow = openCounts.get(it.id) || 0;
        return `
          <label class="dedup-member" data-item-id="${Number(it.id)}">
            <input type="radio" name="keep-g${gi}" value="${Number(it.id)}" ${i === 0 ? "checked" : ""} />
            <div style="flex:1;">
              <div class="borrower-name">
                ${escapeHtml3(it.name)}
                ${i === 0 ? '<span class="loan-meta" style="color:var(--magenta);">(busiest — suggested)</span>' : ""}
              </div>
              <div class="loan-meta">
                ${escapeHtml3(it.category || "Other")} \xB7 ${Number(it.timesCheckedOut) || 0}\xD7 out \xB7 ${escapeHtml3(it.condition || "good")}
                ${outNow ? ' \xB7 <span style="color:var(--warning);">out right now</span>' : ""}
                ${it.createdAt ? ` \xB7 added ${escapeHtml3(formatRelativeTime(Date.now() - it.createdAt))}` : ""}
              </div>
            </div>
          </label>
        `;
      }).join("");
      return `
        <div class="loan-section" data-group="${gi}">
          <h3 class="section-title">${escapeHtml3(group[0].name)} — ${group.length} entries</h3>
          <div class="dedup-group">${members}</div>
          <div class="dedup-actions">
            <button class="btn btn-primary" data-action="merge" data-group="${gi}" ${bothOut ? "disabled" : ""}>
              Merge the other ${group.length - 1} into the selected one
            </button>
            <button class="btn btn-ghost" data-action="separate" data-group="${gi}">These are different units</button>
          </div>
          ${bothOut ? `<div class="loan-meta" style="color:var(--warning); margin-top:8px;">${groupOut} of these are checked out right now. Check one in first — otherwise the survivor ends up with two open loans.</div>` : ""}
        </div>
      `;
    }).join("");
    content.innerHTML = `
      <div class="return-card" style="margin-bottom:16px;">
        <div class="loan-meta">
          Pick which entry should survive, then merge. Loans move to the survivor, it keeps the combined
          checkout count, and the others are archived — nothing is deleted. Merging cannot be undone from here.
        </div>
      </div>
      ${sections}
      ${resetBtn}
    `;
    _wireDuplicatesReview(content, render);
  };
  await render();
}

function _wireDuplicatesReview(content, render) {
  content.querySelector('[data-action="reset-dups"]')?.addEventListener("click", async () => {
    await updateSettings({
      dedupAcknowledged: {}
    });
    showToast("Reviewed groups will be shown again", {
      type: "info"
    });
    await render();
  });
  content.querySelectorAll(".dedup-member").forEach((row) => {
    row.addEventListener("click", () => {
      const radio = row.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
    });
  });
  content.querySelectorAll('[data-action="merge"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const gi = btn.dataset.group;
      const section = content.querySelector(`.loan-section[data-group="${gi}"]`);
      if (!section) return;
      const radios = [...section.querySelectorAll('input[type="radio"]')];
      const keeperRadio = radios.find((r) => r.checked) || radios[0];
      if (!keeperRadio) return;
      const keepId = Number(keeperRadio.value);
      const memberIds = radios.map((r) => Number(r.value));
      const victims = memberIds.filter((id) => id !== keepId);
      if (victims.length === 0) return;
      const items = await listItems({
        includeArchived: true
      });
      const byId = new Map(items.map((it) => [it.id, it]));
      const keeper = byId.get(keepId);
      const keeperName = keeper ? keeper.name : `item ${keepId}`;
      const ok = await confirmDialog(
        `Merge ${victims.length} other entr${victims.length === 1 ? "y" : "ies"} into "${keeperName}"? Their loans move across and they are archived.`,
        {
          title: "Merge duplicates",
          danger: true,
          confirmLabel: "Merge",
          cancelLabel: "Cancel"
        }
      );
      if (!ok) return;
      const nameKey = keeper ? (keeper.nameLower || keeper.name || "").trim().toLowerCase() : "";
      const failures = [];
      let moved = 0;
      for (const victimId of victims) {
        try {
          const res = await mergeItems(keepId, victimId);
          moved += (res && res.loansMoved) || 0;
        } catch (err) {
          failures.push(err.message);
        }
      }
      invalidateItemsCache();
      if (failures.length) {
        showToast(`Merged ${victims.length - failures.length} of ${victims.length}. ${failures[0]}`, {
          type: "error",
          duration: 1e4
        });
      } else {
        // Drop any "these are different" note for this name: the membership just
        // changed, so whatever is left deserves a fresh decision rather than
        // inheriting a stale acknowledgement.
        if (nameKey) await setDedupAcknowledged(nameKey, null);
        showToast(`Merged ${victims.length} entr${victims.length === 1 ? "y" : "ies"} into ${keeperName} \xB7 ${moved} loan${moved === 1 ? "" : "s"} moved`, {
          type: "success"
        });
      }
      await render();
    });
  });
  content.querySelectorAll('[data-action="separate"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const gi = btn.dataset.group;
      const section = content.querySelector(`.loan-section[data-group="${gi}"]`);
      if (!section) return;
      const ids = [...section.querySelectorAll('input[type="radio"]')].map((r) => Number(r.value));
      const items = await listItems({
        includeArchived: true
      });
      const byId = new Map(items.map((it) => [it.id, it]));
      const members = ids.map((id) => byId.get(id)).filter(Boolean);
      if (members.length === 0) return;
      const nameKey = (members[0].nameLower || members[0].name || "").trim().toLowerCase();
      await setDedupAcknowledged(nameKey, _dedupSignature(members));
      showToast("Marked as separate units — won't ask again unless the list changes", {
        type: "info"
      });
      await render();
    });
  });
}
async function _renderItemsList(content, query, sortBy) {
  if (!content) return;
  const includeArchived = true;
  const all = await listItems({
    includeArchived
  });
  const q = (query || "").toLowerCase().trim();
  let filtered = q ? all.filter((it) => it.name.toLowerCase().includes(q) || (it.category || "").toLowerCase().includes(q)) : all;
  filtered.sort((a, b) => {
    if (sortBy === "timesCheckedOut") return (b.timesCheckedOut || 0) - (a.timesCheckedOut || 0);
    if (sortBy === "lastCheckedOutAt") return (b.lastCheckedOutAt || 0) - (a.lastCheckedOutAt || 0);
    if (sortBy === "condition") return (a.condition || "").localeCompare(b.condition || "");
    return (a.name || "").localeCompare(b.name || "", void 0, {
      numeric: true
    });
  });
  content.innerHTML = "";
  if (filtered.length === 0) {
    content.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding:32px;">No items yet</p>';
    return;
  }
  for (const item of filtered) {
    const row = document.createElement("div");
    row.className = "admin-list-item";
    if (item.isArchived) row.style.opacity = "0.5";
    row.innerHTML = `
      <div style="flex:1;">
        <div class="borrower-name">${escapeHtml3(item.name)} ${item.isArchived ? '<span class="loan-meta" style="color:var(--warning);">(archived)</span>' : ""}</div>
        <div class="loan-meta">${escapeHtml3(item.category || "Other")} \xB7 ${item.timesCheckedOut || 0}\xD7 out${item.lastCheckedOutAt ? " \xB7 last " + agoLabel(Date.now() - item.lastCheckedOutAt) : ""}</div>
      </div>
      <div class="item-count">${item.condition || "good"}</div>
    `;
    row.onclick = () => showItemDetail(item.id);
    content.appendChild(row);
  }
}
async function renderPeople() {
  const panel = document.querySelector("#tab-people .admin-list");
  if (!panel) return;
  panel.innerHTML = `
    <div style="display:flex; gap:12px; margin-bottom:16px; flex-wrap:wrap;">
      <input type="text" class="setting-input" placeholder="Search people..." data-filter="q" style="flex:2; min-width:200px;" />
      <select class="setting-input" data-filter="sort" style="flex:1; min-width:160px;">
        <option value="name">Name (A-Z)</option>
        <option value="timesCheckedOut">Most active</option>
        <option value="lastSeenAt">Recently seen</option>
      </select>
      <button class="btn btn-primary" data-action="add-borrower">+ Add</button>
    </div>
    <div id="people-content"></div>
  `;
  const content = panel.querySelector("#people-content");
  const qInput = panel.querySelector('input[data-filter="q"]');
  const sortSelect = panel.querySelector('select[data-filter="sort"]');
  const refresh = () => _renderPeopleList(content, qInput.value, sortSelect.value);
  qInput.addEventListener("input", refresh);
  sortSelect.addEventListener("change", refresh);
  panel.querySelector('[data-action="add-borrower"]').onclick = () => _promptAddBorrower(refresh);
  await refresh();
}
async function _renderPeopleList(content, query, sortBy) {
  if (!content) return;
  const all = await listBorrowers({
    includeArchived: true
  });
  const q = (query || "").toLowerCase().trim();
  let filtered = q ? all.filter((b) => b.name.toLowerCase().includes(q) || (b.phoneFormatted || "").includes(q) || b.phone.includes(q)) : all;
  filtered.sort((a, b) => {
    if (sortBy === "timesCheckedOut") return (b.timesCheckedOut || 0) - (a.timesCheckedOut || 0);
    if (sortBy === "lastSeenAt") return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
    return (a.name || "").localeCompare(b.name || "", void 0, {
      numeric: true
    });
  });
  content.innerHTML = "";
  if (filtered.length === 0) {
    content.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding:32px;">No people yet</p>';
    return;
  }
  for (const b of filtered) {
    const row = document.createElement("div");
    row.className = "admin-list-item";
    if (b.isArchived) row.style.opacity = "0.5";
    row.innerHTML = `
      <div style="flex:1;">
        <div class="borrower-name">${escapeHtml3(b.name)} ${b.isArchived ? '<span class="loan-meta" style="color:var(--warning);">(archived)</span>' : ""}</div>
        <div class="loan-meta">${escapeHtml3(formatPhone(b.phone))} \xB7 ${b.timesCheckedOut || 0}\xD7 out${b.lastSeenAt ? " \xB7 last " + agoLabel(Date.now() - b.lastSeenAt) : ""}</div>
      </div>
    `;
    row.onclick = () => showBorrowerDetail(b.id);
    content.appendChild(row);
  }
}
async function renderSettings() {
  const panel = document.querySelector("#tab-settings .settings-panel");
  if (!panel) return;
  const settings = await getSettings();
  const items = await listItems({
    includeArchived: true
  });
  const borrowers = await listBorrowers({
    includeArchived: true
  });
  const allLoans = await getAllLoans({
    limit: 1e6
  });
  panel.innerHTML = `
    <div class="setting-group">
      <label class="setting-label">Admin PIN</label>
      <input type="password" class="setting-input" placeholder="${settings.pin === "1234" ? "Still the factory default 1234" : "Enter new PIN (4-8 digits)"}" data-setting="pin" inputmode="numeric" autocomplete="off" maxlength="8" />
      <input type="password" class="setting-input" style="margin-top:8px;" placeholder="Confirm new PIN" data-setting="pin-confirm" inputmode="numeric" autocomplete="off" maxlength="8" />
      <div class="loan-meta" style="margin-top:6px;">4-8 digits. Leave blank to keep the current PIN.</div>
      ${settings.pin === "1234" ? '<div class="loan-meta" style="margin-top:6px; color:var(--warning);">This device is still on the factory default PIN. Anyone who knows it can open the admin panel.</div>' : ""}
    </div>

    <div class="setting-group">
      <label class="setting-label">Default loan duration (hours)</label>
      <input type="number" class="setting-input" value="${Number(settings.defaultLoanHours) || 8}" min="1" max="168" data-setting="defaultLoanHours" />
    </div>

    <div class="setting-group">
      <label class="setting-label">Theme</label>
      <select class="setting-input" data-setting="theme">
        <option value="dark"${settings.theme === "dark" ? " selected" : ""}>Dark</option>
        <option value="light"${settings.theme === "light" ? " selected" : ""}>Light</option>
      </select>
    </div>

    <div class="setting-group">
      <button class="btn btn-primary" data-action="save-settings">Save Settings</button>
    </div>

    <div class="setting-group" style="margin-top:32px; padding-top:24px; border-top:1px solid var(--border);">
      <h3 class="section-title" style="font-size:18px; margin-bottom:16px;">Backup &amp; Restore</h3>
      <div class="setting-actions">
        <button class="btn btn-secondary" data-action="export-json">Export Backup (JSON)</button>
        <button class="btn btn-secondary" data-action="export-csv-overdue">Export Overdue (CSV)</button>
        <button class="btn btn-secondary" data-action="import">Import Backup</button>
        <input type="file" accept="application/json" data-action="import-file" style="display:none;" />
      </div>
    </div>

    <div id="host-settings"></div>

    <div class="setting-group" style="margin-top:32px; padding-top:24px; border-top:1px solid var(--border);">
      <h3 class="section-title" style="font-size:18px; margin-bottom:16px; color:var(--error);">Danger Zone</h3>
      <button class="btn btn-danger" data-action="wipe">Wipe All Data\u2026</button>
    </div>

    <div class="setting-group" style="margin-top:32px; padding-top:24px; border-top:1px solid var(--border); color:var(--text-muted); font-size:12px;">
      <div>Schema version: <strong>${settings.schemaVersion || 1}</strong></div>
      <div>Items: <strong>${items.length}</strong> \xB7 People: <strong>${borrowers.length}</strong> \xB7 Loans: <strong>${allLoans.length}</strong></div>
      <div>Last backup: ${settings.lastBackupAt ? formatAbsoluteTime(settings.lastBackupAt) : "never"}</div>
    </div>
  `;
  panel.querySelector('[data-action="save-settings"]').onclick = async () => {
    const newPin = panel.querySelector('input[data-setting="pin"]').value.trim();
    const confirmPin = panel.querySelector('input[data-setting="pin-confirm"]').value.trim();
    const newHours = Number(panel.querySelector('input[data-setting="defaultLoanHours"]').value);
    const newTheme = panel.querySelector('select[data-setting="theme"]').value;
    // The login field is maxlength="8". A longer PIN could be saved here and then
    // never entered again -- the panel was locked out permanently, with no reset
    // short of wiping the app's storage.
    if (newPin) {
      if (!/^\d{4,8}$/.test(newPin)) {
        showToast("PIN must be 4-8 digits", {
          type: "error"
        });
        return;
      }
      if (newPin !== confirmPin) {
        showToast("The two PIN entries do not match", {
          type: "error"
        });
        return;
      }
    }
    if (!Number.isFinite(newHours) || newHours < 1 || newHours > 168) {
      showToast("Loan duration must be 1-168 hours", {
        type: "error"
      });
      return;
    }
    const updates = {
      defaultLoanHours: newHours,
      theme: newTheme
    };
    // Changing the PIN also clears the failed-attempt lockout -- otherwise staff
    // who locked themselves out would have to wait out the timer to use the PIN
    // they just set.
    if (newPin) {
      updates.pin = newPin;
      updates.pinFailures = 0;
      updates.pinLockedUntil = 0;
    }
    await updateSettings(updates);
    _pinFailures = 0;
    _pinLockedUntil = 0;
    document.body.classList.toggle("light", newTheme === "light");
    showToast("Settings saved", {
      type: "success"
    });
    if (newPin) renderSettings();
  };
  panel.querySelector('[data-action="export-json"]').onclick = () => downloadExport();
  panel.querySelector('[data-action="export-csv-overdue"]').onclick = async () => {
    const overdue = await getOverdueLoans();
    const borrowers2 = await listBorrowers({
      includeArchived: true
    });
    const borrowerById = new Map(borrowers2.map((b) => [
      b.id,
      b
    ]));
    const csv = overdueToCsv(overdue, borrowerById);
    const blob = new Blob([
      csv
    ], {
      type: "text/csv;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frontdesk-overdue-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("CSV downloaded", {
      type: "success"
    });
  };
  const importFile = panel.querySelector('input[data-action="import-file"]');
  panel.querySelector('[data-action="import"]').onclick = () => importFile.click();
  importFile.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importFromFile(file);
      showToast("Import complete", {
        type: "success"
      });
      await renderSettings();
      await renderAdminStats();
    } catch (err) {
      showToast("Import failed: " + err.message, {
        type: "error"
      });
    }
  };
  panel.querySelector('[data-action="wipe"]').onclick = () => _wipeData();
  await _renderHostSettings(panel.querySelector("#host-settings"));
}

/**
 * The Windows-app-only half of Settings.
 *
 * Everything here exists because the browser cannot do it: a backup folder the
 * app can write to unattended, a list of what is already in it, and the choice
 * of whether the desk app starts with Windows. In a plain browser the section
 * is a single line of explanation rather than an empty hole.
 */
async function _renderHostSettings(container) {
  if (!container) return;
  if (!isHosted()) {
    container.innerHTML = `
      <div class="setting-group" style="margin-top:32px; padding-top:24px; border-top:1px solid var(--border);">
        <h3 class="section-title" style="font-size:18px; margin-bottom:8px;">Backup folder</h3>
        <div class="loan-meta">In the browser, a backup can only be downloaded. The Windows app additionally
        writes one into a folder on this machine on every launch, and keeps the last few &mdash; open
        <strong>RotmanFrontDesk.exe</strong> to use it.</div>
      </div>`;
    return;
  }
  let info = null;
  let backups = [];
  let listError = "";
  try {
    info = await hostInfo();
  } catch (_) {
  }
  try {
    const res = await hostCall("ListBackups");
    backups = res.backups || [];
  } catch (err) {
    listError = err.message;
  }
  if (!document.contains(container)) return;
  const escape = escapeHtml3;
  const rows = backups.slice(0, 6).map((b) => `
      <div class="backup-row">
        <div class="backup-row-main">
          <div class="backup-row-name">${escape(b.file)}</div>
          <div class="loan-meta">${formatBytes(b.bytes)} \xB7 ${formatAbsoluteTime(b.modified)}</div>
        </div>
        <button class="btn btn-secondary" data-restore="${escape(b.file)}">Restore</button>
      </div>`).join("");
  const listHtml = listError
    ? `<div class="loan-meta" style="color:var(--error);">Could not list the backup folder: ${escape(listError)}</div>`
    : backups.length
      ? `<div class="backup-list">${rows}</div>
         ${backups.length > 6 ? `<div class="loan-meta" style="margin-top:8px;">and ${backups.length - 6} older &mdash; see the folder.</div>` : ""}`
      : `<div class="loan-meta">No backups yet. One is written automatically each time the app opens.</div>`;
  container.innerHTML = `
    <div class="setting-group" style="margin-top:32px; padding-top:24px; border-top:1px solid var(--border);">
      <h3 class="section-title" style="font-size:18px; margin-bottom:16px;">This computer</h3>
      <div class="path-row">
        <div class="path-row-main">
          <div class="setting-label" style="margin:0;">Data folder</div>
          <div class="path-value">${escape(info?.dataDir || "unknown")}</div>
          <div class="loan-meta">${info?.portable ? "Beside the app — copy this whole folder to move the desk." : "In your user profile — the app folder itself is not writable."}</div>
        </div>
        <button class="btn btn-secondary" data-action="open-folder" data-which="data">Open</button>
      </div>
      <div class="path-row">
        <div class="path-row-main">
          <div class="setting-label" style="margin:0;">Backup folder</div>
          <div class="path-value">${escape(info?.backupDir || "unknown")}</div>
          <div class="loan-meta">Newest ${Number(info?.keepBackups) || 30} kept. These are ordinary files &mdash; copy them anywhere.</div>
        </div>
        <button class="btn btn-secondary" data-action="open-folder" data-which="backups">Open</button>
      </div>
      <div class="setting-actions" style="margin-top:16px;">
        <button class="btn btn-primary" data-action="backup-now">Back up now</button>
        <button class="btn btn-secondary" data-action="open-folder" data-which="log">Open log file folder</button>
      </div>
      <label class="setting-toggle">
        <input type="checkbox" data-action="autostart"${info?.autostart ? " checked" : ""} />
        <span>Start Front Desk when Windows starts</span>
      </label>
      <div class="loan-meta">Starts minimised to the notification area, so the desk is ready before anyone arrives.</div>
    </div>

    <div class="setting-group" style="margin-top:24px;">
      <h3 class="section-title" style="font-size:18px; margin-bottom:12px;">Recent backups</h3>
      ${listHtml}
    </div>

    <div class="setting-group" style="margin-top:24px; color:var(--text-muted); font-size:12px;">
      <div>Front Desk app: <strong>${escape(info?.version || "?")}</strong> \xB7 WebView2 <strong>${escape(info?.runtime || "?")}</strong></div>
    </div>
  `;
  container.querySelectorAll('[data-action="open-folder"]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await hostCall("OpenFolder", btn.getAttribute("data-which"));
      } catch (err) {
        showToast("Could not open the folder: " + err.message, {
          type: "error"
        });
      }
    };
  });
  container.querySelector('[data-action="backup-now"]').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Backing up…";
    try {
      await runBackupNow({
        force: true
      });
    } finally {
      await renderSettings();
    }
  };
  const autostart = container.querySelector('[data-action="autostart"]');
  autostart.onchange = async () => {
    const wanted = autostart.checked;
    try {
      await hostCall("SetAutostart", wanted);
      if (_hostInfoCache) _hostInfoCache.autostart = wanted;
      showToast(wanted ? "Front Desk will start with Windows" : "Front Desk will no longer start with Windows", {
        type: "success"
      });
    } catch (err) {
      autostart.checked = !wanted;
      showToast("Could not change that setting: " + err.message, {
        type: "error"
      });
    }
  };
  container.querySelectorAll("[data-restore]").forEach((btn) => {
    btn.onclick = async () => {
      const file = btn.getAttribute("data-restore");
      // Restoring replaces everything currently in the database, so this is a
      // two-step: the dialog names the file and says plainly what is lost.
      const yes = await confirmDialog(
        `Replace everything in Front Desk with the contents of ${file}? Anything checked out or added since that backup was written will be gone.`,
        {
          title: "Restore from backup",
          danger: true,
          confirmLabel: "Restore"
        }
      );
      if (!yes) return;
      btn.disabled = true;
      try {
        await hostRestoreBackup(file);
        showToast(`Restored from ${file}`, {
          type: "success"
        });
        await renderSettings();
        await renderAdminStats();
      } catch (err) {
        btn.disabled = false;
        showToast("Restore failed: " + err.message, {
          type: "error"
        });
      }
    };
  });
}
// ── Reports ───────────────────────────────────────────────────────────
// The term summary for whoever has to account for the desk: how much went out,
// to how many people, which items carry the load and which never move.
//
// Everything is derived from the loans table, so it needs no separate
// bookkeeping and cannot drift from what the other tabs show. Everything down
// to reportToCsv is pure -- it takes rows and a clock and returns a plain
// object -- so it can be checked without a browser or a database.

const REPORT_PERIODS = [
  {
    key: "week",
    label: "This week"
  },
  {
    key: "month",
    label: "Last 30 days"
  },
  {
    key: "term",
    label: "Last 90 days"
  },
  {
    key: "all",
    label: "All time"
  }
];
var REPORT_PERIOD_KEY = "frontdesk.reportPeriod";
// Months of history the "All time" chart will draw. Older loans are still
// counted in the totals; they are just not on the chart.
var REPORT_MAX_MONTHS = 24;
var _reportPeriod = "month";
function reportPeriodLabel(key) {
  const found = REPORT_PERIODS.find((p) => p.key === key);
  return found ? found.label : "Last 30 days";
}
/**
 * Midnight local time, `days` days before `now`.
 * @param {number} now
 * @param {number} days
 * @returns {number}
 */
function reportDaysBack(now, days) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - days).getTime();
}
/**
 * Midnight on the Monday of the week `now` falls in, local time.
 * @param {number} now
 * @returns {number}
 */
function reportWeekStart(now) {
  const d = new Date(now);
  const mondayOffset = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - mondayOffset).getTime();
}
/**
 * The instant a period starts. "All time" is the epoch, so every loan passes
 * the >= test without a special case downstream.
 * @param {string} key
 * @param {number} now
 * @returns {number}
 */
function reportSince(key, now) {
  if (key === "week") return reportWeekStart(now);
  if (key === "month") return reportDaysBack(now, 29);
  if (key === "term") return reportDaysBack(now, 89);
  return 0;
}
/**
 * One bucket per day, or one per month across all of history. Month buckets are
 * capped at the most recent REPORT_MAX_MONTHS so an old desk cannot produce a
 * chart wider than any screen.
 * @param {number} since
 * @param {number} until
 * @param {boolean} byMonth
 * @returns {Array<{start:number, end:number, label:string, count:number}>}
 */
function reportBuckets(since, until, byMonth) {
  const out = [];
  const cursor = new Date(since);
  cursor.setHours(0, 0, 0, 0);
  if (byMonth) cursor.setDate(1);
  let guard = 0;
  while (cursor.getTime() <= until && guard++ < 1200) {
    const start = cursor.getTime();
    // Built from the calendar fields rather than by adding 24h, so a DST
    // change does not drift the buckets off local midnight.
    const next = byMonth ? new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1).getTime() : new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1).getTime();
    out.push({
      start,
      end: next,
      label: byMonth ? cursor.toLocaleDateString(void 0, {
        month: "short",
        year: "2-digit"
      }) : cursor.toLocaleDateString(void 0, {
        month: "short",
        day: "numeric"
      }),
      count: 0
    });
    cursor.setTime(next);
  }
  return byMonth && out.length > REPORT_MAX_MONTHS ? out.slice(out.length - REPORT_MAX_MONTHS) : out;
}
/**
 * Whole days between two instants, rounded.
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
function reportDaysBetween(from, to) {
  return Math.max(0, Math.round((to - from) / 864e5));
}
/**
 * Aggregate a set of loans into the numbers the Reports tab shows.
 *
 * `loans` may be every loan in the database -- the period filter is applied
 * here -- so a caller never has to know the date rules.
 *
 * @param {{loans: Array, items: Array, borrowers: Array, period: string, now: number}} input
 * @returns {object}
 */
function buildReport({
  loans,
  items,
  borrowers,
  period,
  now
}) {
  const since = reportSince(period, now);
  const byMonth = period === "all";
  const inPeriod = loans.filter((l) => (l.checkedOutAt || 0) >= since && (l.checkedOutAt || 0) <= now);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const borrowerById = new Map(borrowers.map((b) => [b.id, b]));
  const people = /* @__PURE__ */ new Set();
  const distinctItems = /* @__PURE__ */ new Set();
  const itemCounts = /* @__PURE__ */ new Map();
  const personCounts = /* @__PURE__ */ new Map();
  const totals = {
    loans: inPeriod.length,
    open: 0,
    overdue: 0,
    returned: 0,
    people: 0,
    walkIns: 0,
    items: 0,
    avgLoanMs: null,
    onTime: 0,
    onTimePct: null
  };
  let closedMs = 0;
  let closedCount = 0;
  let onTime = 0;
  for (const loan of inPeriod) {
    const out = loan.checkedOutAt || 0;
    const open = isLoanOpen(loan);
    if (open) {
      totals.open++;
      if (loan.dueAt && loan.dueAt < now) totals.overdue++;
    } else if (loan.returnedAt) {
      totals.returned++;
      closedCount++;
      closedMs += Math.max(0, loan.returnedAt - out);
      if (!loan.dueAt || loan.returnedAt <= loan.dueAt) onTime++;
    }
    // A borrower with no saved record is keyed on their phone, so someone who
    // gave the same number twice counts once. Anonymous walk-ins all carry the
    // literal phone snapshot "walk-in" and cannot be told apart, so they are
    // counted as loans rather than folded into a single misleading "person".
    const walkIn = loan.borrowerId == null && (!loan.borrowerPhoneSnapshot || loan.borrowerPhoneSnapshot === "walk-in");
    if (walkIn) totals.walkIns++;
    const personKey = loan.borrowerId != null ? "id:" + loan.borrowerId : "phone:" + (loan.borrowerPhoneSnapshot || "walk-in");
    if (!walkIn) people.add(personKey);
    const itemKey = loan.itemId != null ? "id:" + loan.itemId : "name:" + (loan.itemNameSnapshot || "unknown");
    distinctItems.add(itemKey);
    let ic = itemCounts.get(itemKey);
    if (!ic) {
      const live = itemById.get(loan.itemId);
      ic = {
        key: itemKey,
        id: loan.itemId,
        name: live ? live.name : loan.itemNameSnapshot || "Unknown item",
        count: 0,
        open: 0
      };
      itemCounts.set(itemKey, ic);
    }
    ic.count++;
    if (open) ic.open++;
    if (walkIn) continue;
    let pc = personCounts.get(personKey);
    if (!pc) {
      const live2 = borrowerById.get(loan.borrowerId);
      pc = {
        key: personKey,
        id: loan.borrowerId != null ? loan.borrowerId : null,
        name: live2 ? live2.name : loan.borrowerNameSnapshot || "Walk-in",
        phone: live2 ? live2.phone : loan.borrowerPhoneSnapshot || "",
        count: 0,
        open: 0
      };
      personCounts.set(personKey, pc);
    }
    pc.count++;
    if (open) pc.open++;
  }
  totals.people = people.size;
  totals.items = distinctItems.size;
  totals.avgLoanMs = closedCount ? Math.round(closedMs / closedCount) : null;
  totals.onTime = onTime;
  totals.onTimePct = closedCount ? Math.round(onTime / closedCount * 100) : null;

  // The chart. "All time" starts at the oldest loan in range and is bucketed by
  // month; a desk with no history at all gets an empty chart rather than one
  // running from 1970.
  let bucketStart = since;
  if (byMonth) {
    let earliest = 0;
    for (const loan of inPeriod) {
      const out = loan.checkedOutAt || 0;
      if (out && (!earliest || out < earliest)) earliest = out;
    }
    bucketStart = earliest ? Math.max(reportDaysBack(now, 30 * REPORT_MAX_MONTHS), earliest) : reportDaysBack(now, 30);
  }
  const buckets = reportBuckets(bucketStart, now, byMonth);
  if (buckets.length) {
    const first = buckets[0].start;
    for (const loan of inPeriod) {
      const out = loan.checkedOutAt || 0;
      if (out < first) continue;
      for (let i = buckets.length - 1; i >= 0; i--) {
        if (out >= buckets[i].start) {
          buckets[i].count++;
          break;
        }
      }
    }
  }
  let busiest = null;
  for (const b of buckets) {
    if (b.count > 0 && (!busiest || b.count > busiest.count)) busiest = b;
  }

  // Idle inventory: in the catalog, no use at all this period. Matched against
  // the live catalog by both id and name, because a loan written before an item
  // was renamed carries only the old name.
  const usedIds = /* @__PURE__ */ new Set();
  const usedNames = /* @__PURE__ */ new Set();
  for (const key of distinctItems) {
    if (key.indexOf("id:") === 0) usedIds.add(Number(key.slice(3)));
    else usedNames.add(key.slice(5).toLowerCase());
  }
  const idle = items.filter((i) => !usedIds.has(i.id) && !usedNames.has(i.nameLower || String(i.name).toLowerCase())).sort((a, b) => a.name.localeCompare(b.name, void 0, {
    numeric: true
  }));
  const byCount = (a, b) => b.count - a.count || a.name.localeCompare(b.name);
  return {
    period,
    label: reportPeriodLabel(period),
    since,
    until: now,
    byMonth,
    totals,
    buckets,
    busiest,
    topItems: Array.from(itemCounts.values()).sort(byCount).slice(0, 8),
    topBorrowers: Array.from(personCounts.values()).sort(byCount).slice(0, 8),
    idle,
    catalogSize: items.length,
    peopleCount: borrowers.length
  };
}
/**
 * Loan-level CSV for the period a report covers -- one row per loan, so the
 * summary on screen can be rebuilt or extended in a spreadsheet.
 * @param {{loans: Array, items: Array, borrowers: Array, period: string, now: number}} input
 * @returns {string}
 */
function reportToCsv({
  loans,
  items,
  borrowers,
  period,
  now
}) {
  const since = reportSince(period, now);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const borrowerById = new Map(borrowers.map((b) => [b.id, b]));
  const headers = [
    "borrower",
    "phone",
    "item",
    "category",
    "checked_out",
    "due",
    "returned",
    "status",
    "days_out"
  ];
  const rows = loans.filter((l) => (l.checkedOutAt || 0) >= since && (l.checkedOutAt || 0) <= now).sort((a, b) => (a.checkedOutAt || 0) - (b.checkedOutAt || 0)).map((l) => {
    const item = itemById.get(l.itemId);
    const borrower = borrowerById.get(l.borrowerId);
    const open = isLoanOpen(l);
    const overdue = !!(open && l.dueAt && l.dueAt < now);
    const stamp = (ms) => ms ? new Date(ms).toISOString() : "";
    return [borrower ? borrower.name : l.borrowerNameSnapshot || "Walk-in", formatPhone(borrower ? borrower.phone : l.borrowerPhoneSnapshot || ""), item ? item.name : l.itemNameSnapshot || "", item ? item.category || "Other" : "", stamp(l.checkedOutAt), stamp(l.dueAt), stamp(l.returnedAt), open ? overdue ? "overdue" : "out" : "returned", String(reportDaysBetween(l.checkedOutAt || now, l.returnedAt || now))];
  });
  return "﻿" + [headers, ...rows].map((r) => r.map((c) => csvEscape(c)).join(",")).join("\n");
}
function _reportLoadPeriod() {
  try {
    const stored = localStorage.getItem(REPORT_PERIOD_KEY);
    if (stored && REPORT_PERIODS.some((p) => p.key === stored)) _reportPeriod = stored;
  } catch (_) {
  }
  return _reportPeriod;
}
function _formatDuration(ms) {
  if (ms == null) return "—";
  const mins = Math.round(ms / 6e4);
  if (mins < 60) return `${mins}m`;
  const hours = ms / 36e5;
  if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  return `${(ms / 864e5).toFixed(1)}d`;
}
/** A tile in the summary grid. */
function _reportTile(label, value, hint, tone) {
  return `<div class="report-tile${tone ? " report-tile-" + tone : ""}">
    <div class="report-tile-value">${escapeHtml3(value)}</div>
    <div class="report-tile-label">${escapeHtml3(label)}</div>
    ${hint ? `<div class="report-tile-hint">${escapeHtml3(hint)}</div>` : ""}
  </div>`;
}
/** A ranked row: name on the left, a share bar, a count on the right. */
function _reportRankRow(name, sub, count, share) {
  return `<div class="report-row">
    <div class="report-row-main">
      <div class="report-row-name">${escapeHtml3(name)}</div>
      ${sub ? `<div class="report-row-sub">${escapeHtml3(sub)}</div>` : ""}
      <div class="report-row-bar"><span style="width:${Math.max(2, Math.round(share * 100))}%"></span></div>
    </div>
    <div class="report-row-count">${escapeHtml3(count)}</div>
  </div>`;
}
/**
 * Draw the Reports tab: a period switch, the headline numbers, the shape of the
 * period, the items and people carrying it, and what nothing touched at all.
 */
async function renderReports() {
  const panel = document.querySelector("#tab-reports .reports-panel");
  if (!panel) return;
  const period = _reportLoadPeriod();
  panel.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding:32px;">Building report…</p>';
  let loans;
  let items;
  let borrowers;
  try {
    loans = await getAllLoans({
      limit: null
    });
    items = await listItems({
      includeArchived: true
    });
    borrowers = await listBorrowers({
      includeArchived: true
    });
  } catch (err) {
    panel.innerHTML = `<p style="text-align:center; color:var(--error); padding:32px;">Could not build the report: ${escapeHtml3(err.message)}</p>`;
    return;
  }
  const now = Date.now();
  const report = buildReport({
    loans,
    items,
    borrowers,
    period,
    now
  });
  const t = report.totals;
  const periodSwitch = `<div class="report-periods" role="group" aria-label="Report period">
    ${REPORT_PERIODS.map((p) => `<button class="report-period${p.key === period ? " active" : ""}" data-period="${p.key}">${escapeHtml3(p.label)}</button>`).join("")}
  </div>`;
  const spanText = period === "all" ? "All loans ever recorded" : `Since ${new Date(report.since).toLocaleDateString(void 0, {
    month: "short",
    day: "numeric"
  })}`;
  const emptyTile = t.loans === 0 ? `<div class="report-empty">No loans ${period === "all" ? "recorded yet" : "in this period"}. Try a longer period.</div>` : "";
  const maxBucket = report.buckets.reduce((m, b) => Math.max(m, b.count), 0);
  const chart = report.buckets.length === 0 || maxBucket === 0 ? "" : `<div class="report-section">
      <h3 class="report-section-title">LOANS ${report.byMonth ? "BY MONTH" : "BY DAY"}</h3>
      <div class="report-chart" role="img" aria-label="Loans over the period">
        ${report.buckets.map((b) => `<div class="report-bar" title="${escapeHtml3(b.label)}: ${b.count}"><span style="height:${b.count === 0 ? 2 : Math.max(6, Math.round(b.count / maxBucket * 100))}%"></span></div>`).join("")}
      </div>
      <div class="report-chart-axis">
        <span>${escapeHtml3(report.buckets[0].label)}</span>
        <span>${report.busiest ? `Busiest: ${escapeHtml3(report.busiest.label)} (${report.busiest.count})` : ""}</span>
        <span>${escapeHtml3(report.buckets[report.buckets.length - 1].label)}</span>
      </div>
      ${report.byMonth && t.loans > 0 ? `<p class="report-note">Chart shows the last ${REPORT_MAX_MONTHS} months; the totals above cover everything.</p>` : ""}
    </div>`;
  const topItems = report.topItems.length === 0 ? "" : `<div class="report-section">
      <h3 class="report-section-title">BUSIEST ITEMS</h3>
      ${report.topItems.map((i) => _reportRankRow(i.name, i.open > 0 ? `${i.open} still out` : "", String(i.count), i.count / report.topItems[0].count)).join("")}
    </div>`;
  const topPeople = report.topBorrowers.length === 0 ? "" : `<div class="report-section">
      <h3 class="report-section-title">BUSIEST PEOPLE</h3>
      ${report.topBorrowers.map((p) => _reportRankRow(p.name, [p.phone ? formatPhone(p.phone) : "", p.open > 0 ? `${p.open} still out` : ""].filter(Boolean).join(" \xB7 "), String(p.count), p.count / report.topBorrowers[0].count)).join("")}
    </div>`;
  const idleShown = report.idle.slice(0, 12);
  const idle = report.idle.length === 0 ? "" : `<div class="report-section">
      <h3 class="report-section-title">NOT USED ${period === "all" ? "AT ALL" : "THIS PERIOD"} (${report.idle.length})</h3>
      <div class="report-idle">
        ${idleShown.map((i) => `<span class="report-idle-chip">${escapeHtml3(i.name)}</span>`).join("")}
      </div>
      ${report.idle.length > idleShown.length ? `<p class="report-note">…and ${report.idle.length - idleShown.length} more of ${report.catalogSize} in the catalog.</p>` : ""}
    </div>`;
  panel.innerHTML = `
    <div class="report-toolbar">
      ${periodSwitch}
      <button class="btn btn-secondary" data-action="report-csv">⬇️ Export CSV</button>
    </div>
    <p class="report-span">${escapeHtml3(spanText)} \xB7 ${t.loans} loan${t.loans === 1 ? "" : "s"} \xB7 ${report.catalogSize} item${report.catalogSize === 1 ? "" : "s"} \xB7 ${report.peopleCount} ${report.peopleCount === 1 ? "person" : "people"} on file</p>
    <div class="report-grid">
      ${_reportTile("Loans", String(t.loans), period === "all" ? "all time" : report.label)}
      ${_reportTile("People", String(t.people), t.walkIns > 0 ? `+${t.walkIns} walk-in${t.walkIns === 1 ? "" : "s"}` : "borrowed")}
      ${_reportTile("Items used", String(t.items), `of ${report.catalogSize}`)}
      ${_reportTile("Still out", String(t.open), "open now")}
      ${_reportTile("Overdue", String(t.overdue), "need chasing", t.overdue > 0 ? "warn" : "")}
      ${_reportTile("Returned", String(t.returned), "in period")}
      ${_reportTile("Average loan", _formatDuration(t.avgLoanMs), t.avgLoanMs == null ? "nothing returned yet" : "from checkout to return")}
      ${_reportTile("On time", t.onTimePct == null ? "—" : t.onTimePct + "%", t.onTimePct == null ? "nothing returned yet" : `${t.onTime} of ${t.returned}`, t.onTimePct != null && t.onTimePct < 80 ? "warn" : "")}
    </div>
    ${emptyTile}
    ${chart}
    ${topItems}
    ${topPeople}
    ${idle}
  `;
  for (const btn of panel.querySelectorAll(".report-period")) {
    btn.onclick = () => {
      _reportPeriod = btn.dataset.period;
      try {
        localStorage.setItem(REPORT_PERIOD_KEY, _reportPeriod);
      } catch (_) {
      }
      renderReports();
    };
  }
  const csvBtn = panel.querySelector('[data-action="report-csv"]');
  if (csvBtn) {
    csvBtn.onclick = () => {
      const csv = reportToCsv({
        loans,
        items,
        borrowers,
        period,
        now
      });
      const rows = csv.split("\n").length - 1;
      if (rows === 0) {
        showToast("Nothing to export in this period", {
          type: "info"
        });
        return;
      }
      const blob = new Blob([csv], {
        type: "text/csv;charset=utf-8"
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `frontdesk-report-${period}-${dateStamp()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${rows} loan${rows === 1 ? "" : "s"}`, {
        type: "success"
      });
    };
  }
}
async function _makeOpenLoanRow(loan) {
  const row = document.createElement("div");
  row.className = "loan-item";
  if (loan.dueAt && loan.dueAt < Date.now()) row.classList.add("overdue");
  const item = await get("items", loan.itemId);
  const borrower = loan.borrowerId ? await getBorrower(loan.borrowerId) : null;
  const badge = document.createElement("div");
  badge.className = `loan-badge ${loan.dueAt && loan.dueAt < Date.now() ? "badge-overdue" : "badge-today"}`;
  if (loan.dueAt && loan.dueAt < Date.now()) {
    badge.textContent = `OVERDUE ${formatRelativeTime(Date.now() - loan.dueAt)}`;
  } else {
    badge.textContent = formatRelativeTime(Date.now() - loan.checkedOutAt);
  }
  row.appendChild(badge);
  const details = document.createElement("div");
  details.className = "loan-details";
  details.innerHTML = `
    <div class="borrower-name">${escapeHtml3(borrower?.name || loan.borrowerNameSnapshot || "(walk-in)")}</div>
    <div class="loan-meta">${escapeHtml3(item?.name || loan.itemNameSnapshot || "?")} \xB7 out ${formatRelativeTime(Date.now() - loan.checkedOutAt)}</div>
  `;
  row.appendChild(details);
  const quickCheckin = document.createElement("button");
  quickCheckin.className = "btn btn-success";
  quickCheckin.style.cssText = "min-height:48px; padding:8px 16px; font-size:14px;";
  quickCheckin.textContent = "\u2713";
  quickCheckin.onclick = async (e) => {
    e.stopPropagation();
    try {
      await returnLoan(loan.id, {
        returnedAt: Date.now(),
        conditionIn: "good"
      });
      showToast("Returned OK", {
        type: "success"
      });
      if (document.getElementById("screen-admin-detail").classList.contains("hidden") === false) {
        const activeTab = document.querySelector(".tab.active")?.dataset.tab;
        if (activeTab === "queue") renderQueue();
        else if (activeTab === "currently-out") renderCurrentlyOut();
        else if (activeTab === "overdue") renderOverdue();
        else if (activeTab === "all-loans") renderAllLoans();
      } else {
        const activeTab = document.querySelector(".tab.active")?.dataset.tab;
        if (activeTab === "queue") renderQueue();
        else if (activeTab === "currently-out") renderCurrentlyOut();
        else if (activeTab === "overdue") renderOverdue();
        else if (activeTab === "all-loans") renderAllLoans();
        else if (activeTab === "items") renderItems();
        else if (activeTab === "people") renderPeople();
      }
      await renderAdminStats();
    } catch (err) {
      showToast("Failed: " + err.message, {
        type: "error"
      });
    }
  };
  row.appendChild(quickCheckin);
  row.onclick = () => {
    if (loan.borrowerId) showBorrowerDetail(loan.borrowerId);
    else if (item) showItemDetail(item.id);
  };
  return row;
}
async function _makeOverdueRow(loan) {
  const row = document.createElement("div");
  row.className = "admin-list-item";
  row.style.cssText = "flex-direction:column; align-items:stretch; padding:20px; gap:12px;";
  const item = await get("items", loan.itemId);
  const borrower = loan.borrowerId ? await getBorrower(loan.borrowerId) : null;
  const phone = borrower?.phone || loan.borrowerPhoneSnapshot || "";
  const top = document.createElement("div");
  top.style.cssText = "display:flex; align-items:center; gap:12px; flex-wrap:wrap;";
  top.innerHTML = `
    <div style="flex:1; min-width:200px;">
      <div class="borrower-name" style="color:var(--magenta); font-size:20px;">${escapeHtml3(borrower?.name || loan.borrowerNameSnapshot || "(walk-in)")}</div>
      <div class="loan-meta" style="margin-top:4px;">
        <strong>${escapeHtml3(item?.name || loan.itemNameSnapshot || "?")}</strong>
        &middot; out ${formatRelativeTime(Date.now() - loan.checkedOutAt)}
        &middot; <span style="color:var(--warning);">overdue by ${formatRelativeTime(Date.now() - (loan.dueAt || Date.now()))}</span>
      </div>
      <div class="loan-meta">${escapeHtml3(formatPhone(phone))}</div>
    </div>
  `;
  row.appendChild(top);
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex; gap:8px; flex-wrap:wrap;";
  if (phone) {
    const callBtn = document.createElement("a");
    callBtn.className = "btn btn-secondary";
    callBtn.style.cssText = "min-height:48px; padding:8px 16px; text-decoration:none;";
    callBtn.href = telUri(phone);
    callBtn.textContent = "\u{1F4DE} Call";
    actions.appendChild(callBtn);
    const textBtn = document.createElement("a");
    textBtn.className = "btn btn-secondary";
    textBtn.style.cssText = "min-height:48px; padding:8px 16px; text-decoration:none;";
    const body = `Hi, you have an overdue item at the Rotman front desk (${item?.name || loan.itemNameSnapshot || "?"}). Please return it. Thanks!`;
    textBtn.href = smsUri(phone, body);
    textBtn.textContent = "\u{1F4AC} Text";
    actions.appendChild(textBtn);
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn btn-secondary";
    copyBtn.style.cssText = "min-height:48px; padding:8px 16px;";
    copyBtn.textContent = "\u{1F4CB} Copy";
    copyBtn.onclick = async () => {
      const overdue = formatRelativeTime(Date.now() - (loan.dueAt || Date.now()));
      const text = `${borrower?.name || loan.borrowerNameSnapshot} \xB7 ${formatPhone(phone)} \xB7 ${item?.name || loan.itemNameSnapshot} \xB7 overdue ${overdue}`;
      try {
        await navigator.clipboard.writeText(text);
        showToast("Copied to clipboard", {
          type: "success"
        });
      } catch (err) {
        const ta = document.createElement("textarea");
        ta.value = text;
        // Off-screen rather than inline: appending it in the flow can scroll
        // the list the staff member was looking at.
        ta.style.cssText = "position:fixed; top:-1000px; left:0; opacity:0;";
        document.body.appendChild(ta);
        ta.select();
        let copied = false;
        try {
          // The boolean is the only signal there is. It used to be discarded and
          // "Copied" toasted regardless, so a failed copy looked like a success
          // and the staff member pasted whatever was already on the clipboard.
          copied = document.execCommand("copy");
        } catch (_) {
          copied = false;
        }
        ta.remove();
        showToast(copied ? "Copied" : "Could not copy — select the text and copy it by hand", {
          type: copied ? "success" : "error"
        });
      }
    };
    actions.appendChild(copyBtn);
  }
  const checkinBtn = document.createElement("button");
  checkinBtn.className = "btn btn-success";
  checkinBtn.style.cssText = "min-height:48px; padding:8px 16px;";
  checkinBtn.textContent = "\u2713 Returned";
  checkinBtn.onclick = async () => {
    try {
      await returnLoan(loan.id, {
        returnedAt: Date.now(),
        conditionIn: "good"
      });
      showToast("Returned OK", {
        type: "success"
      });
      await renderOverdue();
      await renderAdminStats();
    } catch (err) {
      showToast("Failed: " + err.message, {
        type: "error"
      });
    }
  };
  actions.appendChild(checkinBtn);
  row.appendChild(actions);
  return row;
}
function _makeClosedLoanRow(loan) {
  const row = document.createElement("div");
  row.className = "admin-list-item";
  const cond = loan.conditionIn;
  const condColor = cond === "damaged" ? "var(--warning)" : cond === "lost" ? "var(--error)" : "var(--text-muted)";
  row.innerHTML = `
    <div style="flex:1; min-width:200px;">
      <div class="borrower-name">${escapeHtml3(loan.borrowerNameSnapshot || "(walk-in)")}</div>
      <div class="loan-meta">${escapeHtml3(loan.itemNameSnapshot || "?")} \xB7 ${formatAbsoluteTime(loan.checkedOutAt)}${loan.returnedAt ? " \u2192 " + formatAbsoluteTime(loan.returnedAt) : " (still out)"}</div>
    </div>
    <div class="loan-meta" style="color:${condColor};">${escapeHtml3(cond || "open")}</div>
  `;
  return row;
}
async function _editItem(item) {
  const form = document.createElement("div");
  form.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:12px;">
      <input class="input" placeholder="Name" value="${escapeAttr2(item.name)}" data-f="name" />
      <input class="input" placeholder="Category" value="${escapeAttr2(item.category || "")}" data-f="category" />
      <input class="input" placeholder="Location" value="${escapeAttr2(item.location || "")}" data-f="location" />
      <select class="input" data-f="condition">
        <option value="good"${item.condition === "good" ? " selected" : ""}>Good</option>
        <option value="fair"${item.condition === "fair" ? " selected" : ""}>Fair</option>
        <option value="damaged"${item.condition === "damaged" ? " selected" : ""}>Damaged</option>
      </select>
      <textarea class="input" placeholder="Notes" data-f="notes" rows="3">${escapeHtml3(item.notes || "")}</textarea>
    </div>
  `;
  const choice = await showDialog({
    title: "Edit item",
    body: form,
    buttons: [
      {
        label: "Cancel",
        value: null,
        variant: "ghost"
      },
      {
        label: "Save",
        value: "save",
        variant: "primary"
      }
    ]
  });
  if (choice === "save") {
    item.name = sentenceCase(form.querySelector('[data-f="name"]').value.trim());
    item.nameLower = item.name.toLowerCase();
    item.category = sentenceCase(form.querySelector('[data-f="category"]').value.trim()) || "Other";
    item.location = form.querySelector('[data-f="location"]').value.trim();
    item.condition = form.querySelector('[data-f="condition"]').value;
    item.notes = form.querySelector('[data-f="notes"]').value;
    await put("items", item);
    showToast("Item updated", {
      type: "success"
    });
    invalidateItemsCache();
    showItemDetail(item.id);
  }
}
async function _archiveItem(item) {
  item.isArchived = !item.isArchived;
  await put("items", item);
  showToast(item.isArchived ? "Item archived" : "Item unarchived", {
    type: "success"
  });
  invalidateItemsCache();
  showItemDetail(item.id);
}
async function _editBorrower(borrower) {
  const form = document.createElement("div");
  form.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:12px;">
      <input class="input" placeholder="Name" value="${escapeAttr2(borrower.name)}" data-f="name" />
      <input class="input" placeholder="Phone" value="${escapeAttr2(formatPhone(borrower.phone))}" data-f="phone" />
      <input class="input" placeholder="Secondary contact (email etc.)" value="${escapeAttr2(borrower.contact2 || "")}" data-f="contact2" />
      <textarea class="input" placeholder="Notes" data-f="notes" rows="3">${escapeHtml3(borrower.notes || "")}</textarea>
    </div>
  `;
  const choice = await showDialog({
    title: "Edit borrower",
    body: form,
    buttons: [
      {
        label: "Cancel",
        value: null,
        variant: "ghost"
      },
      {
        label: "Save",
        value: "save",
        variant: "primary"
      }
    ]
  });
  if (choice === "save") {
    borrower.name = sentenceCase(form.querySelector('[data-f="name"]').value.trim());
    borrower.nameLower = borrower.name.toLowerCase();
    const newPhone = normalizePhone(form.querySelector('[data-f="phone"]').value);
    if (newPhone && newPhone.length === 10) {
      borrower.phone = newPhone;
      borrower.phoneFormatted = formatPhone(newPhone);
    }
    borrower.contact2 = form.querySelector('[data-f="contact2"]').value.trim();
    borrower.notes = form.querySelector('[data-f="notes"]').value;
    await put("borrowers", borrower);
    showToast("Borrower updated", {
      type: "success"
    });
    showBorrowerDetail(borrower.id);
  }
}
async function _archiveBorrower(borrower) {
  borrower.isArchived = !borrower.isArchived;
  await put("borrowers", borrower);
  showToast(borrower.isArchived ? "Borrower archived" : "Borrower unarchived", {
    type: "success"
  });
  showBorrowerDetail(borrower.id);
}
async function _mergeBorrower(borrower) {
  const all = await listBorrowers({
    includeArchived: true
  });
  const others = all.filter((b) => b.id !== borrower.id);
  if (others.length === 0) {
    showToast("No other borrowers to merge with", {
      type: "error"
    });
    return;
  }
  const buttons = others.slice(0, 10).map((b) => ({
    label: `${b.name} \xB7 ${formatPhone(b.phone)}`,
    value: b,
    variant: "secondary"
  }));
  buttons.push({
    label: "Cancel",
    value: null,
    variant: "ghost"
  });
  const other = await showDialog({
    title: `Merge "${borrower.name}" with\u2026`,
    body: '<p style="color:var(--text-secondary); margin-bottom:12px;">All loans from the chosen borrower will be moved to <strong>' + escapeHtml3(borrower.name) + "</strong>. The other borrower will be deleted.</p>",
    buttons
  });
  if (!other) return;
  const confirmChoice = await showDialog({
    title: "Confirm merge",
    body: `<p>Move all loans from <strong>${escapeHtml3(other.name)}</strong> to <strong>${escapeHtml3(borrower.name)}</strong> and delete the other borrower?</p>`,
    buttons: [
      {
        label: "Cancel",
        value: null,
        variant: "ghost"
      },
      {
        label: "Merge",
        value: "merge",
        variant: "danger"
      }
    ]
  });
  if (confirmChoice !== "merge") return;
  try {
    await mergeBorrowers(borrower.id, other.id);
    showToast("Merged", {
      type: "success"
    });
    showBorrowerDetail(borrower.id);
  } catch (err) {
    showToast("Merge failed: " + err.message, {
      type: "error"
    });
  }
}
async function _promptAddItem(refresh) {
  const form = document.createElement("div");
  form.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:12px;">
      <input class="input" placeholder="Item name" data-f="name" />
      <input class="input" placeholder="Category (default: Other)" data-f="category" />
    </div>
  `;
  const choice = await showDialog({
    title: "Add new item",
    body: form,
    buttons: [
      {
        label: "Cancel",
        value: null,
        variant: "ghost"
      },
      {
        label: "Add",
        value: "add",
        variant: "primary"
      }
    ]
  });
  if (choice !== "add") return;
  const name = sentenceCase(form.querySelector('[data-f="name"]').value.trim());
  const category = sentenceCase(form.querySelector('[data-f="category"]').value.trim()) || "Other";
  if (!name) {
    showToast("Please enter a name", {
      type: "error"
    });
    return;
  }
  const existing = await findItemByName(name);
  if (existing) {
    const confirm3 = await showDialog({
      title: "Item already exists",
      body: `<p>An item named <strong>${escapeHtml3(existing.name)}</strong> already exists.</p>`,
      buttons: [
        {
          label: "Cancel",
          value: null,
          variant: "ghost"
        },
        {
          label: "Add anyway",
          value: "add",
          variant: "secondary"
        }
      ]
    });
    if (confirm3 !== "add") return;
  }
  await createItem({
    name,
    category
  });
  invalidateItemsCache();
  showToast("Item added", {
    type: "success"
  });
  await refresh();
}
async function _promptAddBorrower(refresh) {
  const form = document.createElement("div");
  form.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:12px;">
      <input class="input" placeholder="Name" data-f="name" />
      <input class="input" placeholder="Phone" data-f="phone" />
    </div>
  `;
  const choice = await showDialog({
    title: "Add new borrower",
    body: form,
    buttons: [
      {
        label: "Cancel",
        value: null,
        variant: "ghost"
      },
      {
        label: "Add",
        value: "add",
        variant: "primary"
      }
    ]
  });
  if (choice !== "add") return;
  const name = form.querySelector('[data-f="name"]').value.trim();
  const phone = normalizePhone(form.querySelector('[data-f="phone"]').value);
  if (!name || phone.length !== 10) {
    showToast("Name and 10-digit phone required", {
      type: "error"
    });
    return;
  }
  await upsertBorrower({
    phone,
    name
  });
  showToast("Borrower added", {
    type: "success"
  });
  await refresh();
}
async function _wipeData() {
  const form = document.createElement("div");
  form.innerHTML = `
    <p style="color:var(--error); margin-bottom:12px;">This will delete <strong>every</strong> item, borrower, and loan record. This cannot be undone (unless you have a backup).</p>
    <p style="margin-bottom:8px;">Type <strong>DELETE</strong> to confirm:</p>
    <input class="input" placeholder="DELETE" data-f="confirm" />
  `;
  const choice = await showDialog({
    title: "Wipe all data",
    body: form,
    buttons: [
      {
        label: "Cancel",
        value: null,
        variant: "ghost"
      },
      {
        label: "Wipe",
        value: "wipe",
        variant: "danger"
      }
    ]
  });
  if (choice !== "wipe") return;
  const text = form.querySelector('[data-f="confirm"]').value;
  if (text !== "DELETE") {
    showToast("Confirmation text didn't match", {
      type: "error"
    });
    return;
  }
  const d = await openDB();
  const tx2 = d.transaction([
    "items",
    "borrowers",
    "loans",
    "settings"
  ], "readwrite");
  tx2.objectStore("items").clear();
  tx2.objectStore("borrowers").clear();
  tx2.objectStore("loans").clear();
  const settings = await getSettings();
  settings.pin = "1234";
  settings.defaultLoanHours = 8;
  settings.theme = "dark";
  settings.lastBackupAt = null;
  settings.pinFailures = 0;
  settings.pinLockedUntil = 0;
  _pinFailures = 0;
  _pinLockedUntil = 0;
  tx2.objectStore("settings").put(settings);
  await new Promise((resolve, reject) => {
    tx2.oncomplete = () => resolve();
    tx2.onerror = () => reject(tx2.error);
  });
  showToast("All data wiped", {
    type: "success"
  });
  await _renderActiveTab();
  await renderAdminStats();
}
function _wireAdminChrome() {
  if (_wiredOnce) return;
  const root = document.getElementById("screen-admin");
  if (!root) return;
  // Any real interaction on the admin screens pushes the idle timer back. The
  // timer used to be started once in showAdmin() and never extended, so a staff
  // member actively working was thrown back to the login screen mid-task after
  // five minutes. These are passive listeners, so they cost nothing.
  const bump = () => touchAdminSession();
  root.addEventListener("pointerdown", bump, { passive: true });
  root.addEventListener("keydown", bump);
  root.addEventListener("wheel", bump, { passive: true });
  const tabs = root.querySelectorAll(".tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const panels = root.querySelectorAll(".tab-panel");
      panels.forEach((p) => p.classList.remove("active"));
      const target = root.querySelector(`#tab-${tab.dataset.tab}`);
      if (target) target.classList.add("active");
      try {
        localStorage.setItem(ACTIVE_TAB_KEY, tab.dataset.tab);
      } catch (_) {
      }
      _renderActiveTab();
    });
  });
  root.addEventListener("click", async (e) => {
    const confirmReturnBtn = e.target.closest('[data-action="confirm-return"]');
    if (confirmReturnBtn) {
      await _confirmPendingReturn(Number(confirmReturnBtn.dataset.loanId));
      return;
    }
    const confirmDamagedBtn = e.target.closest('[data-action="confirm-return-damaged"]');
    if (confirmDamagedBtn) {
      await _confirmPendingReturn(Number(confirmDamagedBtn.dataset.loanId), "damaged");
      return;
    }
    const denyReturnBtn = e.target.closest('[data-action="deny-return"]');
    if (denyReturnBtn) {
      await _denyPendingReturn(Number(denyReturnBtn.dataset.loanId));
      return;
    }
    const fulfillBtn = e.target.closest('[data-action="fulfill-request"]');
    if (fulfillBtn) {
      const id = Number(fulfillBtn.dataset.requestId);
      await _fulfillRequestFlow(id);
      return;
    }
    const cancelBtn = e.target.closest('[data-action="cancel-request"]');
    if (cancelBtn) {
      const id = Number(cancelBtn.dataset.requestId);
      const confirmed = await confirmDialog("Cancel this borrower request? They will not be told.", {
        title: "Cancel request",
        danger: true,
        // "Cancel" next to "Cancel request" reads as the same button twice.
        cancelLabel: "Keep it",
        confirmLabel: "Cancel request"
      });
      if (!confirmed) return;
      try {
        await cancelRequest(id);
        showToast("Request cancelled", {
          type: "info"
        });
        renderQueue();
        renderAdminStats();
      } catch (err) {
        showToast("Failed: " + err.message, {
          type: "error"
        });
      }
    }
  });
  const adminBack = root.querySelector('[data-action="admin-back"]');
  if (adminBack) {
    adminBack.onclick = () => {
      goToScreen("welcome");
    };
  }
  // The way to the desk from the admin panel.
  //
  // This was a `.btn-back:not([data-action])` fallback that could never match:
  // the admin header's only back button carries data-action="admin-back", so
  // the branch was dead and nothing on the admin panel led to the staff home.
  // That left the home screen -- where checkout and check-in live, and which
  // the README calls the main staff job -- reachable only by tapping the splash
  // inside its 400ms window or by pressing Escape, and a tablet has no Escape
  // key. Staff who signed in on the desk tablet could reach the admin panel and
  // nothing else. The kiosk still refuses to leave for a staff screen; this is
  // the authenticated side of that boundary, which is where it belongs.
  const adminHome = root.querySelector('[data-action="admin-home"]');
  if (adminHome) {
    adminHome.onclick = () => {
      goToScreen("home");
      refreshHome();
    };
  }
  _wiredOnce = true;
}
function _restoreActiveTab() {
  let active = "queue";
  try {
    const stored = localStorage.getItem(ACTIVE_TAB_KEY);
    if (stored) active = stored;
  } catch (_) {
  }
  const root = document.getElementById("screen-admin");
  if (!root) return;
  const tabs = root.querySelectorAll(".tab");
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === active));
  const panels = root.querySelectorAll(".tab-panel");
  panels.forEach((p) => p.classList.toggle("active", p.id === `tab-${active}`));
}
async function _renderActiveTab() {
  const active = document.querySelector("#screen-admin .tab.active")?.dataset.tab;
  if (!active) return;
  if (active === "queue") await renderQueue();
  else if (active === "currently-out") await renderCurrentlyOut();
  else if (active === "overdue") await renderOverdue();
  else if (active === "all-loans") await renderAllLoans();
  else if (active === "items") await renderItems();
  else if (active === "people") await renderPeople();
  else if (active === "reports") await renderReports();
  else if (active === "settings") await renderSettings();
}
function escapeHtml3(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}
function escapeAttr2(s) {
  return escapeHtml3(s);
}

// ../frontdesk/app.js
window.app = {
  goToScreen,
  goBack,
  hideDialog: () => Promise.resolve().then(() => (init_ui(), ui_exports)).then((m) => m.hideDialog()),
  showAdminLogin,
  cancelAdminLogin,
  refreshHome,
  // Called by the host's tray menu. Exposed so a support person can also run
  // it from the devtools console.
  runBackupNow,
  isHosted,
  hostInfo,
  renderSettings,
  renderReports,
  _ready: true
};
if (window.__appReadyQueue) {
  for (const fn of window.__appReadyQueue) {
    try {
      fn();
    } catch (_) {
    }
  }
  window.__appReadyQueue = [];
}
window.__appReady = true;
async function bootstrap() {
  try {
    await openDB();
    const settings = await getSettings();
    if (!settings.lastDedupAt || Date.now() - settings.lastDedupAt > 24 * 60 * 60 * 1e3) {
      runDailyDedup().then((result) => {
        window.__duplicateItemGroups = result.duplicateGroups || 0;
        updateSettings({ lastDedupAt: Date.now() }).catch(() => {
        });
      }).catch((err) => {
        console.warn("[dedup] failed:", err);
      });
    }
    document.body.classList.toggle("light", settings.theme === "light");
    // If the last launch had to recreate the database from a schema mismatch,
    // say so. Silently throwing away records is the thing H1 was about; a
    // console warning is not visible to the person standing at the desk.
    const recovery = takeRecoveryReport();
    if (recovery) {
      const when = new Date(recovery.at).toLocaleString("en-CA");
      showToast(`Database was rebuilt on ${when} — ${recovery.salvaged} records carried over. Check your data, then take a backup.`, {
        type: recovery.skipped > 0 ? "error" : "info",
        duration: 12e3
      });
    }
    initScreens();
    initHomeScreen();
    initKiosk();
    renderBuildInfo().catch(() => {});
    // Re-render the active admin tab whenever the admin screen is entered.
    // `onEnterHooks` existed and was never populated, so returning from a detail
    // screen (item, borrower, duplicate review) left the list underneath showing
    // the state from before the edit -- an archived item still listed, a merged
    // duplicate still counted, a resolved banner still warning.
    onEnterHooks.set("admin", () => _renderActiveTab());
    // And the same for Home, whose "N out / N overdue / N today" bar is the
    // first thing a staff member reads. Every route that reaches Home happened
    // to pair goToScreen("home") with refreshHome() by hand -- the splash tap,
    // Escape, the admin back button, the visibility handler. A route that
    // forgot left the bar showing whatever it said last, which on a fresh
    // document is three zeros sitting above a desk with items out. Doing it
    // here means the counts are right by construction rather than by memory.
    onEnterHooks.set("home", () => refreshHome());
    try {
      const keyboardContainer = document.getElementById("keyboard");
      if (keyboardContainer) {
        const { initKeyboard: initKeyboard2 } = await Promise.resolve().then(() => (init_keyboard(), keyboard_exports));
        window.__keyboard = initKeyboard2(keyboardContainer);
      }
    } catch (err) {
      console.warn("Keyboard init failed (non-fatal):", err);
    }
    // One instance per flow, reused. `_wireDom` guards on `_wireOnce` which is
    // per-instance, so building a new flow on every entry re-attached the input
    // listeners each time -- N handlers meant N concurrent catalog lookups, which
    // created N duplicate items -- and left old listeners calling into a dead
    // instance's state. start() resets state, so reuse is safe.
    window.addEventListener("frontdesk:checkout-start", () => {
      if (!window.__checkoutFlow) window.__checkoutFlow = new CheckoutFlow();
      window.__checkoutFlow.start();
    });
    window.addEventListener("frontdesk:checkin-start", () => {
      if (!window.__checkinFlow) window.__checkinFlow = new CheckinFlow();
      window.__checkinFlow.start();
    });
    window.addEventListener("frontdesk:admin-start", () => {
      showAdminLogin();
    });
    const splash = document.getElementById("screen-splash");
    if (splash) {
      splash.addEventListener("click", () => {
        if (getCurrentScreen() === "splash") {
          goToScreen("home");
          refreshHome();
        }
      });
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && getCurrentScreen() === "home") {
        refreshHome();
      }
    });
    autoBackup().catch((e) => console.warn("Auto-backup failed:", e));
    // The service-worker registration was removed. It pointed at ./sw.js, which
    // does not exist in this build, so every launch logged a 404 -- and a cache
    // in front of a locally-installed app is pure downside: if a stale app.js is
    // ever pinned, a fix you shipped never reaches the tablet. The app is served
    // from disk (file:// or the WebView2 virtual host) and is never more than a
    // restart away from current.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        for (const reg of regs) reg.unregister().catch(() => {});
      }).catch(() => {});
    }
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "A" || e.key === "a")) {
        e.preventDefault();
        // Never from the public kiosk surface. This shortcut is a physical-keyboard
        // route into staff screens that anyone standing at the tablet could press.
        if (!isKioskScreen(getCurrentScreen())) showAdminLogin();
        return;
      }
      if (e.key === "Escape") {
        // Let an open dialog handle Escape first. This listener is registered at
        // bootstrap, so it ran before the dialog's own handler -- pressing Escape
        // to dismiss "Which person?" also threw the user out to Home mid-checkout.
        const dialogEl = document.getElementById("dialog");
        if (dialogEl && !dialogEl.classList.contains("hidden")) return;
        if (isKioskScreen(getCurrentScreen())) return;
        const current = getCurrentScreen();
        const isStaffScreen = current === "home" || current === "admin" || current === "admin-detail" || current === "checkout" || current === "checkin" || current === "checkin-return";
        if (isStaffScreen) {
          if (current !== "home" && current !== "admin-login" && current !== "splash") {
            goToScreen("home");
            refreshHome();
          }
        }
        return;
      }
    });
    goToScreen("splash");
    setTimeout(() => {
      if (getCurrentScreen() === "splash") {
        goToScreen("welcome");
      }
    }, 400);
  } catch (err) {
    console.error("Bootstrap failed:", err);
    showFatalError(err);
  }
}
function showFatalError(err) {
  const message = err && err.message || "Unknown error";
  document.body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.cssText = "padding: 40px; text-align: center; color: #f0f0f2; background: #0a0a0b; min-height: 100vh; font-family: system-ui, sans-serif;";
  wrap.innerHTML = `
    <h1 style="color: #E6007E; font-size: 28px; margin-bottom: 16px;">Something went wrong</h1>
    <p style="margin-bottom: 16px; opacity: 0.8;">${escapeHtml4(message)}</p>
    <p style="color: #848892; margin-top: 20px; font-size: 14px;">
      Try refreshing the page. If the problem persists, your data is still safe
      in this device's storage.
    </p>
    <button onclick="location.reload()" style="margin-top: 24px; padding: 12px 24px; background: #E6007E; color: #fff; border: 0; border-radius: 8px; font-size: 16px; cursor: pointer;">
      Reload
    </button>
  `;
  document.body.appendChild(wrap);
}
function escapeHtml4(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}
bootstrap();

})();

