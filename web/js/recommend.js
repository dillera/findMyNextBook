// Build a reading profile from the library and ask an LLM (OpenRouter, the visitor's own key) what to read next.
// The profile is built here in the browser and sent only to openrouter.ai.
import * as store from "./store.js";
import { isKnown, keyOf, knownSet, stripSeries } from "./match.js";
import { lookup } from "./books-api.js";
import { chat } from "./llm.js";

export const kindleSearch = (t, a) => `https://www.amazon.com/s?k=${encodeURIComponent(`${t} ${a || ""}`.trim())}&i=digital-text`;

const ws = (s) => (s || "").replace(/\s+/g, " ").trim();
const line = (b) => { const yr = b.original_year || b.year_published; return `${ws(b.title)} — ${ws(b.author)}` + (yr ? ` (${yr})` : ""); };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const cats = (b) => (b.categories || []).map((c) => cap(ws(c)));
const fmt = (r) => r.title + (r.author ? ` — ${r.author}` : "");
function ageYears(b) {
  const d = b.date_read || b.date_added;
  const t = d ? Date.parse(d.slice(0, 10)) : NaN;
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / (365.25 * 864e5)) : null;
}

function feedback() {
  const recs = store.all("runs").sort((a, b) => b.id - a.id).flatMap((r) => r.recs || []).filter((r) => r.status !== "new");
  return {
    rejected: recs.filter((r) => r.status === "dismissed").slice(0, 40).map((r) => `${r.title} — ${r.author}`),
    accepted: recs.filter((r) => ["bought", "added"].includes(r.status)).slice(0, 40).map((r) => `${r.title} — ${r.author}`),
  };
}

/** Every title already read/shelved/owned, grouped by author so ~1,000 titles stay compact. Subtitles are kept only
 *  where they tell books apart ("Exodus: The Archimedes Engine; Exodus: The Helium Sea"). */
function dedupBlock(books, kindle) {
  const byAuthor = new Map(), seen = new Set();
  for (const { title, author } of [...books, ...kindle]) {
    const k = keyOf(title, author), id = k.full + "|" + k.sur;
    if (!k.main || seen.has(id)) continue;
    seen.add(id);
    let name = ws((author || "").split(";")[0]) || "(unknown)";
    if (name.includes(",")) { const [last, first] = name.split(",", 2).map((x) => x.trim()); name = `${first} ${last}`.trim(); }
    const [main, ...rest] = stripSeries(title).split(/:| - /);
    if (!byAuthor.has(name)) byAuthor.set(name, new Map());
    const mains = byAuthor.get(name), m = main.trim();
    (mains.get(m) || mains.set(m, new Set()).get(m)).add(rest.join(":").trim());
  }
  const last = (a) => a.split(" ").pop().toLowerCase();
  return [...byAuthor].sort((a, b) => last(a[0]).localeCompare(last(b[0]))).map(([a, mains]) => `${a}: ` + [...mains]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .flatMap(([m, subs]) => (subs.size > 1 && !subs.has("") ? [...subs].map((sub) => `${m}: ${sub}`) : [m])).join("; "));
}

