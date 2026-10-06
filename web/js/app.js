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
        let req;
        try {
          req = store.put(rec);
        } catch (_) {
          result.skipped++;
          continue;
        }
        // The count follows the *request*, not the call. `put` only throws
        // synchronously for a shape it can reject outright; a unique index the
        // new schema added, or anything else the store refuses on write, fails
        // asynchronously -- and a failure that was merely queued used to be
        // counted as restored. Containing it here is also what keeps one bad
        // record from aborting the restore of the other 299.
        req.onsuccess = () => {
          result.restored++;
        };
        req.onerror = (e) => {
          result.skipped++;
          if (e && e.preventDefault) e.preventDefault();
          if (e && e.stopPropagation) e.stopPropagation();
        };
      }
    }
    t.oncomplete = () => resolve(result);
    // The transaction failed or was aborted, so it rolled back: nothing was
    // written, whatever the request counters reached before it died. Reporting
    // those counts here is a lie at the worst possible moment -- the person is
    // being told how much survived a rebuild.
    t.onerror = () => resolve({
      restored: 0,
      skipped: result.skipped,
      stores: names,
      failed: true
    });
    t.onabort = () => resolve({
      restored: 0,
      skipped: result.skipped,
      stores: names,
      failed: true
    });
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
      stores: report.stores,
      // The whole restore rolled back. Kept separate from `skipped` because it is
      // a different sentence to the person reading it.
      failed: report.failed === true
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
    // The callback is async, so a throw inside it *rejects this promise* instead of
    // throwing here, and that rejection is how the caller is told what went wrong.
    // The handler for it is attached further down -- in `oncomplete`, or in
    // `onerror`/`onabort` -- which is a macrotask later, and the browser reports an
    // unhandled rejection at the end of the turn it was rejected in. Nothing is
    // actually unhandled, but the page says it is, and this app forwards unhandled
    // rejections to the host's log file, stopping after twenty.
    //
    // So a page of ordinary refusals crowds out the one real crash that log exists
    // for. "Both entries are checked out. Check one in before merging" is a correct
    // answer, shown to staff as a toast, and it was arriving in the log as
    // "Unhandled rejection" alongside every other rule this app enforces. Claiming
    // it here does not change what the caller sees: the handlers below still run,
    // and the transaction's own outcome still decides the result.
    //
    // And a throw after the callback has written something must undo it. The
    // transaction used to commit whatever had been put before the throw, so a
    // refusal half-way through a multi-write operation left half of it behind.
    let asyncError = null;
    if (fnResult && typeof fnResult.then === "function") {
      fnResult.then(undefined, (err) => {
        asyncError = err;
        try {
          transaction.abort();
        } catch {
        }
      });
    }
    if (fnError) {
      try {
        transaction.abort();
      } catch {
      }
      return reject(fnError);
    }
    transaction.oncomplete = () => {
      // Any committed write can change what the catalog resolves to, or what is
      // available, so both caches are dropped here rather than at each call site.
      // Central is the point: the previous arrangement called the invalidator from
      // four places and `createItem` was not one of them, so an item a staff member
      // added from the checkout step was in the database but invisible to the
      // kiosk picker until the page reloaded.
      if (mode !== "readonly") {
        if (storeNames.indexOf("items") !== -1) invalidateItemsCache();
        // Availability comes from `loans`, not `items`: a check-in writes only a
        // loan, and missing that is a borrower refused an item that is on the shelf.
        if (storeNames.indexOf("loans") !== -1) invalidateAvailabilityCache();
      }
      Promise.resolve(fnResult).then(resolve, reject);
    };
    // A failed request reaches the transaction's onerror *before* the abort sets
    // transaction.error, so that was always null here: every caller got
    // `reject(null)`, and the `err.message` in its catch threw instead of showing
    // the toast. The request's own error is on the event.
    transaction.onerror = (e) => reject(transaction.error || (e && e.target && e.target.error) || new Error("The database refused the change."));
    transaction.onabort = () => reject(asyncError || transaction.error || new Error("transaction aborted"));
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
  const result = await asPromise(tx(store, "readwrite").put(value));
  // See the note in `runTx`: these are the two stores the read caches derive from.
  if (store === "items") invalidateItemsCache();
  if (store === "loans") invalidateAvailabilityCache();
  return result;
}
async function del(store, id) {
  await openDB();
  const result = await asPromise(tx(store, "readwrite").delete(id));
  if (store === "items") invalidateItemsCache();
  if (store === "loans") invalidateAvailabilityCache();
  return result;
}
async function getByIndex(store, indexName, value) {
  await openDB();
  return asPromise(tx(store).index(indexName).get(value));
}
async function getAllByIndex(store, indexName, value) {
  await openDB();
  return asPromise(tx(store).index(indexName).getAll(value));
}
/**
 * Every item record, cached for a moment.
 *
 * `listItems` is the hot path in this app: it is called on every keystroke of
 * every search box, and each call used to be a full `getAll("items")` plus an
 * in-memory sort. That is invisible at 20 items and ruinous at 10,000, which is
 * the catalog size this app has to hold.
 *
 * The TTL is a backstop, not the mechanism. The mechanism is
 * `invalidateItemsCache()`, which every item-writing path calls. The TTL exists
 * because a *missed* invalidation here is not a slow screen, it is a "the item
 * you just created does not exist" bug -- and that is exactly the bug this work
 * was opened to fix. A cache that heals itself in 1.5s is a delay; a cache that
 * never heals is a data-loss report.
 *
 * Callers always get a fresh array, because `searchItems` sorts what it is
 * handed and `_renderItemsList` sorts what it is handed.
 */
