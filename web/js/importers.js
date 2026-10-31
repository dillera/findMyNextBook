// Importers. Every file is read and parsed right here in the browser; nothing is uploaded anywhere.
//   Goodreads library export (.csv)   → ratings, shelves, read dates
//   Kindle export (from kindle-export.js, pasted or dropped as a file) → the Kindle ledger → the library
//   Amazon "Your Orders" data export (.zip or .csv) → paper books
import { BookIndex, authorName, cleanTitle, keyOf, sameTitle } from "./match.js";
import * as store from "./store.js";

/* ---------- CSV (RFC 4180: quoted fields, doubled quotes, newlines inside quotes) ---------- */
export function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function csvObjects(text) {
  const [head = [], ...rows] = parseCSV(text);
  const cols = head.map((h) => h.trim());
  return { cols, rows: rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""]))) };
}

/* ---------- Goodreads ---------- */
const clean = (v) => {
  v = (v ?? "").trim();
  if (v.startsWith('="') && v.endsWith('"')) v = v.slice(2, -1); // Goodreads wraps ISBNs to stop Excel mangling them
  return v || null;
};
const int = (v) => { const n = parseInt(clean(v), 10); return Number.isFinite(n) ? n : null; };
const date = (v) => clean(v)?.replaceAll("/", "-") || null;

export function importGoodreads(text) {
  const { cols, rows } = csvObjects(text);
  if (!cols.includes("Book Id")) throw new Error("That isn't a Goodreads library export (no “Book Id” column)");
  const books = store.all("books");
  const byGr = new Map(books.filter((b) => b.goodreads_id).map((b) => [b.goodreads_id, b]));
  // books that came from Amazon (no Goodreads id yet): a Goodreads row for the same book adopts that row
  const orphans = new BookIndex(books.filter((b) => !b.goodreads_id));
  const ts = store.now(), writes = [];
  let inserted = 0, updated = 0, merged = 0;
  for (const r of rows) {
    const g = {
      goodreads_id: int(r["Book Id"]), title: clean(r.Title) || "(untitled)", author: clean(r.Author),
      additional_authors: clean(r["Additional Authors"]), isbn: clean(r.ISBN), isbn13: clean(r.ISBN13),
      my_rating: int(r["My Rating"]) || 0, publisher: clean(r.Publisher), binding: clean(r.Binding),
      pages: int(r["Number of Pages"]), year_published: int(r["Year Published"]), original_year: int(r["Original Publication Year"]),
      date_read: date(r["Date Read"]), date_added: date(r["Date Added"]), shelves: clean(r.Bookshelves),
      exclusive_shelf: clean(r["Exclusive Shelf"]) || "to-read", review: clean(r["My Review"]),
      private_notes: clean(r["Private Notes"]), read_count: int(r["Read Count"]) || 0,
    };
    let b = g.goodreads_id && byGr.get(g.goodreads_id);
    if (!b && g.goodreads_id) {
      b = orphans.find(g.title, g.author, { isbn: g.isbn });
      if (b) { orphans.remove(b); merged++; }
    }
    if (b) {
      // Goodreads wins for its own fields, except where you've edited rating / shelf / date here
      const keep = b.edited ? { my_rating: b.my_rating, exclusive_shelf: b.exclusive_shelf, date_read: b.date_read } : {};
      for (const [k, v] of Object.entries(g)) if (v != null || ["my_rating", "exclusive_shelf", "date_read", "shelves"].includes(k)) b[k] = v;
      Object.assign(b, keep, { updated_at: ts });
      updated++;
    } else {
      b = { ...g, source: "goodreads", created_at: ts, updated_at: ts };
      inserted++;
    }
    if (b.goodreads_id) byGr.set(b.goodreads_id, b);
    writes.push(b);
  }
  return store.putMany("books", writes).then(() => ({ inserted, updated, merged }));
}

/* ---------- Kindle (data produced by kindle-export.js on Amazon's own pages) ---------- */
const SAMPLE = "EBOOK_SAMPLE";

/** Accepts what kindle-export.js copies ({app, kind, items}), or a bare list of library items. */
export function parseKindleExport(text) {
  text = (text || "").replace(/^﻿/, "").trim();
  const start = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start == null || end < start) throw new Error("That doesn't look like the Kindle export. Run the script on Amazon again, then paste.");
  let data = JSON.parse(text.slice(start, end + 1));
  if (Array.isArray(data)) data = { kind: data[0]?.date_read && !data[0]?.title ? "kindle-finished" : "kindle-library", items: data };
  if (data.itemsList) data = { kind: "kindle-library", items: data.itemsList };
  const items = (data.items || []).filter((x) => x && x.asin);
  if (!items.length) throw new Error("No Kindle books in that export");
  if (data.kind === "kindle-finished") return { kind: "finished", items };
  return { kind: "library", items: items.filter((x) => x.title) };
}