// The distilled profile: ranked taste signals instead of a 400-title dump.
//   · signature books: 5★ reads ranked by recency + how far the reader out-rated the crowd, max 2 per author
//   · author record, anti-signal (1–2★ and crowd-loved-but-not-them), genre lift vs. their own mean
//   · trajectory, recent Kindle purchases, read-but-unrated Kindle books, past rec feedback
//   · a compact dedup list, marked as NOT a taste signal
export function buildProfile() {
  const books = store.all("books"), kindle = store.all("kindle");
  const read = books.filter((b) => b.exclusive_shelf === "read");
  const rated = read.filter((b) => b.my_rating);
  const mean = rated.length ? rated.reduce((s, b) => s + b.my_rating, 0) / rated.length : 3;
  const dist = Object.fromEntries([1, 2, 3, 4, 5].map((s) => [s, rated.filter((b) => b.my_rating === s).length]));

  const score = (b) => {
    let s = 1;
    const age = ageYears(b);
    s += 0.5 ** ((age ?? 8) / 4); // half-life of 4 years
    if (b.google_rating) s += Math.max(-0.5, Math.min(0.75, (b.my_rating - b.google_rating - 1) / 2));
    return s;
  };
  const pick = (pool, limit, perAuthor = 2) => {
    const out = [], per = new Map();
    for (const b of [...pool].sort((a, c) => score(c) - score(a))) {
      if ((per.get(b.author) || 0) < perAuthor) { out.push(b); per.set(b.author, (per.get(b.author) || 0) + 1); }
      if (out.length >= limit) break;
    }
    return out;
  };
  const rich = (b) => {
    const bits = [line(b)];
    const c = cats(b).filter((x) => x !== "Fiction").slice(0, 2);
    if (c.length) bits.push(c.join("/"));
    if (b.google_rating) bits.push(`crowd ${b.google_rating.toFixed(1)}★ → theirs ${b.my_rating}★`);
    if (b.date_read) bits.push(`read ${b.date_read.slice(0, 4)}`);
    return bits.join(" · ");
  };

  let signature = pick(rated.filter((b) => b.my_rating === 5), 30);
  if (signature.length < 30) signature = signature.concat(pick(rated.filter((b) => b.my_rating === 4), 30 - signature.length, 1));

  const byAuthor = new Map();
  for (const b of rated) { const a = ws(b.author); if (!byAuthor.has(a)) byAuthor.set(a, []); byAuthor.get(a).push(b); }
  const avg = (bs) => bs.reduce((s, x) => s + x.my_rating, 0) / bs.length;
  const authors = [...byAuthor].filter(([, bs]) => bs.length >= 2).sort((a, b) => b[1].length * avg(b[1]) - a[1].length * avg(a[1]))
    .slice(0, 35).map(([a, bs]) => {
      const best = [...bs].sort((x, y) => y.my_rating - x.my_rating || score(y) - score(x))[0];
      const worst = [...bs].sort((x, y) => x.my_rating - y.my_rating || score(y) - score(x))[0];
      let tail = ` — best: ${best.title} (${best.my_rating}★)`;
      if (worst.my_rating < best.my_rating) tail += `, weakest: ${worst.title} (${worst.my_rating}★)`;
      return `${a}: ${bs.length} rated, avg ${avg(bs).toFixed(1)}★${tail}`;
    });

  const anti = rated.filter((b) => b.my_rating <= 2 || (b.my_rating <= 3 && b.google_rating && b.google_rating - b.my_rating >= 1))
    .sort((a, b) => a.my_rating - b.my_rating).slice(0, 20).map((b) => rich(b) + (b.google_rating ? "" : ` · theirs ${b.my_rating}★`));

  const cat = new Map();
  for (const b of rated) for (const c of cats(b)) { if (!cat.has(c)) cat.set(c, []); cat.get(c).push(b.my_rating); }
  const lifts = [...cat].filter(([c, r]) => r.length >= 4 && c !== "Fiction")
    .map(([c, r]) => [c, r.length, r.reduce((s, x) => s + x, 0) / r.length - mean]).sort((a, b) => b[2] - a[2]);
  const lift = ([c, n, d]) => `${c}: ${n} rated, ${d >= 0 ? "+" : ""}${d.toFixed(2)}★ vs their mean`;
  const genre = lifts.slice(0, 10).map(lift).concat(lifts.length > 10 ? lifts.slice(-5).filter((l) => l[2] < 0).map(lift) : []);

  const recent = read.filter((b) => b.date_read).sort((a, b) => b.date_read.localeCompare(a.date_read)).slice(0, 15)
    .map((b) => `${line(b)} [${b.my_rating || "-"}★, ${b.date_read.slice(0, 10)}]`);
  const ledger = kindle.filter((k) => k.kindle_rank != null && k.resource_type !== "EBOOK_SAMPLE").sort((a, b) => a.kindle_rank - b.kindle_rank);
  // Amazon reports no reading progress, so every Kindle purchase counts as read; the unrated ones still show what
  // they chose to buy and finish
  const unratedKindle = read.filter((b) => !b.my_rating && b.asin).sort((a, b) => (a.kindle_rank ?? 1e9) - (b.kindle_rank ?? 1e9)).slice(0, 40).map(fmt);

  return {
    summary: `${read.length} books read, ${rated.length} rated, mean ${mean.toFixed(2)}★ (5★ ${dist[5]}, 4★ ${dist[4]}, 3★ ${dist[3]}, 2★ ${dist[2]}, 1★ ${dist[1]}).`
      + (ledger.length ? ` Kindle library: ${ledger.length} books.` : ""),
    signature: signature.map(rich), authors, anti, genre, recent,
    recent_buys: ledger.slice(0, 15).map(fmt), unrated_kindle: unratedKindle,
    feedback: feedback(), dedup: dedupBlock(books, kindle),
  };
}

