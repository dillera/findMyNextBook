/* findMyNextBook — vanilla JS front end */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), ms);
}
const stars = (n) => `<span class="stars">${"★".repeat(n)}<span class="off">${"★".repeat(5 - n)}</span></span>`;
const kindleUrl = (t, a) => `https://www.amazon.com/s?k=${encodeURIComponent(`${t} ${a || ""}`.trim())}&i=digital-text`;
const coverHtml = (b, cls = "") => b.thumbnail
  ? `<img class="cover ${cls}" src="${esc(b.thumbnail)}" alt="" loading="lazy">`
  : `<div class="cover placeholder ${cls}"><span>${esc(b.title)}</span></div>`;

/* ---------- navigation ---------- */
const views = { library: loadBooks, stats: loadStats, recs: loadRecs, owned: loadOwned, add: () => $("#g-q").focus() };
function show(name) {
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  location.hash = name;
  views[name]?.();
}
$$("nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

/* ---------- library ---------- */
let layout = "grid";
let authorsLoaded = false;
async function loadBooks() {
  if (!authorsLoaded) {
    const authors = await api("/api/authors");
    $("#f-author").insertAdjacentHTML("beforeend", authors.map((a) => `<option value="${esc(a.author)}">${esc(a.author)} (${a.n})</option>`).join(""));
    authorsLoaded = true;
  }
  const [sort, dir] = $("#f-sort").value.split(":");
  const p = new URLSearchParams({ q: $("#q").value, shelf: $("#f-shelf").value, rating: $("#f-rating").value, author: $("#f-author").value, sort, dir });
  const { books, total } = await api(`/api/books?${p}`);
  $("#count").textContent = `${total} book${total === 1 ? "" : "s"}`;
  const el = $("#books");
  el.className = layout;
  el.innerHTML = books.map((b) => layout === "grid"
    ? `<div class="book" data-id="${b.id}">${coverHtml(b)}<div class="t">${esc(b.title)}</div><div class="a">${esc(b.author)}</div>
       <div>${b.my_rating ? stars(b.my_rating) : `<span class="badge ${b.exclusive_shelf}">${b.exclusive_shelf}</span>`}</div></div>`
    : `<div class="book" data-id="${b.id}">${coverHtml(b)}<div class="t">${esc(b.title)}</div><div class="a">${esc(b.author)}</div>
       <div class="meta">${stars(b.my_rating)}<span class="badge ${b.exclusive_shelf}">${b.exclusive_shelf}</span><span>${b.date_read || ""}</span><span>${b.pages ? b.pages + "p" : ""}</span></div></div>`
  ).join("") || `<p class="muted">Nothing here. Import your Goodreads CSV (top right) or add a book.</p>`;
}
function syncStarButtons() {
  $$(".star-seg button").forEach((b) => b.classList.toggle("active", b.dataset.star === $("#f-rating").value));
}
$$(".star-seg button").forEach((b) => b.addEventListener("click", () => {
  const same = $("#f-rating").value === b.dataset.star;
  $("#f-rating").value = same ? "" : b.dataset.star;   // click again to clear
  if (!same) $("#f-sort").value = "date_read:desc";
  syncStarButtons(); loadBooks();
}));
$("#f-rating").addEventListener("change", syncStarButtons);
let debounce;
$("#q").addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(loadBooks, 200); });
["#f-shelf", "#f-rating", "#f-author", "#f-sort"].forEach((s) => $(s).addEventListener("change", loadBooks));
$$(".seg button").forEach((b) => b.addEventListener("click", () => {
  layout = b.dataset.layout; $$(".seg button").forEach((x) => x.classList.toggle("active", x === b)); loadBooks();
}));
$("#books").addEventListener("click", (e) => { const card = e.target.closest(".book"); if (card) openBook(+card.dataset.id); });

/* ---------- drawer ---------- */
async function openBook(id) {
  const b = await api(`/api/books/${id}`);
  renderDrawer(b);
  $("#drawer").hidden = false; $("#backdrop").hidden = false;
}
function closeDrawer() { $("#drawer").hidden = true; $("#backdrop").hidden = true; }
$("#drawer-close").onclick = closeDrawer; $("#backdrop").onclick = closeDrawer;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); $("#modal").hidden = true; } });

