// findMyNextBook — browser-only edition. All data lives in this browser (see store.js); the server that hosts these
// files never receives anything (see the Content-Security-Policy in index.html and the Privacy panel).
import * as store from "./store.js";
import * as imp from "./importers.js";
import { isKnown, keyOf } from "./match.js";
import * as gb from "./books-api.js";
import * as llm from "./llm.js";
import * as rec from "./recommend.js";
import * as privacy from "./privacy.js";
import { onLog } from "./net.js";
import { bookmarklet, exportSource } from "./kindle-export.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, one, many = one + "s") => `${(n ?? 0).toLocaleString()} ${n === 1 ? one : many}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toast(msg, ms = 2800) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- formatting ---------- */
const stars = (n) => `<span class="stars">${"★".repeat(n)}<span class="off">${"★".repeat(5 - n)}</span></span>`;
const parseUTC = (s) => (s ? new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z") : null);
function ago(iso) {
  const d = parseUTC(iso); if (!d) return "never";
  const s = (Date.now() - d) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return plural(Math.round(s / 3600), "hour") + " ago";
  if (s < 86400 * 14) return plural(Math.round(s / 86400), "day") + " ago";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
const when = (iso) => parseUTC(iso)?.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) || "";
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const mb = (bytes) => (bytes == null ? "?" : bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`);
const modelNames = {};
const modelName = (id) => modelNames[id] || (id || "").split("/").pop().replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const hue = (s) => [...String(s || "")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const placeholder = (title, author, cls = "") =>
  `<div class="cover ph ${cls}" style="--h:${hue(title)}" aria-hidden="true"><span class="pt">${esc(title)}</span><span class="pa">${esc(author || "")}</span></div>`;
function cover(b, cls = "") {
  const src = b.thumbnail || b.cover;
  return src ? `<img class="cover ${cls}" src="${esc(src)}" alt="" loading="lazy" data-t="${esc(b.title)}" data-a="${esc(b.author || "")}">`
    : placeholder(b.title, b.author, cls);
}
// a dead (or policy-blocked) cover URL becomes a generated cover instead of a broken image
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img.tagName === "IMG" && img.classList.contains("cover")) img.outerHTML = placeholder(img.dataset.t, img.dataset.a, [...img.classList].filter((c) => c !== "cover").join(" "));
}, true);
function genres(cats) {
  const seen = new Set();
  return (cats || []).map((c) => c.split("/")[0].trim().toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()))
    .filter((c) => c && c !== "Fiction" && !seen.has(c) && seen.add(c));
}
function download(name, text) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type: "application/json" })), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- status: one snapshot feeds the banner, the hero line, the chips and the header ---------- */
const S = { status: null, layout: "grid", shelf: "all", tracking: false, showDismissed: false, run: null };
function computeStatus() {
  const books = store.all("books"), ledger = store.all("kindle");
  const shelves = {};
  for (const b of books) shelves[b.exclusive_shelf] = (shelves[b.exclusive_shelf] || 0) + 1;
  return {
    books: books.length, shelves, rated: books.filter((b) => b.my_rating > 0).length,
    unrated_read: books.filter((b) => b.exclusive_shelf === "read" && !b.my_rating).length,
    on_kindle: books.filter((b) => b.asin).length, goodreads: books.filter((b) => b.goodreads_id).length,
    kindle_ledger: ledger.length, kindle_pending: pendingKindle(ledger),
    kindle_last_sync: store.setting("kindle_last_sync"), kindle_last_apply: store.setting("kindle_last_apply"),
    kindle_finished: store.setting("kindle_finished_sync"),
    enriched: books.filter((b) => b.enriched_at && !b.enrich_error).length, unenriched: books.filter((b) => !b.enriched_at).length,
    key: llm.hasKey(), google_key: !!store.setting("google_key"), runs: store.all("runs").length,
  };
}
// Kindle books an apply would add (or move to read). Only worth computing when some ledger rows aren't linked yet.
function pendingKindle(ledger) {
  if (!ledger.some((k) => k.book_id == null && k.resource_type !== "EBOOK_SAMPLE")) return 0;
  const p = imp.kindlePreview(WZ.opts);
  return p.new + p.flip;
}
function refresh() {
  S.status = computeStatus();
  renderBanner(); renderHeroSub(); renderShelfChips(); renderBgPill();
  return S.status;
}
function renderHeroSub() {
  const s = S.status;
  $("#hero-sub").textContent = !s.books ? "Import your books and get picks matched to your taste."
    : `Picked from your ${plural(s.rated, "rated book")}${s.on_kindle ? ` and ${plural(s.on_kindle, "book")} on your Kindle` : ""}.`;
}
function renderBanner() {
  const s = S.status, el = $("#banner");
  let html = "";
  if (s.kindle_pending) html = `<span class="txt"><b>${plural(s.kindle_pending, "Kindle book")}</b> from your last import ${s.kindle_pending === 1 ? "isn't" : "aren't"} in your library yet.</span><button class="btn sm primary" data-wizard="review">Review</button>`;
  else if (!s.books) html = `<span class="txt"><b>Your library is empty.</b> Bring in your Kindle library, your Goodreads ratings, or both.</span><button class="btn sm primary" data-wizard>Import books</button>`;
  else if (!s.key) html = `<span class="txt"><b>Connect OpenRouter to get picks.</b> You use your own account, and this browser talks to OpenRouter directly.</span><button class="btn sm primary" data-connect>Connect</button>`;
  else if (!s.kindle_last_apply && chosenSources().includes("kindle")) html = `<span class="txt"><b>Your Kindle library isn't imported yet,</b> so picks may include books you already own.</span><button class="btn sm primary" data-wizard="kindle">Import from Amazon</button>`;
  el.innerHTML = html; el.hidden = !html;
}
function renderBgPill() {
  const p = gb.progress, el = $("#bg-pill");
  el.innerHTML = p.running ? `<span class="spinner"></span>Fetching book details ${p.done}/${p.total}` : "";
  el.hidden = !p.running;
}
let enrichRedraw;
function onEnrichTick() {
  renderBgPill();
  clearTimeout(enrichRedraw);
  enrichRedraw = setTimeout(() => { if (!$("#view-library").hidden) loadBooks(); if (!gb.progress.running) refresh(); }, 1500);
}
const startEnrich = () => { if (!gb.progress.running && store.all("books").some((b) => !b.enriched_at)) gb.enrichAll(onEnrichTick); };

document.addEventListener("click", (e) => {
  const w = e.target.closest("[data-wizard]"); if (w) { e.preventDefault(); openWizard(w.dataset.wizard || undefined); }
  if (e.target.closest("[data-connect]")) { e.preventDefault(); openSettings(); }
  if (e.target.closest("[data-privacy]")) { e.preventDefault(); openPrivacy(); }
});

/* ---------- navigation ---------- */
const views = { discover: loadDiscover, library: loadLibrary, insights: loadInsights };
function show(name) {
  if (!views[name]) name = "discover";
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
  views[name]();
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
window.addEventListener("hashchange", () => show(location.hash.slice(1)));

/* ================================================================================================
   DISCOVER
   ================================================================================================ */
let modelsLoaded = false;
function loadDiscover() {
  refresh();
  $("#rec-effort").value = store.setting("last_effort", "");
  $("#rec-n").value = store.setting("last_n", 10);
  $("#deny-training").checked = llm.denyTraining();
  if (!modelsLoaded) { modelsLoaded = true; M.picked = [...store.setting("last_models", [llm.DEFAULT_MODEL])]; renderPicked(); loadModels(); }
  loadRuns();
}

/* model picker: Suggested (a few Claude + the newest model of each open-weight family), Open models, All */
const MAX_MODELS = 6;
const M = { all: [], byId: new Map(), filter: "suggested", search: "", sort: "price", picked: [], failed: null };
const OPEN_FAMILIES = ["deepseek", "qwen", "moonshotai", "z-ai", "minimax", "mistralai", "meta", "meta-llama", "google", "openai", "nvidia", "xiaomi", "stepfun"];
const SPECIALTY = /code|coder|safety|guard|embed|ocr|-mt|vision-exp|preview|omni|translat|-vl\b/i; // not general-purpose writers
const EXTRA_SUGGESTED = ["typesafe/jev-router"];

async function loadModels() {
  try {
    M.all = await llm.listModels();
    M.byId = new Map(M.all.map((m) => [m.id, m]));
    M.all.forEach((m) => (modelNames[m.id] = m.name));
    M.failed = null;
  } catch (e) { M.failed = e.message; }
  renderModels(); renderPicked();
  if (S.run && !$("#results").hidden) showRun(S.run.id);
}

let promptCache = { key: null, chars: 0 };
function promptChars() {
  const n = Math.max(3, Math.min(25, +$("#rec-n").value || 10));
  const key = `${n}|${store.all("books").length}|${store.all("kindle").length}|${store.all("runs").length}`;
  if (promptCache.key !== key) promptCache = { key, chars: rec.SYSTEM.length + rec.promptFor(n, null).length + 1500 /* schema */ };
  return promptCache.chars;
}
const fmtCost = (c) => (c == null ? "" : c === 0 ? "free" : c < 0.001 ? "<0.1¢" : c < 0.01 ? `${(c * 100).toFixed(1)}¢` : c < 1 ? `${Math.round(c * 100)}¢` : `$${c.toFixed(2)}`);
const fmtPrice = (p) => (p == null ? "?" : p === 0 ? "0" : p < 0.1 ? p.toFixed(3).replace(/0+$/, "") : p < 10 ? p.toFixed(2).replace(/\.?0+$/, "") : Math.round(p));
const costOf = (m) => rec.estimateCost(m, promptChars(), Math.max(3, +$("#rec-n").value || 10), $("#rec-effort").value || null);

function suggestedModels(need) {
  const fits = (m) => !m.context || m.context >= need;
  const claude = M.all.filter((m) => m.vendor === "anthropic" && !m.id.startsWith("~")).sort((a, b) => b.created - a.created).slice(0, 3);
  const open = OPEN_FAMILIES.map((f) => M.all.filter((m) => m.vendor === f && m.open && !m.free && !m.id.startsWith("~") && (m.structured || m.json_mode)
    && !SPECIALTY.test(m.id) && fits(m)).sort((a, b) => b.created - a.created)[0]).filter(Boolean);
  const ids = new Set([...claude, ...open].map((m) => m.id).concat(llm.DEFAULT_MODEL, EXTRA_SUGGESTED));
  return M.all.filter((m) => ids.has(m.id));
}

function renderModels() {
  const box = $("#model-list");
  if (M.failed) {
    box.innerHTML = `<p class="muted small" style="margin:0 0 8px">Couldn't load the model list from OpenRouter (${esc(M.failed)}). Type a model ID instead:</p>
      <input id="rec-model" placeholder="e.g. deepseek/deepseek-v4.1-flash" spellcheck="false" style="width:100%" value="${esc(M.picked[0] || "")}">`;
    return;
  }
  if (!M.all.length) return;
  const need = promptChars() / 3.8 + 8000; // the profile plus room to answer
  const q = M.search.toLowerCase().split(/\s+/).filter(Boolean);
  let list = q.length ? (M.filter === "open" ? M.all.filter((m) => m.open) : M.all)
    : M.filter === "suggested" ? suggestedModels(need) : M.filter === "open" ? M.all.filter((m) => m.open) : M.all;
  if (q.length) list = list.filter((m) => q.every((w) => `${m.id} ${m.name}`.toLowerCase().includes(w)));
  const cost = new Map(list.map((m) => [m.id, costOf(m)]));
  // free providers usually keep prompts, so with "skip providers that store prompts" on they mostly can't serve: list them last
  const freeLast = llm.denyTraining() ? (a, b) => a.free - b.free : () => 0;
  list = [...list].sort(M.sort === "new" ? (a, b) => b.created - a.created
    : (a, b) => freeLast(a, b) || (cost.get(a.id) ?? 1e9) - (cost.get(b.id) ?? 1e9) || b.created - a.created);
  const shown = list.slice(0, 120);
  box.innerHTML = shown.length ? shown.map((m) => {
    const small = m.context && m.context < need;
    const tags = [m.open && `<span class="mtag open" title="Open weights: the model is published on Hugging Face">open</span>`,
      m.free && `<span class="mtag free" title="Free, but rate-limited; free providers often keep prompts">free</span>`,
      m.reasoning && `<span class="mtag" title="Reasons before answering${m.reasoning.efforts.length ? `; efforts: ${m.reasoning.efforts.join(", ")}` : ""}">thinks</span>`].filter(Boolean).join("");
    const c = cost.get(m.id);
    const tip = small ? `Your profile is too big for its ${m.context.toLocaleString()}-token context` : `${m.context ? `${Math.round(m.context / 1000).toLocaleString()}k context` : ""}${m.structured ? "" : m.json_mode ? " · JSON mode" : " · plain-text JSON"}`;
    return `<label class="model-row${small ? " off" : ""}" title="${esc(tip)}"><input type="checkbox" value="${esc(m.id)}" ${M.picked.includes(m.id) ? "checked" : ""} ${small ? "disabled" : ""}>
      <span class="mr-main"><span class="nm">${esc(m.name)}</span>${tags}<span class="slug">${esc(m.id)}</span></span>
      <span class="mr-cost"><b>${c == null ? "" : `≈ ${fmtCost(c)}`}</b><span>${m.free ? "rate-limited" : m.prompt_price == null ? "price varies" : `$${fmtPrice(m.prompt_price)} / $${fmtPrice(m.completion_price)} per M`}</span></span></label>`;
  }).join("") + (list.length > shown.length ? `<p class="muted small mr-more">${(list.length - shown.length).toLocaleString()} more. Search to narrow it down.</p>` : "")
    : `<p class="muted small mr-more">No model matches “${esc(M.search)}”.</p>`;
}

function renderPicked() {
  $("#model-picked").innerHTML = M.picked.length ? M.picked.map((id) => {
    const m = M.byId.get(id), c = m ? costOf(m) : null;
    return `<span class="pick-chip">${esc(modelName(id))}${c != null ? ` <span class="pc-cost">≈ ${fmtCost(c)}</span>` : ""}<button type="button" data-unpick="${esc(id)}" aria-label="Remove ${esc(modelName(id))}">×</button></span>`;
  }).join("") : `<span class="muted small">No model picked: ${esc(modelName(llm.DEFAULT_MODEL))} will be used.</span>`;
}

function setPicked(list) {
  M.picked = list;
  store.setSetting("last_models", list.length ? list : [llm.DEFAULT_MODEL]);
  renderPicked();
}
$("#model-list").addEventListener("change", (e) => {
  const box = e.target.closest("input[type=checkbox]"); if (!box) return;
  if (box.checked && M.picked.length >= MAX_MODELS) { box.checked = false; toast(`Pick at most ${MAX_MODELS} models`); return; }
  setPicked(box.checked ? [...M.picked, box.value] : M.picked.filter((x) => x !== box.value));
});
$("#model-picked").addEventListener("click", (e) => {
  const b = e.target.closest("[data-unpick]"); if (!b) return;
  setPicked(M.picked.filter((x) => x !== b.dataset.unpick));
  const box = $$("#model-list input").find((i) => i.value === b.dataset.unpick); if (box) box.checked = false;
});
$("#model-filter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]"); if (!b) return;
  M.filter = b.dataset.f;
  $$("#model-filter button").forEach((x) => x.classList.toggle("active", x === b));
  renderModels();
});
$("#model-search").addEventListener("input", (e) => { M.search = e.target.value; renderModels(); });
$("#model-sort").addEventListener("change", (e) => { M.sort = e.target.value; renderModels(); });
for (const id of ["#rec-effort", "#rec-n"]) $(id).addEventListener("change", () => { renderModels(); renderPicked(); });
$("#deny-training").addEventListener("change", async (e) => { await store.setSetting("deny_training", e.target.checked); renderModels(); });

