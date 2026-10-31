/* findMyNextBook — vanilla JS front end (no build step) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, one, many = one + "s") => `${(n ?? 0).toLocaleString()} ${n === 1 ? one : many}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const r = await fetch(path, { ...opts, headers: isForm ? {} : { "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return r.json();
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });
const upload = (path, file) => { const fd = new FormData(); fd.append("file", file); return api(path, { method: "POST", body: fd }); };

function toast(msg, ms = 2800) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- formatting ---------- */
const stars = (n) => `<span class="stars">${"★".repeat(n)}<span class="off">${"★".repeat(5 - n)}</span></span>`;
const kindleSearch = (t, a) => `https://www.amazon.com/s?k=${encodeURIComponent(`${t} ${a || ""}`.trim())}&i=digital-text`;
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
const modelNames = {};
const modelName = (id) => modelNames[id] || (id || "").split("/").pop().replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const hue = (s) => [...String(s || "")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
function placeholder(title, author, cls = "") {
  return `<div class="cover ph ${cls}" style="--h:${hue(title)}" aria-hidden="true"><span class="pt">${esc(title)}</span><span class="pa">${esc(author || "")}</span></div>`;
}
function cover(b, cls = "") {
  const src = b.thumbnail || b.cover;
  return src ? `<img class="cover ${cls}" src="${esc(src)}" alt="" loading="lazy" data-t="${esc(b.title)}" data-a="${esc(b.author || "")}">`
    : placeholder(b.title, b.author, cls);
}
// a dead cover URL becomes a generated cover instead of a broken image
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img.tagName === "IMG" && img.classList.contains("cover")) img.outerHTML = placeholder(img.dataset.t, img.dataset.a, [...img.classList].filter((c) => c !== "cover").join(" "));
}, true);

