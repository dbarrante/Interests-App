"use strict";

// Thin promise wrapper around IndexedDB. Schema mirrors core/db.js's SQLite tables
// closely enough that the sync/merge logic (Phase 3) can treat this as a drop-in
// peer store: cards, saved, kv, fp, tombstones, plus an images blob store that
// SQLite doesn't have (desktop keeps images as loose files instead).

const DB_NAME = "interests-app-pwa";
const DB_VERSION = 3;
const STORES = ["cards", "saved", "kv", "fp", "tombstones", "images", "recovery"];

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    console.log("idb: opening", DB_NAME, "v" + DB_VERSION);
    const watchdog = setTimeout(() => {
      console.error("idb: indexedDB.open() has not fired ANY event (success/error/blocked/upgradeneeded) after 5s — the browser's IndexedDB is stuck. Try DevTools > Application > Storage > 'Clear site data', then reload.");
    }, 5000);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      console.log("idb: upgradeneeded, oldVersion=" + event.oldVersion);
      const db = req.result;
      if (!db.objectStoreNames.contains("cards")) db.createObjectStore("cards", { keyPath: "id" });
      if (!db.objectStoreNames.contains("saved")) db.createObjectStore("saved", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "key" });
      if (!db.objectStoreNames.contains("fp")) db.createObjectStore("fp", { keyPath: "id" });
      if (!db.objectStoreNames.contains("images")) db.createObjectStore("images", { keyPath: "id" });
      // v2: tombstones need a composite (kind, id) identity — a card and a saved
      // item can share the same id. v1 shipped this store keyed on bare "id" but
      // never actually wrote to it (Phase 2 didn't touch tombstones), so dropping
      // and recreating on upgrade loses nothing.
      if (event.oldVersion < 2 && db.objectStoreNames.contains("tombstones")) {
        db.deleteObjectStore("tombstones");
      }
      if (!db.objectStoreNames.contains("tombstones")) db.createObjectStore("tombstones", { keyPath: "key" });
      if (!db.objectStoreNames.contains("recovery")) db.createObjectStore("recovery", { keyPath: "key" });
    };
    // A version bump (like v1->v2 here) hangs indefinitely — no error, no
    // resolve — if another tab still holds an open connection at the old
    // version. Two-part fix: (1) any connection THIS tab successfully opens
    // closes itself the moment a newer version wants in, so switching tabs
    // self-heals; (2) if we're still the one being blocked, fail loudly
    // instead of hanging forever with zero feedback.
    req.onsuccess = () => {
      clearTimeout(watchdog);
      console.log("idb: open succeeded");
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => { clearTimeout(watchdog); reject(req.error); };
    req.onblocked = () => {
      clearTimeout(watchdog);
      reject(new Error(
        "IndexedDB upgrade blocked — another tab of this app is still open with an older version. Close every other localhost:8080 tab, then reload this page."
      ));
    };
  });
  return _dbPromise;
}