function renderDrawer(b) {
  const year = b.original_year || b.year_published || (b.google_published || "").slice(0, 4);
  $("#drawer-body").innerHTML = `
    <div class="dhead">${coverHtml(b)}
      <div>
        <h2>${esc(b.title)}</h2>
        <div class="a">${esc(b.author)}${b.additional_authors ? ", " + esc(b.additional_authors) : ""}</div>
        <div class="big-stars" id="rate">${[1, 2, 3, 4, 5].map((i) => `<span data-v="${i}" class="${i <= b.my_rating ? "on" : ""}">★</span>`).join("")}</div>
        <div class="muted" style="font-size:12px">click a star to rate · click the same star to clear</div>
        <div class="actions">
          <select id="shelf">${["read", "currently-reading", "to-read", "abandoned"].map((s) => `<option ${s === b.exclusive_shelf ? "selected" : ""}>${s}</option>`).join("")}</select>
          <a class="kindle" href="${kindleUrl(b.title, b.author)}" target="_blank" rel="noopener"><button class="kindle">Kindle store ↗</button></a>
        </div>
      </div>
    </div>
    <div class="tags">${(b.categories || []).map((c) => `<span class="badge">${esc(c)}</span>`).join("")}</div>
    <dl class="kv">
      ${year ? `<dt>Published</dt><dd>${esc(year)}${b.publisher ? " · " + esc(b.publisher) : ""}</dd>` : ""}
      <dt>Pages</dt><dd>${b.pages || b.google_pages || "—"}</dd>
      <dt>Date read</dt><dd><input type="date" id="date_read" value="${esc(b.date_read || "")}" style="padding:3px 6px"></dd>
      <dt>Date added</dt><dd>${esc(b.date_added || "—")}</dd>
      ${b.google_rating ? `<dt>Google rating</dt><dd>${b.google_rating} ★ (${b.google_ratings_count || 0})</dd>` : ""}
      ${b.isbn13 ? `<dt>ISBN-13</dt><dd>${esc(b.isbn13)}</dd>` : ""}
      ${b.binding ? `<dt>Format</dt><dd>${esc(b.binding)}</dd>` : ""}
      ${b.goodreads_id ? `<dt>Goodreads</dt><dd><a href="https://www.goodreads.com/book/show/${b.goodreads_id}" target="_blank" rel="noopener">#${b.goodreads_id}</a></dd>` : ""}
      ${b.google_id ? `<dt>Google Books</dt><dd><a href="https://books.google.com/books?id=${esc(b.google_id)}" target="_blank" rel="noopener">open ↗</a></dd>` : ""}
    </dl>
    <p class="desc">${esc(b.description || "")}${!b.description ? `<span class="muted">No blurb yet. ${b.enrich_error ? "Google Books said: " + esc(b.enrich_error) + ". " : ""}</span>` : ""}</p>
    <div class="actions"><button id="enrich-one" class="small ghost">↻ Refresh from Google Books</button>
      <button id="delete" class="small ghost danger">Remove from library</button></div>
    <h4 style="margin:14px 0 6px">My notes</h4>
    <textarea id="notes" placeholder="Private notes…">${esc(b.user_notes || b.review || "")}</textarea>
    <div class="muted" style="font-size:12px;margin-top:4px">saved automatically</div>`;

  const patch = async (body) => { const nb = await api(`/api/books/${b.id}`, { method: "PATCH", body: JSON.stringify(body) }); Object.assign(b, nb); toast("Saved"); loadBooks(); return nb; };
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
  $("#shelf").onchange = async (e) => { await patch({ exclusive_shelf: e.target.value }); renderDrawer(b); };
  $("#date_read").onchange = (e) => patch({ date_read: e.target.value });
  let nt; $("#notes").oninput = (e) => { clearTimeout(nt); nt = setTimeout(() => patch({ user_notes: e.target.value }), 600); };
  $("#enrich-one").onclick = async (e) => {
    e.target.textContent = "Fetching…";
    const r = await api(`/api/books/${b.id}/enrich`, { method: "POST" });
    renderDrawer(r.book); loadBooks(); toast(r.ok ? "Updated from Google Books" : "Not found on Google Books");
  };
  $("#delete").onclick = async () => {
    if (!confirm(`Remove “${b.title}” from your library?`)) return;
    await api(`/api/books/${b.id}`, { method: "DELETE" }); closeDrawer(); loadBooks(); toast("Removed");
  };
}

/* ---------- import + enrich ---------- */
$("#import-file").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append("file", f);
  const r = await fetch("/api/import", { method: "POST", body: fd }).then((r) => r.json());
  toast(`Imported: ${r.inserted} new, ${r.updated} updated`); authorsLoaded = false; $("#f-author").innerHTML = '<option value="">All authors</option>'; loadBooks();
});
async function pollEnrich() {
  const p = await api("/api/enrich/progress");
  const st = $("#enrich-status");
  if (p.running) {
    st.innerHTML = `<span class="spinner"></span>${p.done}/${p.total} · ${esc(p.current)}`;
    $("#enrich-btn").disabled = true;
    setTimeout(pollEnrich, 1500);
    if (p.done % 20 === 0) loadBooks();
  } else {
    if ($("#enrich-btn").disabled) { toast(`Enrichment done: ${p.done - p.failed} matched, ${p.failed} not found`); loadBooks(); }
    st.textContent = ""; $("#enrich-btn").disabled = false;
  }
}
$("#enrich-btn").onclick = async () => { await api("/api/enrich", { method: "POST" }); pollEnrich(); };

/* ---------- stats ---------- */
const tip = $("#tip");
function attachTips(root) {
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
async function loadStats() {
  const s = await api("/api/stats");
  const thisYear = new Date().getFullYear().toString();
  const ty = s.by_year.find((y) => y.year === thisYear);
  $("#stat-tiles").innerHTML = [
    [s.shelves.read || 0, "books read"], [ty ? ty.n : 0, `read in ${thisYear}`], [s.total_pages.toLocaleString(), "pages read"],
    [s.avg_rating, "avg rating"], [s.shelves["currently-reading"] || 0, "in progress"], [s.shelves["to-read"] || 0, "to read"],
    [`${s.enriched}/${s.total}`, "enriched"],
  ].map(([v, l]) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  $("#chart-year").innerHTML = vbars(s.by_year, "year", "n", s.by_year.length > 14 ? 2 : 1);
  const ratings = [0, 1, 2, 3, 4, 5].map((r) => ({ label: r ? "★".repeat(r) : "unrated", n: s.ratings[r] || 0 }));
  $("#chart-rating").innerHTML = vbars(ratings, "label", "n");
  $("#chart-authors").innerHTML = hbars(s.authors, "author", "n", "avg_rating");
  $("#chart-cats").innerHTML = s.categories.length ? hbars(s.categories, "name", "n", "avg") : `<p class="muted">Run “Enrich from Google” to get genre data.</p>`;
  attachTips($("#view-stats"));
}

/* ---------- recommendations ---------- */
let modelsLoaded = false;
async function loadRecs() {
  const cfg = await api("/api/config");
  if (!$("#rec-model").value) $("#rec-model").value = cfg.default_model;
  if (!cfg.openrouter_key) $("#rec-status").innerHTML = `⚠️ No <code>OPENROUTER_API_KEY</code> in .env — recommendations won't run until you add one.`;
  if (!modelsLoaded && cfg.openrouter_key) {
    api("/api/models").then((ms) => { $("#model-list").innerHTML = ms.map((m) => `<option value="${esc(m.id)}">`).join(""); modelsLoaded = true; }).catch(() => {});
  }
  const runs = await api("/api/recommend/runs");
  const sel = $("#run-select");
  sel.innerHTML = runs.map((r) => `<option value="${r.id}">#${r.id} · ${r.created_at.slice(0, 16).replace("T", " ")} · ${esc(r.model)} · ${r.n} recs${r.status === "error" ? " · ERROR" : ""}${r.mood ? " · “" + esc(r.mood.slice(0, 30)) + "”" : ""}</option>`).join("") || `<option value="">none yet</option>`;
  if (runs.length) showRun(runs[0].id);
  else { $("#recs").innerHTML = ""; $("#taste").textContent = ""; }
}
$("#run-select").onchange = (e) => e.target.value && showRun(+e.target.value);
$("#hide-dismissed").onchange = () => { const v = $("#run-select").value; if (v) showRun(+v); };
async function showRun(id) {
  const run = await api(`/api/recommend/runs/${id}`);
  $("#taste").textContent = run.taste_summary || (run.error ? "Error: " + run.error : "");
  if (run.dropped && run.dropped.length) $("#taste").textContent += `  (${run.dropped.length} suggestion${run.dropped.length > 1 ? "s" : ""} dropped as already owned: ${run.dropped.map((d) => d.split(" ~ ")[0]).join(", ")})`;
  const hide = $("#hide-dismissed").checked;
  $("#recs").innerHTML = run.recommendations.filter((r) => !hide || r.status !== "dismissed").map((r) => `
    <div class="rec ${r.status}" data-id="${r.id}">${coverHtml(r)}
      <div>
        <h3><span class="rank">${r.rank}.</span>${esc(r.title)}</h3>
        <div class="a">${esc(r.author)}${r.year ? " · " + r.year : ""}</div>
        <div class="hook">${esc(r.hook || "")}</div>
        <div class="reason">${esc(r.reason || "")}</div>
        ${r.description ? `<div class="desc">${esc(r.description)}</div>` : ""}
        <div class="meta">${r.google_rating ? `<span>Google ${r.google_rating}★</span>` : ""}${(r.categories || []).slice(0, 3).map((c) => `<span class="badge">${esc(c)}</span>`).join("")}
          ${r.confidence != null ? `<span>confidence ${Math.round(r.confidence * 100)}%</span>` : ""}<span class="badge">${r.status}</span></div>
        <div class="actions">
          <a href="${esc(r.amazon_url || kindleUrl(r.title, r.author))}" target="_blank" rel="noopener"><button class="kindle small">Buy on Kindle ↗</button></a>
          <button class="small" data-act="bought">✓ Bought it</button>
          <button class="small ghost" data-act="added">+ To-read</button>
          <button class="small ghost" data-act="owned" title="Adds it to the Owned-on-Kindle list so it never comes back">📚 Already own it</button>
          <button class="small ghost" data-act="dismissed">✕ Not for me</button>
        </div>
      </div>
    </div>`).join("") || `<p class="muted">No recommendations in this run.</p>`;
}
$("#recs").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]"); if (!btn) return;
  const id = +btn.closest(".rec").dataset.id;
  await api(`/api/recommendations/${id}`, { method: "PATCH", body: JSON.stringify({ status: btn.dataset.act }) });
  toast({ bought: "Marked bought and shelved as to-read", added: "Added to to-read", dismissed: "Dismissed", owned: "Added to your owned list" }[btn.dataset.act]);
  showRun(+$("#run-select").value);
});
$("#rec-go").onclick = async () => {
  const btn = $("#rec-go"); btn.disabled = true;
  $("#rec-status").innerHTML = `<span class="spinner"></span>Asking ${esc($("#rec-model").value)}… this takes 20–60s`;
  try {
    const run = await api("/api/recommend", { method: "POST", body: JSON.stringify({ model: $("#rec-model").value || null, mood: $("#rec-mood").value || null, n: +$("#rec-n").value }) });
    $("#rec-status").textContent = ""; await loadRecs(); $("#run-select").value = run.id; showRun(run.id);
  } catch (err) { $("#rec-status").textContent = "Failed: " + err.message; }
  btn.disabled = false;
};
$("#rec-prompt").onclick = async () => {
  const p = await api(`/api/recommend/prompt?n=${$("#rec-n").value}`);
  $("#modal-pre").textContent = `SYSTEM:\n${p.system}\n\nUSER:\n${p.user}`; $("#modal").hidden = false;
};
$("#modal-close").onclick = () => ($("#modal").hidden = true);