const pickedModels = () => {
  const typed = $("#rec-model")?.value.trim();
  const list = M.failed && typed ? [typed] : M.picked;
  return list.length ? list : [llm.DEFAULT_MODEL];
};

$$("#mood-chips .chip").forEach((c) => c.addEventListener("click", () => {
  const same = $("#mood").value === c.textContent;
  $("#mood").value = same ? "" : c.textContent;
  $$("#mood-chips .chip").forEach((x) => x.classList.toggle("active", !same && x === c));
}));
$("#mood").addEventListener("input", () => $$("#mood-chips .chip").forEach((x) => x.classList.toggle("active", x.textContent === $("#mood").value)));
$("#ask").addEventListener("submit", (e) => { e.preventDefault(); startRun(); });

async function startRun() {
  if (S.tracking) return;
  if (!llm.hasKey()) { openSettings(); toast("Connect OpenRouter first: picks run on your own account"); return; }
  if (!store.all("books").length) { openWizard(); return; }
  const models = pickedModels();
  if (models.length > 6) { toast("Pick at most 6 models"); return; }
  const n = Math.max(3, Math.min(25, +$("#rec-n").value || 10)), effort = $("#rec-effort").value || null, mood = $("#mood").value.trim() || null;
  await Promise.all([store.setSetting("last_models", models), store.setSetting("last_effort", effort || ""), store.setSetting("last_n", n)]);
  const batchId = models.length > 1 ? crypto.randomUUID().slice(0, 12) : null;
  S.tracking = true;
  $("#go").disabled = true; $("#go").textContent = "Finding…";
  $("#progress").hidden = false;
  const live = [];
  const draw = () => renderProgress(live);
  const timer = setInterval(draw, 1000);
  const runs = await Promise.all(models.map((model, i) => rec.runRecommendation({ model, mood, n, effort, batchId }, (r) => { live[i] = r; draw(); })));
  clearInterval(timer); draw();
  S.tracking = false;
  $("#go").disabled = false; $("#go").textContent = "Find my next book";
  const ok = runs.find((r) => r.status === "done");
  if (ok) { await sleep(500); $("#progress").hidden = true; loadRuns(ok.id); }
  const bad = runs.filter((r) => r.status === "error");
  if (bad.length && ok) toast(`${bad.map((r) => modelName(r.model)).join(", ")} failed: ${bad[0].error}`, 6000);
  refresh();
}
const STAGES = [["thinking", "Thinking it over"], ["enriching", "Adding covers & blurbs"], ["done", "Done"]];
function renderProgress(runs) {
  $("#progress").innerHTML = runs.filter(Boolean).map((r) => {
    const idx = r.status === "done" ? 3 : Math.max(0, STAGES.findIndex(([k]) => k === r.stage));
    const label = r.status === "error" ? "failed" : r.status === "done" ? "done" : mmss((Date.now() - parseUTC(r.created_at)) / 1000);
    return `<div class="prog-row"><div class="prog-model"><span>${esc(modelName(r.model))}${(r.effort_used ?? r.effort) ? ` · ${esc((r.effort_used ?? r.effort) === "none" ? "no reasoning" : `${r.effort_used ?? r.effort} effort`)}` : ""}</span><span class="t">${label}</span></div>
      <ol class="stages three">${STAGES.map(([, name], i) => `<li class="${i < idx ? "done" : i === idx && r.status === "running" ? "active" : ""}">${name}</li>`).join("")}</ol>
      ${r.status === "error" ? `<div class="prog-err">${esc(r.error)}</div>` : ""}</div>`;
  }).join("") + (runs.some((r) => r?.status === "running" && r.stage === "thinking") ? `<p class="muted small" style="margin:14px 0 0">Your browser is talking to OpenRouter directly. Bigger models at high effort can take a few minutes; keep this tab open.</p>` : "");
}