function tx(storeName, mode) {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const idb = {
  getAll(storeName) {
    return tx(storeName, "readonly").then((s) => reqToPromise(s.getAll()));
  },
  get(storeName, key) {
    return tx(storeName, "readonly").then((s) => reqToPromise(s.get(key)));
  },
  put(storeName, value) {
    return tx(storeName, "readwrite").then((s) => reqToPromise(s.put(value)));
  },
  putMany(storeName, values) {
    return tx(storeName, "readwrite").then((s) => {
      values.forEach((v) => s.put(v));
      return new Promise((resolve, reject) => {
        s.transaction.oncomplete = () => resolve();
        s.transaction.onerror = () => reject(s.transaction.error);
        s.transaction.onabort = () => reject(s.transaction.error || new Error("IndexedDB write aborted"));
      });
    });
  },
  putAcross(storeValues) {
    const names = Object.keys(storeValues || {}).filter((name) => (storeValues[name] || []).length);
    if (!names.length) return Promise.resolve();
    return openDb().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(names, "readwrite");
      names.forEach((name) => (storeValues[name] || []).forEach((value) => transaction.objectStore(name).put(value)));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB multi-store write aborted"));
    }));
  },
  markNotDuplicates(entries) {
    const requested = Array.isArray(entries) ? entries : [];
    return openDb().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(["cards", "saved"], "readwrite");
      let changed = 0, failure = null;
      requested.forEach((entry) => {
        const store = transaction.objectStore(entry.scope === "saved" ? "saved" : "cards");
        const request = store.get(String(entry.id));
        request.onsuccess = () => {
          const item = request.result;
          if (!item) { failure = new Error("A duplicate card changed before the choice could be saved."); transaction.abort(); return; }
          const prior = Array.isArray(item.dupeNotDuplicateGroups) ? item.dupeNotDuplicateGroups.filter((v) => typeof v === "string") : [];
          if (prior.indexOf(entry.key) >= 0) return;
          item.dupeNotDuplicateGroups = prior.slice(-49).concat([entry.key]);
          item.updatedAt = Date.now(); changed++;
          store.put(item);
        };
        request.onerror = () => { failure = request.error; transaction.abort(); };
      });
      transaction.oncomplete = () => resolve({ ok:true, changed });
      transaction.onerror = () => { failure = failure || transaction.error; };
      transaction.onabort = () => reject(failure || transaction.error || new Error("IndexedDB duplicate decision aborted"));
    }));
  },
  // Full-array replacement must be one transaction. A clear followed by a
  // separate putMany can strand the store empty if the browser suspends or the
  // second transaction fails between those two operations.
  replaceAll(storeName, values) {
    return tx(storeName, "readwrite").then((s) => {
      s.clear();
      values.forEach((v) => s.put(v));
      return new Promise((resolve, reject) => {
        s.transaction.oncomplete = () => resolve();
        s.transaction.onerror = () => reject(s.transaction.error);
        s.transaction.onabort = () => reject(s.transaction.error || new Error("IndexedDB replacement aborted"));
      });
    });
  },
  delete(storeName, key) {
    return tx(storeName, "readwrite").then((s) => reqToPromise(s.delete(key)));
  },
  deleteMany(storeName, keys) {
    return tx(storeName, "readwrite").then((s) => {
      keys.forEach((k) => s.delete(k));
      return new Promise((resolve, reject) => {
        s.transaction.oncomplete = () => resolve();
        s.transaction.onerror = () => reject(s.transaction.error);
      });
    });
  },
  clear(storeName) {
    return tx(storeName, "readwrite").then((s) => reqToPromise(s.clear()));
  },
  // Replace several stores in one IndexedDB transaction. The PWA recovery
  // journal uses this for rollback so cards/settings/images cannot be restored
  // piecemeal across separate transactions.
  replaceStores(snapshot) {
    const names = ["cards", "saved", "kv", "fp", "tombstones", "images"];
    return openDb().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(names, "readwrite");
      try {
        names.forEach((name) => {
          const store = transaction.objectStore(name);
          store.clear();
          (snapshot[name] || []).forEach((value) => store.put(value));
        });
      } catch (e) {
        try { transaction.abort(); } catch (_) {}
        reject(e);
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB recovery transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB recovery transaction aborted"));
    }));
  },

  // kv convenience wrappers, factored out here (rather than left as Store-only
  // logic) so both storage-pwa.js (the UI-facing Store) and sync-pwa.js (which
  // must NOT depend on Store — see sync-pwa.js header) can read/write kv without
  // a circular module dependency between the two.
  kvGet(key) {
    return this.get("kv", key).then((row) => {
      if (!row || row.value == null) return null;
      try { return JSON.parse(row.value); } catch (e) { return row.value; }
    });
  },
  kvSet(key, val) {
    return this.put("kv", { key, value: JSON.stringify(val) }).then(() => {});
  },

  // Mirrors core/db.js's addTombstone: always keeps the NEWEST deletedAt for a
  // given (kind,id) rather than overwriting with whatever's passed in — a replayed
  // older delete (e.g. from a re-processed merge) must never regress a tombstone.
  addTombstone(kind, id, deletedAt) {
    const ts = (deletedAt != null && isFinite(deletedAt)) ? Math.trunc(Number(deletedAt)) : Date.now();
    const key = kind + ":" + id;
    return this.get("tombstones", key).then((existing) => {
      const newest = existing ? Math.max(existing.deletedAt, ts) : ts;
      return this.put("tombstones", { key, id, kind, deletedAt: newest });
    });
  },
};

window.IA_IDB = idb;
