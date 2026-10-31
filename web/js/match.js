// Title/author normalisation and matching, shared by the importers and the recommender.
// Amazon, Goodreads and the LLM each spell the same book differently ("Children of Ruin (Children of Time Book 2)",
// "Children of Ruin", "Gone-Away World, The"; "Tchaikovsky, Adrian" vs "Adrian Tchaikovsky"), so books are compared
// as (normalised title, author surname).

/** 'Dark Diamond (A Time's Shadow #1)' -> 'Dark Diamond' */
export const stripSeries = (t) =>
  (t || "").replace(/\s*\((?:[^()]*#\d+[^()]*|[^()]*(?:Book|Trilogy|Series)[^()]*)\)\s*$/i, "").trim();

/** Amazon titles carry marketing suffixes: "Foo: A Novel (Bar Series Book 2) (English Edition)" */
export function cleanTitle(t) {
  t = (t || "").replace(/\s*\((?:[^()]*(?:Book|Series|Edition|Trilogy|Saga|Novel)[^()]*)\)/gi, "");
  t = t.replace(/\s*\[[^\]]*\]/g, "").trim();
  t = t.replace(/:\s*(?:a|an)\s+(?:novel|thriller|memoir)\s*$/i, "");
  return t.replace(/^[\s:-]+|[\s:-]+$/g, "");
}

const fold = (t) => stripSeries(t || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
const tidy = (t) => t.replace(/^(the|a|an)\s+/, "").replace(/,\s*(the|a|an)\s*$/, "").replace(/[^a-z0-9]+/g, " ").trim();

/** The main title, without subtitle: "Exodus: The Archimedes Engine" -> "exodus". Used for grouping and lookup. */
export const normTitle = (t) => tidy(fold(t).split(/[:(]| - /)[0]);

/** {main, sub, full}: main title, subtitle ("" if none) and the two together, all normalised. */
export function titleKeys(t) {
  const [main, ...rest] = fold(t).split(/[:(]| - /);
  const sub = tidy(rest.join(" "));
  return { main: tidy(main), sub, full: tidy([main, sub].join(" ")) };
}

/** 'Peter Watts' -> 'watts'; Amazon's 'Watts, Peter' -> 'watts'; 'Pitre, Boisy G; Loguidice, Bill' -> 'pitre' */
export function surname(a) {
  a = (a || "").split(";")[0].trim();
  if (!a) return "";
  if (a.includes(",")) return a.split(",")[0].trim().toLowerCase();
  return a.split(/\s+/).pop().toLowerCase();
}

/** Amazon's 'Salinger, J. D.:' -> 'J. D. Salinger' */
export function authorName(raw) {
  const a = (raw || "").trim().replace(/:+$/, "").trim();
  const parts = a.split(",");
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) return `${parts[1].trim()} ${parts[0].trim()}`;
  return a || null;
}

// difflib.SequenceMatcher.ratio(): 2·M / T, M = characters in the matching blocks (Ratcliff/Obershelp)
function longestMatch(a, b) {
  let best = 0, ia = 0, ib = 0;
  let prev = new Uint16Array(b.length + 1), cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
      if (cur[j] > best) { best = cur[j]; ia = i - best; ib = j - best; }
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return [ia, ib, best];
}
function matched(a, b) {
  if (!a.length || !b.length) return 0;
  const [i, j, k] = longestMatch(a, b);
  return k ? k + matched(a.slice(0, i), b.slice(0, j)) + matched(a.slice(i + k), b.slice(j + k)) : 0;
}
export const ratio = (a, b) => (a.length + b.length ? (2 * matched(a, b)) / (a.length + b.length) : 1);

const NUMS = /\b(\d+|i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)\b/g;
const numbers = (s) => (s.match(NUMS) || []).sort().join(" ");
// "Wool Omnibus Edition" is "Wool Omnibus"; "Foundation and Empire" is not "Foundation"
const EDITION_TAIL = /^(omnibus|edition|complete|collection|box(ed)? set|the complete|special edition|anniversary edition|unabridged|and other stories)\b/;

/** Are two titles (by authors already known to be compatible) the same book? a, b are titleKeys(). */
export function sameTitle(a, b) {
  if (!a.main || !b.main) return false;
  if (a.full === b.full) return true;
  // a marketing subtitle on one side only: "Children of Time: Winner of the 2016 Arthur C. Clarke Award"
  if (a.main === b.main && (!a.sub || !b.sub)) return true;
  // Part I vs Part II, Book 2 vs Book 3: never the same book
  if (numbers(a.full) !== numbers(b.full)) return false;
  // both have subtitles: they must agree too ("Exodus: The Archimedes Engine" ≠ "Exodus: The Helium Sea"), where
  // agreeing includes one extending the other: "…Computer Revolution" / "…Computer Revolution - 25th Anniversary
  // Edition", "The Commodore Amiga" / "The Commodore Amiga (Platform Studies)", "Part 1" / "A Silo Story (Part 1)"
  if (a.main === b.main) {
    const [s, l] = a.sub.length <= b.sub.length ? [a.sub, b.sub] : [b.sub, a.sub];
    return (s.length >= 5 && (l.startsWith(s + " ") || l.endsWith(" " + s))) || ratio(a.sub, b.sub) >= 0.85;
  }
  const [short, long] = a.full.length <= b.full.length ? [a.full, b.full] : [b.full, a.full];
  if (short.length >= 8 && long.startsWith(short + " ") && EDITION_TAIL.test(long.slice(short.length + 1))) return true;
  return ratio(a.full, b.full) >= 0.9; // spelling: "Grand Thieves & Tomb Raiders … Video Games" vs "… Videogames"
}

const authorsAgree = (sa, sb) => !sa || !sb || sa === sb;
export const keyOf = (title, author) => ({ ...titleKeys(title), sur: surname(author) });

/** known = [keyOf(…), …]. Returns the matching known title key, or null. */
export function isKnown(title, author, known) {
  const k = keyOf(title, author);
  if (!k.main) return null;
  for (const x of known) {
    if (k.full === x.full) return x.full;
    if (authorsAgree(k.sur, x.sur) && sameTitle(k, x)) return x.full;
  }
  return null;
}

/** Every book, indexed for matching an incoming Kindle / Goodreads / order-history item to one already there.
 *  ASIN and ISBN are exact; otherwise the same title (see sameTitle) by a compatible author. */
export class BookIndex {
  constructor(books) {
    this.byId = new Map(); this.byAsin = new Map(); this.byIsbn = new Map();
    this.byMain = new Map(); this.bySurname = new Map();
    for (const b of books) this.add(b);
  }
  add(b) {
    const e = { book: b, ...keyOf(b.title, b.author) };
    this.byId.set(b.id, e);
    if (b.asin && !this.byAsin.has(b.asin)) this.byAsin.set(b.asin, e);
    if (b.isbn && !this.byIsbn.has(b.isbn.toUpperCase())) this.byIsbn.set(b.isbn.toUpperCase(), e);
    if (e.main) {
      (this.byMain.get(e.main) || this.byMain.set(e.main, []).get(e.main)).push(e);
      (this.bySurname.get(e.sur) || this.bySurname.set(e.sur, []).get(e.sur)).push(e);
    }
    return e;
  }
  remove(b) {
    const e = this.byId.get(b.id); if (!e) return;
    this.byId.delete(b.id);
    if (this.byAsin.get(b.asin) === e) this.byAsin.delete(b.asin);
    if (b.isbn && this.byIsbn.get(b.isbn.toUpperCase()) === e) this.byIsbn.delete(b.isbn.toUpperCase());
    for (const m of [this.byMain.get(e.main), this.bySurname.get(e.sur)]) if (m) { const i = m.indexOf(e); if (i >= 0) m.splice(i, 1); }
  }
  find(title, author = null, { asin = null, isbn = null } = {}) {
    if (asin && this.byAsin.has(asin)) return this.byAsin.get(asin).book;
    if (isbn && this.byIsbn.has(isbn.toUpperCase())) return this.byIsbn.get(isbn.toUpperCase()).book;
    const k = keyOf(title, author);
    if (!k.main) return null;
    const same = this.byMain.get(k.main) || [];
    if (!k.sur) { // title-only items (order history has no author): no fuzzy matching, too risky
      const e = same.find((e) => e.full === k.full || !e.sub || !k.sub);
      return e ? e.book : null;
    }
    for (const e of same) if (authorsAgree(k.sur, e.sur) && sameTitle(k, e)) return e.book;
    for (const e of this.bySurname.get(k.sur) || []) if (e.main !== k.main && sameTitle(k, e)) return e.book;
    return null;
  }
}

/* ---------- authors and series, for the author page ---------- */

/** One key per person however the name is written: "Watts, Peter" = "Peter Watts", "J.R.R. Tolkien" = "J. R. R. Tolkien". */
export function authorKey(name) {
  let a = (name || "").trim().replace(/:+$/, "");
  const parts = a.split(",");
  if (parts.length === 2 && parts[1].trim() && !/^\s*(jr|sr|ii|iii|iv)\.?\s*$/i.test(parts[1])) a = `${parts[1]} ${parts[0]}`;
  const toks = a.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  const out = [];
  let initials = false; // run initials together, so "j r r" and "jrr" agree
  for (const t of toks) {
    if (t.length === 1 && initials) out[out.length - 1] += t;
    else out.push(t);
    initials = t.length === 1 || (initials && t.length === 1);
  }
  return out.join(" ");
}

/** Everyone credited on a book: the author field (Kindle separates several with ";") and Goodreads' additional authors. */
export function bookAuthors(b) {
  const names = (b.author || "").split(";").concat((b.additional_authors || "").split(/,(?![^,]*,)|;/).filter((x) => x.trim()))
    .map((n) => authorName(n.trim())).filter(Boolean);
  const seen = new Set();
  return names.map((name) => ({ name, key: authorKey(name) })).filter((a) => a.key && !seen.has(a.key) && seen.add(a.key));
}

const NUMWORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const SERIES_WORDS = /\s+(series|trilogy|duology|saga|sequence|cycle|chronicles|novels|books|universe|collection)$/;
/** "Children of Time" / "The Children of Time Series" → the same key */
export const seriesKey = (name) => {
  let k = (name || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/^the\s+/, "");
  while (SERIES_WORDS.test(k)) k = k.replace(SERIES_WORDS, "");
  return k;
};

/** The series a title names, if any:
 *   Goodreads  "Children of Ruin (Children of Time, #2)", "The Expanse Box Set (The Expanse, #1-3)"
 *   Amazon     "Children of Ruin (Children of Time Book 2)", "Wool (Silo, Book 1)", "(Book 2 of the Foo Series)"
 *  → {name, key, num, label}, or null. num is for sorting; label is what to show ("2", "1–3", "0.5"). */
export function seriesOf(title) {
  const groups = [...(title || "").matchAll(/\(([^()]+)\)/g)].map((m) => m[1]).reverse();
  for (const g of groups) {
    const seg = g.split(";")[0].trim();
    // the first "Name #N" in the group: "Agent Cormac #1, Polity Universe #3" is Agent Cormac #1
    let m = seg.match(/^\s*([^#;]+?)\s*,?\s*#\s*(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?(?=\s*(?:,|$))/);
    if (!m) m = seg.match(/^(.+?)[,:]?\s+(?:Book|Volume|Vol\.?|Part|Novel)\s+(\d+(?:\.\d+)?|[a-z]+)(?:\s*[-–]\s*(\d+))?(?:\s+of\s+\d+)?$/i);
    if (!m) { const r = seg.match(/^(?:Book|Volume|Part)\s+(\d+|[a-z]+)\s+of\s+(?:the\s+)?(.+?)$/i); if (r) m = [r[0], r[2], r[1]]; }
    // "Orbus (Spatterjay 3)": a bare number after a name, but not "(Anniversary Edition 2)" or "(Paperback 2)"
    if (!m) { const r = seg.match(/^([A-Za-z][^\d]*?[A-Za-z])\s+(\d{1,2})$/); if (r && !/edition|paperback|hardcover|kindle|print|reprint|volume set/i.test(r[1])) m = [r[0], r[1], r[2]]; }
    if (!m) continue;
    const num = /^\d/.test(m[2]) ? +m[2] : NUMWORD[m[2].toLowerCase()];
    if (num == null || !Number.isFinite(num)) continue;
    const name = m[1].trim().replace(/[,:]$/, "");
    const key = seriesKey(name);
    if (!key) continue;
    return { name, key, num, label: m[3] ? `${m[2]}–${m[3]}` : String(m[2]).replace(/^0+(?=\d)/, "") };
  }
  return null;
}

export const knownSet = (books, kindle) => {
  const seen = new Set(), out = [];
  for (const b of [...books, ...kindle]) {
    const k = keyOf(b.title, b.author), id = k.full + "|" + k.sur;
    if (k.main && !seen.has(id)) { seen.add(id); out.push(k); }
  }
  return out;
};