/* runs + history */
let runGroups = [];
function loadRuns(selectId) {
  const runs = store.all("runs").sort((a, b) => b.id - a.id);
  const seen = new Set();
  runGroups = [];
  for (const r of runs) {
    if (r.batch_id) {
      if (seen.has(r.batch_id)) continue;
      seen.add(r.batch_id);
      runGroups.push(runs.filter((x) => x.batch_id === r.batch_id).sort((a, b) => a.id - b.id));
    } else runGroups.push([r]);
  }
  const finished = runGroups.filter((g) => g.some((r) => r.status !== "running"));
  $("#run-select").innerHTML = finished.map((g) => {
    const r = g[0], n = g.reduce((a, x) => a + (x.recs?.length || 0), 0);
    return `<option value="${r.id}">${esc(when(r.created_at))} · ${esc(g.map((x) => modelName(x.model)).join(" vs "))} · ${plural(n, "pick")}${r.mood ? ` · “${esc(r.mood.slice(0, 28))}”` : ""}</option>`;
  }).join("");
  const target = selectId || finished[0]?.[0]?.id;
  if (!target) { $("#results").hidden = true; return; }
  $("#run-select").value = runGroups.find((g) => g.some((r) => r.id === target))[0].id;
  showRun(target);
}
$("#run-select").addEventListener("change", (e) => showRun(+e.target.value));

function showRun(id) {
  const run = store.get("runs", id);
  if (!run) return;
  const group = runGroups.find((g) => g.some((r) => r.id === id)) || [run];
  // picks that other models in the same batch also made
  const others = group.filter((r) => r.id !== id).map((r) => [r.model, (r.recs || []).map((x) => keyOf(x.title, x.author))]);
  for (const x of run.recs || []) x.also_by = others.filter(([, known]) => isKnown(x.title, x.author, known)).map(([m]) => m);
  $("#results").hidden = false;
  $("#model-tabs").hidden = group.length < 2;
  $("#model-tabs").innerHTML = group.map((r) => `<button class="chip ${r.id === id ? "active" : ""}" data-run="${r.id}">${esc(modelName(r.model))}${r.status === "error" ? " · failed" : ""}</button>`).join("");
  const served = run.served_model && run.served_model !== run.model ? ` → ${modelName(run.served_model)}` : "";
  $("#results-meta").textContent = [`${modelName(run.model)}${served}`, when(run.created_at), run.cost != null && `cost ${fmtCost(run.cost) || "$0"}`, run.mood && `“${run.mood}”`].filter(Boolean).join(" · ");
  const taste = $("#taste");
  taste.hidden = !run.taste_summary && !run.error;
  taste.innerHTML = run.error ? `<span class="who">This run failed</span>${esc(run.error)}`
    : `<span class="who">Your taste, as ${esc(modelName(run.served_model || run.model))} reads it</span>${esc(run.taste_summary)}`;
  S.run = run;
  renderRecs();
}
$("#model-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-run]"); if (b) showRun(+b.dataset.run); });

const REC_STATE = { bought: "✓ Bought", added: "✓ On your want-to-read list", owned: "✓ Marked as read", dismissed: "Not for you" };
function recCard(r) {
  const url = r.amazon_url || rec.kindleSearch(r.title, r.author);
  const facts = [
    r.google_rating && `<span class="tag"><span class="star">★</span>${r.google_rating}</span>`,
    r.also_by?.length && `<span class="tag agree">Also picked by ${esc(r.also_by.map(modelName).join(", "))}</span>`,
    ...genres(r.categories).slice(0, 2).map((c) => `<span class="tag">${esc(c)}</span>`),
  ].filter(Boolean).join("");
  return `<article class="rec st-${r.status}" data-id="${esc(r.id)}">
    <a href="${esc(url)}" target="_blank" rel="noopener noreferrer" tabindex="-1">${cover(r)}</a>
    <div>
      <div class="rec-top"><span class="rank">${r.rank}</span><div><h3>${esc(r.title)}</h3><div class="byline">${[esc(r.author), r.year].filter(Boolean).join(" · ")}</div></div></div>
      ${r.hook ? `<p class="hook">${esc(r.hook)}</p>` : ""}
      <p class="reason">${esc(r.reason || "")}</p>
      ${r.description ? `<p class="blurb" title="Click to expand">${esc(r.description)}</p>` : ""}
      ${facts ? `<div class="facts">${facts}</div>` : ""}
      <div class="rec-actions">
        <a class="btn sm buy" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Find on Kindle ↗</a>
        ${r.status === "new" ? `<span class="acts">
          <button class="btn sm" data-act="bought" title="Shelves it as want-to-read">Bought it</button>
          <button class="btn sm ghost" data-act="added">Want to read</button>
          <button class="btn sm ghost" data-act="owned" title="You've already read it: it goes into your library as read">Read it</button>
          <button class="btn sm ghost" data-act="dismissed" title="Future picks steer away from it">Not for me</button></span>`
        : `<span class="state">${REC_STATE[r.status] || esc(r.status)}</span>`}
      </div>
    </div></article>`;
}
function renderRecs() {
  const run = S.run, recs = run.recs || [];
  const hidden = recs.filter((r) => r.status === "dismissed").length;
  $("#recs").innerHTML = recs.filter((r) => S.showDismissed || r.status !== "dismissed").map(recCard).join("")
    || (run.error ? "" : `<div class="empty"><h3>No picks in this run</h3>Try again with a different steer.</div>`);
  const parts = [];
  if (hidden) parts.push(`<a href="#" data-toggle-dismissed>${S.showDismissed ? "Hide" : "Show"} ${plural(hidden, "dismissed pick")}</a>`);
  const dropped = run.dropped || [];
  if (dropped.length) parts.push(`Left out ${plural(dropped.length, "pick")} already in your library: ${dropped.map((d) => `<i>${esc(d.title)}</i>`).join(", ")}.`);
  $("#dropped").innerHTML = parts.join(" ");
}
$("#dropped").addEventListener("click", (e) => { if (e.target.closest("[data-toggle-dismissed]")) { e.preventDefault(); S.showDismissed = !S.showDismissed; renderRecs(); } });
$("#recs").addEventListener("click", async (e) => {
  const blurb = e.target.closest(".blurb"); if (blurb) { blurb.classList.toggle("open"); return; }
  const btn = e.target.closest("button[data-act]"); if (!btn) return;
  const id = btn.closest(".rec").dataset.id, act = btn.dataset.act;
  const r = S.run.recs.find((x) => x.id === id);
  r.status = act;
  for (const x of S.run.recs) delete x.also_by; // display-only, recomputed by showRun
  await store.put("runs", S.run);
  // every outcome but "not for me" shelves the book, so the next run excludes it; "read it" counts as read
  const shelf = { bought: "to-read", added: "to-read", owned: "read" }[act];
  if (shelf) await imp.addBook({ ...r, year: r.year, source: "rec" }, shelf);
  showRun(S.run.id);
  toast({ bought: "Added to your library as want-to-read", added: "Added to want-to-read", owned: "Added to your library as read; it won't come back", dismissed: "Noted. Future picks will steer away from it" }[act]);
  refresh();
});
$("#rec-prompt").addEventListener("click", () => {
  const model = pickedModels()[0], info = M.byId.get(model) || null;
  const user = rec.promptFor(Math.max(3, +$("#rec-n").value || 10), $("#mood").value.trim() || null);
  const { body } = llm.buildRequest([{ role: "system", content: rec.SYSTEM }, { role: "user", content: user }],
    { model, effort: $("#rec-effort").value || null, schema: rec.SCHEMA, info });
  const { messages, ...settings } = body;
  $("#modal-title").textContent = `What gets sent · ≈${Math.round((user.length + rec.SYSTEM.length) / 3.8).toLocaleString()} tokens`;
  $("#modal-note").textContent = `This is the whole request your browser sends to OpenRouter (with your key) for ${modelName(model)}${M.picked.length > 1 ? " (each model you picked gets the same, adapted to what it supports)" : ""}. It goes to openrouter.ai and nowhere else.`;
  $("#modal-pre").textContent = `SETTINGS\n${JSON.stringify(settings, null, 2)}\n\nSYSTEM\n${messages[0].content}\n\nUSER\n${messages[1].content}`;
  openOverlay("#modal");
});

/* ================================================================================================
   LIBRARY
   ================================================================================================ */
