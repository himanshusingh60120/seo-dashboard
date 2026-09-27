// lib/idb.ts
"use client";
/**
 * One IndexedDB database for everything the dashboard keeps in the browser.
 * IndexedDB holds hundreds of MB (localStorage stops at ~5 MB), which large sites need.
 *   snapshots: daily index checks (Deindexed pages tab)
 *   kv:        the Indexing tab's URL list and latest results per property
 */
const DB = "seo-dashboard";
const VERSION = 2;
let opening: Promise<IDBDatabase> | null = null;

export function db(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("snapshots")) d.createObjectStore("snapshots", { keyPath: "id" }).createIndex("site", "site");
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { opening = null; reject(req.error); };
    });
  }
  return opening;
}

export function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const r = fn(d.transaction(store, mode).objectStore(store));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      })
  );
}

export const kvGet = <T>(key: string) => tx<T | undefined>("kv", "readonly", (s) => s.get(key));
export const kvSet = (key: string, value: unknown) => tx("kv", "readwrite", (s) => s.put(value, key));
export const kvDel = (key: string) => tx("kv", "readwrite", (s) => s.delete(key));
