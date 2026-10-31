// The script visitors run on Amazon's own pages, as a bookmarklet or pasted into the browser console.
// It reads their Kindle data with their own Amazon session, in their own browser, and hands it to them: copied to
// the clipboard, or as a file to download. They then paste or drop it into findMyNextBook. It never sends anything
// anywhere: there is no network call in it except the two Amazon reads below, made to the page's own origin.
//
//   on read.amazon.com   → /kindle-library/search: every Kindle book, newest purchase first
//   on www.amazon.com    → /kindle/reading/insights/data: the books Kindle saw you finish, with dates
//
// The app shows this function's source (kindleExport.toString()), so what people paste is exactly this code.
export function kindleExport() {
  (async () => {
    const box = document.getElementById("fmnb-box") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "fmnb-box" }));
    box.style.cssText = "position:fixed;z-index:2147483647;top:16px;right:16px;width:340px;padding:16px 18px;border-radius:14px;" +
      "font:14px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#fff;color:#1c1a16;" +
      "box-shadow:0 20px 50px rgba(0,0,0,.3);border:2px solid #1f6b57";
    const say = (html, bad) => { box.style.borderColor = bad ? "#b4473a" : "#1f6b57"; box.innerHTML = html; };
    const btn = "display:inline-block;margin:10px 8px 0 0;padding:7px 14px;border-radius:999px;border:0;cursor:pointer;font:600 13px system-ui;text-decoration:none;";
    say("<b>findMyNextBook</b><br>Reading your Kindle data…");
    const hand = async (kind, label, items) => {
      const text = JSON.stringify({ app: "findMyNextBook", kind, exported_at: new Date().toISOString(), items });
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      say(`<b>${items.length} ${label}</b><br>Copy them, then paste into findMyNextBook (or download the file and drop it in).<br>` +
        `<button id="fmnb-copy" style="${btn}background:#1f6b57;color:#fff">Copy</button>` +
        `<a href="${url}" download="${kind}.json" style="${btn}background:#eee;color:#111">Download file</a>` +
        `<button id="fmnb-x" style="${btn}background:none;color:#777">Close</button>`);
      const copy = async () => {
        try { await navigator.clipboard.writeText(text); document.getElementById("fmnb-copy").textContent = "Copied ✓"; }
        catch { document.getElementById("fmnb-copy").textContent = "Couldn't copy: download instead"; }
      };
      document.getElementById("fmnb-copy").onclick = copy;
      document.getElementById("fmnb-x").onclick = () => box.remove();
      copy(); // works straight away in most browsers; the button is there for the ones that want a click
    };
    try {
      if (location.hostname === "read.amazon.com") {
        const out = [];
        let tok = null;
        for (let page = 0; page < 200; page++) {
          const r = await fetch("/kindle-library/search?query=&libraryType=BOOKS&sortType=acquisition_desc&querySize=50" +
            (tok ? "&paginationToken=" + encodeURIComponent(tok) : ""), { credentials: "include" });
          if (!r.ok) throw new Error("Amazon answered " + r.status + ". Are you signed in?");
          const j = await r.json();
          out.push(...(j.itemsList || []));
          tok = j.paginationToken;
          say(`<b>findMyNextBook</b><br>Reading your Kindle library… ${out.length} books`);
          if (!tok) break;
        }
        await hand("kindle-library", "Kindle books", out.map((x) => ({ asin: x.asin, title: x.title, authors: x.authors,
          productUrl: x.productUrl, resourceType: x.resourceType, originType: x.originType })));
      } else if (/(^|\.)amazon\.com$/.test(location.hostname)) {
        const r = await fetch("/kindle/reading/insights/data", { credentials: "include" });
        if (!r.ok) throw new Error("Amazon answered " + r.status + ". Are you signed in?");
        const t = ((await r.json()).goal_info || {}).titles_read || [];
        await hand("kindle-finished", "finished books with dates", t.map((x) => ({ asin: x.asin, date_read: x.date_read })));
      } else {
        say("<b>findMyNextBook</b><br>Run this on <b>read.amazon.com/kindle-library</b> for your Kindle books, or on any <b>amazon.com</b> page for the dates you finished them.", true);
      }
    } catch (e) {
      say("<b>findMyNextBook</b><br>" + String(e.message || e).replace(/</g, "&lt;"), true);
    }
  })();
}

export const exportSource = () => `(${kindleExport.toString()})()`;
export const bookmarklet = () => "javascript:" + encodeURIComponent(exportSource());