const SHELF_CHIPS = [["all", "All"], ["read", "Read"], ["to-read", "Want to read"], ["currently-reading", "Reading"], ["unrated", "Unrated"], ["kindle", "On Kindle"], ["abandoned", "Abandoned"]];
function renderShelfChips() {
  const s = S.status; if (!s) return;
  const counts = { all: s.books, unrated: s.unrated_read, kindle: s.on_kindle, ...s.shelves };
  $("#shelf-chips").innerHTML = SHELF_CHIPS.filter(([k]) => k === "all" || counts[k] || S.shelf === k)
    .map(([k, label]) => `<button class="chip ${S.shelf === k ? "active" : ""}" data-shelf="${k}">${label} <span class="n">${(counts[k] || 0).toLocaleString()}</span></button>`).join("");
}
$("#shelf-chips").addEventListener("click", (e) => { const c = e.target.closest("[data-shelf]"); if (c) { S.shelf = c.dataset.shelf; renderShelfChips(); loadBooks(); } });
function loadLibrary() { refresh(); loadBooks(); }
const SHELF = { read: "Read", "to-read": "Want to read", "currently-reading": "Reading", abandoned: "Abandoned" };
function loadBooks() {
  const [sort, dir] = $("#f-sort").value.split(":");
  const q = $("#q").value.trim().toLowerCase(), rating = $("#f-rating").value;
  let list = store.all("books");
  if (S.shelf === "unrated") list = list.filter((b) => b.exclusive_shelf === "read" && !b.my_rating);
  else if (S.shelf === "kindle") list = list.filter((b) => b.asin);
  else if (S.shelf !== "all") list = list.filter((b) => b.exclusive_shelf === S.shelf);
  if (rating) list = list.filter((b) => b.my_rating === +rating);
  if (q) list = list.filter((b) => [b.title, b.author, b.additional_authors, b.description].some((x) => (x || "").toLowerCase().includes(q)));
  const sign = dir === "asc" ? 1 : -1;
  list.sort((a, b) => {
    const x = a[sort], y = b[sort];
    if ((x ?? "") === "" && (y ?? "") !== "") return 1;
    if ((y ?? "") === "" && (x ?? "") !== "") return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
    return c * sign || a.title.localeCompare(b.title);
  });
  $("#lib-count").textContent = list.length.toLocaleString();
  const el = $("#books");
  el.className = S.layout;
  el.innerHTML = list.map((b) => `<div class="book" data-id="${b.id}" tabindex="0">${cover(b)}
      <div class="t">${esc(b.title)}</div><div class="a">${esc(b.author || "Unknown author")}</div>
      <div class="meta">${b.my_rating ? stars(b.my_rating) : `<span class="tag ${b.exclusive_shelf}">${SHELF[b.exclusive_shelf] || esc(b.exclusive_shelf)}</span>`}
        ${S.layout === "list" && b.asin ? `<span class="tag">Kindle</span>` : ""}<span class="d">${esc((b.date_read || "").slice(0, 10))}</span></div></div>`).join("")
    || `<div class="empty" style="grid-column:1/-1"><h3>${S.status?.books ? "Nothing matches" : "Your library is empty"}</h3>${S.status?.books ? "Try another search or filter." : `<button class="btn primary" data-wizard style="margin-top:12px">Import your books</button>`}</div>`;
}
let qTimer;
$("#q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(loadBooks, 150); });
["#f-rating", "#f-sort"].forEach((s) => $(s).addEventListener("change", loadBooks));
$$(".seg button").forEach((b) => b.addEventListener("click", () => {
  S.layout = b.dataset.layout; $$(".seg button").forEach((x) => x.classList.toggle("active", x === b)); loadBooks();
}));
$("#books").addEventListener("click", (e) => { const c = e.target.closest(".book"); if (c) openBook(+c.dataset.id); });
$("#books").addEventListener("keydown", (e) => { const c = e.target.closest(".book"); if (c && e.key === "Enter") openBook(+c.dataset.id); });

/* ---------- drawer ---------- */
function openBook(id) { const b = store.get("books", id); if (!b) return; renderDrawer(b); $("#drawer").hidden = false; $("#backdrop").hidden = false; }
function closeDrawer() { $("#drawer").hidden = true; $("#backdrop").hidden = true; }
$("#drawer-close").onclick = closeDrawer; $("#backdrop").onclick = closeDrawer;
const SOURCE = { kindle: "Your Kindle library", "amazon-print": "Your Amazon orders", rec: "A recommendation", manual: "Added by hand", goodreads: "Goodreads" };
function renderDrawer(b) {
  const year = b.original_year || b.year_published || (b.google_published || "").slice(0, 4);
  const source = b.goodreads_id ? "Goodreads" + (b.asin ? " + your Kindle library" : "") : SOURCE[b.source] || (b.asin ? SOURCE.kindle : "");
  $("#drawer-body").innerHTML = `
    <div class="dhead">${cover(b)}
      <div>
        <h2>${esc(b.title)}</h2>
        <div class="byline"><span class="author-link" data-author="${esc(b.author || "")}" title="Show their books">${esc(b.author || "Unknown author")}</span>${b.additional_authors ? ", " + esc(b.additional_authors) : ""}</div>
        <div class="big-stars" id="rate">${[1, 2, 3, 4, 5].map((i) => `<span data-v="${i}" class="${i <= (b.my_rating || 0) ? "on" : ""}">★</span>`).join("")}</div>
        <div class="hint">${b.my_rating ? "Click the same star to clear" : "Not rated yet"}</div>
        <div class="dactions">
          <select id="shelf" aria-label="Shelf">${[["read", "Read"], ["currently-reading", "Reading"], ["to-read", "Want to read"], ["abandoned", "Abandoned"]].map(([v, l]) => `<option value="${v}" ${v === b.exclusive_shelf ? "selected" : ""}>${l}</option>`).join("")}</select>
          ${b.asin ? `<a class="btn sm" href="https://read.amazon.com/?asin=${esc(b.asin)}" target="_blank" rel="noopener noreferrer">Read in Kindle ↗</a>
                     <a class="btn sm ghost" href="https://www.amazon.com/dp/${esc(b.asin)}" target="_blank" rel="noopener noreferrer">Amazon page ↗</a>`
                   : `<a class="btn sm buy" href="${rec.kindleSearch(b.title, b.author)}" target="_blank" rel="noopener noreferrer">Find on Kindle ↗</a>`}
        </div>
      </div>
    </div>
    <dl class="kv">
      ${year ? `<dt>Published</dt><dd>${esc(year)}${b.publisher ? " · " + esc(b.publisher) : ""}</dd>` : ""}
      ${b.pages || b.google_pages ? `<dt>Pages</dt><dd>${b.pages || b.google_pages}</dd>` : ""}
      <dt>Date read</dt><dd><input type="date" id="date_read" value="${esc((b.date_read || "").slice(0, 10))}" style="padding:3px 8px"></dd>
      ${source ? `<dt>From</dt><dd>${esc(source)}</dd>` : ""}
      ${b.google_rating ? `<dt>Crowd rating</dt><dd>${b.google_rating} ★${b.google_ratings_count ? ` (${b.google_ratings_count.toLocaleString()})` : ""}</dd>` : ""}
      ${genres(b.categories).length ? `<dt>Genres</dt><dd>${genres(b.categories).map(esc).join(", ")}</dd>` : ""}
      ${b.goodreads_id ? `<dt>Goodreads</dt><dd><a href="https://www.goodreads.com/book/show/${b.goodreads_id}" target="_blank" rel="noopener noreferrer">View ↗</a></dd>` : ""}
    </dl>
    <p class="desc">${b.description ? esc(b.description) : `<span class="muted">No blurb yet.${b.enrich_error ? ` Lookup said: ${esc(b.enrich_error)}.` : ""}</span>`}</p>
    <div class="drawer-h">Notes</div>
    <textarea id="notes" placeholder="Private notes… (saved in this browser)">${esc(b.user_notes || b.review || "")}</textarea>
    <div class="dactions" style="margin-top:22px">
      <button id="enrich-one" class="btn sm ghost">↻ Refresh details</button>
      <button id="delete" class="btn sm ghost danger">Remove from library</button>
    </div>`;
  const patch = async (fields, quiet) => {
    Object.assign(b, fields, { updated_at: store.now() });
    if (["my_rating", "exclusive_shelf", "date_read"].some((k) => k in fields)) b.edited = true; // a later Goodreads import won't undo it
    await store.put("books", b);
    if (!quiet) toast("Saved");
    if (!$("#view-library").hidden) loadBooks();
    refresh();
  };
  const rate = $("#rate");
  rate.addEventListener("mouseover", (e) => { const v = +e.target.dataset.v; if (v) $$("span", rate).forEach((s) => s.classList.toggle("hover", +s.dataset.v <= v)); });
  rate.addEventListener("mouseleave", () => $$("span", rate).forEach((s) => s.classList.remove("hover")));
  rate.addEventListener("click", async (e) => {
    const v = +e.target.dataset.v; if (!v) return;
    const nv = v === b.my_rating ? 0 : v;
    const f = { my_rating: nv };
    if (nv && b.exclusive_shelf !== "read") Object.assign(f, { exclusive_shelf: "read", date_read: b.date_read || store.now().slice(0, 10) });
    await patch(f); renderDrawer(b);
  });
  $(".author-link").onclick = (e) => { closeDrawer(); S.shelf = "all"; $("#q").value = e.target.dataset.author; show("library"); };
  $("#shelf").onchange = async (e) => {
    const f = { exclusive_shelf: e.target.value };
    if (f.exclusive_shelf === "read" && !b.date_read) f.date_read = store.now().slice(0, 10);
    await patch(f); renderDrawer(b);
  };
  $("#date_read").onchange = (e) => patch({ date_read: e.target.value || null });
  let nt; $("#notes").oninput = (e) => { clearTimeout(nt); nt = setTimeout(() => patch({ user_notes: e.target.value }, true), 600); };
  $("#enrich-one").onclick = async (e) => {
    e.target.textContent = "Fetching…"; e.target.disabled = true;
    try { const ok = await gb.enrichBook(b); renderDrawer(b); toast(ok ? "Details updated" : "Not found on Google Books or Open Library"); if (!$("#view-library").hidden) loadBooks(); }
    catch (err) { toast(err.message); e.target.textContent = "↻ Refresh details"; e.target.disabled = false; }
  };
  $("#delete").onclick = async () => {
    if (!confirm(`Remove “${b.title}” from your library?`)) return;
    await store.del("books", b.id); closeDrawer(); loadBooks(); refresh(); toast("Removed");
  };
}

/* ---------- add a book ---------- */
$("#add-book").addEventListener("click", () => { openOverlay("#adder"); setTimeout(() => $("#g-q").focus(), 50); });
$("#g-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#g-q").value.trim(); if (!q) return;
  const out = $("#g-results");
  out.innerHTML = `<p class="muted"><span class="spinner"></span> Searching…</p>`;
  try {
    const hits = await gb.googleSearch(q, 10);
    out._hits = hits;
    out.innerHTML = hits.map((h, i) => `<div class="hit" data-i="${i}">${cover({ ...h, author: h.authors[0] })}
      <div><h3>${esc(h.title)}</h3><div class="byline">${esc(h.authors.join(", "))}${h.google_published ? " · " + esc(h.google_published.slice(0, 4)) : ""}</div>
        ${h.description ? `<p class="blurb">${esc(h.description)}</p>` : ""}
        <div class="rec-actions">
          <button class="btn sm primary" data-shelf="read">Read it</button>
          <button class="btn sm" data-shelf="to-read">Want to read</button>
          <button class="btn sm ghost" data-shelf="currently-reading">Reading now</button>
        </div></div></div>`).join("") || `<p class="muted">No results.</p>`;
  } catch (err) { out.innerHTML = `<p class="muted">Search failed: ${esc(err.message)}. Adding a Google Books key in Settings gives you your own quota.</p>`; }
});
$("#g-results").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-shelf]"); if (!btn) return;
  const h = $("#g-results")._hits[+btn.closest(".hit").dataset.i];
  const { book, existed } = await imp.addBook({ ...h, author: h.authors[0], year: +(h.google_published || "").slice(0, 4) || null, pages: h.google_pages }, btn.dataset.shelf);
  toast(existed ? `“${book.title}” is already in your library` : `Added “${book.title}”`);
  btn.closest(".rec-actions").innerHTML = `<span class="state">✓ ${existed ? "Already there" : "Added"}</span>`;
  refresh(); if (!$("#view-library").hidden) loadBooks();
});

