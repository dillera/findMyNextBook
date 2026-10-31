// Everything the app knows lives here, in this browser's IndexedDB. Nothing is ever sent to the server that hosts
// these files. The whole database is also mirrored in memory (a library is a few thousand rows at most), so reads are
// plain array work and every write goes to both.
//
// Stores: books (the library), kindle (one row per Kindle item, keyed by ASIN), runs (recommendation runs, picks
// inside), settings (key/value: preferences and the user's own API keys).

const DB_NAME = "findMyNextBook";
const VERSION = 1;
const STORES = {
  books: { keyPath: "id", autoIncrement: true },
  kindle: { keyPath: "asin" },
  runs: { keyPath: "id", autoIncrement: true },
  settings: { keyPath: "key" },
};
// never written to a backup file: they're credentials, not library data
const SECRET_SETTINGS = new Set(["openrouter_key", "google_key", "or_key_label"]);

let db;
export const mem = { books: new Map(), kindle: new Map(), runs: new Map(), settings: new Map() };

const req = (r) => new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
const done = (tx) => new Promise((ok, fail) => { tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => fail(tx.error); });

export async function open() {
  db = await new Promise((ok, fail) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      for (const [name, opts] of Object.entries(STORES)) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name, opts);
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
    r.onblocked = () => fail(new Error("Close other findMyNextBook tabs and reload"));
  });
  for (const name of Object.keys(STORES)) {
    const rows = await req(db.transaction(name).objectStore(name).getAll());
    const key = STORES[name].keyPath;
    mem[name] = new Map(rows.map((r) => [r[key], r]));
  }
  // ask the browser not to evict the library under storage pressure (granted silently in most browsers)
  navigator.storage?.persist?.().catch(() => {});
}

export const all = (store) => [...mem[store].values()];
export const get = (store, key) => mem[store].get(key);

export async function putMany(store, objs) {
  if (!objs.length) return objs;
  const tx = db.transaction(store, "readwrite");
  const os = tx.objectStore(store);
  const key = STORES[store].keyPath;
  for (const o of objs) {
    if (o[key] == null && STORES[store].autoIncrement) delete o[key];
    os.put(o).onsuccess = (e) => { o[key] = e.target.result; mem[store].set(o[key], o); };
  }
  await done(tx);
  return objs;
}
export const put = async (store, obj) => (await putMany(store, [obj]))[0];

export async function del(store, key) {
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await done(tx);
  mem[store].delete(key);
}

export const setting = (key, dflt = null) => mem.settings.get(key)?.value ?? dflt;
export const setSetting = (key, value) => put("settings", { key, value });
export const delSetting = (key) => del("settings", key);

export const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

/* ---------- backup / restore / wipe: files the user saves and opens themselves ---------- */
export function backup() {
  return {
    app: "findMyNextBook", version: 1, exported_at: now(),
    books: all("books"), kindle: all("kindle"), runs: all("runs"),
    settings: all("settings").filter((s) => !SECRET_SETTINGS.has(s.key)),
  };
}

export async function restore(data) {
  if (data?.app !== "findMyNextBook" || !Array.isArray(data.books)) throw new Error("That isn't a findMyNextBook backup file");
  const keep = all("settings").filter((s) => SECRET_SETTINGS.has(s.key)); // a restore doesn't sign you out
  const tx = db.transaction(Object.keys(STORES), "readwrite");
  for (const name of Object.keys(STORES)) tx.objectStore(name).clear();
  for (const name of ["books", "kindle", "runs"]) for (const row of data[name] || []) tx.objectStore(name).put(row);
  for (const s of [...(data.settings || []).filter((s) => !SECRET_SETTINGS.has(s.key)), ...keep]) tx.objectStore("settings").put(s);
  await done(tx);
  await open();
  return { books: mem.books.size, kindle: mem.kindle.size, runs: mem.runs.size };
}

export async function wipe() {
  db?.close();
  await new Promise((ok, fail) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = ok; r.onerror = () => fail(r.error); r.onblocked = ok; });
  try { localStorage.clear(); sessionStorage.clear(); } catch {}
}
