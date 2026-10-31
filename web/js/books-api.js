// Covers, blurbs and genres: Google Books first, Open Library when Google is out of quota. Called straight from the
// browser (both allow it). They receive a book title or ISBN per request and nothing else.
import * as store from "./store.js";
import { stripSeries } from "./match.js";
import { net } from "./net.js";

const GOOGLE = "https://www.googleapis.com/books/v1/volumes";
const quota = { google: false };

function volumeToMeta(v) {
  const info = v.volumeInfo || {};
  const ids = Object.fromEntries((info.industryIdentifiers || []).map((i) => [i.type, i.identifier]));
  let thumb = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || null;
  if (thumb) thumb = thumb.replace("http://", "https://").replace("&edge=curl", "");
  return {
    google_id: v.id, title: info.title, authors: info.authors || [], description: info.description || null,
    categories: info.categories || [], thumbnail: thumb, google_rating: info.averageRating ?? null,
    google_ratings_count: info.ratingsCount ?? null, google_pages: info.pageCount ?? null,
    google_published: info.publishedDate || null, isbn13: ids.ISBN_13 || null, source: "google",
  };
}

export async function googleSearch(q, max = 5) {
  const key = store.setting("google_key");
  const params = new URLSearchParams({ q, maxResults: max, printType: "books", ...(key ? { key } : {}) });
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await net(`${GOOGLE}?${params}`, {}, "Book details");
    if (r.status === 429) {
      if ((await r.text()).includes("per day")) { quota.google = true; throw new Error("Google Books' daily quota is used up"); }
      await new Promise((ok) => setTimeout(ok, 4000 * (attempt + 1)));
      continue;
    }
    if (!r.ok) throw new Error(`Google Books ${r.status}`);
    quota.google = false;
    return ((await r.json()).items || []).map(volumeToMeta);
  }
  quota.google = true;
  throw new Error("Google Books is rate-limiting this network");
}

async function openLibrary(title, author, isbn13) {
  const params = new URLSearchParams({ limit: 3, fields: "key,title,author_name,first_publish_year,cover_i,isbn,subject,ratings_average,ratings_count,number_of_pages_median" });
  if (isbn13) params.set("isbn", isbn13);
  else { params.set("title", title); if (author) params.set("author", author.split(/\s+/).pop()); }
  const r = await net(`https://openlibrary.org/search.json?${params}`, {}, "Book details");
  if (!r.ok) return null;
  const docs = (await r.json()).docs || [];
  if (!docs.length) return isbn13 ? openLibrary(title, author, null) : null;
  const d = docs[0];
  let description = null;
  try {
    const w = await net(`https://openlibrary.org${d.key}.json`, {}, "Book details");
    if (w.ok) { const dd = (await w.json()).description; description = typeof dd === "object" ? dd?.value : dd || null; }
  } catch {}
  return {
    google_id: null, title: d.title, authors: d.author_name || [], description, categories: (d.subject || []).slice(0, 6),
    thumbnail: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
    google_rating: d.ratings_average ? Math.round(d.ratings_average * 10) / 10 : null, google_ratings_count: d.ratings_count ?? null,
    google_pages: d.number_of_pages_median ?? null, google_published: d.first_publish_year ? String(d.first_publish_year) : null,
    isbn13: isbn13 || (d.isbn || []).find((i) => i.length === 13) || null, source: "openlibrary",
  };
}

/** ISBN first (exact), then title + author, then bare title; Open Library if Google is unavailable. */
export async function lookup(title, author, isbn13, isbn) {
  const short = stripSeries(title);
  const queries = [isbn13 && `isbn:${isbn13}`, isbn && `isbn:${isbn}`, author && `intitle:"${short}" inauthor:${author.split(";")[0].trim().split(/\s+/).pop()}`, `intitle:"${short}"`].filter(Boolean);
  if (!quota.google) {
    try {
      for (const q of queries) {
        const hits = await googleSearch(q, 5);
        if (!hits.length) continue;
        hits.sort((a, b) => (!!b.description - !!a.description) || (!!b.thumbnail - !!a.thumbnail) || ((b.google_ratings_count || 0) - (a.google_ratings_count || 0)));
        return hits[0];
      }
      return null;
    } catch { /* fall through to Open Library */ }
  }
  try { return await openLibrary(title, author, isbn13); } catch { return null; }
}

export async function enrichBook(b) {
  const meta = await lookup(b.title, b.author, b.isbn13, b.isbn);
  const ts = store.now();
  if (!meta) { Object.assign(b, { enriched_at: ts, enrich_error: "not found" }); await store.put("books", b); return false; }
  Object.assign(b, {
    google_id: meta.google_id, description: meta.description, categories: meta.categories,
    // Amazon covers (from the Kindle import) are sharper than Google's thumbnails
    thumbnail: (b.thumbnail || "").includes("media-amazon.com") ? b.thumbnail : meta.thumbnail || b.thumbnail,
    google_rating: meta.google_rating, google_ratings_count: meta.google_ratings_count, google_pages: meta.google_pages,
    google_published: meta.google_published, isbn13: b.isbn13 || meta.isbn13, author: b.author || meta.authors[0] || null,
    enriched_at: ts, enrich_error: null,
  });
  await store.put("books", b);
  return true;
}

/* background enrichment of everything without details yet; one at a time-ish so Google's per-minute limit holds */
export const progress = { running: false, done: 0, total: 0, failed: 0 };
export async function enrichAll(onTick) {
  if (progress.running) return;
  const todo = store.all("books").filter((b) => !b.enriched_at);
  Object.assign(progress, { running: true, done: 0, total: todo.length, failed: 0 });
  onTick?.();
  try {
    let i = 0;
    const worker = async () => {
      while (i < todo.length && progress.running) {
        const b = todo[i++];
        try { if (!(await enrichBook(b))) progress.failed++; } catch { progress.failed++; }
        progress.done++;
        onTick?.();
        await new Promise((ok) => setTimeout(ok, 600));
      }
    };
    await Promise.all([worker(), worker()]);
  } finally { progress.running = false; onTick?.(); }
}
export const stopEnrich = () => { progress.running = false; };
