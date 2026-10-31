// Evidence for the Privacy panel: the policy the browser enforces, every host this page has talked to, and a live
// attempt to send data to the hosting server (which the browser refuses).
import { log } from "./net.js";

// the browser keeps 250 resource-timing entries by default; a library full of covers would push entries out
performance.setResourceTimingBufferSize?.(10000);

/** The Content-Security-Policy from the page's <meta> tag, as {directive: [sources]}. */
export function policy() {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  return Object.fromEntries((meta?.content || "").split(";").map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]));
}

const PURPOSE = [
  [/^openrouter\.ai$/, "Your reading profile, with your own key, when you ask for picks; the model list"],
  [/^www\.googleapis\.com$/, "A book title or ISBN, to look up covers, blurbs and genres"],
  [/^openlibrary\.org$/, "A book title or ISBN, when Google Books is out of quota"],
  [/^m\.media-amazon\.com$|amazon\.com$/, "Cover images for your Kindle books"],
  [/^books\.google(usercontent)?\.com$/, "Cover images"],
  [/(^|\.)openlibrary\.org$|(^|\.)archive\.org$/, "Cover images"],
];
const purposeOf = (host) => (host === location.host ? "The app's own files, downloaded when the page opened. Nothing is sent." : PURPOSE.find(([re]) => re.test(host))?.[1] || "");

/** Every network request this page has made since it opened: page load, files, images, API calls. */
export function requests() {
  const hosts = new Map();
  const add = (url, kind, extra = {}) => {
    let u; try { u = new URL(url); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    const h = hosts.get(u.host) || { host: u.host, own: u.host === location.host, purpose: purposeOf(u.host), count: 0, kinds: new Set(), paths: new Set(), sent: 0, blocked: 0 };
    // the browser logs a timing entry even for a request its policy refused; it never left the machine
    if (extra.blocked) { h.blocked++; hosts.set(u.host, h); return; }
    h.count++; h.kinds.add(kind);
    if (h.own) h.paths.add(u.pathname);
    if (extra.sent) h.sent++;
    hosts.set(u.host, h);
  };
  for (const e of performance.getEntriesByType("navigation")) add(e.name, "page");
  for (const e of performance.getEntriesByType("resource")) {
    // the app's API calls go through net() and are counted below with their method; skip their duplicate timing entries
    if (e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest") continue;
    add(e.name, { img: "image", script: "script", link: "stylesheet", css: "stylesheet", other: "file" }[e.initiatorType] || e.initiatorType,
      { blocked: e.responseStatus === 0 && e.transferSize === 0 && e.decodedBodySize === 0 && new URL(e.name).host === location.host });
  }
  for (const r of log) add(`https://${r.host}${r.path}`, r.method === "GET" ? "data request" : `${r.method} (sends data)`, { sent: r.method !== "GET" });
  return [...hosts.values()].sort((a, b) => b.own - a.own || b.count - a.count).map((h) => ({ ...h, kinds: [...h.kinds], paths: [...h.paths] }));
}

/** Try to send something to the server that hosts this page, two ways. The browser should refuse both before anything
 *  leaves the machine, and it says so with a securitypolicyviolation event: that event, not a failed request (a 404
 *  fails too), is what counts as "blocked". */
export async function tryToReachServer() {
  const violations = [];
  const onv = (e) => violations.push(e.effectiveDirective || e.violatedDirective);
  document.addEventListener("securitypolicyviolation", onv);
  let fetchWentOut = false;
  try {
    try {
      await fetch(`${location.origin}/privacy-check?note=this-should-never-arrive`, { method: "POST", body: "test", cache: "no-store" });
      fetchWentOut = true;
    } catch {}
    await new Promise((ok) => {
      const i = new Image();
      i.onload = i.onerror = ok;
      i.src = `${location.origin}/pixel.gif?note=this-should-never-arrive&t=${Date.now()}`;
      setTimeout(ok, 3000);
    });
    await new Promise((ok) => setTimeout(ok, 150)); // violation events arrive asynchronously
  } finally {
    document.removeEventListener("securitypolicyviolation", onv);
  }
  return [
    { how: "Send data with fetch() (a POST to the server)", blocked: !fetchWentOut && violations.includes("connect-src"), rule: "connect-src" },
    { how: "Send data in an image URL (a tracking pixel)", blocked: violations.includes("img-src"), rule: "img-src" },
  ];
}

export async function storageInfo() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  return { used: est?.usage ?? null, quota: est?.quota ?? null, persisted };
}