/** Kindle library items → the kindle ledger (keyed by ASIN). */
export async function saveKindleLibrary(items) {
  const ts = store.now();
  let added = 0;
  const rows = items.map((it, rank) => {
    const old = store.get("kindle", it.asin);
    if (!old) added++;
    const authors = (it.authors || (it.author ? [it.author] : [])).map(authorName).filter(Boolean);
    return {
      ...old, asin: it.asin, title: cleanTitle(it.title), author: authors.join("; ") || null, cover: it.productUrl || it.cover || null,
      resource_type: it.resourceType || it.resource_type || null, origin: it.originType || it.origin || null, kindle_rank: rank,
      first_seen_at: old?.first_seen_at || ts, book_id: old?.book_id ?? null, read_at: old?.read_at ?? null,
    };
  });
  await store.putMany("kindle", rows);
  await store.setSetting("kindle_last_sync", ts);
  return { fetched: rows.length, added };
}

/** Kindle Reading Insights' finished titles → read dates on the ledger and on linked books that have none. */
export async function saveKindleFinished(items) {
  const latest = new Map();
  for (const t of items) { const d = (t.date_read || "").slice(0, 10); if (d && d > (latest.get(t.asin) || "")) latest.set(t.asin, d); }
  const ledger = [], books = [];
  for (const [asin, d] of latest) {
    const k = store.get("kindle", asin); if (!k) continue;
    k.read_at = d; ledger.push(k);
    const b = k.book_id != null && store.get("books", k.book_id);
    if (b && b.exclusive_shelf === "read" && !b.date_read) { b.date_read = d; books.push(b); }
  }
  await store.putMany("kindle", ledger);
  await store.putMany("books", books);
  await store.setSetting("kindle_finished_sync", store.now());
  return { finished: latest.size, matched: ledger.length, dated: books.length };
}

// an old link (or an ASIN stamped on a book by an earlier, looser matcher) is only trusted when the titles agree
const agree = (a, b) => { const x = keyOf(a.title, a.author), y = keyOf(b.title, b.author); return (!x.sur || !y.sur || x.sur === y.sur) && sameTitle(x, y); };

/** For each ledger item: link (to a book), flip (link + to-read→read), new, or skip (a sample). */
function plan({ include_samples = false, toread_as_read = true } = {}) {
  const idx = new BookIndex(store.all("books"));
  const out = [];
  const ledger = store.all("kindle").sort((a, b) => (a.kindle_rank ?? 1e9) - (b.kindle_rank ?? 1e9));
  for (const r of ledger) {
    if (r.resource_type === SAMPLE && !include_samples) { out.push({ kind: "skip", r }); continue; }
    const linked = r.book_id != null && store.get("books", r.book_id);
    let b = linked || idx.find(r.title, r.author, { asin: r.asin });
    if (b && !b.pending && !agree(r, b)) b = idx.find(r.title, r.author);
    if (b?.pending) out.push({ kind: "edition", r, b }); // another edition of a book this same import adds
    else if (b) out.push({ kind: toread_as_read && b.exclusive_shelf === "to-read" ? "flip" : "link", r, b });
    else {
      // a second edition of the same book later in the list should link to this one, not duplicate it
      const pending = { id: `pending-${r.asin}`, title: r.title, author: r.author, asin: r.asin, exclusive_shelf: "read", pending: r };
      idx.add(pending);
      out.push({ kind: "new", r });
    }
  }
  return out;
}

export function kindlePreview(opts) {
  const p = plan(opts);
  const n = (k) => p.filter((x) => x.kind === k).length;
  const ledger = store.all("kindle");
  return {
    total: p.length, skipped: n("skip"), matched: n("link") + n("flip"), new: n("new"), flip: n("flip"), editions: n("edition"),
    samples: ledger.filter((r) => r.resource_type === SAMPLE).length,
    with_dates: p.filter((x) => x.kind === "new" && x.r.read_at).length,
    new_books: p.filter((x) => x.kind === "new").slice(0, 36).map(({ r }) => ({ title: r.title, author: r.author, cover: r.cover })),
    flip_books: p.filter((x) => x.kind === "flip").slice(0, 20).map(({ b }) => ({ title: b.title, author: b.author })),
  };
}

export async function kindleApply(opts) {
  const p = plan(opts);
  const ts = store.now();
  let added = 0, linked = 0, flipped = 0;
  const books = new Set(), ledger = []; // a Set of objects: a book linked twice is still written once
  for (const b of store.all("books")) if (b.kindle_rank != null) { b.kindle_rank = null; books.add(b); } // ranks shift with every purchase
  const created = new Map(); // asin of the first edition → new book
  for (const { kind, r, b } of p) {
    if (kind === "skip") continue;
    let book;
    if (kind === "new") {
      book = { title: r.title, author: r.author, asin: r.asin, source: "kindle", kindle_rank: r.kindle_rank, exclusive_shelf: "read",
        my_rating: 0, date_read: r.read_at, date_added: ts.slice(0, 10), thumbnail: r.cover, binding: "Kindle Edition", created_at: ts, updated_at: ts };
      created.set(r.asin, book);
      added++;
    } else if (kind === "edition") {
      book = created.get(b.pending.asin);
      linked++;
    } else {
      book = b;
      const owner = book.asin && store.get("kindle", book.asin);
      if (!book.asin || (book.asin !== r.asin && (!owner || !agree(owner, book)))) book.asin = r.asin;
      book.kindle_rank = Math.min(book.kindle_rank ?? Infinity, r.kindle_rank ?? Infinity);
      if (!Number.isFinite(book.kindle_rank)) book.kindle_rank = null;
      // Amazon's covers are sharper than Google's thumbnails
      if (r.cover && !(book.thumbnail || "").includes("media-amazon.com")) book.thumbnail = r.cover;
      if (book.exclusive_shelf === "read" && !book.date_read && r.read_at) book.date_read = r.read_at;
      if (kind === "flip") {
        Object.assign(book, { exclusive_shelf: "read", date_read: book.date_read || r.read_at, edited: true, updated_at: ts });
        flipped++;
      }
      linked++;
    }
    books.add(book);
    ledger.push({ r, book });
  }
  await store.putMany("books", [...books.values()]);
  for (const { r, book } of ledger) r.book_id = book.id;
  await store.putMany("kindle", ledger.map((x) => x.r));
  await store.setSetting("kindle_last_apply", ts);
  return { added, linked, flipped };
}