/* ---------- owned on Kindle ---------- */
const KINDLE_SCRIPT = `(async()=>{const s=(ms)=>new Promise(r=>setTimeout(r,ms));let n=0;for(let i=0;i<200;i++){window.scrollTo(0,document.body.scrollHeight);await s(700);const c=document.querySelectorAll('[id^="title-"]').length;if(c===n&&i>3)break;n=c;}const out=[...document.querySelectorAll('[id^="title-"]')].map(t=>({title:t.textContent.trim(),author:(document.getElementById(t.id.replace('title-','author-'))||{}).textContent?.trim()||null}));const j=JSON.stringify(out);try{await navigator.clipboard.writeText(j);console.log('copied',out.length,'books');}catch(e){console.log(j);}})()`;
$("#kindle-script").textContent = KINDLE_SCRIPT;
async function loadOwned() {
  const { owned, total } = await api("/api/owned");
  $("#owned-count").textContent = total ? `(${total})` : "(empty)";
  $("#owned-list").innerHTML = owned.map((o) => `<span class="badge" title="${esc(o.source)}">${esc(o.title)}${o.author ? " · " + esc(o.author) : ""} <a href="#" data-del="${o.id}" style="text-decoration:none">×</a></span>`).join("");
}
$("#owned-list").addEventListener("click", async (e) => {
  const a = e.target.closest("a[data-del]"); if (!a) return; e.preventDefault();
  await api(`/api/owned/${a.dataset.del}`, { method: "DELETE" }); loadOwned();
});
$("#owned-add").onclick = async () => {
  const text = $("#owned-text").value.trim(); if (!text) return;
  const r = await api("/api/owned", { method: "POST", body: JSON.stringify({ text, source: text.startsWith("[") ? "kindle-web" : "paste" }) });
  toast(`Owned: ${r.added} added, ${r.skipped} already there`); $("#owned-text").value = ""; loadOwned();
};
$("#owned-file").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append("file", f);
  const r = await fetch("/api/owned/import", { method: "POST", body: fd }).then((r) => r.json());
  toast(`Owned: ${r.added} added, ${r.skipped} skipped of ${r.parsed} rows`); loadOwned(); e.target.value = "";
});
$("#owned-clear").onclick = async () => { if (confirm("Clear the whole owned list?")) { await api("/api/owned", { method: "DELETE" }); loadOwned(); } };