var _itemsRawCache = null;
var _itemsRawCachedAt = 0;
var ITEMS_CACHE_TTL_MS = 1500;
async function _allItemRecords() {
  const now = Date.now();
  if (_itemsRawCache && now - _itemsRawCachedAt < ITEMS_CACHE_TTL_MS) {
    return _itemsRawCache;
  }
  await openDB();
  _itemsRawCache = await getAll("items");
  _itemsRawCachedAt = now;
  return _itemsRawCache;
}
async function listItems({ includeArchived = false, sortBy = "name" } = {}) {
  const allItems = await _allItemRecords();
  let items = includeArchived ? allItems.slice() : allItems.filter((item) => !item.isArchived);
  items.sort((a, b) => {
    if (sortBy === "timesCheckedOut") {
      return b.timesCheckedOut - a.timesCheckedOut;
    }
    return String(a.name || "").localeCompare(String(b.name || ""), void 0, {
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
/**
 * What is wrong with this name for a catalog entry, or "" if nothing is.
 *
 * `createItem` refuses these by throwing, which is right for the one choke point
 * -- but a throw from a click handler whose dialog has already closed is
 * invisible: the dialog goes, no item appears, and the only trace is a rejection
 * in the log. Typing "..." or "???" did exactly that. So this is the same answer
 * in a form a caller can show, and the surfaces that create check it *before*
 * they put a toast up; `createItem` still throws it as the backstop behind them.
 *
 * The letters-or-digits rule is not fussiness: matching strips punctuation, so a
 * name made only of punctuation has no match key and could never be found again.
 */
function itemNameProblem(name) {
  const clean = String(name == null ? "" : name).trim();
  if (!clean) return "Please enter a name";
  if (!matchKey(clean)) return "That name needs at least one letter or digit";
  return "";
}
/**
 * Create a catalog entry. The single choke point for that, so every rule about
 * what a name may be lives here rather than in each caller.
 *
 * The length cap and the "must reduce to something" check are not cosmetic. Both
 * surfaces offer to create an item from whatever is in a text box, and the kiosk
 * offers it to the public, so without a cap a paste of 100KB becomes a catalog
 * row that every list, export and backup then carries forever.
 *
 * `extra` lets a caller stamp fields the desk will want to see -- the kiosk uses
 * it for `createdBy` and `needsReview` -- without this function having to know
 * what those mean.
 */
async function createItem({ name, category, location: location2, condition, notes, extra } = {}) {
  await openDB();
  const clean = String(name == null ? "" : name).trim().slice(0, 120);
  const problem = itemNameProblem(clean);
  if (problem) throw new Error(problem);
  const item = {
    name: clean,
    nameLower: clean.toLowerCase(),
    category: category || "Other",
    location: location2 || "",
    condition: condition || "good",
    notes: String(notes || "").slice(0, 500),
    timesCheckedOut: 0,
    lastCheckedOutAt: null,
    isArchived: false,
    createdAt: Date.now(),
    ...(extra || {})
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
      // Kept in step with `phone` wherever the number is set. It was seeded as ""
      // and never written, so every screen that prefers "the live number if there
      // is one" fell back to the loan's snapshot instead -- a corrected number
      // could not reach the overdue list, and People could not be searched by a
      // formatted number at all.
      borrower2.phoneFormatted = formatPhone(borrower2.phone);
      if (contact2) borrower2.contact2 = contact2;
      await s.req(store.put(borrower2));
      return borrower2;
    }
    const borrower = {
      phone: normalizedPhone,
      phoneFormatted: formatPhone(normalizedPhone),
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
    return String(a.name || "").localeCompare(String(b.name || ""), void 0, {
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
  borrower.phoneFormatted = formatPhone(newPhone);
  borrower.lastSeenAt = Date.now();
  await put("borrowers", borrower);
  await _syncOpenLoanPhones(borrowerId, newPhone);
  return borrower;
}
/**
 * Carry a corrected phone number onto the loans that are still open.
 *
 * A loan stores the borrower's number as it was when the loan was booked, and for
 * a loan that has been returned that snapshot is the honest record of the receipt
 * that was handed over, so it is left alone. An **open** loan is not history: it
 * is a live obligation and the row the desk rings someone about, and the overdue
 * card and the loan export both read this field. Leaving it stale meant a
 * corrected number never reached the one place it was needed.
 *
 * Called from both paths that can change a number -- `updateBorrowerPhone` and the
 * admin's Edit borrower dialog -- so the two cannot diverge.
 */
async function _syncOpenLoanPhones(borrowerId, phone) {
  return runTx([
    "loans"
  ], "readwrite", async (s) => {
    const store = s.get("loans");
    const loans = await s.req(store.index("borrowerId").getAll(borrowerId));
    let updated = 0;
    for (const loan of loans) {
      if (isLoanOpen(loan) && loan.borrowerPhoneSnapshot !== phone) {
        loan.borrowerPhoneSnapshot = phone;
        await s.req(store.put(loan));
        updated++;
      }
    }
    return {
      updated
    };
  });
}
async function createLoan({ itemId, borrowerId, checkedOutAt, dueAt, conditionOut, notes, recordedBy, customName, matchedFrom, walkIn }) {
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
      // A cart can outlive its items: a checkout draft resumed after one of its
      // items was merged away used to write the loan against the archived copy,
      // where the keeper's "already out" check could not see it -- so the same
      // unit could go out twice. Follow the merge to the item that lives on.
      for (let hops = 0; item.mergedIntoId != null && hops < 16; hops++) {
        const next = await s.req(s.get("items").get(item.mergedIntoId));
        if (!next) break;
        item = next;
      }
      if (item.isArchived) {
        const err = new Error(`${item.name} is archived. Unarchive it under Items to lend it.`);
        err.code = "ARCHIVED";
        throw err;
      }
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
    } else if (!walkIn) {
      // A loan with no borrower is a walk-in, and has to say so.
      //
      // This gate used to require `customName` instead -- which is about the
      // *item* ("a loan against something not in the catalog"), not about the
      // borrower at all. Two consequences: the desk's own "Walk-in -- no name"
      // button failed on every press, because no caller passes `customName`, and
      // the error it produced named an argument nobody had heard of. It made
      // walk-ins unrecordable, which is why `totals.walkIns` sat at zero in every
      // report the desk ever ran.
      throw new Error("A loan needs a borrower; pass walkIn: true for a walk-in");
    }
    const loan = {
      itemId: itemId || null,
      itemNameSnapshot: itemName,
      borrowerId: borrowerId || null,
      // A walk-in's snapshots are written deliberately rather than sniffed out of
      // the notes. They were derived from `notes.startsWith("walk-in")` before,
      // which nothing ever passed, so both fields came out empty and the loan
      // rendered as "(unknown)" at check-in. The literal "walk-in" is load-bearing
      // for the report, which tells anonymous walk-ins apart on exactly this
      // value (see `buildReport`).
      borrowerPhoneSnapshot: borrower ? borrower.phone : walkIn ? "walk-in" : "",
      borrowerNameSnapshot: borrower ? borrower.name : walkIn ? "(walk-in)" : "",
      checkedOutAt: checkedOutAt || Date.now(),
      dueAt,
      returnedAt: null,
      isOpen: "open",
      conditionOut: conditionOut || "good",
      conditionIn: null,
      notes: notes || "",
      recordedBy: recordedBy || ""
    };
    // Only set when there is something to say: a loan whose name was typed
    // exactly does not need an empty field riding along on every export.
    if (matchedFrom) loan.matchedFrom = String(matchedFrom).trim().slice(0, 120);
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
    // With no condition given, the borrower's own report stands -- the quick
    // "returned" buttons pass none. They used to pass "good", and the delete
    // below then threw away "damaged: battery cover missing" for good.
    loan.conditionIn = conditionIn || loan.returnRequestedCondition || "good";
    // Whatever the desk decides, what the borrower said goes on the record.
    const reported = loan.returnRequestedNote ? `borrower reported: ${loan.returnRequestedNote}` : "";
    let addition = String(notes || "").trim();
    if (reported && !addition.includes(reported)) addition = addition ? `${reported} | ${addition}` : reported;
    // The return is now real, so any kiosk request that asked for it is spent.
    delete loan.returnRequestedAt;
    delete loan.returnRequestedCondition;
    delete loan.returnRequestedNote;
    if (addition) {
      loan.notes = loan.notes ? `${loan.notes} | Check-in: ${addition}` : `Check-in: ${addition}`;
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
  // Makes sure the record exists (and adopts an old one) before the write.
  const base = await getSettings();
  // The read and the write are one transaction. They used to be two, so a
  // background write landing in between -- the daily backup recording
  // lastBackupAt, say -- was overwritten with the stale copy, and in the worst
  // case a PIN change was undone by it.
  return runTx([
    "settings"
  ], "readwrite", async (s) => {
    const store = s.get("settings");
    const current = await s.req(store.get(1)) || base;
    const next = Object.assign({}, current, updates, { id: 1 });
    await s.req(store.put(next));
    return next;
  });
}
/**
 * Merge one catalog entry into another.
 *
 * The keeper absorbs the victim's loans and counters, and -- the part that makes
 * a merge actually stick -- the victim's **name and aliases**, recorded as
 * aliases of the keeper. Without that, the losing name is forgotten the moment
 * the merge commits, so the next person to type "Room 115" creates the duplicate
 * again by lunchtime. That is the whole reason this function changed.
 *
 * `itemNameSnapshot` on the moved loans is rewritten to the keeper's name. That
 * is deliberate and it is honest: the snapshot means "the item's name at the
 * time of this loan", and after a merge the item has one name. Nothing reads it
 * as a historical record -- reports group on `itemId` whenever it is set -- and
 * leaving two names on one item's loans only makes the history look like it
 * belongs to two items. For a loan that is *still out*, an undo puts the old name
 * back, because that loan's item is once again the victim.
 *
 * Nothing is deleted. The victim is archived with `mergedIntoId` and a
 * `mergeMeta` audit of everything an undo needs, and `unmergeItem` is that undo.
 * It is reachable from the victim's own detail screen, where the Archive button
 * reads "Undo merge" while the item is merged -- one control and one code path,
 * so "archived but still the keeper's alias" is a state nothing can reach.
 *
 * See `unmergeItem` for what it does and does not put back.
 */
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
    // The victim's name, and every name the victim was itself known by, now mean
    // the keeper. `keep`'s own key is skipped -- an item is not its own alias.
    const keepKey = matchKey(keep.name);
    const aliasMap = new Map();
    for (const a of keep.aliases || []) {
      if (a && a.k) aliasMap.set(a.k, a);
    }
    const remember = (k, label) => {
      if (!k || k === keepKey || aliasMap.has(k)) return;
      aliasMap.set(k, { k, label: String(label || "").trim().slice(0, 60), addedAt: Date.now() });
    };
    // The keeper's aliases as they stood *before* this merge, so an undo can tell
    // the ones this merge added from the ones that were already there. Getting
    // that wrong would let an undo delete a name the keeper was legitimately known
    // by, and the desk would see a name stop resolving for no reason they could
    // see.
    const beforeKeys = new Set((keep.aliases || []).map((a) => a && a.k).filter(Boolean));
    // What the victim is about to lose. `unmergeItem` puts these back, and the
    // merge is destructive to them on its own: it sums the keeper's counter with
    // the victim's and then zeroes the victim, so without this record the victim's
    // "checked out 14 times" is unrecoverable -- it is not derivable from the loans,
    // which is why it is copied rather than recomputed.
    const victimCounters = {
      timesCheckedOut: merge.timesCheckedOut || 0,
      lastCheckedOutAt: merge.lastCheckedOutAt || null
    };
    const victimNeedsReview = merge.needsReview === true;
    remember(matchKey(merge.name), merge.name);
    for (const a of merge.aliases || []) {
      if (a && a.k) remember(a.k, a.label);
    }
    const nextAliases = Array.from(aliasMap.values()).slice(-8);
    keep.aliases = nextAliases;
    keep.timesCheckedOut = (keep.timesCheckedOut || 0) + victimCounters.timesCheckedOut;
    keep.lastCheckedOutAt = Math.max(keep.lastCheckedOutAt || 0, victimCounters.lastCheckedOutAt || 0) || null;
    await s.req(itemsStore.put(keep));
    merge.timesCheckedOut = 0;
    merge.lastCheckedOutAt = null;
    merge.isArchived = true;
    merge.mergedIntoId = keepId;
    merge.needsReview = false;
    merge.mergeMeta = {
      keepId,
      keepName: keep.name,
      mergedAt: Date.now(),
      loansMoved: mergeLoans.length,
      // The three things an undo needs and cannot re-derive: which loans moved,
      // which aliases this merge added (post-cap, so only ones that survived),
      // and what the victim's counters were.
      loanIds: mergeLoans.map((l) => l.id),
      aliasesAdded: nextAliases.filter((a) => !beforeKeys.has(a.k)).map((a) => a.k),
      counters: victimCounters,
      needsReview: victimNeedsReview
    };
    await s.req(itemsStore.put(merge));
    return {
      keepId,
      mergedId: mergeId,
      keepName: keep.name,
      mergedName: merge.name,
      loansMoved: mergeLoans.length
    };
  });
}
/**
 * Undo a merge: put the victim back in the catalog as its own item.
 *
 * This exists because the desk owner chose **silent attachment** for near
 * matches. That is the aggressive option, and what makes it survivable is that a
 * wrong attach can be undone -- so the undo has to actually restore the state,
 * not just unarchive a row and leave the catalog asserting something that is no
 * longer true.
 *
 * Three things have to go back, and the first is not obvious:
 *
 *   1. **The alias.** The merge taught the keeper that the victim's name means
 *      the keeper. Leaving it after an undo means the name the desk just
 *      resurrected still quietly resolves to the *other* item whenever the
 *      resurrected one is not an exact hit -- so the item is back and the desk
 *      can still never reach it by typing its own name. Only the aliases this
 *      merge added are removed; the ones the keeper already had stay, which is
 *      why `mergeMeta.aliasesAdded` is recorded post-cap.
 *   2. **The counters.** The merge summed them into the keeper and zeroed the
 *      victim, so the victim's history is put back and the keeper gives back what
 *      it borrowed. `lastCheckedOutAt` on the keeper is left alone: a maximum
 *      cannot be un-taken, and a date that is too recent is a smaller lie than
 *      one that is too early.
 *   3. **The loans that are still out.** An open loan is the physical object
 *      being out *right now*, so its item is unambiguous and it moves back with
 *      its original name restored. Loans that have already been returned stay
 *      with the keeper and are counted in the result, because their snapshots are
 *      history and re-pointing them would rewrite a record of something that
 *      happened. The caller says the count out loud rather than hiding it.
 *
 * Refuses on an item that was not merged, so a stray call cannot archive or
 * unarchive anything by accident.
 */
async function unmergeItem(victimId) {
  await openDB();
  return runTx([
    "items",
    "loans"
  ], "readwrite", async (s) => {
    const itemsStore = s.get("items");
    const loansStore = s.get("loans");
    const victim = await s.req(itemsStore.get(victimId));
    if (!victim) throw new Error(`Item ${victimId} not found`);
    const keepId = victim.mergedIntoId;
    if (keepId == null) {
      throw new Error(`"${victim.name}" was not merged into anything, so there is nothing to undo`);
    }
    const meta = victim.mergeMeta || {};
    const counters = meta.counters || {};
    const keep = await s.req(itemsStore.get(keepId));
    // A then B: A was merged into B, and B later into D. A's open loan now sits
    // on D, so the loop below skipped it, and A came back "available" while its
    // unit was still out -- free to be checked out a second time -- with the
    // loan counted on both. Undo in the order it was done.
    if (keep && keep.mergedIntoId != null) {
      const later = await s.req(itemsStore.get(keep.mergedIntoId));
      const err = new Error(`"${keep.name}" has since been merged into "${later ? later.name : "another item"}". Undo that merge first, then this one.`);
      err.code = "MERGE_CHAINED";
      throw err;
    }
    if (keep) {
      const added = Array.isArray(meta.aliasesAdded) ? meta.aliasesAdded : [];
      if (added.length > 0) {
        keep.aliases = (keep.aliases || []).filter((a) => !(a && added.indexOf(a.k) !== -1));
      }
      keep.timesCheckedOut = Math.max(0, (keep.timesCheckedOut || 0) - (Number(counters.timesCheckedOut) || 0));
      await s.req(itemsStore.put(keep));
    }
    const ids = Array.isArray(meta.loanIds) ? meta.loanIds : [];
    let movedBack = 0;
    for (const id of ids) {
      const loan = await s.req(loansStore.get(id));
      // `itemId !== keepId` means the loan has been re-pointed by a later merge,
      // so it is no longer this victim's to claim.
      if (!loan || loan.itemId !== keepId) continue;
      if (!(loan.isOpen === "open" && !loan.returnedAt)) continue;
      loan.itemId = victimId;
      loan.itemNameSnapshot = victim.name;
      await s.req(loansStore.put(loan));
      movedBack++;
    }
    victim.isArchived = false;
    victim.mergedIntoId = null;
    victim.mergeMeta = null;
    victim.timesCheckedOut = Number(counters.timesCheckedOut) || 0;
    victim.lastCheckedOutAt = counters.lastCheckedOutAt || null;
    victim.needsReview = meta.needsReview === true;
    await s.req(itemsStore.put(victim));
    return {
      victimId,
      keepId,
      name: victim.name,
      keepName: meta.keepName || (keep && keep.name) || `item ${keepId}`,
      loansMovedBack: movedBack,
      loansStayed: ids.length - movedBack
    };
  });
}
/**
 * What a merge would do, without doing it.
 *
 * The duplicate-review screen shows this before the merge button commits, so the
 * desk is told how many loans will move rather than discovering it afterwards.
 * Read-only, so it needs no lock and cannot half-happen.
 */
async function previewMerge(keepId, mergeId) {
  if (keepId === mergeId) return null;
  await openDB();
  return runTx(["items", "loans"], "readonly", async (s) => {
    const keep = await s.req(s.get("items").get(keepId));
    const merge = await s.req(s.get("items").get(mergeId));
    if (!keep || !merge) return null;
    const loans = await s.req(s.get("loans").index("itemId").getAll(mergeId));
    const openLoans = loans.filter((l) => l.isOpen === "open" && !l.returnedAt);
    return {
      keepName: keep.name,
      mergeName: merge.name,
      loansMoved: loans.length,
      openLoansMoved: openLoans.length,
      checkOutsMoved: merge.timesCheckedOut || 0,
      bothOpen: openLoans.length > 0 &&
        (await s.req(s.get("loans").index("itemId").getAll(keepId))).some((l) => l.isOpen === "open" && !l.returnedAt)
    };
  });
}
/**
 * Catalog entries that look like the same thing.
 *
 * Two tiers, because the two kinds of duplicate need different levels of
 * confidence from the desk.
 *
 * `duplicates` -- entries whose names match exactly (case and spacing aside).
 * This is what the app has always reported, and a group of them is close to
 * certainly one thing recorded repeatedly.
 *
 * `nearDuplicates` -- entries that do **not** match exactly but share a
 * distinctive word, which is what `Room 115` / `115` / `115 Key` are. The
 * matcher now *attaches* these silently when they are typed, so this exists for
 * the entries that got into the catalog before it did, and for the pairs the
 * silent rule deliberately refuses (`Cable HDMI` alongside `Cable VGA` is two
 * cables, not a duplicate, but the desk should still get to say so once).
 *
 * "Distinctive" is the whole trick. Entries are connected through a word only
 * when that word is rare enough to identify something -- appearing in at most
 * `NEAR_TOKEN_MAX` entries, or 5% of the catalog for a big one. A word that
 * appears more often than that is category vocabulary, not identity: joining
 * every entry containing "usb" would produce one group of twenty and teach the
 * desk to ignore the banner. `Cable HDMI` and `Cable VGA` have only "cable" in
 * common, and in any catalog big enough to contain both, "cable" is common, so
 * they stay apart -- which is what the desk wants.
 *
 * Cheap by construction: one pass to count words, one pass to union, no
 * pairwise comparison anywhere, so 10,000 entries cost the same per entry as 10.
 */
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
  const inExactGroup = new Set();
  for (const [, items] of groups) {
    if (items.length < 2) continue;
    items.sort((a, b) => (b.timesCheckedOut || 0) - (a.timesCheckedOut || 0) || (a.createdAt || 0) - (b.createdAt || 0));
    duplicates.push(items);
    for (const it of items) inExactGroup.add(it.id);
  }
  duplicates.sort((a, b) => b.length - a.length);

  // --- near duplicates: union entries that share a distinctive word ---
  const remaining = live.filter((it) => !inExactGroup.has(it.id));
  const wordsOf = new Map();
  for (const it of remaining) wordsOf.set(it.id, new Set(itemTokens(it.name)));
  const wordCount = new Map();
  for (const [, words] of wordsOf) {
    for (const w of words) wordCount.set(w, (wordCount.get(w) || 0) + 1);
  }
  const NEAR_TOKEN_MAX = Math.max(3, Math.ceil(remaining.length * 0.05));
  const parent = new Map();
  const find = (id) => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(id) !== r) {
      const next = parent.get(id);
      parent.set(id, r);
      id = next;
    }
    return r;
  };
  for (const it of remaining) parent.set(it.id, it.id);
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const byWord = new Map();
  for (const [id, words] of wordsOf) {
    for (const w of words) {
      if ((wordCount.get(w) || 0) > NEAR_TOKEN_MAX) continue;
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push(id);
    }
  }
  for (const [, ids] of byWord) {
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  }
  const nearGroups = new Map();
  for (const it of remaining) {
    const root = find(it.id);
    if (!nearGroups.has(root)) nearGroups.set(root, []);
    nearGroups.get(root).push(it);
  }
  const nearDuplicates = [];
  for (const [, items] of nearGroups) {
    if (items.length < 2) continue;
    items.sort((a, b) => (b.timesCheckedOut || 0) - (a.timesCheckedOut || 0) || (a.createdAt || 0) - (b.createdAt || 0));
    nearDuplicates.push(items);
  }
  nearDuplicates.sort((a, b) => b.length - a.length);

  return {
    duplicates,
    nearDuplicates,
    scanned: live.length,
    itemCount: duplicates.reduce((n, g) => n + g.length, 0) + nearDuplicates.reduce((n, g) => n + g.length, 0)
  };
}
async function runDailyDedup() {
  // Detection only. This used to merge automatically, which was destructive:
  // the app deliberately lets the desk add a second item with the same name
  // (two physical "HDMI Cable" units are not duplicates), and the merge also
  // re-ran against already-archived victims, compounding their counters upward
  // on every launch. Duplicates are now surfaced for a human to resolve.
  const { duplicates, nearDuplicates, scanned } = await findDuplicateItems();
  const exactItems = duplicates.reduce((n, g) => n + g.length, 0);
  const nearItems = nearDuplicates.reduce((n, g) => n + g.length, 0);
  if (duplicates.length > 0 || nearDuplicates.length > 0) {
    console.warn(`[dedup] ${duplicates.length} duplicate name group(s) (${exactItems} items) and ${nearDuplicates.length} similar-name group(s) (${nearItems} items). Not merging automatically — resolve in Admin → Items → Duplicates.`);
  }
  return {
    merged: 0,
    scanned,
    duplicateGroups: duplicates.length,
    duplicateItems: exactItems,
    nearGroups: nearDuplicates.length,
    nearItems
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
 * The acknowledgement key for a group. `near` groups get a prefix, so that
 * "these are three different things" said about `Room 115` / `115` / `115 Key`
 * is not also read as saying it about a later exact pair that starts with the
 * same entry. One function so the three places that build this key -- the
 * scanner, the merge and the dismiss -- cannot drift apart.
 */
function _dedupKeyFor(itemOrNameLower, near) {
  const base = typeof itemOrNameLower === "string"
    ? itemOrNameLower
    : (itemOrNameLower && (itemOrNameLower.nameLower || itemOrNameLower.name)) || "";
  const key = String(base).trim().toLowerCase();
  return near ? `near:${key}` : key;
}

/**
 * The key a whole group is recorded under: its alphabetically first name, so
 * it does not move when usage reorders the group.
 */
function _dedupGroupKey(members, near) {
  const names = (members || []).map((m) => _dedupKeyFor(m, false)).filter(Boolean).sort();
  return names.length ? _dedupKeyFor(names[0], near) : "";
}

/**
 * The duplicate groups a human should still be shown: unacknowledged, and not
 * silently acknowledged by a stale signature.
 *
 * Exact and near groups are acknowledged under separate keys. A near group's key
 * is prefixed so that dismissing "Room 115 / 115 / 115 Key" as three different
 * things cannot also dismiss a *later* exact "Room 115" / "Room 115" pair whose
 * first member happens to be the same entry.
 */
async function findUnreviewedDuplicates() {
  const { duplicates, nearDuplicates, scanned } = await findDuplicateItems();
  const settings = await getSettings();
  const seen = settings.dedupAcknowledged && typeof settings.dedupAcknowledged === "object"
    ? settings.dedupAcknowledged
    : {};
  // Acknowledged if the exact set of items was acknowledged under any member's
  // name. It used to be looked up under group[0] only -- the busiest member --
  // so one checkout could reorder the group and bring a dismissed group back.
  // The signature is the exact set of ids, so matching on any member's name
  // cannot hide a group that changed.
  const isSeen = (group, near) => {
    const sig = _dedupSignature(group);
    return group.some((m) => seen[_dedupKeyFor(m, near)] === sig);
  };
  const pendingFor = (list, near) => list.filter((group) => !isSeen(group, near));
  const groups = pendingFor(duplicates, false);
  const nearGroups = pendingFor(nearDuplicates, true);
  const count = (list) => list.reduce((n, g) => n + g.length, 0);
  return {
    groups,
    nearGroups,
    scanned,
    itemCount: count(groups) + count(nearGroups),
    // Counts across *all* groups, acknowledged or not, so the banner can say
    // "you have already looked at the rest" rather than hiding the work.
    totalGroups: duplicates.length + nearDuplicates.length
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
  // A safe, positive id well under 2^53. An id at or above that exhausts the
  // store's key generator for good -- clear() does not reset it -- so after one
  // such import no new item or loan could ever be added, and restoring a good
  // backup did not bring it back.
  if (!Number.isSafeInteger(record.id) || record.id < 1 || record.id > MAX_IMPORT_ID) {
    return `a "${storeName}" entry is missing a usable numeric id (${JSON.stringify(record.id)})`;
  }
  // The catalog and the people list sort by name, and an entry with none used to
  // throw there and take down the Items list, search and the kiosk.
  if ((storeName === "items" || storeName === "borrowers") && (typeof record.name !== "string" || !record.name.trim())) {
    return `a "${storeName}" entry (id ${record.id}) has no name`;
  }
  return null;
}
var MAX_IMPORT_ID = 2 ** 40;
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
/** Take every message off the screen: the next person at the kiosk starts clean. */
function clearToasts() {
  for (const entry of [..._liveToasts.values()]) {
    if (!entry || !entry.toast) continue;
    // At once, not faded: the next person should not watch the last one's
    // message leave.
    _forgetToast(entry.toast);
    if (entry.toast.parentNode) entry.toast.parentNode.removeChild(entry.toast);
  }
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
      if (container._closeActive === close) container._closeActive = null;
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
  container._closeActive = close;
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
  // Close through the dialog's own close() when it has one, so the caller's
  // promise settles as a cancel. Emptying the container alone left the caller
  // awaiting forever -- and, before anything called this on a lock, left the
  // dialog itself live on top of the screen that replaced it.
  if (typeof container._closeActive === "function") {
    container._closeActive();
    return;
  }
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
  // OK with an empty field is "" and Cancel is null -- two different answers. Both
  // used to come back null, so "Not handed in" could not tell Cancel from "no
  // reason given" and cleared the borrower's return request either way.
  }).then((ok) => ok ? input.value : null);
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
  return formatTimeAgo(ms) + " (" + shortWhen(ms) + ")";
}
// A clock time a person reads at a glance: "2:48 PM" today, "Oct 3, 2:48 PM"
// otherwise, the year only when it is not this one. toLocaleString() gave
// "10/4/2026, 2:48:34 PM" -- seconds nobody needs and a date nobody parses.
function shortWhen(ms) {
  if (ms == null) return "\u2014";
  const d = new Date(ms);
  const now = /* @__PURE__ */ new Date();
  const time = d.toLocaleTimeString(void 0, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return `${d.toLocaleDateString(void 0, opts)}, ${time}`;
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
  // Only a word typed all in lower case is changed, and only its first letter:
  // "maria lopez" becomes "Maria Lopez", while "HDMI", "iPad" and "McDonald"
  // stay as typed. This used to lower-case everything first, which turned an
  // HDMI cable into "Hdmi" and McDonald into "Mcdonald".
  // Caps lock is the exception: a whole line typed in capitals is shouting, not
  // an acronym, so its longer words are softened ("MARIA LOPEZ" -> "Maria
  // Lopez", "HDMI CABLE" -> "HDMI Cable").
  const shouting = t === t.toUpperCase() && t !== t.toLowerCase() && t.includes(" ");
  return t.split(" ").map((w) => {
    if (!w.length) return w;
    if (shouting && w.length > 4) return w[0] + w.slice(1).toLowerCase();
    return w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w;
  }).join(" ");
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

// ── Matching: is this the same thing? ──────────────────────────────────────
//
// The desk types one object several ways. "Room 115", "115" and "115 Key" are
// the same room, and before this the app treated them as three unrelated
// strings: a merge existed but copied no fields, so the losing name was not
// remembered and the next person retyped it and recreated the duplicate.
//
// `normalize` cannot see the equivalence on its own. It does not split on "-"
// or "_", while `isWordBoundary` a few lines above treats all three as word
// boundaries -- and that inconsistency is why "USB C" does not even *suggest*
// "USB-C" today. So matching works on a token list instead: split on any
// non-alphanumeric run, drop the words that carry no identity in a room-and-
// equipment catalog, and compare the *multiset* of what is left, order-blind.
//
// Counts rather than a set, deliberately: "Cable Cable" is not a subset of
// "Cable".
var _itemNoiseWords = null;
function _noiseWords() {
  if (!_itemNoiseWords) {
    // Two words, both room-and-equipment vocabulary. Deliberately narrow.
    //
    // "key" is NOT here: a key to room 115 is a different physical object from
    // the room, and `createLoan` refuses a second open loan against one item --
    // so collapsing them would make the room read as "out" whenever its key
    // was out. They are told apart by the merge and alias machinery instead.
    //
    // "the", "a" and "an" are NOT here either, and the reason is not style:
    // "A Frame" would canonicalise to "frame" and collide with a bare "Frame",
    // and "Room A" would canonicalise to nothing at all.
    _itemNoiseWords = new Set(["room", "rm"]);
  }
  return _itemNoiseWords;
}
function itemTokens(name) {
  const n = normalize(name);
  if (!n) return [];
  // Split on any non-alphanumeric run, not just whitespace. `normalize` does not
  // split on "-" or "_", which is why this app cannot currently match "USB C"
  // to "USB-C" at all -- while `isWordBoundary` a few lines up treats those
  // same characters as boundaries. Tokenising here fixes that without touching
  // `normalize`, whose output every scorer in the app depends on.
  const all = [];
  for (const w of n.split(/[^a-z0-9]+/)) {
    if (w) all.push(w);
  }
  const stripped = all.filter((w) => !_noiseWords().has(w));
  // Never let stripping empty a name: "Room" alone is still the name "room".
  return stripped.length ? stripped : all;
}
/**
 * The canonical form of a name, for comparing two names and nothing else.
 *
 * Tokens are sorted, so word order stops mattering: "Key 115" and "115 Key"
 * are one key. Never shown to anyone -- every screen displays `item.name`.
 *
 * Named `matchKey` rather than `itemKey` because `buildReport` has a local
 * `itemKey` of its own, and a shadowed function is a trap for the next reader.
 */
function matchKey(name) {
  return itemTokens(name).slice().sort().join(" ");
}
function _tokenCounts(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}
/**
 * Does one of these token lists strictly contain all of the other? No guard.
 *
 * This is the raw relation: symmetric, and willing to pair "cable" with "cable
 * hdmi". It is only ever used to *suggest*. Attaching uses `isSilentSubset`.
 */
function isSubsetKey(aTokens, bTokens) {
  if (aTokens.length === 0 || bTokens.length === 0) return false;
  const [small, large] = aTokens.length <= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  if (small.length === large.length) return false;
  const need = _tokenCounts(small);
  const have = _tokenCounts(large);
  for (const [tok, n] of need) {
    if ((have.get(tok) || 0) < n) return false;
  }
  return true;
}
/**
 * May the desk attach silently on this pair?
 *
 * This is the tier that pairs "115" with "115 Key" -- the desk owner's example.
 * It is by far the loosest rule in the matcher, so `isSubsetKey` alone is not
 * enough and it carries a guard, measured against real vocabulary rather than
 * guessed:
 *
 *   the shorter key must be a SINGLE token that CONTAINS A DIGIT
 *
 * Without it, every one of these silently attaches to the wrong object:
 *   "iPad 2"       -> "iPad"          a different device
 *   "USB Hub"      -> "USB"           a different object
 *   "Key Card"     -> "Key"           a different object
 *   "Cable HDMI"   -> "Cable"         and worse, being MORE specific
 *                                     reaches a different item
 * With it, all four fall through to a suggestion instead, and the desk still
 * gets to type "115" and mean the 115 whose key is also on the list. Every
 * example the owner gave is numeric, so the guard costs them nothing.
 *
 * It also preserves the ability to catalogue a second physical unit: once
 * "115 Key" exists, "115 Key 2" is two tokens against two, so it does not
 * attach and can be created -- which is the whole point of the existing
 * "These are different units" path.
 *
 * Counts, not a set: a doubled token is not a subset.
 */
function isSilentSubset(aTokens, bTokens) {
  if (!isSubsetKey(aTokens, bTokens)) return false;
  const small = aTokens.length <= bTokens.length ? aTokens : bTokens;
  return small.length === 1 && /\d/.test(small[0]);
}
/**
 * An item's key and tokens, memoised.
 *
 * Derived from `item.name` every time rather than stored on the record. A
 * stored copy would be one more field to keep in step across rename, import,
 * restore and salvage -- and a stale stored key means two names that should
 * find each other silently stop doing so, which is the whole bug being fixed.
 * The memo is validated against the name it was built from, so a rename heals
 * itself even if nothing invalidated the cache.
 */
var _nameKeyMemo = null;
function _nameKeyOf(item) {
  if (!_nameKeyMemo) _nameKeyMemo = new Map();
  // Bounded: an import or a wipe can walk ids past the live catalog, and the
  // memo is only ever an optimisation -- dropping it costs one rebuild, never
  // correctness.
  if (_nameKeyMemo.size > 2e4) _nameKeyMemo.clear();
  const id = item && item.id;
  if (id != null) {
    const cached = _nameKeyMemo.get(id);
    if (cached && cached.name === item.name) return cached;
  }
  const tokens = itemTokens(item.name);
  const rec = {
    name: item.name,
    key: tokens.slice().sort().join(" "),
    tokens
  };
  if (id != null) _nameKeyMemo.set(id, rec);
  return rec;
}
var _catalogIdxCache = null;
/**
 * The live catalog, arranged for matching: by name key, by alias, and as a
 * list of tokens for the subset pass.
 *
 * Both maps hold **arrays**, not single items, and that is load-bearing. Two
 * catalog entries can share one canonical key -- "Room A" and "A" both reduce to
 * "a" -- and picking a winner for them by any rule at all (busiest, lowest id,
 * first inserted) would be an arbitrary choice dressed up as an answer. A key
 * held by more than one item is reported as ambiguity instead, so the desk sees
 * the duplicate rather than one of them silently absorbing the other's loans.
 *
 * Rebuilt whenever `getAllItems()` hands back a different array — i.e. exactly
 * when the catalog actually changed — so there is one invalidation path, not
 * two caches with two ways to go stale.
 */
async function _getCatalogIndex() {
  const items = await getAllItems();
  if (_catalogIdxCache && _catalogIdxCache.src === items) return _catalogIdxCache;
  const byKey = new Map();
  const byAlias = new Map();
  const entries = [];
  const addTo = (map, key, item) => {
    const cur = map.get(key);
    if (cur) cur.push(item);
    else map.set(key, [item]);
  };
  for (const item of items) {
    const rec = _nameKeyOf(item);
    entries.push({
      item,
      tokens: rec.tokens
    });
    if (rec.key) addTo(byKey, rec.key, item);
    for (const alias of item.aliases || []) {
      const k = alias && typeof alias === "object" ? alias.k : null;
      if (k) addTo(byAlias, k, item);
    }
  }
  _catalogIdxCache = {
    src: items,
    byKey,
    byAlias,
    entries
  };
  return _catalogIdxCache;
}
/**
 * What does the desk mean by this name?
 *
 * Three tiers, in order, and nothing else in the app should need to guess:
 *
 *   1. `exact`  — the typed form canonicalises to a live item's own name.
 *   2. `alias`  — it canonicalises to a form that item was once known by,
 *                 recorded when it was merged away or typed an extra way.
 *   3. `subset` — the typed form is not itself an item, and exactly one live
 *                 item's tokens strictly contain it, under the numeric guard
 *                 documented on `isSilentSubset`.
 *
 * The two guards are the point of the design, and both exist because the desk
 * owner asked for silent attachment and silent attachment is only survivable if
 * it refuses to guess:
 *
 *   - **Exact beats subset.** Typing "Projector" in a catalog holding both
 *     "Projector" and "Projector Screen" gives the Projector. Tier 3 is only
 *     reached when the typed form is not itself an item.
 *   - **A unique winner is required**, at every tier. Typing "Cable" where both
 *     "Cable HDMI" and "Cable VGA" exist matches two supersets, so nothing
 *     attaches and the caller is handed both. Two entries sharing one canonical
 *     key ("Room A" and "A") are the same situation and are treated the same
 *     way. Ambiguity never resolves silently.
 *
 * Returns `{ item, tier, matchedFrom, alternatives }`, or `null` when the typed
 * string is blank. `item` is null when nothing resolved; `alternatives` then
 * carries the candidates the caller should offer instead, and is non-empty
 * exactly when the answer was *ambiguous* rather than unknown. Keeping those two
 * apart matters: "Cable" matching both "Cable HDMI" and "Cable VGA" is a question
 * for the desk, while "Widget" matching nothing is an offer to create.
 *
 * `alternatives` always uses the unguarded relation, deliberately: it is the list
 * of things a person might have meant, so it must include the pairs too loose to
 * attach to. That is how "Cable" still ends up showing both cables even though it
 * attaches to neither.
 *
 * `matchedFrom` is the string the person actually typed when it differs from the
 * item's name, so the loan can record what was meant rather than only what it
 * became.
 */
async function resolveItem(name) {
  const typed = String(name == null ? "" : name).trim();
  if (!typed) return null;
  const idx = await _getCatalogIndex();
  const key = matchKey(typed);
  if (!key) return null;
  const exact = idx.byKey.get(key);
  if (exact && exact.length === 1) {
    return { item: exact[0], tier: "exact", matchedFrom: null, alternatives: [] };
  }
  if (exact) {
    // One key, several live items: report the duplicate rather than pick one.
    return { item: null, tier: null, matchedFrom: null, alternatives: exact.slice() };
  }
  const viaAlias = idx.byAlias.get(key);
  if (viaAlias && viaAlias.length === 1) {
    return { item: viaAlias[0], tier: "alias", matchedFrom: typed, alternatives: [] };
  }
  if (viaAlias) {
    return { item: null, tier: null, matchedFrom: null, alternatives: viaAlias.slice() };
  }
  // One pass, two lists: everything that could be meant, and the subset of that
  // which the guard permits attaching to. Collected together so the scan cost
  // does not double at 10,000 items.
  const tokens = key.split(" ");
  const candidates = [];
  const attachable = [];
  for (const entry of idx.entries) {
    if (!isSubsetKey(tokens, entry.tokens)) continue;
    candidates.push(entry.item);
    if (isSilentSubset(tokens, entry.tokens)) attachable.push(entry.item);
  }
  if (attachable.length === 1) {
    return { item: attachable[0], tier: "subset", matchedFrom: typed, alternatives: [] };
  }
  return { item: null, tier: null, matchedFrom: null, alternatives: candidates };
}
/**
 * Remember that an item is also known by this name.
 *
 * Called on every silent attach. This is the mechanism that makes a merge
 * permanent: the losing name becomes an alias of the survivor, so the next
 * person to type it gets a tier-1 exact hit instead of recreating the duplicate.
 * The merge carries the victim's aliases across for the same reason.
 */
async function addItemAlias(item, typed, { label } = {}) {
  const k = matchKey(typed);
  if (!k) return item;
  const own = _nameKeyOf(item).key;
  if (k === own) return item;
  if ((Array.isArray(item.aliases) ? item.aliases : []).some((a) => a && a.k === k)) return item;
  // Newest kept, and few of them. An alias list is a memory of how people got
  // the name wrong, not an archive: a handful covers every real desk, and a long
  // one would ride along on every export and every `_nameKeyOf` alias pass.
  //
  // Written onto the item as it is in the store *now*, in one transaction. It
  // used to put the caller's copy back with the alias added, so anything that
  // changed the item in between -- a checkout bumping its counters, a staff
  // edit -- was quietly undone.
  return runTx([
    "items"
  ], "readwrite", async (s) => {
    const store = s.get("items");
    const fresh = item.id != null ? await s.req(store.get(item.id)) : null;
    const target = fresh || item;
    const have = Array.isArray(target.aliases) ? target.aliases.slice() : [];
    if (have.some((a) => a && a.k === k)) return target;
    have.push({
      k,
      label: String(label || typed).trim().slice(0, 60),
      addedAt: Date.now()
    });
    const next = Object.assign({}, target, { aliases: have.slice(-8) });
    await s.req(store.put(next));
    return next;
  });
}
/**
 * The name an item is also known by, for display. Empty when there are none.
 */
function itemAliasLabels(item) {
  return (item && Array.isArray(item.aliases) ? item.aliases : []).map((a) => a && a.label).filter(Boolean);
}
/**
 * Attach to an item the person reached by a name that is not its name.
 *
 * Two jobs, and both matter. It records the typed form as an alias, which is
 * what stops the same near-name being typed again tomorrow and creating the
 * duplicate this whole area exists to prevent. And it says out loud what it did,
 * because a silent attach that is genuinely silent is indistinguishable from the
 * app picking the wrong thing -- the desk has to be able to see the decision it
 * did not make.
 *
 * Used by both surfaces, so staff and kiosk cannot disagree about what a typed
 * name means, and both say the same sentence when they attach.
 */
async function attachToItem(item, typed) {
  const saved = await addItemAlias(item, typed, { label: typed });
  const label = String(typed).trim();
  if (normalize(label) !== normalize(saved.name)) {
    showToast(`Using "${saved.name}" — matched from "${label}"`, {
      type: "info",
      duration: 4e3
    });
  }
  return saved;
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
  const qk = matchKey(query);
  for (const item of all) {
    // The raw string comparison stays first: it is what gives typos and
    // partial words their tolerance.
    let best = scoreMatch(q, normalize(item.name));
    // Then the canonical form and the remembered names, so "Room 115" finds
    // "115" and a merged-away name still finds its survivor. The raw
    // comparison cannot see any of that -- "115" neither contains nor
    // prefixes "room 115".
    if (qk) {
      const rec = _nameKeyOf(item);
      best = Math.max(best, scoreMatch(qk, rec.key));
      for (const alias of item.aliases || []) {
        if (alias && alias.k) best = Math.max(best, scoreMatch(qk, alias.k));
      }
    }
    if (best > 0) {
      scored.push({
        item,
        score: best,
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
// Whether this device uses the app's own on-screen keyboard. It was built for
// the Windows touch desk, where it is the only keyboard there is; on a phone or
// tablet in a browser it came up *as well as* the device's own, and its alpha
// layout ran off both sides of a phone screen. "auto" means: on inside the
// Windows app, off in a browser. Settings can force it either way, per device.
var KEYBOARD_PREF_KEY = "frontdesk.keyboard";
function onScreenKeyboardMode() {
  try {
    const v = localStorage.getItem(KEYBOARD_PREF_KEY);
    if (v === "on" || v === "off") return v;
  } catch (_) {
  }
  return "auto";
}
function onScreenKeyboardWanted() {
  const mode = onScreenKeyboardMode();
  if (mode === "on") return true;
  if (mode === "off") return false;
  return isHosted();
}
// Input types the on-screen keyboard types into. Anything else (radio, checkbox,
// date, range, file, ...) is left to its own control.
var KBD_TEXT_TYPES = /* @__PURE__ */ new Set(["text", "search", "tel", "password", "email", "url", "number"]);
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
          if (!onScreenKeyboardWanted()) return;
          if (t.dataset.kbd === "off") return;
          // Only fields that take typed text. A radio, checkbox or date input is
          // an <input> too, and the keyboard used to come up on all of them and
          // overwrite `.value`: on Review duplicates, tapping a row and then a
          // digit turned the radio's item id 712 into 7123, and Merge folded the
          // duplicate into an unrelated item.
          if (t.tagName === "INPUT" && !KBD_TEXT_TYPES.has((t.type || "text").toLowerCase())) return;
          if (t.readOnly || t.disabled) return;
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
        // A real keyboard cannot type past maxlength, and neither may this one.
        // It used to: the 8-digit PIN field took 12, and a double-tapped digit
        // made an 11-digit phone number.
        if (input.maxLength > 0 && next.length > input.maxLength) return;
        this._setValue(input, next);
        this._placeCaret(input, next, start + text.length);
      }
      // Put the caret where the edit left it -- unless an `input` handler rewrote
      // the value while _setValue was dispatching. The kiosk phone fields do that:
      // they reformat "4" into "(4" and park the caret at the end. Moving it back
      // to an offset worked out against the *unformatted* text then put every
      // later digit in the wrong place, so 4165551234 came out as (165) 123-4554
      // and could sign the borrower in as whoever owns that number. A handler that
      // rewrites the value owns the caret.
      _placeCaret(input, expected, caret) {
        if (input.value !== expected) return;
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
          this._placeCaret(input, next, start - 1);
        } else if (start !== end) {
          const next = current.slice(0, start) + current.slice(end);
          this._setValue(input, next);
          this._placeCaret(input, next, start);
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
  // Same for the kiosk's own idle timer: armed on any kiosk screen past the
  // welcome, cleared everywhere else.
  _armKioskIdle();
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
/** The public is looking: a kiosk screen, or the splash it starts on. */
function _onPublicScreen() {
  return currentScreen === "splash" || isKioskScreen(currentScreen);
}
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
/**
 * The phone as a person should read it.
 *
 * `formatPhone` is for a number someone typed as a number. On anything else it
 * half-formats -- "x1234", an extension, comes back as "(123) 4" -- which is
 * worse than what the desk typed, and it is what Copy would hand over too. So a
 * value that cannot be dialled is shown exactly as it was entered.
 */
function displayPhone(phone) {
  if (isValidPhone(phone)) return formatPhone(phone);
  return String(phone == null ? "" : phone);
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

// The four conditions an item can come back in, and the only four. This is the
// list `_confirmAndReturn` checks a condition against before interpolating it
// into a class attribute, and the list the return sheet's buttons are written
// from -- `good`/`fair`/`damaged`/`lost`, matching `returnLoan`'s default and
// the damaged/lost counts on the admin dashboard. It is deliberately not
// "whatever the caller passed": see the note in `_confirmAndReturn`.
var RETURN_CONDITIONS = ["good", "fair", "damaged", "lost"];

/**
 * How many catalog cards the checkout step draws before the box is the way in.
 *
 * This step used to render the entire catalog -- 10,000 cards, each a DOM node
 * with a click handler, built on every visit to the step. The frequent strip
 * above is what people actually pick from, and 60 is comfortably more than a
 * hand's-width scroll; the search box below covers everything else and the count
 * line says how much is not shown.
 */
var CHECKOUT_LIST_CAP = 60;
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
    // The number wins over the name, and it should: the phone is the identity
    // here, and the schema allows one borrower per number. But the staff member
    // has just typed a different name, and without this it is discarded in
    // silence -- the loan is booked to whoever the number belongs to and the
    // name on screen never appears anywhere. Say so while the number can still
    // be corrected, rather than leaving it to be noticed on a receipt.
    //
    // The ordinary path does not reach this: `handlePhone` finds one match and
    // skips the name step, and finds none and the record cannot appear here. It
    // is the resume-and-race case -- a draft resumed after the number was taken
    // in another tab -- which is exactly when nobody is looking.
    if (normalize(borrower.name) !== normalize(trimmed)) {
      showToast(`Using ${borrower.name} — ${formatPhone(borrower.phone)} is already on record for them. Fix the number if this is someone else.`, {
        type: "info",
        duration: 8e3
      });
    }
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
   * @param {boolean} [opts.skipDialog] - if true and the name is already taken
   *   *verbatim*, return the existing item instead of prompting. Used for the
   *   frictionless "Add to catalog" button.
   *
   * Matching goes through `resolveItem`, so the desk gets the same answer here
   * as on the kiosk. The one case that still asks a question is the literal
   * duplicate: typing "115" when an item is named exactly "115" is genuinely
   * ambiguous -- it is either the 115 that exists or a second physical unit of
   * it -- and no rule can tell those apart, which is what the existing "These
   * are different units" flow is for. Everything else is a spelling of
   * something already catalogued, and attaches.
   */
  async handleNewItem(name, category = "Other", opts = {}) {
    const trimmed = sentenceCase(String(name || "").trim());
    const problem = itemNameProblem(trimmed);
    if (problem) {
      showToast(problem, {
        type: "error"
      });
      return null;
    }
    const res = await resolveItem(trimmed);
    if (res && res.item) {
      const literal = normalize(trimmed) === normalize(res.item.name);
      if (!literal) {
        // "Room 115" for "115", "115" for "115 Key", "usb c" for "USB-C".
        // No dialog: the desk owner asked for these to attach, and the naming
        // toast is how a silent attach stays visible rather than surprising.
        return await attachToItem(res.item, trimmed);
      }
      if (opts.skipDialog) {
        return res.item;
      }
      const choice = await showDialog({
        title: "Item already exists",
        body: `<p>An item named <strong>${escapeHtml(res.item.name)}</strong> already exists (${res.item.timesCheckedOut || 0} check-outs).</p><p>Add another with the same name?</p>`,
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
      if (choice === "existing") return res.item;
      if (choice !== "new") return null;
    } else if (res && res.alternatives.length) {
      // Two or more items could be meant. Never guess, and never create --
      // creating here is what produces the duplicate this work exists to stop.
      showToast("Several items match that name — pick one from the list", {
        type: "error",
        duration: 5e3
      });
      return null;
    }
    try {
      const created = await createItem({
        name: trimmed,
        category
      });
      return created;
    } catch (err) {
      // createItem is the choke point and can still refuse something the check
      // above did not predict. Saying so beats a handler that dies quietly.
      showToast(err?.message || "Could not add that item", {
        type: "error",
        duration: 5e3
      });
      return null;
    }
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
          // No borrower means the desk pressed "Walk-in — no name". Saying so is
          // what the loan record needs; without it `createLoan` refuses, which is
          // how this button came to fail on every press.
          walkIn: !this.state.borrower,
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
        // `undoLoansAtomic` either undoes all of them or throws -- it works in one
        // transaction, so there is no partial result to report. The branch that
        // used to sit here logged `result.errors` and then toasted success
        // regardless; it could never fire, because that function has no path that
        // puts anything in `errors`. Removed rather than kept as decoration: a
        // reader has to be able to trust that a failure means the catch below.
        await undoLoansAtomic(created.map((c) => c.loan));
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
        // The same rules as the list and the kiosk: resolveItem, not the fuzzy
        // search's top hit. Enter used to take searchItems(..)[0], a subsequence
        // match, so "Key 12" picked "Key 112" -- the wrong key went out, and
        // "Key 12" could not be added from here at all.
        const res = await resolveItem(query);
        if (res && !res.item && res.alternatives.length) {
          showToast(`Several items match "${query}" \u2014 pick one from the list.`, {
            type: "info"
          });
          return;
        }
        // handleNewItem attaches to a resolved item (and remembers the name it
        // was typed as), or adds a new one when nothing is meant.
        const picked = await this.handleNewItem(query, "Other", {
          skipDialog: true
        });
        if (picked) {
          this.handleItemSelect(picked, true);
          showToast(res && res.item ? `Selected "${picked.name}"` : `Added "${picked.name}"`, {
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
      const shown = rest.slice(0, CHECKOUT_LIST_CAP);
      for (const item of shown) allWrap.appendChild(this._makeItemCard(item));
      if (rest.length > shown.length) {
        // Says so rather than trailing off. A list that stops without a word looks
        // like the catalog is that size, and the desk goes hunting for an item it
        // was never shown.
        const more = document.createElement("p");
        more.className = "item-list-empty";
        more.textContent = `Showing the first ${shown.length} of ${rest.length} — type below to find the rest.`;
        allWrap.appendChild(more);
      }
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
    // Resolve before deciding whether to offer creation, so the two cannot
    // disagree: this is the screen where the desk types "Room 115" and needs to
    // be told it means the 115 already on the list, not offered a new one.
    const res = typed ? await resolveItem(typed) : null;
    const resolved = (res && res.item) || null;
    const ambiguous = !!(res && !res.item && res.alternatives.length);
    // Only the verbatim repeat is a question for the desk.
    const literal = !!(resolved && normalize(typed) === normalize(resolved.name));
    if (resolved && !literal) {
      // Say so before the tap, not after it. The item card is already in the
      // list above; this explains why tapping anything up there is fine.
      const note = document.createElement("p");
      note.className = "item-match-note";
      note.appendChild(document.createTextNode(`Using ${resolved.name} — matched from `));
      const typedEl = document.createElement("em");
      typedEl.textContent = `"${typed}"`;
      note.appendChild(typedEl);
      allWrap.appendChild(note);
    }
    // Offered whenever nothing is meant. It used to be withheld whenever the
    // fuzzy search found anything at all, so with "Key 112" in the catalog,
    // "Key 12" could never be added from checkout.
    const showAddNew = !!(typed && !resolved && !ambiguous);
    if (ambiguous) {
      // Two or more entries could be meant. Offer nothing to create, because
      // creating here is exactly how "Cable" becomes three catalog rows.
      const note = document.createElement("p");
      note.className = "item-match-note";
      note.textContent = `Several items match "${typed}" — pick one from the list above.`;
      allWrap.appendChild(note);
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
      continueBtn.textContent = this.state.items.length > 0 ? `Continue (${this.state.items.length} selected)` : "Continue";
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
    if (dueEl) dueEl.textContent = formatDueLabel(dueAt) + ` (${shortWhen(dueAt)})`;
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
    // `condition` is interpolated into a class attribute below, so it is checked
    // against the four the app can produce rather than trusted. Nothing passes
    // anything else today -- it comes from the button's own `data-condition`,
    // which the app wrote -- but "it comes from our own markup" is a property of
    // today's callers, not of this function, and a class attribute is somewhere a
    // quote character escapes from.
    if (RETURN_CONDITIONS.indexOf(condition) === -1) condition = "good";
    const item = this.state.items.get(loan.itemId);
    const borrower = loan.borrowerId != null ? this.state.borrowers.get(loan.borrowerId) : null;
    const itemName = item?.name || loan.itemNameSnapshot || "?";
    const borrowerName = borrower?.name || loan.borrowerNameSnapshot || "(unknown)";
    const phone = borrower?.phoneFormatted || (loan.borrowerPhoneSnapshot ? formatPhone(loan.borrowerPhoneSnapshot) : "");
    const outAt = shortWhen(loan.checkedOutAt);
    const dueAt = loan.dueAt ? shortWhen(loan.dueAt) : "\u2014";
    const wasOverdue = loan.dueAt && loan.dueAt < Date.now();
    const conditionLabel = {
      good: "\u2713 Returned in good condition",
      fair: "~ Returned in fair condition",
      damaged: "\u26A0 Returned damaged",
      lost: "\u2717 Marked as LOST"
    }[condition];
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
      // The phone is shown to the staff member as "(416) 555-1230" and typed,
      // by anyone reading it off the screen or off a note, as "4165551230".
      // Matching only the formatted string meant the digits form found nothing
      // on the one screen where a person is standing at the desk waiting. The
      // admin People search already matched both; this is the same rule.
      const qDigits = q.replace(/\D/g, "");
      filtered = this.state.allLoans.filter((loan) => {
        const item = this.state.items.get(loan.itemId);
        const borrower = loan.borrowerId != null ? this.state.borrowers.get(loan.borrowerId) : null;
        const itemName = (item?.name || loan.itemNameSnapshot || "").toLowerCase();
        const borrowerName = (borrower?.name || loan.borrowerNameSnapshot || "").toLowerCase();
        const phone = (borrower?.phoneFormatted || (loan.borrowerPhoneSnapshot ? formatPhone(loan.borrowerPhoneSnapshot) : "") || "").toLowerCase();
        const phoneDigits = phone.replace(/\D/g, "");
        return itemName.includes(q) || borrowerName.includes(q) || phone.includes(q) || (qDigits && phoneDigits.includes(qDigits));
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
    // Three hidden sections and nothing else is a blank screen under the search
    // box, which reads as a page that failed to load. Say which of the two
    // things happened -- nothing is out, or nothing matches what was typed --
    // and echo the query back so it is obvious the filter is the reason.
    const emptyEl = root.querySelector(".loans-empty");
    if (emptyEl) {
      const total = filtered.length;
      if (total === 0) {
        const typed = String(this.state.query || "").trim();
        emptyEl.classList.remove("hidden");
        emptyEl.textContent = typed
          ? `Nothing out matches "${typed}". Clear the search to see everything that is out.`
          : "Nothing is checked out right now.";
      } else {
        emptyEl.classList.add("hidden");
        emptyEl.textContent = "";
      }
    }
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
      <span><span class="timing-label">Out:</span> <span class="timing-value">${escapeHtml(outText)}</span> <span class="timing-label" style="font-size:11px;color:var(--text-muted);">(${escapeHtml(shortWhen(outAt.getTime()))})</span></span>
      <span><span class="timing-label">Due:</span> <span class="timing-value ${dueClass}">${escapeHtml(dueText)}</span>${dueAt ? ` <span class="timing-label" style="font-size:11px;color:var(--text-muted);">(${escapeHtml(shortWhen(dueAt.getTime()))})</span>` : ""}</span>
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
    // A kiosk return request carries what the borrower said about the item. The
    // desk never saw it here, pressed RETURNED OK, and it was gone.
    const reportEl = root.querySelector(".return-report");
    if (reportEl) {
      if (loan.returnRequestedAt) {
        const cond = loan.returnRequestedCondition === "damaged" ? "something is wrong" : "all good";
        const note = loan.returnRequestedNote ? `: \u201C${loan.returnRequestedNote}\u201D` : "";
        reportEl.textContent = `The borrower reported at the kiosk \u2014 ${cond}${note}`;
        reportEl.classList.remove("hidden");
      } else {
        reportEl.textContent = "";
        reportEl.classList.add("hidden");
      }
    }
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

async function autoBackup({ force = false } = {}) {
  try {
    const settings = await getSettings();
    const last = settings.lastBackupAt || 0;
    const now = Date.now();
    if (!force && now - last < BACKUP_INTERVAL_MS && last > 0) {
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
        // Only a backup that read back intact counts. This used to be recorded
        // either way, so a failed backup was not retried for 24 hours -- and on a
        // desk that starts minimised, nobody saw the toast saying it failed.
        if (result.verified) {
          await updateSettings({
            lastBackupAt: now
          });
          if (force || !_onPublicScreen()) showToast(`Backup saved to the backup folder (${formatBytes(result.bytes)}). ${result.kept} kept.`, {
            type: "info",
            duration: 5e3
          });
        } else {
          // The file was written but did not read back the same. Say so loudly:
          // a backup you cannot trust is worse than none, because it is the one
          // you find out about when you need it.
          if (!force && _onPublicScreen()) logToHost("automatic backup could not be verified: " + (result.error || "mismatch"));
          else showToast(`Backup could not be verified: ${result.error || "the file on disk does not match"}. Check the backup folder.`, {
            type: "error",
            duration: 15e3
          });
        }
        return {
          ok: !!result.verified,
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
    if (force || !_onPublicScreen()) showToast("Backup saved. Check your Downloads folder.", {
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
  // Forced by argument rather than by zeroing lastBackupAt first: a forced run
  // that then failed left the record saying no backup had ever been made.
  return autoBackup({ force });
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
  // A cell beginning with = + - @ (or a tab, or a carriage return) is a *formula*
  // to Excel, Numbers and Sheets, not text. A spreadsheet evaluates it on open,
  // and the app's cells are not all the desk's own: the kiosk lets a borrower name
  // an item, and a borrower could name one "=HYPERLINK(...)" -- which would then
  // run the moment anyone opened an exported report. A leading apostrophe is the
  // standard way to say "this is text"; it is what OWASP recommends for CSV
  // exports, and it is visible, so nothing is hidden from the person reading it.
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
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
  document.addEventListener("pointerdown", _bumpKioskIdle, { passive: true, capture: true });
  document.addEventListener("keydown", _bumpKioskIdle, { capture: true });
  document.addEventListener("input", _bumpKioskIdle, { capture: true });
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
      // All of them, settled: this used to remove the first sign-in panel in the
      // document and leave any others -- including a pending condition question
      // still holding the last borrower's loan.
      _clearKioskOverlays();
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
  // There used to be a "Skip — no name" button here, which set isWalkIn.
  //
  // Two things were wrong with it, and only one of them was the obvious one.
  // It failed on every press, because `createLoan` then demanded a `customName`
  // that no kiosk caller ever passed -- a crash, visible as a failure toast.
  // That gate has since been replaced: `createLoan` takes `walkIn` explicitly
  // now, so the button would no longer throw.
  //
  // It would still be wrong. A walk-in loan has no borrowerId, and the kiosk's
  // return step finds a loan by the person standing there -- see the
  // "Please ask staff for help" state in `_renderKioskReturnItems`, which says
  // in as many words that walk-in returns cannot be processed at the kiosk. A
  // borrower who skipped the name could take an item out and then have no way
  // to hand it back, on a tablet with nobody at it. So the kiosk requires a
  // name, and anyone who won't give one is sent to the desk. Removing the
  // button is about the return path; the crash it used to cause is history.
  const nameInput = document.getElementById("kiosk-name");
  if (nameInput) {
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleNameSubmit();
    });
  }
  const needInput = document.getElementById("kiosk-need");
  if (needInput) {
    needInput.addEventListener("input", () => _onNeedInput());
    needInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        _handleCommit();
      }
    });
  }
  const confirmBtn = document.querySelector('[data-action="kiosk-confirm-pick"]');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      // The add offer on screen is the one this button now names: tap it.
      const add = confirmBtn.dataset.adds && document.querySelector('#kiosk-need-suggestions [data-action="kiosk-add-new"]');
      if (add) add.click();
      else _handleCommit();
    };
  }
  // `querySelectorAll`, not `querySelector`: two screens carry this action --
  // the borrow confirmation and the list a borrower sees after a return -- and
  // `querySelector` binds only the first in document order. The return screen's
  // DONE button was therefore dead: tapping an item to report a return and then
  // tapping DONE did nothing at all, and the only way off that screen was Back,
  // through the phone step, to the welcome screen. Nothing caught it because the
  // kiosk suite clicks this action scoped to the *borrow* screen.
  for (const btn of document.querySelectorAll('[data-action="kiosk-back-home"]')) {
    btn.onclick = () => _kioskBackHome();
  }
  // Same person, one more thing: back to the item step without the phone again.
  const another = document.querySelector('[data-action="kiosk-borrow-another"]');
  if (another) {
    another.onclick = () => {
      const who = _doneBorrower;
      _doneBorrower = null;
      if (!who) {
        _kioskBackHome();
        return;
      }
      state.borrower = who;
      state.phone = who.phone || null;
      state.isNew = false;
      const greetEl = document.getElementById("kiosk-greeting-name");
      if (greetEl) greetEl.textContent = who.name;
      _cancelDoneCountdown();
      clearToasts();
      _resetNeedStep();
      goToScreen(KIOSK_SCREENS.borrowNeed);
      setTimeout(() => {
        const need = document.getElementById("kiosk-need");
        if (need) need.focus();
      }, 100);
    };
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
      // The first ten, not the last ten: a digit tapped once too often used to
      // push the first one off the front, and the field then showed -- and
      // looked up -- a different number.
      const before = normalizePhone(valueBefore).slice(0, 10);
      let digits = normalizePhone(e.target.value).slice(0, 10);
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
  // Exactly ten digits (after a leading 1), never "the last ten of however many
  // were typed": a double-tapped digit used to pass as a different, valid number
  // and book the loan to whoever owned it.
  const raw = normalizePhone(input.value);
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
var _allItemsCachedAt = 0;
async function getAllItems() {
  const now = Date.now();
  if (_allItemsCache && now - _allItemsCachedAt < ITEMS_CACHE_TTL_MS) {
    return _allItemsCache;
  }
  _allItemsCache = await listItems({
    includeArchived: false
  });
  _allItemsCachedAt = now;
  return _allItemsCache;
}
/**
 * The single invalidation point for every catalog read cache.
 *
 * **You almost certainly do not need to call this.** It is wired into `runTx`'s
 * `oncomplete`, `put` and `del`, so any committed write that touches the `items`
 * store drops all three caches by itself. Call it directly only for a change
 * that is not an item write but does change what the catalog resolves to --
 * importing a backup, or wiping the database.
 *
 * That placement is the fix for a real bug, not tidiness. It used to be called
 * from four hand-picked places and `createItem` was not among them, so an item a
 * staff member added from the checkout step existed in the database but was
 * invisible to the kiosk picker until the page reloaded. Created instantly, still
 * not there. A per-call-site list cannot be kept complete; this can.
 */
function invalidateItemsCache() {
  _allItemsCache = null;
  _itemsRawCache = null;
  _catalogIdxCache = null;
}
/**
 * Drop the "which items are out" cache. Called from the same central place as
 * `invalidateItemsCache`, but keyed on `loans` rather than `items`.
 *
 * The two are separate on purpose. Check-in writes only to `loans`, so a single
 * cache keyed on the items list would keep reporting a returned item as still
 * out -- refusing a borrower something that is on the shelf, until an unrelated
 * item edit happened to clear it.
 */
function invalidateAvailabilityCache() {
  _outItemIdsCache = null;
}
/**
 * Which items are out right now, cached.
 *
 * Deliberately **not** folded into `_allItemsCache`. Availability is derived from
 * `loans`, not from `items`, so it goes stale on a completely different write:
 * returning an item writes only to `loans`, and a cache keyed on the items list
 * would have gone on saying "already out" until somebody happened to add or edit
 * an item. That is a borrower being refused an item that is sitting on the shelf.
 *
 * Its own invalidation, wired into the same central place as the item caches --
 * see `invalidateAvailabilityCache`.
 */
var _outItemIdsCache = null;
var _outItemIdsCachedAt = 0;
async function _outItemIds() {
  const now = Date.now();
  if (_outItemIdsCache && now - _outItemIdsCachedAt < ITEMS_CACHE_TTL_MS) {
    return _outItemIdsCache;
  }
  const openLoans = await getOpenLoans();
  const ids = new Set();
  for (const loan of openLoans) {
    if (loan.itemId != null) ids.add(loan.itemId);
  }
  _outItemIdsCache = ids;
  _outItemIdsCachedAt = now;
  return ids;
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
  const outItemIds = await _outItemIds();
  return items.map((item) => ({
    item,
    isOut: outItemIds.has(item.id)
  }));
}
/**
 * How many items one kiosk session may add, and what it has added so far.
 *
 * Module-local and reset by `_kioskBackHome`, so "a session" means one borrower
 * standing at the tablet from the moment they reach the item step until they
 * finish or give up. The cap answers the objection the old code was removed for:
 * that the control wrote a permanent catalog row *"with no confirmation, no cap
 * and no rate limit"*. There is still no confirmation -- the desk owner asked for
 * creation to be instant -- so the cap and the once-per-name rule are what stand
 * in its place, together with the review flag that brings a human to look.
 */
var KIOSK_CREATE_MAX = 3;
var _kioskCreateState = { count: 0, keys: new Set() };
function resetKioskCreations() {
  _kioskCreateState = { count: 0, keys: new Set() };
}
/**
 * May the public add this name, and if not, what should they be told?
 *
 * Every branch returns wording a borrower can act on. "Refused" on its own is
 * what the desk reported as a dead end: they could not tell whether the app was
 * broken or the item was genuinely missing.
 */
function kioskCreateCheck(typed) {
  const t = String(typed == null ? "" : typed).trim();
  const alnum = t.replace(/[^a-z0-9]/gi, "");
  if (alnum.length < 2) {
    return { ok: false, reason: "Type a bit more of the name, or ask the front desk." };
  }
  if (t.length > 60) {
    return { ok: false, reason: "That name is too long. Please ask the front desk." };
  }
  const key = matchKey(t);
  if (!key) {
    return { ok: false, reason: "That name is not something the desk can add. Please ask them." };
  }
  if (_kioskCreateState.keys.has(key)) {
    return { ok: false, reason: "You have already added that one. Please ask the front desk." };
  }
  if (_kioskCreateState.count >= KIOSK_CREATE_MAX) {
    return { ok: false, reason: `You have added ${KIOSK_CREATE_MAX} items \u2014 please ask the front desk for anything else.` };
  }
  return { ok: true, key, name: t };
}
/**
 * The item step's list under the text box.
 *
 * `opts` carries the two decisions this step has to make beyond showing matches:
 * whether to offer to add the typed name, and whether the catalog is empty. Both
 * are computed by the caller, which is the only place that knows what else was
 * found.
 *
 * The add control is deliberately **not** classed `kiosk-suggestion`, because
 * that class means "a catalog item you can tap" and several behaviours key on it;
 * an add row that answered to the same selector would make "the list offers the
 * item" true when no item exists. It is a separate class, and it is only ever
 * appended after the real matches are rendered.
 */
function _renderSuggestions(matches, query, opts = {}) {
  const container = document.getElementById("kiosk-need-suggestions");
  if (!container) return;
  const { create = null, catalogEmpty = false } = opts;
  container.innerHTML = "";
  _setBorrowLabel(null);
  // What this list is the answer to. `_onNeedInput` compares the box against it
  // and takes the list away as soon as they disagree -- see there for why that
  // matters more than the flicker it costs.
  _kioskSuggestQuery = query;
  if (matches.length === 0) {
    if (!query) {
      // The catalog being empty used to look exactly like a clean slate: no
      // rows, no message. Someone had to say so, hence the reported "THERES NO
      // ITEMS". Say it here rather than leaving a blank box.
      if (catalogEmpty) {
        const note = document.createElement("div");
        note.className = "kiosk-suggestion-empty";
        note.textContent = "Nothing has been added to the list yet. Type what you need below and it can be added for you.";
        container.appendChild(note);
      }
      return;
    }
    const note = document.createElement("div");
    note.className = "kiosk-suggestion-empty";
    note.textContent = create && create.ok
      ? "Not on the list yet \u2014 you can add it below, or ask the front desk."
      : "Not on the list \u2014 please ask the front desk";
    container.appendChild(note);
    if (create && create.ok) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "kiosk-add-new";
      btn.dataset.action = "kiosk-add-new";
      const label = document.createElement("span");
      label.className = "kiosk-add-new-name";
      label.textContent = `Add "${create.name}"`;
      const hint = document.createElement("span");
      hint.className = "kiosk-suggestion-category";
      hint.textContent = "the desk will check it later";
      btn.appendChild(label);
      btn.appendChild(hint);
      btn.onclick = () => _kioskCreateAndCheckout(create);
      container.appendChild(btn);
      _setBorrowLabel(`Add "${create.name}" and borrow it`);
    } else if (create && create.reason) {
      const why = document.createElement("div");
      why.className = "kiosk-suggestion-empty";
      why.textContent = create.reason;
      container.appendChild(why);
    }
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
    if (!isOut) btn.onclick = () => {
      const box = document.getElementById("kiosk-need");
      _checkout(item, box ? box.value.trim() : "");
    };
    container.appendChild(btn);
  }
}
var KIOSK_TYPEAHEAD_DEBOUNCE_MS = 120;
var _kioskTypeaheadTimer = null;
/**
 * Rebuild the suggestion list, once the typing has stopped.
 *
 * Debounced because each pass is a catalog search, and at the catalog size this
 * app has to hold that is far too much work to repeat on every keystroke. The
 * delay is short enough to feel immediate and long enough that a fast typist
 * triggers one pass rather than eight.
 */
function _updateTypeaheadSoon() {
  if (_kioskTypeaheadTimer) clearTimeout(_kioskTypeaheadTimer);
  _kioskTypeaheadTimer = setTimeout(() => {
    _kioskTypeaheadTimer = null;
    _updateTypeahead();
  }, KIOSK_TYPEAHEAD_DEBOUNCE_MS);
}
/** The query the list currently on screen was built for. */
var _kioskSuggestQuery = null;
/**
 * A keystroke in the item box.
 *
 * The list under the box is only ever the answer to the query it was built for,
 * and this is what enforces that. Clearing it the moment the two disagree is not
 * cosmetic: the rows are tappable, and every row checks out its item on tap. Left
 * standing through the 120ms debounce, a borrower who typed "HDMI dongle" and
 * tapped the first row they saw would be handed the "Clicker" left over from the
 * previous borrower's search -- a wrong item, on a real loan record, with nothing
 * on screen to say so. A brief empty list is the honest thing to show while the
 * answer is still being worked out.
 */
function _onNeedInput() {
  const input = document.getElementById("kiosk-need");
  if (input && input.value.trim() !== _kioskSuggestQuery) {
    const container = document.getElementById("kiosk-need-suggestions");
    if (container) container.innerHTML = "";
    _kioskSuggestQuery = null;
  }
  _updateTypeaheadSoon();
}
async function _updateTypeahead() {
  const input = document.getElementById("kiosk-need");
  if (!input) return;
  const query = input.value.trim();
  const all = await getAllItems();
  if (!query) {
    _renderSuggestions([], "", { catalogEmpty: all.length === 0 });
    return;
  }
  // The same matcher the staff screens use, so a name cannot behave one way at
  // the desk and another at the tablet. This replaced a private `_fuzzyScore`
  // that only ever compared raw strings and therefore could not see that
  // "Room 115" and "115" are the same thing.
  const scored = await searchItems(query, { limit: 20 });
  const outIds = await _outItemIds();
  const withOut = scored.map((s) => ({ item: s.item, isOut: outIds.has(s.item.id) }));
  // Available first, then by match quality: a borrower who types an exact name
  // must not lose it below the fold because a taken item scored higher.
  withOut.sort((a, b) => (a.isOut ? 1 : 0) - (b.isOut ? 1 : 0));
  const matches = withOut.slice(0, 5);
  // An item that is already out is still shown (disabled) -- but it is not an
  // offer to add, and neither is anything the matcher *did* find. The add
  // control therefore appears only when the list came back empty, which is also
  // the only case where `searchItems` and `resolveItem` can disagree.
  const create = matches.length === 0 ? kioskCreateCheck(query) : null;
  _renderSuggestions(matches, query, { create, catalogEmpty: all.length === 0 });
}
/**
 * The borrower pressed Done / Enter on the item step.
 *
 * This path **never creates** anything. Creating is behind the add button and
 * only there, which is what keeps a stray Enter from writing a catalog row --
 * the exact behaviour the old code was removed for. All this does is find the
 * item the borrower means and take it, or say clearly why it cannot.
 *
 * Matching goes through `resolveItem`, against the **whole live catalog** rather
 * than only what is on the shelf. That distinction matters: "115" is out, someone
 * types "Room 115", and a matcher that only looks at available items finds
 * nothing, offers to add, and gives one physical key two open loans. Resolving
 * first and checking availability second cannot do that.
 */
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
  const res = await resolveItem(query);
  if (res && res.item) {
    const outIds = await _outItemIds();
    if (outIds.has(res.item.id)) {
      showToast(`${res.item.name} is already out. Ask the front desk.`, {
        type: "error",
        duration: 4e3
      });
      return;
    }
    await _checkout(res.item, query);
    return;
  }
  if (res && res.alternatives.length) {
    showToast("More than one item matches that — tap the one you need", {
      type: "error",
      duration: 4e3
    });
    return;
  }
  const check = kioskCreateCheck(query);
  showToast(check.ok
    ? `That item is not on the list. Tap Add "${check.name}" and borrow it, or ask the front desk.`
    : "That item is not on the list. Please ask the front desk.", {
    type: "error",
    duration: 5e3
  });
}
/**
 * Create an item at the kiosk and immediately check it out, in one transaction.
 *
 * One transaction because the two halves are one act. `createItem` followed by
 * `createLoan` is two, and anything in between -- a crash, or `createLoan`
 * refusing because the item is somehow already out -- leaves a catalog row with
 * no loan, which is a mystery entry for the desk to find later. Here either both
 * happen or neither does.
 *
 * The item is stamped `createdBy: "kiosk"` and `needsReview: true`, which is the
 * desk owner's chosen policy: the public may add, a human gets told.
 */
async function _kioskCreateAndCheckout(create) {
  if (!create || !create.ok) return;
  if (!state.borrower || state.borrower.id == null) {
    showToast("Please enter your phone number first", {
      type: "error"
    });
    goToScreen(KIOSK_SCREENS.borrowPhone);
    return;
  }
  // Re-check at the moment of the press, not only when the button was drawn: the
  // cap could have been reached, or the same name added, by another tap while
  // this button sat on screen.
  const check = kioskCreateCheck(create.name);
  if (!check.ok) {
    showToast(check.reason, {
      type: "error",
      duration: 5e3
    });
    return;
  }
  const btn = document.querySelector('#kiosk-need-suggestions [data-action="kiosk-add-new"]');
  if (btn) btn.disabled = true;
  await openDB();
  // Claim the slot before the write, so a double tap cannot create two rows.
  _kioskCreateState.count += 1;
  _kioskCreateState.keys.add(check.key);
  const dueAt = await getKioskDueAt();
  try {
    const name = sentenceCase(create.name);
    const loan = await runTx(["items", "loans", "borrowers"], "readwrite", async (s) => {
      const borrower = await s.req(s.get("borrowers").get(state.borrower.id));
      if (!borrower) throw new Error("Your details could not be found. Please ask the front desk.");
      const now = Date.now();
      const item = {
        name,
        nameLower: name.toLowerCase(),
        category: "Other",
        location: "",
        condition: "good",
        notes: "",
        timesCheckedOut: 0,
        lastCheckedOutAt: null,
        isArchived: false,
        createdAt: now,
        createdBy: "kiosk",
        needsReview: true
      };
      const itemId = await s.req(s.get("items").add(item));
      const record = {
        itemId,
        itemNameSnapshot: name,
        borrowerId: borrower.id,
        borrowerPhoneSnapshot: borrower.phone || "",
        borrowerNameSnapshot: borrower.name || "",
        checkedOutAt: now,
        dueAt,
        returnedAt: null,
        isOpen: "open",
        conditionOut: "good",
        conditionIn: null,
        notes: "kiosk self-checkout",
        recordedBy: "kiosk",
        // What the borrower actually typed, when it is not the name on the
        // record -- "room 115" for an item the desk knows as "115". Without it
        // the desk cannot tell a typo from a real second unit.
        matchedFrom: normalize(create.name) !== normalize(name) ? create.name : ""
      };
      await s.req(s.get("loans").add(record));
      const created = Object.assign({}, item, { id: itemId });
      created.timesCheckedOut = 1;
      created.lastCheckedOutAt = now;
      await s.req(s.get("items").put(created));
      borrower.timesCheckedOut = (borrower.timesCheckedOut || 0) + 1;
      borrower.lastSeenAt = now;
      await s.req(s.get("borrowers").put(borrower));
      return Object.assign({}, record, { id: itemId });
    });
    const doneText = document.getElementById("kiosk-done-text");
    if (doneText) doneText.textContent = name;
    clearToasts();
    goToScreen(KIOSK_SCREENS.borrowDone);
    _startDoneCountdown();
    // Kept only while the confirmation is on screen, for "Borrow something
    // else"; leaving it for any reason forgets them (see _kioskBackHome).
    _doneBorrower = state.borrower;
    state.phone = null;
    state.borrower = null;
    state.isNew = false;
    const input = document.getElementById("kiosk-need");
    if (input) input.value = "";
    return loan;
  } catch (err) {
    // Hand the slot back: nothing was written, so the borrower has not used one.
    _kioskCreateState.count -= 1;
    _kioskCreateState.keys.delete(check.key);
    if (btn) btn.disabled = false;
    showToast(err && err.message ? err.message : "That could not be added. Please ask the front desk.", {
      type: "error",
      duration: 5e3
    });
    return null;
  }
}
/**
 * Take an item out to the borrower at the tablet.
 *
 * `typedFrom` is whatever the borrower actually typed, when that differs from the
 * item's name -- "Room 115" for the item the desk calls "115". It is recorded on
 * the loan so the desk can see what was meant rather than only what it became,
 * which is the difference between spotting a naming habit and not.
 */
async function _checkout(item, typedFrom) {
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
      notes: "kiosk self-checkout",
      matchedFrom: typedFrom && normalize(typedFrom) !== normalize(item.name) ? typedFrom : ""
    });
    const doneText = document.getElementById("kiosk-done-text");
    if (doneText) doneText.textContent = item.name;
    clearToasts();
    goToScreen(KIOSK_SCREENS.borrowDone);
    _startDoneCountdown();
    // Kept only while the confirmation is on screen, for "Borrow something
    // else"; leaving it for any reason forgets them (see _kioskBackHome).
    _doneBorrower = state.borrower;
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
/**
 * Put the item step back to blank: the box, and the list under it.
 *
 * This has to run on *entry* to the step, not only when the borrower finishes.
 * Two things were wrong without it, and both are visible in the same moment:
 *
 *  - the box still held whatever the previous borrower typed, so the next person
 *    to walk up read somebody else's item name sitting in the field;
 *  - the list under it still held that borrower's results, including items marked
 *    `already out`. It is only replaced once the new borrower types and the
 *    debounce fires, so for that window the screen was actively asserting
 *    something false -- the same shape of failure as the reported "THERES NO
 *    ITEMS", where the step showed a state that was not the catalog's.
 *
 * Registered as an `onEnter` hook for the step, so every route into it is
 * covered rather than the four that happen to call `goToScreen` today.
 */
/**
 * The item step's main button. Normally "Borrow it"; while the search has come
 * back empty and the add offer is showing, it names the add -- so the button a
 * borrower reaches for does what it says, instead of answering "not on the
 * list, tap the other button". Pressing Enter still never adds anything.
 */
function _setBorrowLabel(text) {
  const btn = document.querySelector('[data-action="kiosk-confirm-pick"]');
  if (!btn) return;
  btn.textContent = text || "Borrow it";
  if (text) btn.dataset.adds = "1";
  else delete btn.dataset.adds;
}
function _resetNeedStep() {
  _setBorrowLabel(null);
  // A debounced pass from the previous borrower must not land after the clear and
  // re-render a list nobody asked for.
  if (_kioskTypeaheadTimer) {
    clearTimeout(_kioskTypeaheadTimer);
    _kioskTypeaheadTimer = null;
  }
  const input = document.getElementById("kiosk-need");
  if (input) input.value = "";
  const suggestEl = document.getElementById("kiosk-need-suggestions");
  if (suggestEl) suggestEl.innerHTML = "";
  _kioskSuggestQuery = null;
}
// Inline kiosk panels that are waiting on the borrower (the condition question).
// Each entry settles its panel as a cancel. They have to be settled, not only
// removed: a panel left behind on the return screen kept its borrower's loan, so
// when Alice walked away from "Is it coming back in good shape?", Carl signed in
// next, saw her question under his own list, and his "All good" flagged her loan
// as handed in.
var _kioskPendingPanels = /* @__PURE__ */ new Set();
function _clearKioskOverlays() {
  for (const cancel of [..._kioskPendingPanels]) cancel();
  _kioskPendingPanels.clear();
  document.querySelectorAll(".kiosk-signin-panel, .kiosk-borrower-picker").forEach((el) => el.remove());
  const continueBtn = document.querySelector('[data-action="kiosk-return-phone-continue"]');
  if (continueBtn) continueBtn.style.display = "";
  closeDialog();
}
// A borrower who walks away mid-session leaves it open for the next person:
// signed in as them on the item step (so the next checkout lands on their
// account), or with their name, phone and loans on the return screen. The only
// timer the kiosk had was the DONE countdown. Any kiosk screen past the welcome
// now goes back to it after this long without a touch or a key.
var KIOSK_IDLE_MS = 9e4;
var _kioskIdleTimer = null;
function _armKioskIdle() {
  if (_kioskIdleTimer) {
    clearTimeout(_kioskIdleTimer);
    _kioskIdleTimer = null;
  }
  const cur = getCurrentScreen();
  if (!isKioskScreen(cur) || cur === KIOSK_SCREENS.welcome) return;
  _kioskIdleTimer = setTimeout(() => {
    _kioskIdleTimer = null;
    const now = getCurrentScreen();
    if (isKioskScreen(now) && now !== KIOSK_SCREENS.welcome) _kioskBackHome();
  }, KIOSK_IDLE_MS);
}
function _bumpKioskIdle() {
  if (_kioskIdleTimer) _armKioskIdle();
}
var _doneBorrower = null;
function _kioskBackHome() {
  _doneBorrower = null;
  _cancelDoneCountdown();
  _clearKioskOverlays();
  clearToasts();
  state.phone = null;
  state.borrower = null;
  state.isNew = false;
  // "kiosk-need" is not in this list on purpose: `_resetNeedStep` owns that box,
  // because it has to be cleared on every entry to the step and not only on the
  // way out.
  const ids = [
    "kiosk-phone",
    "kiosk-name",
    "kiosk-return-phone"
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  }
  _resetNeedStep();
  // A new borrower at the tablet gets a fresh allowance. The cap is per session
  // -- "how much may one person add before a human looks" -- not per shift, so
  // leaving the item step and starting again is exactly the reset it should be.
  //
  // Deliberately *not* part of `_resetNeedStep`: that runs on every entry to the
  // step, and re-entering it is not the same act as finishing a session. If it
  // reset here, a borrower could walk in and out of the step to buy themselves a
  // second three-item allowance.
  resetKioskCreations();
  goToScreen("welcome");
}
async function handleReturnPhoneSubmit() {
  const input = document.getElementById("kiosk-return-phone");
  if (!input) return;
  const raw = normalizePhone(input.value);
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
  // The return flow with a number this device has never seen. It used to offer
  // to "sign in here" with a name -- which made an empty account and then said
  // "You're all clear", when what the person almost always needs is to check
  // the number they typed. Nothing can be out under a number nobody used.
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
      <div class="kiosk-signin-title">Nothing is out under (${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6, 10)}</div>
      <div class="kiosk-signin-sub">Check the number and try again. If you borrowed under a different number, use that one \u2014 or ask the front desk.</div>
      <div class="kiosk-signin-actions">
        <button class="btn btn-primary btn-xl kiosk-cta" data-action="kiosk-signin-cancel">Try again</button>
      </div>
    </div>
  `;
  body.appendChild(panel);
  panel.querySelector('[data-action="kiosk-signin-cancel"]').onclick = () => {
    panel.remove();
    if (continueBtn) continueBtn.style.display = "";
    const phoneInput = document.getElementById("kiosk-return-phone");
    if (phoneInput) {
      phoneInput.value = "";
      phoneInput.focus();
    }
  };
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
    // The greeting above already says who this is; this line says what to do.
    subEl.textContent = "Tap anything you're bringing back, then hand it to the front desk.";
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
  // One step, not two. Tapping an item used to open a "Return this item?" dialog
  // and then put "Is it coming back in good shape?" *below* the screen's big
  // Done button -- so a borrower who tapped Done after the first answer walked
  // away believing it was handed in, with nothing recorded. The question now
  // covers the screen, and answering it is the hand-in.
  // Condition is asked for, not assumed. This used to hardcode "good", so
  // "Damaged"/"Lost" could never be recorded from a kiosk return even though the
  // item detail screen counts them.
  const condition = await _askCondition(loan, { modal: true });
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
function _askCondition(loan, opts = {}) {
  return new Promise((resolve) => {
    const host = document.querySelector(".screen:not(.hidden)");
    const body = host && host.querySelector(".kiosk-flow-body");
    if (!body) {
      resolve(null);
      return;
    }
    const now = Date.now();
    const overdue = loan.dueAt && loan.dueAt < now;
    const when = loan.checkedOutAt ? `Out ${agoLabel(now - loan.checkedOutAt)}` : "";
    const late = overdue ? ` \u00b7 <span class="kiosk-return-item-overdue">overdue by ${formatRelativeTime(loan.dueAt - now)}</span>` : "";
    const panel = document.createElement("div");
    panel.className = "kiosk-signin-panel" + (opts.modal ? " kiosk-modal" : "");
    if (opts.modal) {
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
    }
    panel.innerHTML = `
      <div class="kiosk-signin-card">
        <div class="kiosk-condition-title">${escapeHtml2(loan.itemNameSnapshot || "Item")}</div>
        ${when ? `<div class="kiosk-signin-sub">${escapeHtml2(when)}${late}</div>` : ""}
        <div class="kiosk-signin-sub">Handing it back? Is it in good shape?</div>
        <div class="kiosk-condition-actions">
          <button type="button" class="btn btn-primary btn-xl kiosk-cta" data-cond="good">All good, hand it in</button>
          <button type="button" class="btn btn-secondary btn-xl kiosk-cta" data-cond="damaged">Something's wrong</button>
        </div>
        <div data-role="note-wrap" class="kiosk-condition-note hidden">
          <input type="text" class="input input-xl kiosk-input" data-role="note" maxlength="300" placeholder="e.g. one key is bent, cable missing" autocomplete="off" />
          <button type="button" class="btn btn-primary btn-xl kiosk-cta" data-role="note-submit">Send to the front desk</button>
        </div>
        <button type="button" class="btn btn-ghost kiosk-cta-secondary" data-role="cancel">Cancel</button>
      </div>
    `;
    (opts.modal ? host : body).appendChild(panel);
    const done = (value) => {
      _kioskPendingPanels.delete(cancel);
      panel.remove();
      resolve(value);
    };
    const cancel = () => done(null);
    _kioskPendingPanels.add(cancel);
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
      // An open dialog is part of the session being locked. It used to stay on
      // top of the PIN screen -- an "Edit borrower" form showing a name, phone
      // and notes -- and its Save still wrote to the record and opened the
      // detail screen, with no PIN. Closing it settles it as a cancel.
      closeDialog();
      // Cancel on the lock screen goes back to the kiosk, not to wherever the
      // login was first opened from. That was usually the staff home, which has
      // no lock of its own, so Cancel was a way past this one.
      adminLoginReturn = "welcome";
      goToScreen("admin-login");
      Promise.resolve().then(() => (init_ui(), ui_exports)).then((m) => m.showInfo("Admin panel locked after 5 minutes of inactivity.")).catch(() => {
      });
    }
  }, ADMIN_IDLE_MS);
}
function _inAdminSession() {
  const cur = getCurrentScreen();
  return cur === "admin" || cur === "admin-detail";
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
  // Pick the tab first, then enter the screen: entering runs the enter hook,
  // which draws whichever tab is active at that moment. In the other order the
  // hook drew Queue and the remembered tab was switched to afterwards, never
  // drawn -- so the panel opened on a blank Settings, Items or People.
  _wireAdminChrome();
  _restoreActiveTab();
  goToScreen("admin");
  touchAdminSession();
  await renderAdminStats();
  await renderRecentKiosk();
  // The active tab is *not* rendered here. `goToScreen` above already ran the
  // admin screen's own enter hook, which is `_renderActiveTab` -- and calling it
  // again meant every login read the whole catalog twice, both passes racing on
  // the same innerHTML. At 10,000 items that is two full reads of the store to
  // draw one screen. The hook is the single path, and it also covers coming back
  // from a detail screen, which this line never did.
}
async function showItemDetail(itemId) {
  // Only from inside the panel. A dialog that outlived the idle lock used to
  // finish with one of these and land on the detail screen without a PIN.
  if (!_inAdminSession()) return;
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
    // A merged entry and the item it was merged into are two screens, and the
    // archived one is only reachable from the archived list -- so it has to say
    // where its loans went, or someone will unarchive it and wonder why the
    // history is missing.
    let mergedInto = null;
    if (item.mergedIntoId) {
      const keeper = await get("items", item.mergedIntoId);
      mergedInto = {
        id: item.mergedIntoId,
        name: (keeper && keeper.name) || (item.mergeMeta && item.mergeMeta.keepName) || `item ${item.mergedIntoId}`,
        moved: item.mergeMeta && item.mergeMeta.loansMoved,
        at: item.mergeMeta && item.mergeMeta.mergedAt
      };
    }
    const alsoKnownAs = itemAliasLabels(item);
    content.innerHTML = `
      <div class="return-card">
        <div class="return-item">
          <div class="item-name" style="font-size:24px; margin-bottom:8px;">${escapeHtml3(item.name)}</div>
          <div class="loan-meta">${escapeHtml3(item.category || "Other")} \xB7 ${escapeHtml3(item.location || "no location")}</div>
          <div class="loan-meta" style="margin-top:8px;">Condition: <strong>${escapeHtml3(item.condition || "good")}</strong></div>
          <div class="loan-meta">Checked out <strong>${item.timesCheckedOut || 0}</strong> times total</div>
          ${item.lastCheckedOutAt ? `<div class="loan-meta">Last: ${formatAbsoluteTime(item.lastCheckedOutAt)}</div>` : ""}
          ${item.notes ? `<div class="loan-meta" style="margin-top:8px; font-style:italic;">${escapeHtml3(item.notes)}</div>` : ""}
          ${item.needsReview ? `<div class="loan-meta item-review-chip">Added at the kiosk — not reviewed yet</div>` : ""}
          ${alsoKnownAs.length ? `<div class="loan-meta" style="margin-top:8px;">Also known as: ${escapeHtml3(alsoKnownAs.join(", "))}</div>` : ""}
          ${mergedInto ? `<div class="loan-meta" style="margin-top:8px;">Merged into <button class="link-btn" data-action="open-merged-into" data-id="${mergedInto.id}">${escapeHtml3(mergedInto.name)}</button>${mergedInto.moved != null ? ` — ${mergedInto.moved} loan${mergedInto.moved === 1 ? "" : "s"} moved` : ""}${mergedInto.at ? ` ${formatAbsoluteTime(mergedInto.at)}` : ""}</div>` : ""}
        </div>
        <div style="display:flex; gap:12px; margin-top:16px; flex-wrap:wrap;">
          <button class="btn btn-secondary" data-action="edit-item">Edit</button>
          <button class="btn btn-ghost" data-action="${mergedInto ? "unmerge-item" : "archive-item"}">${mergedInto ? "Undo merge" : item.isArchived ? "Unarchive" : "Archive"}</button>
        </div>
      </div>

      ${openLoan ? `
        <div class="loan-section">
          <h2 class="section-title">CURRENTLY OUT</h2>
          <div id="open-loan-row"></div>
        </div>
      ` : ""}

      <div class="loan-section">
        <h2 class="section-title">STATS</h2>
        <div class="return-card" style="display:flex; gap:24px; flex-wrap:wrap;">
          <div><div class="loan-meta">Avg duration</div><div style="font-size:20px; font-weight:600;">${formatRelativeTime(avgMs) || "\u2014"}</div></div>
          <div><div class="loan-meta">Damaged</div><div style="font-size:20px; font-weight:600; color:var(--warning);">${damageCount}</div></div>
          <div><div class="loan-meta">Lost</div><div style="font-size:20px; font-weight:600; color:var(--error);">${lostCount}</div></div>
        </div>
      </div>

      <div class="loan-section">
        <h2 class="section-title">ALL LOANS (${loans.length})</h2>
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
    // A merged item has one control, not two. Leaving the plain Archive button on
    // it as well would offer an "Unarchive" that puts the item back in the catalog
    // while the keeper still claims its name as an alias -- reachable only by
    // typing that name when it is not an exact hit, so the desk would see an item
    // come back and still not be able to find it. `_unmergeItem` is the only way
    // out of a merged state, and it puts all three things back.
    const unmergeBtn = content.querySelector('[data-action="unmerge-item"]');
    if (unmergeBtn) unmergeBtn.addEventListener("click", () => _unmergeItem(item));
    else content.querySelector('[data-action="archive-item"]')?.addEventListener("click", () => _archiveItem(item));
    content.querySelector('[data-action="open-merged-into"]')?.addEventListener("click", (e) => {
      showItemDetail(Number(e.currentTarget.dataset.id));
    });
  } catch (err) {
    if (content) content.innerHTML = `<p style="color:var(--error);">Error: ${escapeHtml3(err.message)}</p>`;
  }
}
async function showBorrowerDetail(borrowerId) {
  // Only from inside the panel. A dialog that outlived the idle lock used to
  // finish with one of these and land on the detail screen without a PIN.
  if (!_inAdminSession()) return;
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
          <h2 class="section-title">CURRENTLY HELD (${openLoans.length})</h2>
          <div class="admin-list" id="open-loans-borrower"></div>
        </div>
      ` : ""}

      ${topItems.length > 0 ? `
        <div class="loan-section">
          <h2 class="section-title">TOP ITEMS</h2>
          <div class="admin-list">
            ${topItems.map(([name, count]) => `<div class="admin-list-item" style="cursor:default;"><div style="flex:1;">${escapeHtml3(name)}</div><div class="item-count">${count}\xD7</div></div>`).join("")}
          </div>
        </div>
      ` : ""}

      <div class="loan-section">
        <h2 class="section-title">ALL LOANS (${loans.length})</h2>
        <div class="admin-list" id="borrower-loans-list"></div>
      </div>

      ${phoneMatches.length > 1 ? `
        <div class="loan-section">
          <h2 class="section-title">SAME PHONE (${phoneMatches.length} borrowers)</h2>
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
    // The Queue tab's badge, kept in step with the header. It was only ever set
    // by drawing the Queue tab, so a panel that opened on another tab showed
    // "Queue 0" beside "Returns to confirm: 1".
    const pendingRequests = await getRequests({ status: "pending" }).catch(() => []);
    const queued = pendingReturns.length + pendingRequests.length;
    const queueBadge = document.getElementById("queue-count");
    if (queueBadge) {
      queueBadge.textContent = String(queued);
      queueBadge.style.display = queued ? "" : "none";
    }
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
  const who = [
    escapeHtml3(loan.borrowerNameSnapshot || "Unknown"),
    loan.borrowerPhoneSnapshot ? escapeHtml3(formatPhone(loan.borrowerPhoneSnapshot)) : "",
    escapeHtml3(age)
  ].filter(Boolean).join(" \xB7 ");
  // One button per decision. A damaged report used to offer "Accept as reported
  // (damaged)" next to "Returned, damaged" -- two buttons that did the same
  // thing -- and staff had to work out which one they meant.
  row.innerHTML = `
    <div class="queue-header">
      <div class="queue-borrower">
        <span class="queue-name">${escapeHtml3(loan.itemNameSnapshot || "Item")}</span>
        <span class="queue-meta">${who}</span>
      </div>
    </div>
    ${damaged ? `<div class="queue-description queue-warning">Reported a problem${loan.returnRequestedNote ? `: ${escapeHtml3(loan.returnRequestedNote)}` : ""}</div>` : `<div class="queue-description">Says it's in good shape.</div>`}
    <div class="queue-actions">
      <button class="btn btn-primary" data-action="confirm-return" data-loan-id="${loan.id}">${damaged ? "Confirm return (damaged)" : "Confirm return"}</button>
      ${damaged ? "" : `<button class="btn btn-secondary" data-action="confirm-return-damaged" data-loan-id="${loan.id}">It's damaged</button>`}
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
  // Cancel, Escape or a tap outside: change nothing.
  if (reason === null) return;
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
 * that as *UTC* midnight. For a user in Eastern time that is Aug 31, 8pm local, so a
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
  // Every loan, then the date range, then the 200 shown. The 1,000 cap used to
  // come first, so on a busy desk any range older than the newest thousand
  // loans came back empty while the export (which had them) disagreed. The
  // store is read whole either way; only the slicing moved.
  const all = await getAllLoans({
    limit: null
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
    l.notes || ""
  ]);
  const bom = "\uFEFF";
  // Through csvEscape like the other exports. This one did its own quoting, so a
  // kiosk-typed name or item beginning "=" went out as a live formula, and a
  // quote in the notes was doubled twice.
  const csv = [
    headers,
    ...rows
  ].map((r) => r.map(csvEscape).join(",")).join("\n");
  return bom + csv;
}
/**
 * Catalog entries the kiosk created that nobody has looked at yet.
 *
 * The desk owner's decision was that the public tablet may create an item on the
 * spot, flagged for review. This is the other half of that decision, and it is
 * the half that makes it safe: a flag with no surface is the same as no flag, and
 * the failure mode is a catalog quietly filling with whatever a borrower typed.
 *
 * Archived entries are excluded -- archiving one is itself a decision about it --
 * and a merged one has had its flag cleared by the merge. `needsReview` has no
 * index (adding one would mean a schema version bump for a field that is read
 * once per Items tab), so this is a filter over the cached catalog, which is the
 * same array `listItems` already hands out.
 */
async function findKioskReviewItems() {
  const items = await listItems({
    includeArchived: false
  });
  return items.filter((it) => it.needsReview === true);
}
/**
 * The "added at the kiosk" strip above the item list.
 *
 * Sits beside the duplicates banner rather than inside it: the two answer
 * different questions, and the duplicates banner's own checks are built on its
 * markup. A kiosk-created item is not necessarily a duplicate -- it is an item
 * whose name nobody at the desk has seen yet -- so it gets its own line.
 */
async function _renderKioskReviewBanner(container) {
  if (!container) return;
  let pending;
  try {
    pending = await findKioskReviewItems();
  } catch (err) {
    console.error("[kiosk] could not scan for unreviewed items:", err);
    container.innerHTML = "";
    return;
  }
  if (pending.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = `
    <div class="dedup-banner">
      <div class="dedup-banner-text">
        <div class="dedup-banner-title">${pending.length} item${pending.length === 1 ? "" : "s"} added at the kiosk ${pending.length === 1 ? "needs" : "need"} a look</div>
        <div class="loan-meta">
          A borrower typed ${pending.length === 1 ? "this name" : "these names"} at the tablet. The loan went
          through either way — check ${pending.length === 1 ? "it is" : "they are"} the item you would have
          catalogued, and rename, merge or archive ${pending.length === 1 ? "it" : "them"} here.
        </div>
      </div>
      <button class="btn btn-secondary" data-action="review-kiosk">Review</button>
    </div>
  `;
  container.querySelector('[data-action="review-kiosk"]').onclick = () => _showKioskReview();
}
/**
 * Admin → Items → Review kiosk additions.
 *
 * One row per item the tablet created, newest first, each saying what was typed,
 * when, and who took it out -- the three things a person needs to decide whether
 * the entry is right. Every row offers the same three answers, and each of them
 * *is* the review, so none of them leaves the flag set:
 *
 *   Keep          -- the entry is fine; clear the flag and move on.
 *   Merge into…   -- it is a duplicate of something already catalogued. Uses the
 *                    same `mergeItems` the duplicate screen uses, so the merged
 *                    name keeps resolving and the merge is undoable.
 *   Archive       -- it does not belong in the catalog. Archiving hides it and
 *                    keeps it, which is the same treatment a merge gives a victim.
 *
 * Rename is deliberately not a fourth button: the item's own screen already has
 * Edit, and a second rename path here would be a second place to get the alias
 * bookkeeping wrong.
 */
async function _showKioskReview() {
  goToScreen("admin-detail", {
    data: {
      kind: "kiosk-review"
    }
  });
  const root = document.getElementById("screen-admin-detail");
  if (!root) return;
  const titleEl = root.querySelector(".detail-title");
  const content = root.querySelector(".detail-content");
  if (titleEl) titleEl.textContent = "Kiosk additions";
  if (content) content.innerHTML = '<p style="text-align:center; padding:32px;">Loading…</p>';
  const render = async () => {
    if (!content) return;
    let pending;
    try {
      pending = await findKioskReviewItems();
    } catch (err) {
      content.innerHTML = `<p style="color:var(--error);">Error: ${escapeHtml3(err.message)}</p>`;
      return;
    }
    if (pending.length === 0) {
      content.innerHTML = `
        <div class="return-card">
          <div class="item-name" style="font-size:20px; margin-bottom:8px;">Nothing to review</div>
          <div class="loan-meta">Every item the kiosk added has been dealt with. Anything the tablet adds from now on shows up here.</div>
        </div>
      `;
      return;
    }
    // Who took it out, and when. One loan lookup per item rather than a full
    // scan: this list is short by construction -- it is only what the tablet has
    // added and nobody has confirmed.
    const rows = [];
    for (const item of pending.slice().reverse()) {
      let who = "";
      let when = item.createdAt ? formatRelativeTime(Date.now() - item.createdAt) : "";
      try {
        const loans = await getLoansForItem(item.id);
        const latest = loans.slice().sort((a, b) => (b.checkedOutAt || 0) - (a.checkedOutAt || 0))[0];
        if (latest) {
          who = latest.borrowerNameSnapshot || (latest.borrowerPhoneSnapshot ? formatPhone(latest.borrowerPhoneSnapshot) : "(walk-in)");
        }
      } catch {
        who = "";
      }
      rows.push(`
        <div class="loan-section" data-item-id="${Number(item.id)}">
          <div class="dedup-member" style="align-items:flex-start;">
            <div style="flex:1;">
              <div class="borrower-name">${escapeHtml3(item.name)}</div>
              <div class="loan-meta">
                ${when ? `typed ${escapeHtml3(when)}` : "typed at the kiosk"}
                ${who ? ` \xB7 taken by ${escapeHtml3(who)}` : ""}
                \xB7 ${Number(item.timesCheckedOut) || 0}\xD7 out
              </div>
            </div>
          </div>
          <div class="dedup-actions">
            <button class="btn btn-primary" data-action="keep" data-item-id="${Number(item.id)}">Keep</button>
            <button class="btn btn-secondary" data-action="merge-into" data-item-id="${Number(item.id)}">Merge into…</button>
            <button class="btn btn-ghost" data-action="archive" data-item-id="${Number(item.id)}">Archive</button>
            <button class="btn btn-ghost" data-action="open" data-item-id="${Number(item.id)}">Open</button>
          </div>
        </div>
      `);
    }
    content.innerHTML = `
      <div class="return-card" style="margin-bottom:16px;">
        <div class="loan-meta">
          These were created on the public tablet, so the loan is already recorded — this screen is about
          whether the <strong>catalog entry</strong> is right. Keeping one clears its flag; merging removes the
          duplicate for good; archiving hides it without deleting it.
        </div>
      </div>
      ${rows.join("")}
    `;
    _wireKioskReview(content, render);
  };
  await render();
}
function _wireKioskReview(content, render) {
  const idOf = (el) => Number(el.dataset.itemId);
  content.querySelectorAll('[data-action="keep"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = await get("items", idOf(btn));
      if (!item) return;
      item.needsReview = false;
      await put("items", item);
      showToast(`"${item.name}" kept`, {
        type: "success"
      });
      await render();
    });
  });
  content.querySelectorAll('[data-action="archive"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = await get("items", idOf(btn));
      if (!item) return;
      // Archiving is the answer to "this should not be in the catalog", so it
      // also answers the review question. Leaving the flag on an archived item
      // would be invisible (the list hides archived entries) and would come back
      // the moment anyone unarchived it.
      item.isArchived = true;
      item.needsReview = false;
      await put("items", item);
      showToast(`"${item.name}" archived`, {
        type: "success"
      });
      await render();
    });
  });
  content.querySelectorAll('[data-action="open"]').forEach((btn) => {
    btn.addEventListener("click", () => showItemDetail(idOf(btn)));
  });
  content.querySelectorAll('[data-action="merge-into"]').forEach((btn) => {
    btn.addEventListener("click", () => _mergeKioskItem(idOf(btn), render));
  });
}
/**
 * Pick the catalog entry a kiosk addition is a duplicate of, then merge into it.
 *
 * Reuses `mergeItems`, so the typed name becomes an alias of the survivor and the
 * next person who types it gets an exact hit -- and so an undo is available on
 * the survivor's screen. The picker is a search over the catalog rather than the
 * nearest-ten list `_mergeBorrower` uses, because at this catalog size the entry
 * the desk wants is often not in the top ten by any ordering this code could
 * guess, and a search box is the one control that scales.
 */
async function _mergeKioskItem(victimId, render) {
  const victim = await get("items", victimId);
  if (!victim) return;
  const form = document.createElement("div");
  form.innerHTML = `
    <input class="input" placeholder="Search the catalog…" data-f="q" />
    <div id="merge-picker-results" style="max-height:280px; overflow:auto; margin-top:12px;"></div>
  `;
  const results = form.querySelector("#merge-picker-results");
  const qInput = form.querySelector('[data-f="q"]');
  let chosen = null;
  const search = async () => {
    const q = qInput.value.trim();
    const found = q ? (await searchItems(q, {
      limit: 20
    })).map((r) => r.item) : (await listItems({})).slice(0, 20);
    const candidates = found.filter((it) => it.id !== victimId);
    results.innerHTML = "";
    if (candidates.length === 0) {
      const p = document.createElement("div");
      p.className = "loan-meta";
      p.textContent = q ? "Nothing matches that." : "The catalog has nothing else in it.";
      results.appendChild(p);
      return;
    }
    for (const it of candidates) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "dedup-member";
      row.style.width = "100%";
      row.style.textAlign = "left";
      row.innerHTML = `
        <div style="flex:1;">
          <div class="borrower-name">${escapeHtml3(it.name)}</div>
          <div class="loan-meta">${escapeHtml3(it.category || "Other")} \xB7 ${Number(it.timesCheckedOut) || 0}\xD7 out</div>
        </div>
      `;
      row.onclick = () => {
        chosen = it;
        for (const other of results.querySelectorAll(".dedup-member")) {
          other.classList.remove("is-selected");
        }
        row.classList.add("is-selected");
      };
      results.appendChild(row);
    }
  };
  let debounce;
  qInput.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => search().catch((err) => console.error("merge search failed:", err)), 120);
  });
  await search();
  const keepId = await showDialog({
    title: `Merge "${victim.name}" into…`,
    body: form,
    buttons: [
      {
        label: "Cancel",
        value: null,
        variant: "ghost"
      },
      {
        label: "Merge",
        // The dialog closes on the click, so the choice has to be read here
        // rather than returned -- `chosen` is the picker's own state.
        value: "merge",
        variant: "primary"
      }
    ]
  });
  if (keepId !== "merge") return;
  if (!chosen) {
    // The dialog cannot disable its own button while the choice is made inside
    // the body, so the empty case is answered out loud rather than closing in
    // silence -- a Merge button that does nothing on an empty selection reads as
    // a broken button.
    showToast("Pick the entry to merge into first", {
      type: "error"
    });
    return;
  }
  try {
    const res = await mergeItems(chosen.id, victimId);
    showToast(`"${res.mergedName}" merged into "${res.keepName}" \xB7 ${res.loansMoved} loan${res.loansMoved === 1 ? "" : "s"} moved`, {
      type: "success",
      duration: 6e3
    });
  } catch (err) {
    showToast(`Merge failed: ${err && err.message ? err.message : "see the log"}`, {
      type: "error",
      duration: 6e3
    });
  }
  await render();
}
async function renderItems() {
  const panel = document.querySelector("#tab-items .admin-list");
  if (!panel) return;
  panel.innerHTML = `
    <div id="duplicates-panel"></div>
    <div id="kiosk-review-panel"></div>
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
  // Typing waits a moment; choosing a sort and adding an item do not. Every
  // keystroke otherwise re-reads the catalog and re-sorts it, which at 10,000
  // items is the difference between a search box that keeps up and one that drops
  // characters while the desk is still typing.
  let qDebounce = null;
  qInput.addEventListener("input", () => {
    clearTimeout(qDebounce);
    qDebounce = setTimeout(refresh, ADMIN_SEARCH_DEBOUNCE_MS);
  });
  sortSelect.addEventListener("change", refresh);
  panel.querySelector('[data-action="add-item"]').onclick = () => _promptAddItem(refresh);
  // A permanent way in. The banner disappears once every group has been resolved
  // or dismissed -- which would otherwise strand the review screen, and with it
  // the only undo for a group dismissed by mistake.
  panel.querySelector('[data-action="review-dups-all"]').onclick = () => _showDuplicatesReview();
  await Promise.all([
    refresh(),
    _renderDuplicatesBanner(panel.querySelector("#duplicates-panel")),
    _renderKioskReviewBanner(panel.querySelector("#kiosk-review-panel"))
  ]);
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
  const exact = pending.groups.length;
  const near = pending.nearGroups.length;
  if (exact + near === 0) {
    container.innerHTML = "";
    return;
  }
  const reviewed = pending.totalGroups - exact - near;
  // Two sentences, because the two kinds of duplicate deserve different
  // confidence: an identical name is almost certainly one thing entered twice,
  // while entries that merely share a word are a question. Saying so is what
  // keeps the second kind from being merged by reflex.
  const title = exact > 0
    ? `${exact + near} possible duplicate${exact + near === 1 ? "" : "s"} in the catalog`
    : `${near} similar name${near === 1 ? "" : "s"} worth a look`;
  container.innerHTML = `
    <div class="dedup-banner">
      <div class="dedup-banner-text">
        <div class="dedup-banner-title">${title}</div>
        <div class="loan-meta">
          ${exact > 0 ? `${exact} name${exact === 1 ? "" : "s"} shared by more than one entry. ` : ""}
          ${near > 0 ? `${near} group${near === 1 ? "" : "s"} of entries with similar names — "Room 115", "115" and "115 Key" are one thing; "Cable HDMI" and "Cable VGA" are two. ` : ""}
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
    if (pending.groups.length + pending.nearGroups.length === 0) {
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
    // Exact groups first, then similar-name groups. The order is the argument:
    // an identical name is near-certainly one thing, a shared word is a
    // question, and showing them in that order keeps the second from being
    // treated with the first's confidence.
    const allGroups = [
      ...pending.groups.map((group) => ({ group, near: false })),
      ...pending.nearGroups.map((group) => ({ group, near: true }))
    ];
    const sections = allGroups.map(({ group, near }, gi) => {
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
        <div class="loan-section" data-group="${gi}" data-near="${near ? "1" : "0"}">
          <h2 class="section-title">${escapeHtml3(group[0].name)} — ${group.length} entries${near ? " (similar names)" : ""}</h2>
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
          checkout count, and the <strong>other names keep working</strong> — once "Room 115" is merged
          into "115", typing either one finds "115".
        </div>
        <div class="loan-meta" style="margin-top:8px;">
          Nothing is deleted, and a merge can be undone: the merged entry is archived, and
          <strong>Undo merge</strong> on its own screen puts it back — its name stops meaning the survivor,
          and any loan that is still out goes back with it. Loans that have already been returned stay on
          the survivor, because that is where the history happened.
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
      // Near groups are acknowledged under a prefixed key, so dismissing this
      // one cannot also dismiss a later exact group that happens to start with
      // the same entry. Mirrors `findUnreviewedDuplicates`.
      const near = section.dataset.near === "1";
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
      // Dry run first. The desk is about to move real loan records, so it gets
      // told exactly how many before it commits rather than reading it in a
      // toast afterwards -- and told which names will keep resolving to the
      // survivor, because that is the part that is invisible once it is done.
      const previews = [];
      for (const victimId of victims) {
        const p = await previewMerge(keepId, victimId);
        if (p) previews.push(p);
      }
      const totalLoans = previews.reduce((n, p) => n + p.loansMoved, 0);
      const totalOpen = previews.reduce((n, p) => n + p.openLoansMoved, 0);
      const addedCheckOuts = previews.reduce((n, p) => n + p.checkOutsMoved, 0);
      const losingNames = previews.map((p) => p.mergeName).filter((n) => normalize(n) !== normalize(keeperName));
      const sentence = [
        `Merge ${victims.length} other entr${victims.length === 1 ? "y" : "ies"} into "${keeperName}"?`,
        `${totalLoans} loan${totalLoans === 1 ? "" : "s"} move${totalLoans === 1 ? "s" : ""} across${totalOpen ? `, ${totalOpen} of them still out` : ""}, and the checkout count becomes ${(keeper && keeper.timesCheckedOut || 0) + addedCheckOuts}.`,
        losingNames.length ? `"${losingNames.join('", "')}" will keep finding this item.` : "",
        "Nothing is deleted: the merged entries stay in the catalog, archived, and Undo merge on one of their own screens puts it back.",
        previews.some((p) => p.bothOpen)
          ? "One of these is checked out while the survivor is too — that merge will be refused until one is returned."
          : ""
      ].filter(Boolean).join(" ");
      const ok = await confirmDialog(sentence, {
        title: "Merge duplicates",
        danger: true,
        confirmLabel: "Merge",
        cancelLabel: "Cancel"
      });
      if (!ok) return;
      const nameKey = keeper ? _dedupKeyFor(keeper, near) : "";
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
      const near = section.dataset.near === "1";
      const ids = [...section.querySelectorAll('input[type="radio"]')].map((r) => Number(r.value));
      const items = await listItems({
        includeArchived: true
      });
      const byId = new Map(items.map((it) => [it.id, it]));
      const members = ids.map((id) => byId.get(id)).filter(Boolean);
      if (members.length === 0) return;
      const nameKey = _dedupGroupKey(members, near);
      await setDedupAcknowledged(nameKey, _dedupSignature(members));
      showToast("Marked as separate units — won't ask again unless the list changes", {
        type: "info"
      });
      await render();
    });
  });
}
/**
 * How many item rows the admin list draws before it offers "Show more".
 *
 * Deliberately above the 36 items the layout suite seeds, so no existing check
 * changes meaning, and far below the 10,000 this catalog has to hold: the point
 * is that the screen opens instantly and search is the way in, not that every
 * row is on screen.
 */
var ITEMS_RENDER_CAP = 200;
/** Typing settles before the list redraws. See `_renderItemsList`. */
var ADMIN_SEARCH_DEBOUNCE_MS = 120;
async function _renderItemsList(content, query, sortBy, limit = ITEMS_RENDER_CAP) {
  if (!content) return;
  const includeArchived = true;
  const all = await listItems({
    includeArchived
  });
  const q = (query || "").toLowerCase().trim();
  // Aliases and location are searched, not just name and category. An alias is
  // a name people actually type -- it is how a merged-away entry keeps working --
  // so a search that ignored it would fail to find the item by the very word the
  // desk remembers it by, and location is how someone finds "the one in the
  // cabinet". Both are the exact strings the desk uses out loud.
  let filtered = q
    ? all.filter((it) =>
        (it.name || "").toLowerCase().includes(q) ||
        (it.category || "").toLowerCase().includes(q) ||
        (it.location || "").toLowerCase().includes(q) ||
        (it.aliases || []).some((a) => a && String(a.label || "").toLowerCase().includes(q)))
    : all;
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
    // The two empty states are different facts and used to share one sentence.
    // "No items yet" on a search that matched nothing tells the desk the catalog
    // is empty, which is the same false assertion as the reported "THERES NO
    // ITEMS" -- the screen claiming a state the database is not in.
    content.innerHTML = q
      ? `<p style="text-align:center; color:var(--text-muted); padding:32px;">Nothing matches "${escapeHtml3(query.trim())}".</p>`
      : '<p style="text-align:center; color:var(--text-muted); padding:32px;">No items yet</p>';
    return;
  }
  const shown = filtered.slice(0, limit);
  for (const item of shown) {
    const row = document.createElement("div");
    row.className = "admin-list-item";
    if (item.isArchived) row.style.opacity = "0.5";
    row.innerHTML = `
      <div style="flex:1;">
        <div class="borrower-name">${escapeHtml3(item.name)} ${item.isArchived ? '<span class="loan-meta" style="color:var(--warning);">(archived)</span>' : ""}${item.needsReview ? ' <span class="loan-meta item-review-chip">kiosk</span>' : ""}</div>
        <div class="loan-meta">${escapeHtml3(item.category || "Other")} \xB7 ${item.timesCheckedOut || 0}\xD7 out${item.lastCheckedOutAt ? " \xB7 last " + agoLabel(Date.now() - item.lastCheckedOutAt) : ""}</div>
      </div>
      <div class="item-count">${escapeHtml3(item.condition || "good")}</div>
    `;
    row.onclick = () => showItemDetail(item.id);
    content.appendChild(row);
  }
  // The count line is always shown, not only when the list is capped: "200 of
  // 1,204" is the desk's only evidence that the list is a window rather than the
  // whole catalog, and a window that looks complete is how something goes
  // missing from a search.
  const count = document.createElement("div");
  count.className = "loan-meta";
  count.style.padding = "12px";
  count.textContent = shown.length < filtered.length
    ? `Showing ${shown.length} of ${filtered.length} — type to narrow`
    : `${filtered.length} item${filtered.length === 1 ? "" : "s"}${q ? " matching" : ""}`;
  content.appendChild(count);
  if (shown.length < filtered.length) {
    const more = document.createElement("button");
    more.className = "btn btn-ghost";
    more.style.margin = "0 12px 12px";
    more.textContent = `Show ${Math.min(ITEMS_RENDER_CAP, filtered.length - shown.length)} more`;
    // Safe as a stale closure: this button lives inside `content`, which every
    // refresh clears, so a changed query destroys it before it can be clicked.
    more.onclick = () => _renderItemsList(content, query, sortBy, limit + ITEMS_RENDER_CAP);
    content.appendChild(more);
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
  // Digits alone too, so "416-555-0100" finds the number however it was typed.
  const qDigits = q.replace(/\D/g, "");
  let filtered = q ? all.filter((b) => b.name.toLowerCase().includes(q) || (b.phoneFormatted || "").includes(q) || b.phone.includes(q) || qDigits.length >= 3 && b.phone.includes(qDigits)) : all;
  filtered.sort((a, b) => {
    if (sortBy === "timesCheckedOut") return (b.timesCheckedOut || 0) - (a.timesCheckedOut || 0);
    if (sortBy === "lastSeenAt") return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
    return (a.name || "").localeCompare(b.name || "", void 0, {
      numeric: true
    });
  });
  content.innerHTML = "";
  if (filtered.length === 0) {
    // "No people yet" was shown for a search that just found nobody, which
    // reads as if the whole list had gone.
    const msg = all.length === 0
      ? "No people yet"
      : `Nobody matches “${escapeHtml3(query.trim())}”`;
    content.innerHTML = `<p style="text-align:center; color:var(--text-muted); padding:32px;">${msg}</p>`;
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
      <label class="setting-label" for="setting-keyboard">On-screen keyboard</label>
      <select class="setting-input" id="setting-keyboard" data-setting="keyboard">
        <option value="auto"${onScreenKeyboardMode() === "auto" ? " selected" : ""}>Automatic (${isHosted() ? "on in this app" : "off \u2014 this device has its own"})</option>
        <option value="on"${onScreenKeyboardMode() === "on" ? " selected" : ""}>Always show</option>
        <option value="off"${onScreenKeyboardMode() === "off" ? " selected" : ""}>Never show</option>
      </select>
      <div class="loan-meta" style="margin-top:6px;">Just for this device. Turn it on for a touchscreen with no keyboard of its own.</div>
    </div>

    <div class="setting-group">
      <button class="btn btn-primary" data-action="save-settings">Save settings</button>
    </div>

    <div class="setting-group" style="margin-top:32px; padding-top:24px; border-top:1px solid var(--border);">
      <h2 class="section-title" style="font-size:18px; margin-bottom:16px;">Backup &amp; Restore</h2>
      <div class="setting-actions">
        <button class="btn btn-secondary" data-action="export-json">Export Backup (JSON)</button>
        <button class="btn btn-secondary" data-action="export-csv-overdue">Export Overdue (CSV)</button>
        <button class="btn btn-secondary" data-action="import">Import Backup</button>
        <input type="file" accept="application/json" data-action="import-file" style="display:none;" />
      </div>
    </div>

    <div id="host-settings"></div>

    <div class="setting-group" style="margin-top:32px; padding-top:24px; border-top:1px solid var(--border);">
      <h2 class="section-title" style="font-size:18px; margin-bottom:16px; color:var(--error);">Danger Zone</h2>
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
    const kbdMode = panel.querySelector('select[data-setting="keyboard"]').value;
    try {
      if (kbdMode === "auto") localStorage.removeItem(KEYBOARD_PREF_KEY);
      else localStorage.setItem(KEYBOARD_PREF_KEY, kbdMode);
    } catch (_) {
    }
    if (!onScreenKeyboardWanted()) putKeyboardAway();
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
    // Cleared at once, so picking the same file again after Cancel still works.
    importFile.value = "";
    if (!file) return;
    // Import replaces everything, exactly as Restore does -- and Restore has
    // always asked first. This used to go straight ahead on picking a file.
    let counts = null;
    try {
      const peek = JSON.parse(await file.text());
      if (peek && Array.isArray(peek.items) && Array.isArray(peek.borrowers) && Array.isArray(peek.loans)) {
        counts = ` It holds ${peek.items.length} item${peek.items.length === 1 ? "" : "s"}, ${peek.borrowers.length} ${peek.borrowers.length === 1 ? "person" : "people"} and ${peek.loans.length} loan${peek.loans.length === 1 ? "" : "s"}.`;
      }
    } catch (_) {
    }
    // Not a backup at all: nothing would be replaced, so there is nothing to
    // ask -- importFromFile refuses it and says why.
    const yes = counts === null ? true : await confirmDialog(
      `Replace everything in Front Desk with the contents of ${file.name}?${counts} Anything checked out or added since that file was saved will be gone.`,
      {
        title: "Import a backup",
        danger: true,
        confirmLabel: "Replace everything"
      }
    );
    if (!yes) return;
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
  // `.catch` because a wipe that fails must not look like a wipe that worked.
  // This used to reject invisibly -- the three clears had committed while the
  // settings write threw, so the toast and the re-render never ran and the only
  // trace was a line in the host log.
  panel.querySelector('[data-action="wipe"]').onclick = () => {
    _wipeData().catch((err) => {
      console.error("wipe failed:", err);
      showToast(`Wipe failed: ${err && err.message ? err.message : "see the log"}`, {
        type: "error",
        duration: 6e3
      });
    });
  };
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
        <h2 class="section-title" style="font-size:18px; margin-bottom:8px;">Backup folder</h2>
        <div class="loan-meta">In the browser, a backup can only be downloaded. The Windows app additionally
        writes one into a folder on this machine on every launch, and keeps the last few &mdash; open
        <strong>RFrontDesk.exe</strong> to use it.</div>
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
      <h2 class="section-title" style="font-size:18px; margin-bottom:16px;">This computer</h2>
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
      <div class="loan-meta">Starts minimised to the notification area, so the desk is ready before anyone arrives.${
        info?.autostart ? ` Windows will run it as: <span class="path-value" style="display:inline;">${escape(info?.autostartArgs || "no options")}</span>` : ""
      }</div>
    </div>

    <div class="setting-group" style="margin-top:24px;">
      <h2 class="section-title" style="font-size:18px; margin-bottom:12px;">Recent backups</h2>
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
      <h2 class="report-section-title">LOANS ${report.byMonth ? "BY MONTH" : "BY DAY"}</h2>
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
      <h2 class="report-section-title">BUSIEST ITEMS</h2>
      ${report.topItems.map((i) => _reportRankRow(i.name, i.open > 0 ? `${i.open} still out` : "", String(i.count), i.count / report.topItems[0].count)).join("")}
    </div>`;
  const topPeople = report.topBorrowers.length === 0 ? "" : `<div class="report-section">
      <h2 class="report-section-title">BUSIEST PEOPLE</h2>
      ${report.topBorrowers.map((p) => _reportRankRow(p.name, [p.phone ? formatPhone(p.phone) : "", p.open > 0 ? `${p.open} still out` : ""].filter(Boolean).join(" \xB7 "), String(p.count), p.count / report.topBorrowers[0].count)).join("")}
    </div>`;
  const idleShown = report.idle.slice(0, 12);
  const idle = report.idle.length === 0 ? "" : `<div class="report-section">
      <h2 class="report-section-title">NOT USED ${period === "all" ? "AT ALL" : "THIS PERIOD"} (${report.idle.length})</h2>
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
    badge.textContent = `Overdue ${formatRelativeTime(Date.now() - loan.dueAt)}`;
  } else {
    // A bare "1h" read as a due time; it is how long the item has been out.
    badge.textContent = `Out ${formatRelativeTime(Date.now() - loan.checkedOutAt)}`;
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
  // A lone tick on a full-width green bar said nothing about what it would do.
  quickCheckin.textContent = "\u2713 Mark returned";
  quickCheckin.setAttribute("aria-label", `Mark ${loan.itemNameSnapshot || "this item"} returned`);
  quickCheckin.onclick = async (e) => {
    e.stopPropagation();
    try {
      const closed = await returnLoan(loan.id, {
        returnedAt: Date.now()
      });
      showToast(closed.conditionIn === "damaged" ? "Returned \u2014 damaged, as the borrower reported" : "Returned OK", {
        type: closed.conditionIn === "damaged" ? "error" : "success"
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
      <div class="loan-meta">${escapeHtml3(displayPhone(phone))}</div>
    </div>
  `;
  row.appendChild(top);
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex; gap:8px; flex-wrap:wrap;";
  // A phone field is free text, so it may hold something that is not a ten-digit
  // number -- an extension, a note, half a number. telUri and smsUri return ""
  // for those, and an anchor with href="" is not inert: the browser resolves it
  // to the current page and a tap reloads the whole app, losing whatever the
  // staff member had open. So the two buttons exist only when they have a URI,
  // and Copy covers everything else.
  const callHref = telUri(phone);
  const textHref = smsUri(phone, `Hi, you have an overdue item at the front desk (${item?.name || loan.itemNameSnapshot || "?"}). Please return it. Thanks!`);
  if (callHref) {
    const callBtn = document.createElement("a");
    callBtn.className = "btn btn-secondary";
    callBtn.style.cssText = "min-height:48px; padding:8px 16px; text-decoration:none;";
    callBtn.href = callHref;
    callBtn.textContent = "\u{1F4DE} Call";
    actions.appendChild(callBtn);
  }
  if (textHref) {
    const textBtn = document.createElement("a");
    textBtn.className = "btn btn-secondary";
    textBtn.style.cssText = "min-height:48px; padding:8px 16px; text-decoration:none;";
    textBtn.href = textHref;
    textBtn.textContent = "\u{1F4AC} Text";
    actions.appendChild(textBtn);
  }
  if (phone) {
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn btn-secondary";
    copyBtn.style.cssText = "min-height:48px; padding:8px 16px;";
    copyBtn.textContent = "\u{1F4CB} Copy";
    copyBtn.onclick = async () => {
      const overdue = formatRelativeTime(Date.now() - (loan.dueAt || Date.now()));
      const text = `${borrower?.name || loan.borrowerNameSnapshot} \xB7 ${displayPhone(phone)} \xB7 ${item?.name || loan.itemNameSnapshot} \xB7 overdue ${overdue}`;
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
      const closed = await returnLoan(loan.id, {
        returnedAt: Date.now()
      });
      showToast(closed.conditionIn === "damaged" ? "Returned \u2014 damaged, as the borrower reported" : "Returned OK", {
        type: closed.conditionIn === "damaged" ? "error" : "success"
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
    // A blank name used to be saved, leaving an item nobody can find or read.
    // The dialog closes on Save, so the old name is kept and the desk is told.
    const typedName = sentenceCase(form.querySelector('[data-f="name"]').value.trim());
    if (!typedName) {
      showToast(`An item needs a name, so it is still called "${item.name}". Nothing was changed.`, {
        type: "error",
        duration: 5e3
      });
      return;
    }
    item.name = typedName;
    item.nameLower = item.name.toLowerCase();
    item.category = sentenceCase(form.querySelector('[data-f="category"]').value.trim()) || "Other";
    item.location = form.querySelector('[data-f="location"]').value.trim();
    item.condition = form.querySelector('[data-f="condition"]').value;
    item.notes = form.querySelector('[data-f="notes"]').value;
    // Editing an item *is* the review. The flag exists to say "a member of the
    // public typed this name and nobody has confirmed it belongs in the catalog",
    // and a staff member who has just opened it, fixed its name and its location
    // has answered that question. Leaving the flag set would put the item back on
    // the review list it was just dealt with on.
    item.needsReview = false;
    await put("items", item);
    showToast("Item updated", {
      type: "success"
    });
    showItemDetail(item.id);
  }
}
async function _archiveItem(item) {
  item.isArchived = !item.isArchived;
  await put("items", item);
  showToast(item.isArchived ? "Item archived" : "Item unarchived", {
    type: "success"
  });
  showItemDetail(item.id);
}
/**
 * Confirm, then undo a merge from the merged item's own detail screen.
 *
 * The confirmation says what will *not* come back as well as what will: a desk
 * that expects every loan to reappear and gets most of them has been told a
 * half-truth, so the closed loans that stay with the keeper are stated up front
 * rather than mentioned in a toast afterwards.
 */
async function _unmergeItem(item) {
  const meta = item.mergeMeta || {};
  const keepName = meta.keepName || `item ${item.mergedIntoId}`;
  const moved = Number(meta.loansMoved) || 0;
  const confirmed = await showDialog({
    title: "Undo this merge?",
    body: `
      <p><strong>${escapeHtml3(item.name)}</strong> goes back in the catalog as its own item,
      and typing that name will find it again.</p>
      ${moved > 0 ? `<p>Its ${moved} loan${moved === 1 ? "" : "s"} stay${moved === 1 ? "s" : ""} with
      <strong>${escapeHtml3(keepName)}</strong>, except any that are still out — those come back with it.</p>` : ""}
      <p style="color:var(--text-muted);">Nothing is deleted either way.</p>
    `,
    buttons: [
      {
        label: "Cancel",
        value: false,
        variant: "ghost"
      },
      {
        label: "Undo merge",
        value: true,
        variant: "primary"
      }
    ]
  });
  if (!confirmed) return;
  try {
    const res = await unmergeItem(item.id);
    const parts = [];
    if (res.loansMovedBack > 0) {
      parts.push(`${res.loansMovedBack} open loan${res.loansMovedBack === 1 ? "" : "s"} came back with it`);
    }
    if (res.loansStayed > 0) {
      parts.push(`${res.loansStayed} returned loan${res.loansStayed === 1 ? "" : "s"} stayed with "${res.keepName}"`);
    }
    showToast(`"${res.name}" is back${parts.length ? " — " + parts.join(", ") : ""}`, {
      type: "success",
      duration: 6e3
    });
    await showItemDetail(item.id);
  } catch (err) {
    console.error("unmerge failed:", err);
    showToast(`Could not undo the merge: ${err && err.message ? err.message : "see the log"}`, {
      type: "error",
      duration: 6e3
    });
  }
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
    // As for items: a blank name is refused, and the old one kept.
    const typedName = sentenceCase(form.querySelector('[data-f="name"]').value.trim());
    if (!typedName) {
      showToast(`A person needs a name, so they are still "${borrower.name}". Nothing was changed.`, {
        type: "error",
        duration: 5e3
      });
      return;
    }
    borrower.name = typedName;
    borrower.nameLower = borrower.name.toLowerCase();
    const newPhone = normalizePhone(form.querySelector('[data-f="phone"]').value);
    let phoneChanged = false;
    if (newPhone && newPhone.length === 10 && newPhone !== borrower.phone) {
      borrower.phone = newPhone;
      borrower.phoneFormatted = formatPhone(newPhone);
      phoneChanged = true;
    }
    borrower.contact2 = form.querySelector('[data-f="contact2"]').value.trim();
    borrower.notes = form.querySelector('[data-f="notes"]').value;
    await put("borrowers", borrower);
    // The same follow-up the other path does. Editing a number here used to
    // leave every open loan quoting the old one.
    if (phoneChanged) await _syncOpenLoanPhones(borrower.id, newPhone);
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
  // A searchable list of everyone, not the first ten. The ten were whoever the
  // store returned first -- archived people included -- so on a real desk the
  // duplicate you wanted was usually not on offer at all.
  const live = others.filter((b) => !b.isArchived);
  const SHOW_MAX = 30;
  let chosen = null;
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="color:var(--text-secondary); margin-bottom:12px;">All loans from the person you pick move to
    <strong>${escapeHtml3(borrower.name)}</strong>, and that person is then deleted.</p>
    <input class="input" data-f="q" placeholder="Search by name or phone" autocomplete="off" />
    <div data-role="list" style="display:flex; flex-direction:column; gap:8px; margin-top:12px; max-height:50vh; overflow-y:auto;"></div>
  `;
  const input = body.querySelector('[data-f="q"]');
  const list = body.querySelector('[data-role="list"]');
  const note = (text) => {
    const p = document.createElement("p");
    p.className = "loan-meta";
    p.style.textAlign = "center";
    p.textContent = text;
    list.appendChild(p);
  };
  const render = () => {
    const q = input.value.toLowerCase().trim();
    const qDigits = q.replace(/\D/g, "");
    const hits = (q ? live.filter((b) => b.name.toLowerCase().includes(q) || qDigits.length >= 3 && b.phone.includes(qDigits)) : live)
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", void 0, { numeric: true }));
    list.innerHTML = "";
    for (const b of hits.slice(0, SHOW_MAX)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-secondary";
      btn.dataset.mergeWith = String(b.id);
      btn.textContent = `${b.name} \xB7 ${formatPhone(b.phone)}`;
      btn.onclick = () => {
        chosen = b;
        closeDialog();
      };
      list.appendChild(btn);
    }
    if (hits.length === 0) note(live.length ? "Nobody matches that." : "There is nobody else to merge with (archived people are not listed).");
    else if (hits.length > SHOW_MAX) note(`Showing ${SHOW_MAX} of ${hits.length}. Type a name or number to narrow it down.`);
  };
  input.addEventListener("input", render);
  render();
  await showDialog({
    title: `Merge "${borrower.name}" with\u2026`,
    body,
    buttons: [
      {
        label: "Cancel",
        value: null,
        variant: "ghost"
      }
    ]
  });
  const other = chosen;
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
  // The dialog is already gone by now, so a name it cannot use has to be said
  // out loud -- and checked here, before createItem would throw at its tail.
  const problem = itemNameProblem(name);
  if (problem) {
    showToast(problem, {
      type: "error"
    });
    return;
  }
  const res = await resolveItem(name);
  if (res && res.item) {
    // Same rule as the checkout step: only a verbatim repeat asks a question.
    if (normalize(name) !== normalize(res.item.name)) {
      await attachToItem(res.item, name);
      await refresh();
      return;
    }
    const confirm3 = await showDialog({
      title: "Item already exists",
      body: `<p>An item named <strong>${escapeHtml3(res.item.name)}</strong> already exists.</p>`,
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
  } else if (res && res.alternatives.length) {
    showToast("Several items match that name — pick one from the list", {
      type: "error",
      duration: 5e3
    });
    await refresh();
    return;
  }
  try {
    await createItem({
      name,
      category
    });
  } catch (err) {
    showToast(err?.message || "Could not add that item", {
      type: "error",
      duration: 5e3
    });
    return;
  }
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
  // The number is the identity, so adding "Bob Jones" on a number already on
  // record for Jane Smith keeps Jane and drops the typed name. "Borrower added"
  // would then be false in the way that matters -- the desk would go looking for
  // a person who was never created.
  const known = await findBorrowerByPhone(phone);
  if (known.length > 0 && normalize(known[0].name) !== normalize(name)) {
    showToast(`That number is already on record for ${known[0].name} — no new person was added.`, {
      type: "error",
      duration: 8e3
    });
    await refresh();
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
  // Read the settings *before* opening the wipe transaction below.
  //
  // `getSettings` is not a plain read: a database can hold its settings under a
  // key other than 1, and it migrates such a record to id 1 (see there). Doing
  // that inside the wipe would mean awaiting a second transaction while the first
  // was still open, which is what this function used to do and why it silently
  // half-worked -- two overlapping transactions run in creation order, so the
  // read could not be issued until the wipe had committed, and by the time it
  // returned the wipe's transaction was finished and its `put` threw
  // `InvalidStateError`. The three clears had already committed, so items,
  // borrowers and loans were destroyed while the PIN, theme and lockout state
  // survived, no toast appeared and the admin screens went on listing rows that
  // no longer existed.
  const settings = await getSettings();
  settings.pin = "1234";
  settings.defaultLoanHours = 8;
  settings.theme = "dark";
  settings.lastBackupAt = null;
  settings.pinFailures = 0;
  settings.pinLockedUntil = 0;
  // One transaction, and nothing awaited inside it but its own requests. Going
  // through `runTx` rather than building the transaction by hand is what drops
  // the item and loan caches on commit -- without that, the kiosk went on
  // offering deleted items for up to `ITEMS_CACHE_TTL_MS`, and tapping one
  // produced "Item N not found".
  await runTx([
    "items",
    "borrowers",
    "loans",
    "settings"
  ], "readwrite", async (s) => {
    await s.req(s.get("items").clear());
    await s.req(s.get("borrowers").clear());
    await s.req(s.get("loans").clear());
    await s.req(s.get("settings").put(settings));
  });
  _pinFailures = 0;
  _pinLockedUntil = 0;
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
  //
  // On the document, not the admin screen: the detail screen, the dialogs it
  // opens and the on-screen keyboard are all outside #screen-admin, so typing a
  // long note into "Edit borrower" never counted as activity and the lock fired
  // mid-edit. touchAdminSession ignores anything not on an admin screen.
  const bump = () => touchAdminSession();
  document.addEventListener("pointerdown", bump, { passive: true, capture: true });
  document.addEventListener("keydown", bump, { capture: true });
  document.addEventListener("wheel", bump, { passive: true, capture: true });
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
    // On the web build every record lives in this browser's storage, which a
    // browser may clear on its own when the disk runs low unless the site has
    // asked to keep it. Asking is silent where it is granted outright (an
    // installed or frequently used site), and a no-op inside the Windows host.
    if (navigator.storage && typeof navigator.storage.persist === "function") {
      navigator.storage.persist().catch(() => {
      });
    }
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
      // Three different truths, three different sentences. A rollback is not a
      // partial restore and must not be dressed as one: it means nothing was
      // written, and the backup beside the app is now the only copy.
      const said = recovery.failed
        ? `Database was rebuilt on ${when}, but the records could not be written back — nothing was carried over. Do not enter anything new: the backup file beside the app is the copy to restore from.`
        : recovery.skipped > 0
          ? `Database was rebuilt on ${when} — ${recovery.salvaged} records carried over, ${recovery.skipped} could not be. Check your data, then take a backup.`
          : `Database was rebuilt on ${when} — ${recovery.salvaged} records carried over. Check your data, then take a backup.`;
      showToast(said, {
        type: recovery.failed || recovery.skipped > 0 ? "error" : "info",
        duration: recovery.failed ? 2e4 : 12e3
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
    // The kiosk item step opens blank for whoever is standing there. Four
    // separate routes reach it (a known phone, several phones, a new name, the
    // borrower picker), and the step's own contents are the previous borrower's
    // until something clears them -- see `_resetNeedStep`.
    onEnterHooks.set(KIOSK_SCREENS.borrowNeed, () => _resetNeedStep());
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
      // A tap on the splash skips the wait -- to the kiosk, the same place the
      // timer below goes. It used to go to the staff home screen, which shows
      // names and phone numbers and has no PIN in front of it, and the splash is
      // on screen after every F5, Ctrl+R or crash-reload at the public tablet.
      splash.addEventListener("click", () => {
        if (getCurrentScreen() === "splash") goToScreen("welcome");
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

