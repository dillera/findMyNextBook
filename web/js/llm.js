// OpenRouter, called straight from this browser with the visitor's own key. The key is kept in this browser's
// IndexedDB, is never included in backups, and goes nowhere but openrouter.ai.
//
// Connecting: either paste a key from openrouter.ai/keys, or "Sign in with OpenRouter" (OAuth PKCE). PKCE: we make a
// random secret (the verifier) and keep it in this tab's sessionStorage; OpenRouter gets only its SHA-256 hash.
// After sign-in OpenRouter sends the browser back here with ?code=…, which the hosting server does see in that page
// request. That code works once, expires in 10 minutes, and is useless without the verifier, which never leaves the
// tab. The app swaps code + verifier for a key directly with openrouter.ai, then wipes the code from the address bar.
import * as store from "./store.js";
import { net } from "./net.js";

const BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5";
export const EFFORTS = ["low", "medium", "high", "xhigh"];
export const hasKey = () => !!store.setting("openrouter_key");

const headers = () => ({
  Authorization: `Bearer ${store.setting("openrouter_key")}`, "Content-Type": "application/json",
  "HTTP-Referer": location.origin, "X-Title": "findMyNextBook",
});

export async function chat(messages, { model = DEFAULT_MODEL, effort = null, schema = null, maxTokens = 32000 } = {}) {
  if (!hasKey()) throw new Error("Connect OpenRouter first (Settings)");
  // No temperature: newer Claude models reject sampling params; reasoning effort is the quality lever.
  const body = { model, messages, max_tokens: maxTokens };
  if (EFFORTS.includes(effort)) body.reasoning = { effort };
  body.response_format = schema ? { type: "json_schema", json_schema: { name: "result", strict: true, schema } } : { type: "json_object" };
  const r = await net(`${BASE}/chat/completions`, { method: "POST", headers: headers(), body: JSON.stringify(body) }, "Recommendations");
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error?.message || msg; } catch {}
    throw new Error(r.status === 401 ? "OpenRouter rejected the key. Reconnect in Settings." : r.status === 402 ? "Your OpenRouter account is out of credit." : `OpenRouter ${r.status}: ${msg}`);
  }
  const data = JSON.parse(text);
  if (data.error) throw new Error(`OpenRouter: ${data.error.message || JSON.stringify(data.error)}`);
  const choice = data.choices[0];
  if (choice.finish_reason === "length") throw new Error("The model ran out of room before finishing; try a lower effort or fewer picks");
  return { content: choice.message.content || "", served: data.model || model };
}

let modelsCache = null;
export async function listModels(provider = null) {
  if (!modelsCache || Date.now() - modelsCache.at > 3600e3) {
    // cache the promise, so two calls at once make one request
    modelsCache = { at: Date.now(), data: net(`${BASE}/models`, {}, "Model list").then(async (r) => {
      if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
      return (await r.json()).data || [];
    }) };
    modelsCache.data.catch(() => (modelsCache = null));
  }
  const data = await modelsCache.data;
  const perM = (p) => (p == null || isNaN(+p) ? null : Math.round(+p * 1e8) / 100);
  const out = data
    .filter((m) => (!provider || m.id.startsWith(provider + "/")) && !m.id.endsWith(":batch"))
    .map((m) => ({ id: m.id, name: m.name, created: m.created, context: m.context_length,
      prompt_price: perM(m.pricing?.prompt), completion_price: perM(m.pricing?.completion),
      effort: (m.supported_parameters || []).includes("reasoning_effort") }));
  return provider ? out.sort((a, b) => (b.created || 0) - (a.created || 0)) : out.sort((a, b) => a.id.localeCompare(b.id));
}

/** {label, usage, limit} for the connected key, or throws if OpenRouter rejects it. */
export async function keyInfo(key = store.setting("openrouter_key")) {
  const r = await net(`${BASE}/key`, { headers: { Authorization: `Bearer ${key}` } }, "Check key");
  if (r.status === 401) throw new Error("OpenRouter doesn't recognise that key");
  if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
  return (await r.json()).data || {};
}

export async function saveKey(key) {
  key = (key || "").trim();
  if (!/^sk-or-/.test(key)) throw new Error("OpenRouter keys start with sk-or-");
  const info = await keyInfo(key);
  await store.setSetting("openrouter_key", key);
  await store.setSetting("or_key_label", info.label || "");
  return info;
}
export async function disconnect() { await store.delSetting("openrouter_key"); await store.delSetting("or_key_label"); }

/* ---------- Sign in with OpenRouter (OAuth PKCE) ---------- */
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function startSignIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  sessionStorage.setItem("or_pkce", verifier);
  sessionStorage.setItem("or_return", location.hash || "#discover");
  location.href = "https://openrouter.ai/auth?" + new URLSearchParams({
    callback_url: location.origin + location.pathname, code_challenge: challenge, code_challenge_method: "S256", key_label: "findMyNextBook",
  });
}

/** On page load: finish a sign-in if OpenRouter just sent us back with ?code=. Returns true when a key was saved. */
export async function finishSignIn() {
  const code = new URLSearchParams(location.search).get("code");
  if (!code) return false;
  const back = sessionStorage.getItem("or_return") || "#discover";
  history.replaceState(null, "", location.pathname + back); // the code leaves the address bar (and history) at once
  const verifier = sessionStorage.getItem("or_pkce");
  sessionStorage.removeItem("or_pkce"); sessionStorage.removeItem("or_return");
  if (!verifier) throw new Error("That sign-in started in another tab or expired. Try again.");
  const r = await net(`${BASE}/auth/keys`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }) }, "Connect OpenRouter");
  if (!r.ok) throw new Error(`OpenRouter sign-in failed (${r.status}). Try again, or paste a key instead.`);
  const { key } = await r.json();
  await saveKey(key);
  return true;
}