/* ---------- status (one call feeds the banner, the hero line, the chips and the header) ---------- */
const S = { status: null, cfg: null, layout: "grid", shelf: "all", tracking: null, showDismissed: false };
async function refreshStatus() {
  S.status = await api("/api/status");
  renderBanner(); renderHeroSub(); renderShelfChips(); renderBgPill();
  return S.status;
}
function renderHeroSub() {
  const s = S.status;
  $("#hero-sub").textContent = !s.openrouter_key ? "Add OPENROUTER_API_KEY to .env and restart to get recommendations."
    : !s.books ? "Import your books and you'll get picks matched to your taste."
    : `Picked from your ${plural(s.rated, "rated book")}${s.on_kindle ? ` and ${plural(s.on_kindle, "book")} on your Kindle` : ""}.`;
}
function renderBanner() {
  const s = S.status, el = $("#banner");
  let html = "";
  if (!s.books) html = `<span class="txt"><b>Your library is empty.</b> Import the books you've bought on Amazon to get started.</span><button class="btn sm primary" data-wizard>Import books</button>`;
  else if (s.kindle_pending) html = `<span class="txt"><b>${plural(s.kindle_pending, "Kindle book")}</b> from your last sync ${s.kindle_pending === 1 ? "isn't" : "aren't"} in your library yet.</span><button class="btn sm primary" data-wizard="review">Review</button>`;
  else if (!s.kindle_last_apply) html = `<span class="txt"><b>Your Kindle library isn't imported yet,</b> so picks may include books you already own.</span><button class="btn sm primary" data-wizard>Import from Amazon</button>`;
  el.innerHTML = html; el.hidden = !html;
}
function renderBgPill() {
  const s = S.status, el = $("#bg-pill");
  const e = s.enrich, k = s.kindle_sync;
  let html = "";
  if (k.running && $("#wizard").hidden) html = `<span class="spinner"></span>Syncing Kindle…`;
  else if (e.running) html = `<span class="spinner"></span>Fetching book details ${e.done}/${e.total}`;
  el.innerHTML = html; el.hidden = !html;
  if ((e.running || k.running) && !S._bgPoll) S._bgPoll = setTimeout(async () => {
    S._bgPoll = null; const wasRunning = e.running;
    await refreshStatus();
    if (wasRunning && !S.status.enrich.running && !$("#view-library").hidden) loadBooks();
  }, 2500);
}
document.addEventListener("click", (e) => {
  const w = e.target.closest("[data-wizard]"); if (w) openWizard(w.dataset.wizard || undefined);
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
function ensureCfg() {
  return (S.cfgP ||= api("/api/config").then((cfg) => {
    S.cfg = cfg;
    $("#rec-effort").value = cfg.last_effort; $("#rec-profile").value = cfg.last_profile;
    $("#rec-n").value = cfg.last_n || 10; $("#rec-verify").checked = cfg.last_verify !== false;
    loadModels().catch((e) => ($("#model-grid").innerHTML = `<span class="muted small">Couldn't load the model list (${esc(e.message)}). Type a slug below.</span>`));
  }));
}
async function loadDiscover() {
  await Promise.all([refreshStatus(), ensureCfg()]);
  await loadRuns();
}

async function loadModels() {
  const picked = new Set(S.cfg.last_models);
  const [anthropic, all] = await Promise.all([api("/api/models?provider=anthropic"), api("/api/models")]);
  const claude = [...anthropic, ...all.filter((m) => m.id === "typesafe/jev-router")];
  all.forEach((m) => (modelNames[m.id] = (m.name || m.id).replace(/^Anthropic:\s*/, "")));
  const price = (m) => (m.prompt_price != null ? `$${m.prompt_price} / $${m.completion_price} per M` : "");
  $("#model-grid").innerHTML = claude.map((m) => `
    <label class="model-opt"><input type="checkbox" value="${esc(m.id)}" ${picked.has(m.id) ? "checked" : ""}>
      <span><span class="nm">${esc(modelName(m.id))}</span><br>
      <span class="px">${m.id.includes("router") ? "picks the model per request" : price(m)}${m.effort || m.id.includes("router") ? "" : " · no effort control"}</span></span></label>`).join("");
  const custom = [...picked].filter((id) => !claude.some((m) => m.id === id));
  if (custom.length && !$("#rec-model").value) $("#rec-model").value = custom[0];
  $("#model-list").innerHTML = all.map((m) => `<option value="${esc(m.id)}">`).join("");
  if (S.run && !$("#results").hidden) showRun(S.run.id); // relabel with the catalog's model names
}
const pickedModels = () => {
  const boxes = $$("#model-grid input:checked").map((i) => i.value);
  const custom = $("#rec-model").value.trim();
  const list = [...boxes, custom].filter(Boolean);
  return list.length ? list : S.cfg?.last_models || [];
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
  await ensureCfg();
  const models = pickedModels();
  if (!models.length) { $("#options").open = true; toast("Pick a model under Options"); return; }
  if (models.length > 6) { toast("Pick at most 6 models"); return; }
  try {
    const res = await post("/api/recommend", {
      models, mood: $("#mood").value.trim() || null, n: +$("#rec-n").value || 10, effort: $("#rec-effort").value || null,
      profile: $("#rec-profile").value, verify: $("#rec-verify").checked });
    trackRuns(res.run_ids);
  } catch (err) { toast(err.message, 5000); }
}

const STAGES = [["thinking", "Thinking it over"], ["checking", "Checking the Kindle store"], ["enriching", "Adding blurbs"], ["done", "Done"]];
async function trackRuns(ids) {
  S.tracking = ids;
  $("#go").disabled = true; $("#go").textContent = "Finding…";
  $("#progress").hidden = false;
  try {
    for (;;) {
      const runs = await Promise.all(ids.map((id) => api(`/api/recommend/runs/${id}`)));
      renderProgress(runs);
      if (runs.every((r) => r.status !== "running")) {
        const ok = runs.find((r) => r.status === "done");
        if (ok) { await sleep(500); $("#progress").hidden = true; await loadRuns(ok.id); }
        const bad = runs.filter((r) => r.status === "error");
        if (bad.length && ok) toast(`${bad.map((r) => modelName(r.model)).join(", ")} failed: ${bad[0].error}`, 6000);
        break;
      }
      await sleep(1500);
    }
  } catch (err) { toast(err.message, 5000); }
  S.tracking = null;
  $("#go").disabled = false; $("#go").textContent = "Find my next book";
  refreshStatus();
}
function renderProgress(runs) {
  $("#progress").innerHTML = runs.map((r) => {
    const idx = r.status === "done" ? 4 : Math.max(0, STAGES.findIndex(([k]) => k === r.stage));
    const secs = (Date.now() - parseUTC(r.created_at)) / 1000;
    const label = r.status === "error" ? "failed" : r.status === "done" ? "done" : mmss(secs);
    return `<div class="prog-row"><div class="prog-model"><span>${esc(modelName(r.model))}${r.effort ? ` · ${esc(r.effort)} effort` : ""}</span><span class="t">${label}</span></div>
      <ol class="stages">${STAGES.map(([, name], i) => `<li class="${i < idx ? "done" : i === idx && r.status === "running" ? "active" : ""}">${name}</li>`).join("")}</ol>
      ${r.status === "error" ? `<div class="prog-err">${esc(r.error)}</div>` : ""}</div>`;
  }).join("") + (runs.some((r) => r.status === "running" && r.stage === "thinking") ? `<p class="muted small" style="margin:14px 0 0">Bigger models at high effort can take a few minutes.</p>` : "");
}

/* runs + history */
let runGroups = [];
async function loadRuns(selectId) {
  const runs = await api("/api/recommend/runs");
  const seen = new Set();
  runGroups = [];
  for (const r of runs) {
    if (r.batch_id) {
      if (seen.has(r.batch_id)) continue;
      seen.add(r.batch_id);
      runGroups.push(runs.filter((x) => x.batch_id === r.batch_id).sort((a, b) => a.id - b.id));
    } else runGroups.push([r]);
  }
  const running = runs.filter((r) => r.status === "running").map((r) => r.id);
  if (running.length && !S.tracking) { trackRuns(running); }
  const finished = runGroups.filter((g) => g.some((r) => r.status !== "running"));
  $("#run-select").innerHTML = finished.map((g) => {
    const r = g[0];
    const n = g.reduce((a, x) => a + x.n, 0);
    return `<option value="${r.id}">${esc(when(r.created_at))} · ${esc(g.map((x) => modelName(x.model)).join(" vs "))} · ${plural(n, "pick")}${r.mood ? ` · “${esc(r.mood.slice(0, 28))}”` : ""}</option>`;
  }).join("");
  const target = selectId || finished[0]?.[0]?.id;
  if (!target) { $("#results").hidden = true; return; }
  const group = runGroups.find((g) => g.some((r) => r.id === target));
  $("#run-select").value = group[0].id;
  showRun(target);
}
$("#run-select").addEventListener("change", (e) => showRun(+e.target.value));

async function showRun(id) {
  const run = await api(`/api/recommend/runs/${id}`);
  const group = runGroups.find((g) => g.some((r) => r.id === id)) || [run];
  $("#results").hidden = false;
  $("#model-tabs").hidden = group.length < 2;
  $("#model-tabs").innerHTML = group.map((r) => `<button class="chip ${r.id === id ? "active" : ""}" data-run="${r.id}">${esc(modelName(r.model))}${r.status === "error" ? " · failed" : ""}</button>`).join("");
  const served = run.served_model && run.served_model !== run.model ? ` → ${modelName(run.served_model)}` : "";
  $("#results-meta").textContent = [`${modelName(run.model)}${served}`, when(run.created_at), run.mood && `“${run.mood}”`].filter(Boolean).join(" · ");
  const taste = $("#taste");
  taste.hidden = !run.taste_summary && !run.error;
  taste.innerHTML = run.error ? `<span class="who">This run failed</span>${esc(run.error)}`
    : `<span class="who">Your taste, as ${esc(modelName(run.served_model || run.model))} reads it</span>${esc(run.taste_summary)}`;
  S.run = run;
  renderRecs();
}
$("#model-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-run]"); if (b) showRun(+b.dataset.run); });