/* ================================================================================================
   INSIGHTS
   ================================================================================================ */
const tip = $("#tip");
function attachTips(root) {
  if (root._tips) return; root._tips = true;
  root.addEventListener("mousemove", (e) => {
    const t = e.target.closest("[data-tip]");
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip; tip.hidden = false;
    tip.style.left = e.clientX + 12 + "px"; tip.style.top = e.clientY + 12 + "px";
  });
  root.addEventListener("mouseleave", () => (tip.hidden = true));
}
function vbars(items, xKey, yKey, labelEvery = 1) {
  const max = Math.max(...items.map((i) => i[yKey]), 1);
  return `<div class="bars">${items.map((i, idx) => `<div class="bar" style="height:${(i[yKey] / max) * 100}%" data-tip="${esc(i[xKey])}: ${i[yKey]}">
    <div class="y">${i[yKey]}</div>${idx % labelEvery === 0 ? `<div class="x">${esc(i[xKey])}</div>` : ""}</div>`).join("")}</div>`;
}
function hbars(items, nameKey, valKey, extraKey) {
  const max = Math.max(...items.map((i) => i[valKey]), 1);
  return `<div class="hbars">${items.map((i) => `<div class="hbar" data-tip="${esc(i[nameKey])}: ${i[valKey]} books${i[extraKey] ? `, avg ${i[extraKey]}★` : ""}">
    <div class="n">${esc(i[nameKey])}</div><div class="track"><div class="fill" style="width:${(i[valKey] / max) * 100}%"></div></div>
    <div class="val">${i[valKey]}${i[extraKey] ? ` · ${i[extraKey]}★` : ""}</div></div>`).join("")}</div>`;
}
function loadInsights() {
  const s = rec.stats();
  const thisYear = String(new Date().getFullYear());
  const ty = s.by_year.find((y) => y.year === thisYear);
  $("#stat-tiles").innerHTML = [
    [s.read.toLocaleString(), "books read"], [ty ? ty.n : 0, `read in ${thisYear}`], [s.total_pages.toLocaleString(), "pages read"],
    [s.avg_rating || "—", "average rating"], [s.on_kindle.toLocaleString(), "on your Kindle"], [s.to_read.toLocaleString(), "want to read"],
  ].map(([v, l]) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  $("#chart-year").innerHTML = s.by_year.length ? vbars(s.by_year, "year", "n", s.by_year.length > 14 ? 2 : 1) : `<p class="muted">No read dates yet.</p>`;
  $("#chart-rating").innerHTML = vbars([1, 2, 3, 4, 5].map((r) => ({ label: "★".repeat(r), n: s.ratings[r] || 0 })), "label", "n")
    + `<p class="muted small" style="margin:6px 0 0">${plural(s.ratings[0] || 0, "read book")} unrated.</p>`;
  $("#chart-authors").innerHTML = s.authors.length ? hbars(s.authors, "author", "n", "avg_rating") : `<p class="muted">Nothing read yet.</p>`;
  $("#chart-cats").innerHTML = s.categories.length ? hbars(s.categories, "name", "n", "avg") : `<p class="muted">Genres appear once book details have been fetched (Settings).</p>`;
  attachTips($("#view-insights"));
}

/* ================================================================================================
   OVERLAYS
   ================================================================================================ */
function openOverlay(sel) { $(sel).hidden = false; }
function closeOverlay(el) {
  el.hidden = true;
  if (el.id === "wizard") { refresh(); if (location.hash === "#library") loadBooks(); if (location.hash === "#discover" || !location.hash) loadRuns(); }
  if (el.id === "privacy") stopPrivacyLive?.();
}
$$(".overlay").forEach((o) => {
  o.addEventListener("mousedown", (e) => { o._down = e.target === o; });
  o.addEventListener("click", (e) => {
    if ((e.target === o && o._down && o.id !== "wizard") || e.target.closest("[data-close]")) closeOverlay(o);
    o._down = false;
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = $$(".overlay").filter((o) => !o.hidden).pop();
  if (open) closeOverlay(open); else closeDrawer();
});

/* ---------- settings ---------- */
$("#open-settings").addEventListener("click", openSettings);
function openSettings() { refresh(); renderSettings(); $("#wizard").hidden = true; openOverlay("#settings"); }
function connectHTML() {
  return `<div class="connect-row"><button class="btn primary" data-signin>Sign in with OpenRouter</button></div>
    <div class="connect-row"><input type="password" id="or-key" placeholder="…or paste a key (sk-or-…)" autocomplete="off" spellcheck="false"><button class="btn" data-savekey>Save key</button></div>
    <p class="muted small" style="margin:8px 0 0">Picks run on your own OpenRouter account. Get a key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">openrouter.ai/keys</a>. It's stored only in this browser and sent only to openrouter.ai.</p>`;
}
function renderSettings() {
  const s = S.status;
  const label = store.setting("or_key_label");
  $("#settings-body").innerHTML = `
    <div class="set-row"><div class="txt"><b>OpenRouter</b>
      ${s.key ? `<span><span class="ok-dot"></span>Connected${label ? ` (${esc(label)})` : ""}. Picks run on your account, straight from this browser.</span><span id="or-usage" class="muted small"></span>`
              : `<span>Not connected. Recommendations need your own OpenRouter account.</span>${connectHTML()}`}</div>
      ${s.key ? `<button class="btn sm danger" data-disconnect>Disconnect</button>` : ""}</div>
    <div class="set-row"><div class="txt"><b>Kindle library</b><span>${s.kindle_ledger ? `${plural(s.kindle_ledger, "book")} · imported ${ago(s.kindle_last_sync)}` : "Not imported yet"}</span></div>
      <button class="btn sm" data-wizard="kindle">${s.kindle_ledger ? "Import again" : "Import"}</button></div>
    <div class="set-row"><div class="txt"><b>Goodreads</b><span>${s.goodreads ? `${plural(s.goodreads, "book")} from your Goodreads export` : "Ratings and read dates from a Goodreads export"}</span></div>
      <label class="btn sm">Import CSV<input type="file" accept=".csv" hidden id="set-goodreads"></label></div>
    <div class="set-row"><div class="txt"><b>Book details</b><span>Covers, blurbs and genres for ${s.enriched.toLocaleString()} of ${plural(s.books, "book")}${gb.progress.running ? ` · fetching ${gb.progress.done}/${gb.progress.total}` : ""}</span></div>
      <button class="btn sm" id="set-enrich" ${gb.progress.running || !s.unenriched ? "disabled" : ""}>${s.unenriched ? `Fetch ${s.unenriched} missing` : "All fetched"}</button></div>
    <div class="set-row"><div class="txt"><b>Google Books key</b><span>Optional. Without one you share Google's free quota with your network, and Open Library fills in.</span>
      <div class="connect-row"><input type="password" id="g-key" placeholder="${s.google_key ? "•••••• saved" : "AIza…"}" autocomplete="off" spellcheck="false"><button class="btn sm" data-gkey>${s.google_key ? "Replace" : "Save"}</button>${s.google_key ? `<button class="btn sm ghost danger" data-gkey-clear>Remove</button>` : ""}</div></div></div>
    <div class="set-row"><div class="txt"><b>Your data</b><span>${plural(s.books, "book")}, ${plural(s.runs, "recommendation run")}, all in this browser only. A backup is a file you keep; it never includes your keys.</span>
      <div class="data-actions"><button class="btn sm" data-backup>Download backup</button><label class="btn sm">Restore backup<input type="file" accept=".json" hidden data-restore></label>
      <button class="btn sm ghost danger" data-wipe>Delete everything</button></div></div></div>`;
  if (s.key) llm.keyInfo().then((i) => { const u = $("#or-usage"); if (u) u.textContent = i.usage != null ? `Used $${(+i.usage).toFixed(2)}${i.limit ? ` of $${i.limit}` : ""} on this key.` : ""; }).catch(() => {});
  $("#set-goodreads").onchange = (e) => importFile(e.target, "goodreads").then(() => { refresh(); renderSettings(); }).catch(() => {});
  $("#set-enrich").onclick = () => { startEnrich(); renderSettings(); };
}
async function importFile(input, kind) {
  const f = input.files[0]; if (!f) return null;
  input.value = "";
  try {
    let msg;
    if (kind === "goodreads") { const r = await imp.importGoodreads(await f.text()); msg = goodreadsResult(r); }
    else { const r = await imp.importOrders(f); msg = r.found ? `${plural(r.found, "paper book")}: ${r.added} added, ${r.matched} already in your library` : `No paper books found in ${r.rows.toLocaleString()} order rows`; }
    toast(msg, 4000); startEnrich(); refresh();
    return msg;
  } catch (err) { toast(err.message, 5000); throw err; }
}
const goodreadsResult = (r) => `Goodreads: ${r.inserted} added, ${r.updated} updated${r.merged ? `, ${r.merged} matched to Kindle books` : ""}`;
document.addEventListener("click", async (e) => {
  const t = e.target;
  try {
    if (t.closest("[data-signin]")) { await llm.startSignIn(); }
    else if (t.closest("[data-savekey]")) {
      const input = t.closest(".connect-row").querySelector("input");
      t.disabled = true;
      await llm.saveKey(input.value); input.value = "";
      toast("OpenRouter connected"); refresh(); rerenderKeyed();
    } else if (t.closest("[data-disconnect]")) { await llm.disconnect(); toast("Disconnected. Your key is gone from this browser"); refresh(); renderSettings(); }
    else if (t.closest("[data-gkey]")) { const v = $("#g-key").value.trim(); if (!v) return; await store.setSetting("google_key", v); toast("Google Books key saved"); refresh(); renderSettings(); }
    else if (t.closest("[data-gkey-clear]")) { await store.delSetting("google_key"); refresh(); renderSettings(); }
    else if (t.closest("[data-backup]")) { download(`findMyNextBook-backup-${store.now().slice(0, 10)}.json`, JSON.stringify(store.backup())); toast("Backup saved to your downloads"); }
    else if (t.closest("[data-wipe]")) {
      if (!confirm("Delete your whole library, ratings, history and keys from this browser? This can't be undone. Download a backup first if you might want it back.")) return;
      await store.wipe(); location.replace(location.pathname);
    }
  } catch (err) { toast(err.message, 5000); if (t.disabled) t.disabled = false; }
});
document.addEventListener("change", async (e) => {
  if (!e.target.matches("[data-restore]")) return;
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const r = await store.restore(JSON.parse(await f.text()));
    toast(`Restored ${plural(r.books, "book")} and ${plural(r.runs, "run")}`, 4000);
    refresh(); renderSettings(); show(location.hash.slice(1) || "discover");
  } catch (err) { toast(err.message, 5000); }
});
function rerenderKeyed() {
  if (!$("#settings").hidden) renderSettings();
  if (!$("#wizard").hidden && WZ.step === "done") wzDone();
}

/* ---------- privacy ---------- */
let stopPrivacyLive = null;
$("#open-privacy").addEventListener("click", openPrivacy);
function openPrivacy() { renderPrivacy(); openOverlay("#privacy"); stopPrivacyLive = onLog(() => renderHosts()); }
function renderPrivacy() {
  const csp = privacy.policy();
  const host = location.host;
  $("#privacy-body").innerHTML = `<div class="proof">
    <div class="claims">
      <div class="claim"><b>Stored in this browser</b><span>Your library, ratings and picks live in this browser's own storage (IndexedDB) <span id="storage-used"></span>.</span></div>
      <div class="claim"><b>Files never uploaded</b><span>Goodreads exports, Amazon data and backups are opened right here, on your machine.</span></div>
      <div class="claim"><b>${esc(host)} receives nothing</b><span>Your browser itself refuses to let this page send data to the server it came from.</span></div>
    </div>

    <h3>Test it yourself</h3>
    <div class="test-box">
      <p style="margin:0">This button makes the page try to send data to <b>${esc(host)}</b>, two different ways. If the protection works, your browser blocks both before anything leaves your machine.</p>
      <div style="margin-top:12px"><button class="btn primary" id="try-server">Try to send data to this server</button></div>
      <div id="try-results"></div>
    </div>

    <h3>Every connection this page has made</h3>
    <p>Live, since you opened the page. ${esc(host)} appears only for the app's own files, downloaded when the page loaded.</p>
    <div id="hosts"></div>

    <h3>The rule your browser enforces</h3>
    <p>This page carries a Content-Security-Policy. Your browser enforces it, not the app: even if the code tried, the browser would refuse. <b>connect-src</b> lists the only places the page can send data, and this server isn't one of them. <b>img-src</b> doesn't include it either, which rules out tracking pixels. <b>form-action 'none'</b> rules out form posts.</p>
    <pre class="csp">${Object.entries(csp).map(([k, v]) => `${["connect-src", "img-src", "form-action"].includes(k) ? `<b>${esc(k)}</b>` : esc(k)} ${esc(v.join(" "))}`).join("\n")}</pre>

    <h3>What others see</h3>
    <ul class="small" style="color:var(--ink-2);padding-left:18px;margin:0;display:grid;gap:6px">
      <li><b>OpenRouter</b>, and the provider it routes to for the model you picked, get your reading profile with your own key when you ask for picks. “View what gets sent” on Discover shows exactly what that is. With “Skip providers that may store or train on prompts” on (the default), OpenRouter uses only providers that don't.</li>
      <li><b>Google Books / Open Library</b> get one book title or ISBN per lookup, for covers, blurbs and genres. No cookies, no referrer.</li>
      <li><b>Amazon, Google, Open Library</b> serve cover images, so they see which covers your browser loads.</li>
      <li><b>${esc(host)}</b> sees that someone loaded the page (address and time), like any website, and nothing else. If you use “Sign in with OpenRouter”, the return address carries a one-time code that expires in minutes and is useless without a secret that never leaves this tab.</li>
    </ul>

    <h3>Check it independently</h3>
    <p>Open your browser's developer tools, go to the Network tab, filter by <b>${esc(host)}</b>, and use the app: after the page loads, nothing more goes there. The code isn't bundled or minified, so “View source” on any file shows what runs.</p>
  </div>`;
  renderHosts();
  privacy.storageInfo().then((i) => { const el = $("#storage-used"); if (el && i.used != null) el.textContent = `(${mb(i.used)} used${i.persisted ? ", protected from automatic clean-up" : ""})`; });
  $("#try-server").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "Trying…";
    const results = await privacy.tryToReachServer();
    $("#try-results").innerHTML = results.map((r) => `<div class="test-result"><span>${esc(r.how)}</span>
      <span class="verdict ${r.blocked ? "ok" : "bad"}">${r.blocked ? `Blocked by your browser ✓ <span class="muted small">(${r.rule})</span>` : "Not blocked ✗"}</span></div>`).join("");
    e.target.disabled = false; e.target.textContent = "Try again";
    renderHosts();
  };
}
function renderHosts() {
  const el = $("#hosts"); if (!el || $("#privacy").hidden && !el.isConnected) return;
  const rows = privacy.requests();
  el.innerHTML = `<table class="hosts"><thead><tr><th>Host</th><th>What for</th><th>Requests</th></tr></thead><tbody>${rows.map((h) => `
    <tr class="${h.own ? "own" : ""}"><td>${esc(h.host)}${h.own ? " (this site)" : ""}</td>
      <td>${esc(h.purpose)}${h.own ? `<div class="paths">${h.paths.map(esc).join("  ")}</div>` : ""}</td>
      <td>${h.count}${h.own ? `<div class="paths">${h.sent ? `${h.sent} sent data ✗` : "0 sent data"}${h.blocked ? `<br>${h.blocked} blocked by your browser` : ""}</div>` : ""}</td></tr>`).join("")}</tbody></table>`;
}

/* ================================================================================================
   IMPORT WIZARD
   ================================================================================================ */
const WZ = { step: "sources", sources: [], opts: { include_samples: false, toread_as_read: true }, toRate: [], shown: 0, rated: 0 };
const STEP_LABELS = { sources: "Sources", kindle: "Kindle", goodreads: "Goodreads", review: "Review", rate: "Rate", done: "Done" };
const SOURCES = ["kindle", "goodreads"];
/** What this reader uses: what they picked in the wizard, else whatever they've imported. */
function chosenSources() {
  const saved = store.setting("sources");
  if (Array.isArray(saved)) return saved;
  const s = S.status || computeStatus();
  return SOURCES.filter((k) => (k === "kindle" ? s.kindle_ledger : s.goodreads));
}
// Goodreads before the Kindle review, so Kindle books are matched against your Goodreads ratings instead of added twice
function wzSteps() {
  const k = WZ.sources.includes("kindle"), g = WZ.sources.includes("goodreads");
  return ["sources", ...(k ? ["kindle"] : []), ...(g ? ["goodreads"] : []), ...(k || S.status?.kindle_pending ? ["review"] : []), "rate", "done"];
}
const wzNext = () => { const st = wzSteps(); wzGo(st[st.indexOf(WZ.step) + 1] || "done"); };
const wzBack = () => { const st = wzSteps(); wzGo(st[Math.max(0, st.indexOf(WZ.step) - 1)]); };
$("#open-import").addEventListener("click", () => openWizard());
$("#wz-script").textContent = exportSource();
$("#bookmarklet").href = bookmarklet();
$("#bookmarklet").addEventListener("click", (e) => { e.preventDefault(); toast("Drag this button to your bookmarks bar, then click it on Amazon", 4000); });
$("#wz-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(exportSource()); toast("Copied. Paste it into the console on read.amazon.com"); }
  catch { toast("Select the script and copy it by hand"); }
});

