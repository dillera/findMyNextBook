// Every request the app's own code makes goes through net(). It
//   · refuses any URL on the server that hosts the app (the page's Content-Security-Policy blocks those too),
//   · sends no cookies and no Referer, and
//   · records host, path and purpose in a log the Privacy panel shows, so anyone can see where their data goes.
export const log = [];
const listeners = new Set();
export const onLog = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const ping = () => listeners.forEach((fn) => fn());

export async function net(url, opts = {}, purpose = "") {
  const u = new URL(url, location.href);
  if (u.origin === location.origin) throw new Error("findMyNextBook never sends requests to the server that hosts it");
  const entry = { at: Date.now(), host: u.host, path: u.pathname, purpose, method: (opts.method || "GET").toUpperCase(), status: "…" };
  log.push(entry);
  ping();
  try {
    const r = await fetch(u, { ...opts, credentials: "omit", referrerPolicy: "no-referrer" });
    entry.status = r.status;
    return r;
  } catch (e) {
    entry.status = "failed";
    throw e;
  } finally {
    ping();
  }
}