function storeFacts(r) {
  const out = [];
  if (r.amazon_status === "available") out.push(`<span class="tag store">${r.price ? `Kindle ${esc(r.price)}` : "On Kindle"}</span>`);
  if (r.amazon_status === "not-found") out.push(`<span class="tag warn" title="The Kindle store search didn't turn up this exact book">Couldn't confirm on Kindle</span>`);
  if (r.ku) out.push(`<span class="tag">Kindle Unlimited</span>`);
  if (r.amazon_rating) out.push(`<span class="tag"><span class="star">★</span>${r.amazon_rating}${r.amazon_reviews ? ` · ${r.amazon_reviews.toLocaleString()}` : ""}</span>`);
  else if (r.google_rating) out.push(`<span class="tag"><span class="star">★</span>${r.google_rating}</span>`);
  if (r.also_by?.length) out.push(`<span class="tag agree" title="Also recommended by ${esc(r.also_by.map(modelName).join(", "))}">Also picked by ${esc(r.also_by.map(modelName).join(", "))}</span>`);
  genres(r.categories).slice(0, 2).forEach((c) => out.push(`<span class="tag">${esc(c)}</span>`));
  return out.join("");
}
// Google's categories run from "Fiction" to "JUVENILE FICTION / Action & Adventure / General": keep the useful head
function genres(cats) {
  const seen = new Set();
  return (cats || []).map((c) => c.split("/")[0].trim().toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()))
    .filter((c) => c && c !== "Fiction" && !seen.has(c) && seen.add(c));
}
const REC_STATE = { bought: "✓ Bought", added: "✓ On your want-to-read list", owned: "✓ Marked as read", dismissed: "Not for you" };
function recCard(r) {
  const url = r.amazon_url || kindleSearch(r.title, r.author);
  const buyLabel = r.amazon_status === "available" ? "View on Amazon" : "Find on Amazon";
  const by = [esc(r.author), r.year, r.series && esc(r.series)].filter(Boolean).join(" · ");
  return `<article class="rec st-${r.status}" data-id="${r.id}">
    <a href="${esc(url)}" target="_blank" rel="noopener" tabindex="-1">${cover(r)}</a>
    <div>
      <div class="rec-top"><span class="rank">${r.rank}</span><div><h3>${esc(r.title)}</h3><div class="byline">${by}</div></div></div>
      ${r.hook ? `<p class="hook">${esc(r.hook)}</p>` : ""}
      <p class="reason">${esc(r.reason || "")}</p>
      ${r.description ? `<p class="blurb" title="Click to expand">${esc(r.description)}</p>` : ""}
      <div class="facts">${storeFacts(r)}</div>
      <div class="rec-actions">
        <a class="btn sm buy" href="${esc(url)}" target="_blank" rel="noopener">${buyLabel} ↗</a>
        ${r.status === "new" ? `
          <span class="acts">
          <button class="btn sm" data-act="bought" title="Shelves it as want-to-read">Bought it</button>
          <button class="btn sm ghost" data-act="added">Want to read</button>
          <button class="btn sm ghost" data-act="owned" title="You've already read it: it goes into your library as read">Read it</button>
          <button class="btn sm ghost" data-act="dismissed" title="Future picks steer away from it">Not for me</button></span>`
        : `<span class="state">${REC_STATE[r.status] || esc(r.status)}</span>`}
      </div>
    </div></article>`;
}
function renderRecs() {
  const run = S.run;
  const recs = run.recommendations || [];
  const hidden = recs.filter((r) => r.status === "dismissed").length;
  const visible = recs.filter((r) => S.showDismissed || r.status !== "dismissed");
  $("#recs").innerHTML = visible.map(recCard).join("")
    || (run.error ? "" : `<div class="empty"><h3>No picks in this run</h3>Try again with a different steer.</div>`);
  const parts = [];
  if (hidden) parts.push(`<a href="#" data-toggle-dismissed>${S.showDismissed ? "Hide" : "Show"} ${plural(hidden, "dismissed pick")}</a>`);
  const dropped = (run.dropped || []).map((d) => (typeof d === "string" ? { title: d.split(" ~ ")[0], why: "already in your library" } : d));
  if (dropped.length) {
    const owned = dropped.filter((d) => d.why === "you own it on Kindle"), lib = dropped.filter((d) => d.why !== "you own it on Kindle");
    if (lib.length) parts.push(`Left out ${plural(lib.length, "pick")} already in your library: ${lib.map((d) => `<i>${esc(d.title)}</i>`).join(", ")}.`);
    if (owned.length) parts.push(`The Kindle store says you already own ${owned.map((d) => `<i>${esc(d.title)}</i>`).join(", ")}, so ${owned.length === 1 ? "it was" : "they were"} left out.`);
  }
  if (run.store_note) parts.push(esc(run.store_note));
  $("#dropped").innerHTML = parts.join(" ");
}
$("#dropped").addEventListener("click", (e) => { if (e.target.closest("[data-toggle-dismissed]")) { e.preventDefault(); S.showDismissed = !S.showDismissed; renderRecs(); } });
$("#recs").addEventListener("click", async (e) => {
  const blurb = e.target.closest(".blurb"); if (blurb) { blurb.classList.toggle("open"); return; }
  const btn = e.target.closest("button[data-act]"); if (!btn) return;
  const id = +btn.closest(".rec").dataset.id, act = btn.dataset.act;
  btn.disabled = true;
  try {
    await api(`/api/recommendations/${id}`, { method: "PATCH", body: JSON.stringify({ status: act }) });
    S.run.recommendations.find((r) => r.id === id).status = act;
    renderRecs();
    toast({ bought: "Added to your library as want-to-read", added: "Added to want-to-read", owned: "Added to your library as read; it won't come back", dismissed: "Noted. Future picks will steer away from it" }[act]);
    refreshStatus();
  } catch (err) { btn.disabled = false; toast(err.message); }
});
$("#rec-prompt").addEventListener("click", async () => {
  const p = await api(`/api/recommend/prompt?n=${$("#rec-n").value}&profile=${$("#rec-profile").value}`);
  $("#modal-title").textContent = `Prompt · ≈${Math.round(p.chars / 4).toLocaleString()} tokens`;
  $("#modal-pre").textContent = `SYSTEM\n${p.system}\n\nUSER\n${p.user}`;
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
$("#shelf-chips").addEventListener("click", (e) => {
  const c = e.target.closest("[data-shelf]"); if (!c) return;
  S.shelf = c.dataset.shelf; renderShelfChips(); loadBooks();
});
async function loadLibrary() { await refreshStatus(); loadBooks(); }
async function loadBooks() {
  const [sort, dir] = $("#f-sort").value.split(":");
  const p = new URLSearchParams({ q: $("#q").value, rating: $("#f-rating").value, sort, dir });
  if (S.shelf === "unrated") p.set("unrated", "true");
  else if (S.shelf === "kindle") p.set("kindle", "true");
  else if (S.shelf !== "all") p.set("shelf", S.shelf);
  const { books, total } = await api(`/api/books?${p}`);
  $("#lib-count").textContent = total.toLocaleString();
  const el = $("#books");
  el.className = S.layout;
  const SHELF = { read: "Read", "to-read": "Want to read", "currently-reading": "Reading", abandoned: "Abandoned" };
  el.innerHTML = books.map((b) => `<div class="book" data-id="${b.id}" tabindex="0">${cover(b)}
      <div class="t">${esc(b.title)}</div><div class="a">${esc(b.author || "Unknown author")}</div>
      <div class="meta">${b.my_rating ? stars(b.my_rating) : `<span class="tag ${b.exclusive_shelf}">${SHELF[b.exclusive_shelf] || esc(b.exclusive_shelf)}</span>`}
        ${S.layout === "list" && b.asin ? `<span class="tag">Kindle</span>` : ""}<span class="d">${esc((b.date_read || "").slice(0, 10))}</span></div></div>`).join("")
    || `<div class="empty" style="grid-column:1/-1"><h3>${S.status?.books ? "Nothing matches" : "Your library is empty"}</h3>${S.status?.books ? "Try another search or filter." : `<button class="btn primary" data-wizard style="margin-top:12px">Import your books</button>`}</div>`;
}
let qTimer;
$("#q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(loadBooks, 200); });
["#f-rating", "#f-sort"].forEach((s) => $(s).addEventListener("change", loadBooks));
$$(".seg button").forEach((b) => b.addEventListener("click", () => {
  S.layout = b.dataset.layout; $$(".seg button").forEach((x) => x.classList.toggle("active", x === b)); loadBooks();
}));
$("#books").addEventListener("click", (e) => { const c = e.target.closest(".book"); if (c) openBook(+c.dataset.id); });
$("#books").addEventListener("keydown", (e) => { const c = e.target.closest(".book"); if (c && e.key === "Enter") openBook(+c.dataset.id); });

/* ---------- drawer ---------- */
async function openBook(id) {
  renderDrawer(await api(`/api/books/${id}`));
  $("#drawer").hidden = false; $("#backdrop").hidden = false;
}
function closeDrawer() { $("#drawer").hidden = true; $("#backdrop").hidden = true; }
$("#drawer-close").onclick = closeDrawer; $("#backdrop").onclick = closeDrawer;
const SOURCE = { kindle: "Your Kindle library", "amazon-print": "Your Amazon orders", rec: "A recommendation", manual: "Added by hand" };
function renderDrawer(b) {
  const year = b.original_year || b.year_published || (b.google_published || "").slice(0, 4);
  const source = b.goodreads_id ? "Goodreads" + (b.asin ? " + your Kindle library" : "") : SOURCE[b.source] || (b.asin ? SOURCE.kindle : "");
  $("#drawer-body").innerHTML = `
    <div class="dhead">${cover(b)}
      <div>
        <h2>${esc(b.title)}</h2>
        <div class="byline"><span class="author-link" data-author="${esc(b.author || "")}" title="Show their books">${esc(b.author || "Unknown author")}</span>${b.additional_authors ? ", " + esc(b.additional_authors) : ""}</div>
        <div class="big-stars" id="rate">${[1, 2, 3, 4, 5].map((i) => `<span data-v="${i}" class="${i <= b.my_rating ? "on" : ""}">★</span>`).join("")}</div>
        <div class="hint">${b.my_rating ? "Click the same star to clear" : "Not rated yet"}</div>
        <div class="dactions">
          <select id="shelf" aria-label="Shelf">${[["read", "Read"], ["currently-reading", "Reading"], ["to-read", "Want to read"], ["abandoned", "Abandoned"]].map(([v, l]) => `<option value="${v}" ${v === b.exclusive_shelf ? "selected" : ""}>${l}</option>`).join("")}</select>
          ${b.asin ? `<a class="btn sm" href="https://read.amazon.com/?asin=${esc(b.asin)}" target="_blank" rel="noopener">Read in Kindle ↗</a>
                     <a class="btn sm ghost" href="https://www.amazon.com/dp/${esc(b.asin)}" target="_blank" rel="noopener">Amazon page ↗</a>`
                   : `<a class="btn sm buy" href="${kindleSearch(b.title, b.author)}" target="_blank" rel="noopener">Find on Kindle ↗</a>`}
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
      ${b.goodreads_id ? `<dt>Goodreads</dt><dd><a href="https://www.goodreads.com/book/show/${b.goodreads_id}" target="_blank" rel="noopener">View ↗</a></dd>` : ""}
    </dl>
    <p class="desc">${b.description ? esc(b.description) : `<span class="muted">No blurb yet.${b.enrich_error ? ` Google Books said: ${esc(b.enrich_error)}.` : ""}</span>`}</p>
    <div class="drawer-h">Notes</div>
    <textarea id="notes" placeholder="Private notes… (saved automatically)">${esc(b.user_notes || b.review || "")}</textarea>
    <div class="dactions" style="margin-top:22px">
      <button id="enrich-one" class="btn sm ghost">↻ Refresh details</button>
      <button id="delete" class="btn sm ghost danger">Remove from library</button>
    </div>`;
  const patch = async (body) => { const nb = await api(`/api/books/${b.id}`, { method: "PATCH", body: JSON.stringify(body) }); Object.assign(b, nb); toast("Saved"); if (!$("#view-library").hidden) loadBooks(); refreshStatus(); return nb; };
  const rate = $("#rate");
  rate.addEventListener("mouseover", (e) => { const v = +e.target.dataset.v; if (v) $$("span", rate).forEach((s) => s.classList.toggle("hover", +s.dataset.v <= v)); });
  rate.addEventListener("mouseleave", () => $$("span", rate).forEach((s) => s.classList.remove("hover")));
  rate.addEventListener("click", async (e) => {
    const v = +e.target.dataset.v; if (!v) return;
    const nv = v === b.my_rating ? 0 : v;
    const body = { my_rating: nv };
    if (nv && b.exclusive_shelf !== "read") body.exclusive_shelf = "read";
    await patch(body); renderDrawer(b);
  });
  $(".author-link").onclick = (e) => { closeDrawer(); S.shelf = "all"; $("#q").value = e.target.dataset.author; show("library"); };
  $("#shelf").onchange = async (e) => { await patch({ exclusive_shelf: e.target.value }); renderDrawer(b); };
  $("#date_read").onchange = (e) => patch({ date_read: e.target.value });
  let nt; $("#notes").oninput = (e) => { clearTimeout(nt); nt = setTimeout(() => patch({ user_notes: e.target.value }), 700); };
  $("#enrich-one").onclick = async (e) => {
    e.target.textContent = "Fetching…"; e.target.disabled = true;
    try { const r = await post(`/api/books/${b.id}/enrich`); renderDrawer(r.book); toast(r.ok ? "Details updated" : "Not found on Google Books or Open Library"); }
    catch (err) { toast(err.message); e.target.textContent = "↻ Refresh details"; e.target.disabled = false; }
  };
  $("#delete").onclick = async () => {
    if (!confirm(`Remove “${b.title}” from your library?`)) return;
    await api(`/api/books/${b.id}`, { method: "DELETE" }); closeDrawer(); loadBooks(); refreshStatus(); toast("Removed");
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
    const hits = await api(`/api/google/search?q=${encodeURIComponent(q)}`);
    out._hits = hits;
    out.innerHTML = hits.map((h, i) => `<div class="hit" data-i="${i}">${cover({ ...h, author: (h.authors || [])[0] })}
      <div><h3>${esc(h.title)}</h3><div class="byline">${esc((h.authors || []).join(", "))}${h.google_published ? " · " + esc(h.google_published.slice(0, 4)) : ""}</div>
        ${h.description ? `<p class="blurb">${esc(h.description)}</p>` : ""}
        <div class="rec-actions">
          <button class="btn sm primary" data-shelf="read">Read it</button>
          <button class="btn sm" data-shelf="to-read">Want to read</button>
          <button class="btn sm ghost" data-shelf="currently-reading">Reading now</button>
        </div></div></div>`).join("") || `<p class="muted">No results.</p>`;
  } catch (err) { out.innerHTML = `<p class="muted">Search failed: ${esc(err.message)}</p>`; }
});
$("#g-results").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-shelf]"); if (!btn) return;
  const h = $("#g-results")._hits[+btn.closest(".hit").dataset.i];
  try {
    const b = await post("/api/books", {
      title: h.title, author: (h.authors || [])[0], google_id: h.google_id, isbn13: h.isbn13, description: h.description,
      thumbnail: h.thumbnail, categories: h.categories, year: +(h.google_published || "").slice(0, 4) || null,
      pages: h.google_pages, google_rating: h.google_rating, exclusive_shelf: btn.dataset.shelf });
    toast(`Added “${b.title}”`); refreshStatus();
    btn.closest(".rec-actions").innerHTML = `<span class="state">✓ Added</span>`;
    if (!$("#view-library").hidden) loadBooks();
  } catch (err) { toast(err.message); }
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
async function loadInsights() {
  const s = await api("/api/stats");
  const thisYear = String(new Date().getFullYear());
  const ty = s.by_year.find((y) => y.year === thisYear);
  $("#stat-tiles").innerHTML = [
    [(s.shelves.read || 0).toLocaleString(), "books read"], [ty ? ty.n : 0, `read in ${thisYear}`], [s.total_pages.toLocaleString(), "pages read"],
    [s.avg_rating || "—", "average rating"], [(s.on_kindle || 0).toLocaleString(), "on your Kindle"], [(s.shelves["to-read"] || 0).toLocaleString(), "want to read"],
  ].map(([v, l]) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  $("#chart-year").innerHTML = s.by_year.length ? vbars(s.by_year, "year", "n", s.by_year.length > 14 ? 2 : 1) : `<p class="muted">No read dates yet.</p>`;
  const ratings = [1, 2, 3, 4, 5].map((r) => ({ label: "★".repeat(r), n: s.ratings[r] || 0 }));
  $("#chart-rating").innerHTML = vbars(ratings, "label", "n") + `<p class="muted small" style="margin:6px 0 0">${plural(s.ratings[0] || 0, "read book")} unrated.</p>`;
  $("#chart-authors").innerHTML = hbars(s.authors.filter((a) => a.author), "author", "n", "avg_rating");
  $("#chart-cats").innerHTML = s.categories.length ? hbars(s.categories, "name", "n", "avg") : `<p class="muted">Genres appear once book details have been fetched (Settings).</p>`;
  attachTips($("#view-insights"));
}

/* ================================================================================================
   OVERLAYS
   ================================================================================================ */
function openOverlay(sel) { $(sel).hidden = false; }
function closeOverlay(el) {
  el.hidden = true;
  if (el.id === "wizard") onWizardClosed();
}
$$(".overlay").forEach((o) => {
  o.addEventListener("mousedown", (e) => { if (e.target === o) o._down = true; });
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
$("#open-settings").addEventListener("click", async () => { await refreshStatus(); renderSettings(); openOverlay("#settings"); });
function renderSettings() {
  const s = S.status;
  $("#settings-body").innerHTML = `
    <div class="set-row"><div class="txt"><b>Kindle library</b><span>${s.kindle_ledger ? `${plural(s.kindle_ledger, "book")} · synced ${ago(s.kindle_last_sync)}` : "Not imported yet"}</span></div>
      <button class="btn sm" data-wizard>${s.kindle_ledger ? "Sync again" : "Import"}</button></div>
    <div class="set-row"><div class="txt"><b>Goodreads</b><span>${s.goodreads ? `${plural(s.goodreads, "book")} from your Goodreads export` : "Ratings and read dates from a Goodreads export"}</span></div>
      <label class="btn sm">Import CSV<input type="file" accept=".csv" hidden id="set-goodreads"></label></div>
    <div class="set-row"><div class="txt"><b>Book details</b><span>Covers, blurbs and genres for ${s.enriched.toLocaleString()} of ${plural(s.books, "book")}${s.enrich.running ? ` · fetching ${s.enrich.done}/${s.enrich.total}` : ""}</span></div>
      <button class="btn sm" id="set-enrich" ${s.enrich.running ? "disabled" : ""}>Fetch missing</button></div>
    <div class="set-row"><div class="txt"><b>API keys</b><span>Set in <code>.env</code>, then restart the server.</span>
      <span style="display:block;margin-top:6px"><span class="ok-dot ${s.openrouter_key ? "" : "no"}"></span>OpenRouter ${s.openrouter_key ? "connected" : "missing: recommendations won't run"}</span>
      <span style="display:block"><span class="ok-dot ${s.google_key ? "" : "no"}"></span>Google Books ${s.google_key ? "connected" : "missing: using the shared quota and Open Library"}</span></div></div>`;
  $("#set-goodreads").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const r = await upload("/api/import", f); toast(goodreadsResult(r)); await refreshStatus(); renderSettings(); }
    catch (err) { toast(err.message, 5000); }
  };
  $("#set-enrich").onclick = async () => { await post("/api/enrich"); await refreshStatus(); renderSettings(); };
}
const goodreadsResult = (r) => `Goodreads: ${r.inserted} added, ${r.updated} updated${r.merged ? `, ${r.merged} matched to Kindle books` : ""}`;

/* ================================================================================================
   IMPORT WIZARD
   ================================================================================================ */
const WZ = { step: "connect", startedSync: false, opts: { include_samples: false, toread_as_read: true }, preview: null, shown: 0, rated: 0, total: 0 };
const WZ_STEPS = ["connect", "review", "rate", "done"];

async function openWizard(step) {
  await refreshStatus();
  $("#settings").hidden = true;
  openOverlay("#wizard");
  if (!$("#wz-script").textContent) api("/api/kindle/script").then((r) => ($("#wz-script").textContent = r.script));
  wzGo(step || (S.status.kindle_pending ? "review" : "connect"));
}
function onWizardClosed() { refreshStatus(); const v = location.hash.slice(1) || "discover"; if (v === "library") loadBooks(); }
$("#open-import").addEventListener("click", () => openWizard());

function wzGo(step) {
  WZ.step = step;
  const i = WZ_STEPS.indexOf(step);
  $$("#wz-steps li").forEach((li, j) => { li.classList.toggle("active", j === i); li.classList.toggle("done", j < i); });
  $$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== step));
  $("#wizard .sheet-body").scrollTop = 0;
  ({ connect: wzConnect, review: wzReview, rate: wzRate, done: wzDone })[step]();
}
function wzFoot(left, right) {
  $("#wz-foot").innerHTML = `${left || ""}<span class="spacer"></span>${right || ""}`;
}
$("#wz-foot").addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]"); if (b) wzGo(b.dataset.go);
});