function openWizard(step) {
  refresh();
  WZ.sources = [...chosenSources()];
  $("#settings").hidden = true;
  openOverlay("#wizard");
  wzGo(step || (S.status.kindle_pending ? "review" : "sources"));
}
function wzGo(step) {
  if (SOURCES.includes(step) && !WZ.sources.includes(step)) WZ.sources.push(step); // e.g. Settings → Kindle → Import
  WZ.step = step;
  const steps = wzSteps(), i = steps.indexOf(step);
  $("#wz-steps").innerHTML = steps.map((st, j) => `<li class="${j === i ? "active" : j < i ? "done" : ""}"><span class="dot">${j < i ? "✓" : j + 1}</span><span class="lbl">${STEP_LABELS[st]}</span></li>`).join("");
  $$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== step));
  $("#wizard .sheet-body").scrollTop = 0;
  ({ sources: wzSources, kindle: wzKindle, goodreads: wzGoodreads, review: wzReview, rate: wzRate, done: wzDone })[step]();
}
const wzFoot = (left, right) => ($("#wz-foot").innerHTML = `${left || ""}<span class="spacer"></span>${right || ""}`);
$("#wz-foot").addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]"); if (!b) return;
  if (b.dataset.go === "next") wzNext(); else if (b.dataset.go === "back") wzBack(); else wzGo(b.dataset.go);
});
const BACK = `<button class="btn ghost" data-go="back">← Back</button>`;