export function profileText(p, n) {
  const block = (name, items, note = "") => `\n## ${name}${note ? `\n${note}` : ""}\n` + (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");
  return `# Reader profile\n${p.summary}\n`
    + block("Signature books", p.signature, "Their most telling 5★ reads, ranked by recency and by how far they out-rated the crowd.")
    + block("Author record", p.authors, "Authors with 2+ rated books.")
    + block("What they bounce off", p.anti, "1–2★ reads, and books the crowd rated a full star higher than they did.")
    + block("Genre lift", p.genre, "Average rating per Google Books category relative to their own mean.")
    + block("Reading trajectory (most recent first)", p.recent)
    + block("Recent Kindle purchases (newest first)", p.recent_buys, "Show what they're in the mood for right now. Already owned, so never recommend these.")
    + block("Read on Kindle, never rated (newest purchase first)", p.unrated_kindle, "They bought and read these but left no rating. A weak signal: count them as finished, not as loved.")
    + block("Past recommendations they rejected", p.feedback.rejected)
    + block("Past recommendations they accepted", p.feedback.accepted)
    + block("Already read, shelved, or owned (for de-duplication only, not a taste signal)", p.dedup, "Author: title; title; … Never recommend any of these, or another edition of one.")
    + `\n\nGive exactly ${n} recommendations.`;
}

export const SYSTEM = `You are a sharp, well-read book recommender for one reader who reads mostly on Kindle and buys from Amazon.
You get a profile of their reading: ratings run from 1 to 5 stars, and 0 means unrated. Before you choose anything, work out
what actually drives their taste: themes, scale, tone, prose style, pacing, and structure. Genre labels alone are not enough.
Weigh books they rated above the crowd most heavily, because those reveal taste that popularity doesn't explain. Learn from
what they bounce off and from recommendations they rejected. Recent reads and purchases show their current direction.
Rules:
- Recommend only real, published books that are sold on the Kindle store. Never invent a title.
- Never recommend anything they have already read, shelved, or bought, including other editions. Check each pick against the
  de-duplication list before you include it. The most famous books by their favourite authors are probably already on that list.
- Mix them: about half should be unread books by authors they already love, and about half by authors new to them. Include at most one wildcard.
- Prefer a standalone book or the first book of a series, unless the reader is clearly partway through that series.
- Make each reason specific: name the books in their history that make this a match, and say what the shared quality is.
- Set confidence to a value from 0 to 1.`;

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["taste_summary", "recommendations"],
  properties: {
    taste_summary: { type: "string", description: "2-3 sentence portrait of the reader" },
    recommendations: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["title", "author", "year", "reason", "hook", "confidence"],
      properties: {
        title: { type: "string" }, author: { type: "string" }, year: { type: "integer" },
        reason: { type: "string", description: "why this fits, citing their history" },
        hook: { type: "string", description: "one-line pitch" }, confidence: { type: "number" },
      } } },
  },
};

export const OVERASK = 4; // a few picks always turn out to be in the library already

export function promptFor(n, mood) {
  let user = profileText(buildProfile(), n + OVERASK);
  if (mood) user += `\n\nReader's note for this batch: ${mood}`;
  return user;
}