/* step 1: connect */
function wzConnect() {
  renderSyncBox(S.status.kindle_sync);
  if (S.status.kindle_sync.running) pollSync();
}
function renderSyncBox(p) {
  const s = S.status, box = $("#wz-sync");
  const synced = s.kindle_ledger > 0;
  let html = "";
  if (p.running) {
    const hint = p.phase === "waiting-login" ? `<span class="muted small">The Chrome window may be behind this one. This continues on its own once you're signed in.</span>` : "";
    html = `<div class="sync-box"><span class="spinner lg"></span><div class="msg"><b>${esc(p.message || "Working…")}</b>${hint}</div></div>`;
  } else if (p.phase === "error") {
    html = `<div class="sync-box err"><div class="msg"><b>That didn't work</b>${esc(p.message)}</div></div>`;
  } else if (synced) {
    html = `<div class="sync-box ok"><span class="big-check">✓</span><div class="msg"><b>${plural(s.kindle_ledger, "Kindle book")} imported</b><span class="muted small">Last synced ${ago(s.kindle_last_sync)}. Sync again to pick up new purchases.</span></div></div>`;
  }
  box.innerHTML = html;
  wzFoot(`<button class="btn ghost" data-close>Close</button>`,
    `${synced || !p.running ? `<button class="btn ghost" data-go="review">${synced ? "Continue without syncing" : "Skip"}</button>` : ""}
     <button class="btn primary" id="wz-connect" ${p.running ? "disabled" : ""}>${p.running ? "Connecting…" : synced ? "Sync again" : p.phase === "error" ? "Try again" : "Connect Amazon"}</button>`);
  const btn = $("#wz-connect");
  if (btn) btn.onclick = async () => {
    WZ.startedSync = true;
    renderSyncBox(await post("/api/kindle/sync"));
    pollSync();
  };
}
async function pollSync() {
  if (WZ._polling) return; WZ._polling = true;
  try {
    for (;;) {
      const p = await api("/api/kindle/sync");
      if (!p.running) {
        await refreshStatus();
        if (WZ.step === "connect") renderSyncBox(p);
        if (p.phase === "done" && WZ.startedSync && WZ.step === "connect" && !$("#wizard").hidden) { WZ.startedSync = false; await sleep(900); wzGo("review"); }
        break;
      }
      if (WZ.step === "connect") renderSyncBox(p);
      await sleep(1200);
    }
  } finally { WZ._polling = false; }
}
$("#wz-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#wz-script").textContent); toast("Copied. Paste it into the console on read.amazon.com"); }
  catch { toast("Select the script and copy it by hand"); }
});
$("#wz-paste-go").addEventListener("click", async () => {
  const text = $("#wz-paste").value.trim(); if (!text) { toast("Paste the copied library first"); return; }
  try {
    const r = await post("/api/kindle/paste", { text });
    toast(`${plural(r.fetched, "Kindle book")} read`); $("#wz-paste").value = ""; $("#wz-alt").open = false;
    await refreshStatus(); wzGo("review");
  } catch (err) { toast(err.message, 5000); }
});