/* step: sources */
function wzSources() {
  const s = refresh();
  const status = {
    kindle: s.kindle_ledger ? `✓ ${plural(s.kindle_ledger, "book")}, imported ${ago(s.kindle_last_sync)}` : "",
    goodreads: s.goodreads ? `✓ ${plural(s.goodreads, "book")}${store.setting("goodreads_last_import") ? `, imported ${ago(store.setting("goodreads_last_import"))}` : ""}` : "",
  };
  for (const box of $$("#wz-sources input")) box.checked = WZ.sources.includes(box.value);
  for (const el of $$("#wz-sources [data-status]")) el.textContent = status[el.dataset.status];
  wzSourcesFoot();
}
const wzSourcesFoot = () => wzFoot(`<button class="btn ghost" data-close>Close</button>`,
  `<button class="btn primary" data-go="next" ${WZ.sources.length ? "" : "disabled"}>${WZ.sources.length ? "Continue" : "Pick at least one"}</button>`);
$("#wz-sources").addEventListener("change", async (e) => {
  WZ.sources = SOURCES.filter((k) => $(`#wz-sources input[value="${k}"]`).checked);
  await store.setSetting("sources", WZ.sources);
  wzGo("sources");
  renderBanner();
});

/* step 1: Kindle */
function wzKindle() {
  const s = refresh();
  $("#wz-kindle-status").innerHTML = s.kindle_ledger
    ? `<div class="sync-box ok"><span class="big-check">✓</span><div class="msg"><b>${plural(s.kindle_ledger, "Kindle book")} imported</b><span class="muted small">Last imported ${ago(s.kindle_last_sync)}. Paste a fresh export to pick up new purchases.</span></div></div>` : "";
  wzFoot(BACK, s.kindle_ledger ? `<button class="btn primary" data-go="next">Continue</button>` : `<button class="btn ghost" data-go="next">Skip Kindle for now</button>`);
}
async function handleKindleText(text, statusEl) {
  try {
    if (/^\uFEFF?\s*"?Book Id"?,/.test(text)) { // a Goodreads export dropped in the Kindle box: import it as one
      const r = await imp.importGoodreads(text);
      if (!WZ.sources.includes("goodreads")) { WZ.sources.push("goodreads"); await store.setSetting("sources", WZ.sources); }
      toast(`That was your Goodreads export. ${goodreadsResult(r)}`, 4500); startEnrich(); refresh();
      return;
    }
    const { kind, items } = imp.parseKindleExport(text);
    if (kind === "finished") {
      const r = await imp.saveKindleFinished(items);
      const msg = `Finish dates for ${plural(r.matched, "Kindle book")}`;
      if (statusEl) { statusEl.className = "res"; statusEl.textContent = msg; } else toast(msg);
      if (WZ.step === "review") wzReview();
      return;
    }
    const r = await imp.saveKindleLibrary(items);
    toast(`${plural(r.fetched, "Kindle book")} read${r.added && r.added !== r.fetched ? `, ${r.added} new` : ""}`);
    refresh();
    await sleep(400);
    wzNext();
  } catch (err) {
    if (statusEl) { statusEl.className = "res err"; statusEl.textContent = err.message; } else toast(err.message, 5000);
  }
}
const zone = $("#paste-zone"), pasteBox = $("#wz-paste");
pasteBox.addEventListener("paste", (e) => { const t = e.clipboardData.getData("text"); if (t) { e.preventDefault(); pasteBox.value = ""; handleKindleText(t); } });
pasteBox.addEventListener("input", () => { const t = pasteBox.value.trim(); if (t.length > 40 && /[}\]]$/.test(t)) { pasteBox.value = ""; handleKindleText(t); } });
for (const d of [zone, $("#drop-finished")]) {
  d.addEventListener("dragover", (e) => { e.preventDefault(); d.classList.add("over"); });
  d.addEventListener("dragleave", () => d.classList.remove("over"));
  d.addEventListener("drop", async (e) => {
    e.preventDefault(); d.classList.remove("over");
    const f = e.dataTransfer.files[0]; if (f) handleKindleText(await f.text(), d === zone ? null : $(".res", d));
  });
}
$(".mini-paste").addEventListener("paste", (e) => { const t = e.clipboardData.getData("text"); if (t) { e.preventDefault(); handleKindleText(t, $(".res", $("#drop-finished"))); } });

/* step: Goodreads */
function wzGoodreads(result) {
  const s = refresh();
  const gr = store.all("books").filter((b) => b.goodreads_id);
  const read = gr.filter((b) => b.exclusive_shelf === "read").length, rated = gr.filter((b) => b.my_rating > 0).length,
    want = gr.filter((b) => b.exclusive_shelf === "to-read").length;
  const kindleNote = WZ.sources.includes("kindle") && s.kindle_ledger
    ? ` Next, your ${plural(s.kindle_ledger, "Kindle book")} ${s.kindle_ledger === 1 ? "is" : "are"} matched against them.` : "";
  $("#wz-gr-status").innerHTML = gr.length ? `<div class="sync-box ok"><span class="big-check">✓</span><div class="msg">
      <b>${plural(gr.length, "Goodreads book")}: ${read.toLocaleString()} read, ${rated.toLocaleString()} rated${want ? `, ${want.toLocaleString()} want to read` : ""}</b>
      <span class="muted small">${result ? `${goodreadsResult(result)}.` : `${store.setting("goodreads_last_import") ? `Imported ${ago(store.setting("goodreads_last_import"))}. ` : ""}Drop a fresh export to update.`}${kindleNote}</span></div></div>` : "";
  const onKindle = WZ.sources.includes("kindle") && s.kindle_ledger ? imp.kindleBookIds() : new Set();
  const stale = imp.staleReading().filter((b) => b.goodreads_id && !b.asin && !onKindle.has(b.id)); // Kindle ones count as read anyway
  if (stale.length) $("#wz-gr-status").insertAdjacentHTML("beforeend", `<div class="choice-list" style="margin-top:12px"><label class="check">
      <input type="checkbox" id="gr-stale" ${WZ.opts.stale_as_read ? "checked" : ""}>
      <span>Count ${plural(stale.length, "book")} stuck on “currently reading” as read<span class="note">On that shelf for over three months with no finish date, like ${stale.slice(0, 3).map((b) => `<i>${esc(b.title)}</i>`).join(", ")}. ${onKindle.size ? " Kindle books are counted as read anyway." : ""} Leave this unticked if you really are still reading them.</span></span></label></div>`);
  $("#gr-zone-text").innerHTML = gr.length ? "Drop a newer <b>goodreads_library_export.csv</b> here to update" : "Drop <b>goodreads_library_export.csv</b> here, or click to choose it";
  wzFoot(BACK, gr.length ? `<button class="btn primary" id="wz-gr-next">Continue</button>` : `<button class="btn ghost" data-go="next">Skip Goodreads for now</button>`);
  if (gr.length) $("#wz-gr-next").onclick = async () => {
    if (WZ.opts.stale_as_read && stale.length) toast(`${plural(await imp.markRead(stale), "book")} moved to read`);
    refresh(); wzNext();
  };
}
$("#wz-gr-status").addEventListener("change", (e) => { if (e.target.id === "gr-stale") WZ.opts.stale_as_read = e.target.checked; });
{
  const zone = $("#gr-zone"), input = $("#gr-file");
  const handle = async (file) => {
    if (!file) return;
    $("#gr-zone-text").innerHTML = `<span class="spinner"></span> Opening ${esc(file.name)}…`;
    try {
      const r = await imp.importGoodreads(await file.text());
      startEnrich();
      wzGoodreads(r);
    } catch (err) {
      wzGoodreads();
      $("#wz-gr-status").innerHTML = `<div class="sync-box err"><div class="msg"><b>That file didn't work</b><span class="small">${esc(err.message)}</span></div></div>`;
    }
  };
  input.addEventListener("change", () => { handle(input.files[0]); input.value = ""; });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); handle(e.dataTransfer.files[0]); });
}