/** One run, start to finish. onUpdate(run) fires on every stage change. */
export async function runRecommendation({ model, mood = null, n = 10, effort = null, batchId = null }, onUpdate = () => {}) {
  const user = promptFor(n, mood);
  const run = await store.put("runs", { created_at: store.now(), model, mood, effort, batch_id: batchId, n,
    status: "running", stage: "thinking", recs: [], prompt_chars: user.length + SYSTEM.length });
  const save = async (patch) => { Object.assign(run, patch); await store.put("runs", run); onUpdate(run); };
  onUpdate(run);
  try {
    const { content, served } = await chat([{ role: "system", content: SYSTEM }, { role: "user", content: user }], { model, effort, schema: SCHEMA });
    const data = JSON.parse((content.match(/\{[\s\S]*\}/) || [content])[0]);
    const known = knownSet(store.all("books"), store.all("kindle"));
    const kept = [], dropped = [];
    for (const r of data.recommendations || []) {
      if (isKnown(r.title || "", r.author, known)) dropped.push({ title: r.title, author: r.author, why: "already in your library" });
      else kept.push(r);
    }
    const final = kept.slice(0, n);
    await save({ stage: "enriching", served_model: served });
    const metas = await Promise.all(final.map((r) => lookup(r.title, r.author, null, null).catch(() => null)));
    const recs = final.map((r, i) => {
      const m = metas[i] || {};
      return { id: `${run.id}-${i + 1}`, rank: i + 1, title: r.title, author: r.author, year: r.year, reason: r.reason, hook: r.hook,
        confidence: r.confidence, thumbnail: m.thumbnail || null, description: m.description || null, categories: m.categories || [],
        google_rating: m.google_rating ?? null, google_id: m.google_id || null, isbn13: m.isbn13 || null,
        amazon_url: kindleSearch(r.title, r.author), status: "new" };
    });
    await save({ status: "done", stage: "done", taste_summary: data.taste_summary, dropped, recs });
  } catch (e) {
    await save({ status: "error", stage: "error", error: String(e.message || e).slice(0, 600) });
  }
  return run;
}

/** Runs left "running" when the page was closed can never finish. */
export async function markInterrupted() {
  const stale = store.all("runs").filter((r) => r.status === "running");
  for (const r of stale) Object.assign(r, { status: "error", stage: "error", error: "Interrupted: the page was closed while this run was in progress" });
  await store.putMany("runs", stale);
}

/* ---------- stats for Insights ---------- */
export function stats() {
  const books = store.all("books"), read = books.filter((b) => b.exclusive_shelf === "read");
  const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); if (k != null) m[k] = (m[k] || 0) + 1; return m; }, {});
  const byYear = Object.entries(count(read.filter((b) => b.date_read), (b) => b.date_read.slice(0, 4))).sort().map(([year, n]) => ({ year, n }));
  const rated = read.filter((b) => b.my_rating);
  const authorMap = new Map();
  for (const b of read) { if (!b.author) continue; const a = authorMap.get(b.author) || { author: b.author, n: 0, sum: 0, rated: 0 }; a.n++; if (b.my_rating) { a.sum += b.my_rating; a.rated++; } authorMap.set(b.author, a); }
  const authors = [...authorMap.values()].map((a) => ({ ...a, avg_rating: a.rated ? Math.round((a.sum / a.rated) * 100) / 100 : null }))
    .sort((a, b) => b.n - a.n || (b.avg_rating || 0) - (a.avg_rating || 0)).slice(0, 20);
  const catMap = new Map();
  for (const b of read) for (const c of b.categories || []) { const x = catMap.get(c) || { name: c, n: 0, sum: 0 }; x.n++; x.sum += b.my_rating || 0; catMap.set(c, x); }
  const categories = [...catMap.values()].map((c) => ({ ...c, avg: Math.round((c.sum / c.n) * 100) / 100 })).sort((a, b) => b.n - a.n).slice(0, 15);
  return {
    read: read.length, by_year: byYear, ratings: count(read, (b) => b.my_rating || 0), authors, categories,
    total_pages: read.reduce((s, b) => s + (b.pages || b.google_pages || 0), 0),
    avg_rating: rated.length ? Math.round((rated.reduce((s, b) => s + b.my_rating, 0) / rated.length) * 100) / 100 : 0,
    on_kindle: books.filter((b) => b.asin).length, to_read: books.filter((b) => b.exclusive_shelf === "to-read").length,
  };
}