/* step 2: review */
async function wzReview() {
  wzFoot(`<button class="btn ghost" data-go="connect">← Back</button>`, `<button class="btn primary" disabled>Loading…</button>`);
  const qs = new URLSearchParams({ include_samples: WZ.opts.include_samples, toread_as_read: WZ.opts.toread_as_read });
  const p = WZ.preview = await api(`/api/kindle/preview?${qs}`);
  const kindle = p.total - p.skipped;
  const fresh = p.new + p.flip;
  $("#wz-review-title").textContent = kindle ? `${plural(kindle, "book")} on your Kindle` : "Nothing imported from Kindle yet";
  $("#wz-review-lead").textContent = !kindle ? "Go back to connect Amazon, or add a Goodreads export or your paper-book orders below."
    : !fresh ? "Everything on your Kindle is already in your library. Add a Goodreads export or paper books below, or carry on."
    : `${p.new ? `${plural(p.new, "new book")} will be added as read` : "No new books"}${p.matched ? `, and ${p.matched.toLocaleString()} already in your library get their Kindle covers` : ""}. Your Goodreads ratings stay as they are.${p.with_dates ? ` Kindle knows when you finished ${p.with_dates} of the new ones.` : ""}`;
  $("#wz-review-stats").innerHTML = kindle ? [
    [kindle, "on your Kindle"], [p.matched, "already in your library"], [p.new, "new to your library", true],
    ...(p.samples ? [[p.samples, p.samples === 1 ? "free sample" : "free samples"]] : []),
  ].map(([v, l, hl]) => `<div class="stat ${hl ? "hl" : ""}"><div class="v">${(v || 0).toLocaleString()}</div><div class="l">${l}</div></div>`).join("") : "";
  $("#wz-new-wrap").hidden = !p.new;
  $("#wz-new-covers").innerHTML = p.new_books.map((b) => `<div title="${esc(b.title)}${b.author ? " — " + esc(b.author) : ""}">${cover(b)}</div>`).join("")
    + (p.new > p.new_books.length ? `<div class="cover ph" style="--h:0;filter:saturate(0)"><span class="pt">+${p.new - p.new_books.length} more</span></div>` : "");
  const flipNames = p.flip_books.slice(0, 4).map((b) => `<i>${esc(b.title)}</i>`).join(", ") + (p.flip > 4 ? ` and ${p.flip - 4} more` : "");
  const choices = [];
  if (p.flip || !WZ.opts.toread_as_read) choices.push(`<label class="check"><input type="checkbox" data-opt="toread_as_read" ${WZ.opts.toread_as_read ? "checked" : ""}>
      <span>Count Kindle books on my want-to-read shelf as read${p.flip ? ` (${p.flip})` : ""}<span class="note">${p.flip ? flipNames : "Bought on Kindle means read."}</span></span></label>`);
  if (p.samples) choices.push(`<label class="check"><input type="checkbox" data-opt="include_samples" ${WZ.opts.include_samples ? "checked" : ""}>
      <span>Include ${plural(p.samples, "free sample")}<span class="note">Left out by default: you downloaded them but didn't buy them.</span></span></label>`);
  $("#wz-choices").innerHTML = choices.join("") || `<span class="muted small">Nothing to decide here.</span>`;
  $("#wz-choices").closest(".wz-section").hidden = !choices.length;
  const label = fresh ? `Add ${plural(p.new || p.flip, "book")} to my library` : "Continue";
  wzFoot(`<button class="btn ghost" data-go="connect">← Back</button>`, `<button class="btn primary" id="wz-apply">${label}</button>`);
  $("#wz-apply").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "Adding…";
    try {
      if (kindle) {
        const r = await post("/api/kindle/apply", WZ.opts);
        if (r.added || r.flipped) toast(`${plural(r.added, "book")} added${r.flipped ? `, ${r.flipped} moved to read` : ""}`);
      }
      await refreshStatus(); wzGo("rate");
    } catch (err) { toast(err.message, 5000); e.target.disabled = false; e.target.textContent = label; }
  };
}
$("#wz-choices").addEventListener("change", (e) => { const o = e.target.dataset.opt; if (o) { WZ.opts[o] = e.target.checked; wzReview(); } });
$$(".drop").forEach((d) => {
  const input = $("input[type=file]", d), res = $(".res", d);
  const handle = async (file) => {
    if (!file) return;
    res.className = "res"; res.innerHTML = `<span class="spinner"></span> Reading ${esc(file.name)}…`;
    try {
      if (input.dataset.kind === "goodreads") res.textContent = goodreadsResult(await upload("/api/import", file));
      else {
        const r = await upload("/api/amazon/orders", file);
        if (!r.found) { res.className = "res err"; res.textContent = `No paper books found in ${r.rows.toLocaleString()} order rows`; }
        else res.textContent = `${plural(r.found, "paper book")}: ${r.added} added, ${r.matched} already in your library`;
      }
      await refreshStatus();
      if (WZ.step === "review") wzReview();
    } catch (err) { res.className = "res err"; res.textContent = err.message; }
    input.value = "";
  };
  input.addEventListener("change", () => handle(input.files[0]));
  d.addEventListener("dragover", (e) => { e.preventDefault(); d.classList.add("over"); });
  d.addEventListener("dragleave", () => d.classList.remove("over"));
  d.addEventListener("drop", (e) => { e.preventDefault(); d.classList.remove("over"); handle(e.dataTransfer.files[0]); });
});