/* step: review */
function wzReview() {
  const p = imp.kindlePreview(WZ.opts);
  const kindle = p.total - p.skipped - p.editions, fresh = p.new + p.flip;
  $("#wz-review-title").textContent = kindle ? `${plural(kindle, "book")} on your Kindle` : "Nothing imported from Kindle yet";
  $("#wz-review-lead").textContent = !kindle ? "Go back to bring in your Kindle library, or add your paper-book orders below."
    : !fresh ? "Everything on your Kindle is already in your library. Add finish dates or paper books below, or carry on."
    : `${p.new ? `${plural(p.new, "new book")} will be added as read` : "No new books"}${p.matched ? `, and ${p.matched.toLocaleString()} already in your library get their Kindle covers` : ""}. Ratings stay as they are.${p.editions ? ` ${plural(p.editions, "second edition")} (omnibus and single copies of the same book) ${p.editions === 1 ? "is" : "are"} folded in.` : ""}${p.with_dates ? ` Kindle knows when you finished ${p.with_dates} of the new ones.` : ""}`;
  $("#wz-review-stats").innerHTML = kindle ? [[kindle, "on your Kindle"], [p.matched, "already in your library"], [p.new, "new to your library", true],
    ...(p.samples ? [[p.samples, p.samples === 1 ? "free sample" : "free samples"]] : [])]
    .map(([v, l, hl]) => `<div class="stat ${hl ? "hl" : ""}"><div class="v">${(v || 0).toLocaleString()}</div><div class="l">${l}</div></div>`).join("") : "";
  $("#wz-new-wrap").hidden = !p.new;
  $("#wz-new-covers").innerHTML = p.new_books.map((b) => `<div title="${esc(b.title)}${b.author ? " — " + esc(b.author) : ""}">${cover(b)}</div>`).join("")
    + (p.new > p.new_books.length ? `<div class="cover ph" style="--h:0;filter:saturate(0)"><span class="pt">+${p.new - p.new_books.length} more</span></div>` : "");
  const flipNames = p.flip_books.slice(0, 4).map((b) => `<i>${esc(b.title)}</i>`).join(", ") + (p.flip > 4 ? ` and ${p.flip - 4} more` : "");
  const choices = [];
  if (p.flip || !WZ.opts.toread_as_read) choices.push(`<label class="check"><input type="checkbox" data-opt="toread_as_read" ${WZ.opts.toread_as_read ? "checked" : ""}>
      <span>Count Kindle books on my want-to-read or currently-reading shelves as read${p.flip ? ` (${p.flip})` : ""}<span class="note">${p.flip ? flipNames : "Bought on Kindle means read."}</span></span></label>`);
  if (p.samples) choices.push(`<label class="check"><input type="checkbox" data-opt="include_samples" ${WZ.opts.include_samples ? "checked" : ""}>
      <span>Include ${plural(p.samples, "free sample")}<span class="note">Left out by default: you downloaded them but didn't buy them.</span></span></label>`);
  $("#wz-choices").innerHTML = choices.join("");
  $("#wz-choices-wrap").hidden = !choices.length;
  const fin = store.setting("kindle_finished_sync");
  const finRes = $(".res", $("#drop-finished"));
  if (fin && !finRes.textContent) finRes.textContent = `✓ Finish dates imported ${ago(fin)}`;
  const label = fresh ? `Add ${plural(p.new || p.flip, "book")} to my library` : "Continue";
  wzFoot(BACK, `<button class="btn primary" id="wz-apply">${label}</button>`);
  $("#wz-apply").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "Adding…";
    try {
      if (kindle) {
        const r = await imp.kindleApply(WZ.opts);
        if (r.added || r.flipped) toast(`${plural(r.added, "book")} added${r.flipped ? `, ${r.flipped} moved to read` : ""}`);
        startEnrich();
      }
      refresh(); wzNext();
    } catch (err) { toast(err.message, 5000); e.target.disabled = false; e.target.textContent = label; }
  };
}
$("#wz-choices").addEventListener("change", (e) => { const o = e.target.dataset.opt; if (o) { WZ.opts[o] = e.target.checked; wzReview(); } });
for (const d of [$("#drop-orders")]) {
  const input = $("input[type=file]", d), res = $(".res", d);
  const handle = async (file) => {
    if (!file) return;
    res.className = "res"; res.innerHTML = `<span class="spinner"></span> Opening ${esc(file.name)}…`;
    try {
      const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
      const msg = await importFile(input, input.dataset.kind);
      res.textContent = msg;
      if (/^No paper books/.test(msg)) res.className = "res err";
      if (WZ.step === "review") wzReview();
    } catch (err) { res.className = "res err"; res.textContent = err.message; }
  };
  input.addEventListener("change", () => handle(input.files[0]));
  d.addEventListener("dragover", (e) => { e.preventDefault(); d.classList.add("over"); });
  d.addEventListener("dragleave", () => d.classList.remove("over"));
  d.addEventListener("drop", (e) => { e.preventDefault(); d.classList.remove("over"); handle(e.dataTransfer.files[0]); });
}

/* step 3: rate */
function wzRate() {
  WZ.toRate = store.all("books").filter((b) => b.exclusive_shelf === "read" && !b.my_rating)
    .sort((a, b) => (a.kindle_rank ?? 1e9) - (b.kindle_rank ?? 1e9) || (b.date_read || "").localeCompare(a.date_read || "")
      || (b.date_added || "").localeCompare(a.date_added || "") || b.id - a.id);
  WZ.shown = 0; WZ.rated = 0;
  const total = WZ.toRate.length;
  $("#wz-rate-lead").textContent = total
    ? `${plural(total, "book")} ${total === 1 ? "is" : "are"} read but unrated, ${WZ.toRate.some((b) => b.kindle_rank != null) ? "newest Kindle purchase" : "most recent"} first. A 5★ or a 1★ tells the recommender far more than a 3★. Skip any you don't remember.`
    : "Every book you've read has a rating. Nothing to do here.";
  $("#wz-rate").innerHTML = "";
  wzMoreToRate();
  wzRateFoot();
}
const wzRateFoot = () => wzFoot(`${BACK}<span class="rated-count">${WZ.rated ? `${plural(WZ.rated, "book")} rated` : ""}</span>`,
  `<button class="btn primary" data-go="done">${WZ.rated ? "Continue" : "Skip for now"}</button>`);
function wzMoreToRate() {
  const next = WZ.toRate.slice(WZ.shown, WZ.shown + 24);
  $("#wz-rate").insertAdjacentHTML("beforeend", next.map((b) => `<div class="rate-card" data-id="${b.id}">${cover(b)}
    <div class="t">${esc(b.title)}</div><div class="a">${esc(b.author || "")}</div>
    <div class="rate-stars" aria-label="Rate ${esc(b.title)}">${[1, 2, 3, 4, 5].map((i) => `<span data-v="${i}">★</span>`).join("")}</div></div>`).join(""));
  WZ.shown += next.length;
  $("#wz-more").hidden = WZ.shown >= WZ.toRate.length;
}
$("#wz-more").addEventListener("click", wzMoreToRate);
$("#wz-rate").addEventListener("mouseover", (e) => {
  const s = e.target.closest(".rate-stars span"); if (!s) return;
  $$("span", s.parentElement).forEach((x) => x.classList.toggle("hover", +x.dataset.v <= +s.dataset.v));
});
$("#wz-rate").addEventListener("mouseout", (e) => { const r = e.target.closest(".rate-stars"); if (r && !r.contains(e.relatedTarget)) $$("span", r).forEach((x) => x.classList.remove("hover")); });
$("#wz-rate").addEventListener("click", async (e) => {
  const s = e.target.closest(".rate-stars span"); if (!s) return;
  const card = s.closest(".rate-card"), b = store.get("books", +card.dataset.id), prev = b.my_rating || 0;
  const v = +s.dataset.v === prev ? 0 : +s.dataset.v;
  Object.assign(b, { my_rating: v, edited: true, updated_at: store.now() });
  await store.put("books", b);
  card.classList.toggle("rated", v > 0);
  $$(".rate-stars span", card).forEach((x) => x.classList.toggle("on", +x.dataset.v <= v));
  WZ.rated += (v > 0) - (prev > 0);
  wzRateFoot();
});

/* step 4: done */
function wzDone() {
  const s = refresh();
  $("#wz-done-lead").textContent = gb.progress.running ? "Covers, blurbs and genres are still filling in. Your picks can start now." : "Everything's in. Time to find your next book.";
  $("#wz-done-stats").innerHTML = [[s.books, "books in your library"], [s.shelves.read || 0, "read"], [s.rated, "rated"], ...(s.on_kindle ? [[s.on_kindle, "on your Kindle"]] : [])]
    .map(([v, l]) => `<div class="stat"><div class="v">${(v || 0).toLocaleString()}</div><div class="l">${l}</div></div>`).join("");
  const box = $("#wz-connect");
  box.hidden = s.key;
  if (!s.key) box.innerHTML = `<h3>Last step: connect OpenRouter</h3><p class="muted small" style="margin:0">Recommendations come from an AI model on your own OpenRouter account. Your browser talks to OpenRouter directly; this site never sees your key or your library.</p>${connectHTML()}`;
  wzFoot(`<button class="btn ghost" data-close>Close</button>`, `<button class="btn primary" id="wz-find" ${s.key ? "" : "disabled"}>Find my next book →</button>`);
  $("#wz-find").onclick = () => { closeOverlay($("#wizard")); show("discover"); startRun(); };
}

/* ---------- boot ---------- */
(async () => {
  try {
    await store.open();
  } catch (err) {
    document.body.innerHTML = `<div class="empty" style="padding:80px 24px"><h3>This browser won't let the app store your library</h3>${esc(err.message)}. Private windows in some browsers block storage; try a normal window.</div>`;
    return;
  }
  await rec.markInterrupted();
  try { if (await llm.finishSignIn()) toast("OpenRouter connected", 3500); }
  catch (err) { toast(err.message, 6000); }
  show(location.hash.slice(1) || "discover");
  if (!S.status.books && !S.status.kindle_ledger) openWizard();
  startEnrich();
})();