/* ---------- add via Google Books ---------- */
async function gsearch() {
  const q = $("#g-q").value.trim(); if (!q) return;
  $("#g-results").innerHTML = `<p class="muted"><span class="spinner"></span>Searching…</p>`;
  try {
    const hits = await api(`/api/google/search?q=${encodeURIComponent(q)}`);
    $("#g-results").innerHTML = hits.map((h, i) => `
      <div class="rec" data-i="${i}">${coverHtml(h)}
        <div><h3>${esc(h.title)}</h3><div class="a">${esc((h.authors || []).join(", "))}${h.google_published ? " · " + esc(h.google_published.slice(0, 4)) : ""}</div>
          ${h.description ? `<div class="desc">${esc(h.description)}</div>` : ""}
          <div class="meta">${h.google_rating ? `<span>Google ${h.google_rating}★</span>` : ""}${(h.categories || []).slice(0, 3).map((c) => `<span class="badge">${esc(c)}</span>`).join("")}${h.google_pages ? `<span>${h.google_pages}p</span>` : ""}</div>
          <div class="actions">
            <a href="${esc(h.amazon_url)}" target="_blank" rel="noopener"><button class="kindle small">Kindle store ↗</button></a>
            <button class="small" data-shelf="to-read">+ To-read</button>
            <button class="small ghost" data-shelf="currently-reading">Reading now</button>
            <button class="small ghost" data-shelf="read">Already read</button>
          </div></div></div>`).join("") || `<p class="muted">No results.</p>`;
    $("#g-results")._hits = hits;
  } catch (err) { $("#g-results").innerHTML = `<p class="muted">Search failed: ${esc(err.message)}</p>`; }
}
$("#g-go").onclick = gsearch; $("#g-q").addEventListener("keydown", (e) => e.key === "Enter" && gsearch());
$("#g-results").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-shelf]"); if (!btn) return;
  const h = $("#g-results")._hits[+btn.closest(".rec").dataset.i];
  try {
    const b = await api("/api/books", { method: "POST", body: JSON.stringify({
      title: h.title, author: (h.authors || [])[0], google_id: h.google_id, isbn13: h.isbn13, description: h.description,
      thumbnail: h.thumbnail, categories: h.categories, year: +(h.google_published || "").slice(0, 4) || null,
      pages: h.google_pages, google_rating: h.google_rating, exclusive_shelf: btn.dataset.shelf }) });
    toast(`Added “${b.title}” to ${btn.dataset.shelf}`); authorsLoaded = false;
    if (btn.dataset.shelf === "read") openBook(b.id);
  } catch (err) { toast(err.message); }
});

/* ---------- boot ---------- */
show(["library", "stats", "recs", "owned", "add"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "library");
pollEnrich();