/* ---------- Amazon order history: paper books ---------- */
// The "Your Orders" export has been renamed over the years (Retail.OrderHistory.1.csv, Order History.csv, the old
// "Items" report), so look for columns, not file names. A physical book's ASIN is its ISBN-10; everything else
// (Kindle books included) has a B0… ASIN.
const ISBN10 = /^\d{9}[\dX]$/;

/** Minimal zip reader: central directory + inflate via the browser's DecompressionStream. Returns [{name, text}] for CSVs. */
async function unzipCSVs(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("That zip file looks damaged");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count && v.getUint32(p, true) === 0x02014b50; n++) {
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.csv$/i.test(name)) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = u8.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    else continue;
    out.push({ name, text: new TextDecoder().decode(bytes) });
  }
  return out;
}

export async function parseOrders(file) {
  const buf = await file.arrayBuffer();
  const isZip = new DataView(buf).byteLength > 4 && new DataView(buf).getUint32(0, true) === 0x04034b50;
  const texts = isZip ? (await unzipCSVs(buf)).map((f) => f.text) : [new TextDecoder().decode(buf)];
  const books = new Map();
  let seen = 0;
  for (const text of texts) {
    const { cols, rows } = csvObjects(text);
    const lc = Object.fromEntries(cols.map((c) => [c.toLowerCase(), c]));
    const col = (...names) => names.map((n) => lc[n]).find(Boolean);
    const acol = col("asin", "asin/isbn", "isbn"), tcol = col("product name", "title", "productname", "item title");
    if (!acol || !tcol) continue;
    const dcol = col("order date", "orderdate", "order_date"), scol = col("order status", "shipment status");
    for (const r of rows) {
      seen++;
      const asin = (r[acol] || "").trim().toUpperCase();
      if (!ISBN10.test(asin) || (scol && /cancel/i.test(r[scol] || ""))) continue;
      const title = cleanTitle(r[tcol]);
      if (!title) continue;
      const d = dcol ? (r[dcol] || "").slice(0, 10) || null : null;
      if (!books.has(asin) || (d && d < (books.get(asin).date || "9999"))) books.set(asin, { isbn: asin, title, date: d });
    }
  }
  return { books: [...books.values()], rows: seen };
}

export async function importOrders(file) {
  const { books: found, rows } = await parseOrders(file);
  const idx = new BookIndex(store.all("books"));
  const ts = store.now(), writes = [];
  let added = 0, matched = 0;
  for (const o of found) {
    const hit = idx.find(o.title, null, { isbn: o.isbn });
    if (hit) { matched++; if (!hit.isbn && hit.id != null) { hit.isbn = o.isbn; writes.push(hit); } continue; }
    // like Kindle books: bought on Amazon counts as read. No author in order history; book details fill it in.
    const b = { title: o.title, isbn: o.isbn, source: "amazon-print", exclusive_shelf: "read", my_rating: 0,
      date_added: o.date || ts.slice(0, 10), binding: "Print", created_at: ts, updated_at: ts };
    idx.add(b); writes.push(b); added++;
  }
  await store.putMany("books", writes);
  return { found: found.length, added, matched, rows };
}

/* ---------- a book added by hand or from a recommendation ---------- */
export async function addBook(b, shelf) {
  const dup = new BookIndex(store.all("books")).find(b.title, b.author, { asin: b.asin });
  if (dup) return { book: dup, existed: true };
  const ts = store.now();
  const book = await store.put("books", {
    title: b.title, author: b.author || null, isbn13: b.isbn13 || null, exclusive_shelf: shelf, my_rating: 0,
    description: b.description || null, thumbnail: b.thumbnail || null, categories: b.categories || [],
    original_year: b.year || null, pages: b.pages || null, google_rating: b.google_rating || null, google_id: b.google_id || null,
    enriched_at: b.google_id ? ts : null, asin: b.asin || null, source: b.source || "manual", date_added: ts.slice(0, 10),
    date_read: shelf === "read" ? ts.slice(0, 10) : null, binding: "Kindle Edition", edited: true, created_at: ts, updated_at: ts,
  });
  return { book, existed: false };
}