/* step 3: rate */
async function wzRate() {
  WZ.shown = 0; WZ.rated = 0;
  $("#wz-rate").innerHTML = "";
  await wzMoreToRate();
  wzRateFoot();
}
function wzRateFoot() {
  wzFoot(`<button class="btn ghost" data-go="review">← Back</button><span class="rated-count">${WZ.rated ? `${plural(WZ.rated, "book")} rated` : ""}</span>`,
    `<button class="btn primary" data-go="done">${WZ.rated ? "Continue" : "Skip for now"}</button>`);
}
async function wzMoreToRate() {
  const { books, total } = await api(`/api/books/to-rate?limit=24&offset=${WZ.shown - WZ.rated}`);
  if (!WZ.shown) {
    WZ.total = total;
    $("#wz-rate-lead").innerHTML = total
      ? `${plural(total, "book")} ${total === 1 ? "is" : "are"} read but unrated, newest Kindle purchase first. A 5★ or a 1★ tells the recommender far more than a 3★. Skip any you don't remember.`
      : "Every book you've read has a rating. Nothing to do here.";
  }
  $("#wz-rate").insertAdjacentHTML("beforeend", books.map((b) => `<div class="rate-card" data-id="${b.id}">${cover(b)}
    <div class="t">${esc(b.title)}</div><div class="a">${esc(b.author || "")}</div>
    <div class="rate-stars" aria-label="Rate ${esc(b.title)}">${[1, 2, 3, 4, 5].map((i) => `<span data-v="${i}">★</span>`).join("")}</div></div>`).join(""));
  WZ.shown += books.length;
  $("#wz-more").hidden = WZ.shown - WZ.rated >= WZ.total - WZ.rated || !books.length;
}
$("#wz-more").addEventListener("click", wzMoreToRate);
$("#wz-rate").addEventListener("mouseover", (e) => {
  const s = e.target.closest(".rate-stars span"); if (!s) return;
  $$("span", s.parentElement).forEach((x) => x.classList.toggle("hover", +x.dataset.v <= +s.dataset.v));
});
$("#wz-rate").addEventListener("mouseout", (e) => { const r = e.target.closest(".rate-stars"); if (r && !r.contains(e.relatedTarget)) $$("span", r).forEach((x) => x.classList.remove("hover")); });
$("#wz-rate").addEventListener("click", async (e) => {
  const s = e.target.closest(".rate-stars span"); if (!s) return;
  const card = s.closest(".rate-card"), prev = +(card.dataset.rating || 0);
  const v = +s.dataset.v === prev ? 0 : +s.dataset.v;
  try {
    await api(`/api/books/${card.dataset.id}`, { method: "PATCH", body: JSON.stringify({ my_rating: v }) });
    card.dataset.rating = v;
    card.classList.toggle("rated", v > 0);
    $$(".rate-stars span", card).forEach((x) => x.classList.toggle("on", +x.dataset.v <= v));
    WZ.rated += (v > 0) - (prev > 0);
    wzRateFoot();
  } catch (err) { toast(err.message); }
});

/* step 4: done */
async function wzDone() {
  const s = await refreshStatus();
  $("#wz-done-lead").textContent = s.enrich.running ? "Blurbs and genres are still filling in in the background. Your picks can start now."
    : "Everything's in. Time to find your next book.";
  $("#wz-done-stats").innerHTML = [[s.books, "books in your library"], [s.rated, "rated"], [s.on_kindle, "on your Kindle"]]
    .map(([v, l]) => `<div class="stat"><div class="v">${(v || 0).toLocaleString()}</div><div class="l">${l}</div></div>`).join("");
  wzFoot(`<button class="btn ghost" data-close>Close</button>`, `<button class="btn primary" id="wz-find" ${s.openrouter_key ? "" : "disabled title='Add OPENROUTER_API_KEY to .env first'"}>Find my next book →</button>`);
  $("#wz-find").onclick = () => { closeOverlay($("#wizard")); show("discover"); startRun(); };
}

/* ---------- boot ---------- */
(async () => {
  show(location.hash.slice(1) || "discover");
  const s = S.status || (await refreshStatus());
  if (!s.books && !s.kindle_ledger) openWizard("connect");
})();
