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
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";
// every effort OpenRouter knows, lowest first; each model accepts a subset (model.reasoning.efforts)
export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export const hasKey = () => !!store.setting("openrouter_key");
/** Ask OpenRouter to route only to providers that don't store or train on prompts (provider.data_collection). */
export const denyTraining = () => store.setting("deny_training", true) !== false;

const headers = () => ({
  Authorization: `Bearer ${store.setting("openrouter_key")}`, "Content-Type": "application/json",
  "HTTP-Referer": location.origin, "X-Title": "findMyNextBook",
});

/* ---------- models ---------- */
let modelsCache = null;
const perM = (p) => (p == null || p === "" || isNaN(+p) || +p < 0 ? null : +p * 1e6); // $ per million tokens; routers say -1 (varies)
function normalise(m) {
  const sp = new Set(m.supported_parameters || []);
  const arch = m.architecture || {};
  const r = m.reasoning;
  return {
    id: m.id, name: (m.name || m.id).replace(/^[^:]{2,30}:\s+/, ""), vendor: m.id.replace(/^~/, "").split("/")[0], created: m.created || 0,
    context: m.context_length || m.top_provider?.context_length || null, max_out: m.top_provider?.max_completion_tokens || null,
    prompt_price: perM(m.pricing?.prompt), completion_price: perM(m.pricing?.completion),
    free: m.id.endsWith(":free") || (+m.pricing?.prompt === 0 && +m.pricing?.completion === 0),
    open: !!m.hugging_face_id, // open-weight models link their Hugging Face repo
    structured: sp.has("structured_outputs"), json_mode: sp.has("response_format"),
    reasoning: r ? { efforts: r.supported_efforts || [], mandatory: !!r.mandatory, default_on: !!r.default_enabled }
      : sp.has("reasoning") ? { efforts: [], mandatory: false, default_on: false } : null,
    text: (arch.input_modalities || ["text"]).includes("text") && (arch.output_modalities || ["text"]).includes("text"),
  };
}
/** Every text model OpenRouter lists (public, no key needed), normalised. Cached for an hour. */
export async function listModels() {
  if (!modelsCache || Date.now() - modelsCache.at > 3600e3) {
    // cache the promise, so two calls at once make one request
    modelsCache = { at: Date.now(), data: net(`${BASE}/models`, {}, "Model list").then(async (r) => {
      if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
      return ((await r.json()).data || []).filter((m) => !m.id.endsWith(":batch")).map(normalise).filter((m) => m.text);
    }) };
    modelsCache.data.catch(() => (modelsCache = null));
  }
  return modelsCache.data;
}
export const modelInfo = async (id) => (await listModels()).find((m) => m.id === id) || null;

/** The effort to send for this model: the requested one if it accepts it, else the nearest it does accept. */
export function effortFor(requested, info) {
  if (!requested) return null;                              // model default
  if (!info) return requested === "none" ? null : requested; // unknown model: pass it through
  const r = info.reasoning;
  if (!r) return null;                                      // no reasoning to control
  const lowest = () => [...r.efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))[0] || null;
  if (requested === "none") {
    if (r.mandatory) return lowest();                      // it always thinks: as little as it allows
    return !r.efforts.length || r.efforts.includes("none") ? "none" : lowest();
  }
  if (!r.efforts.length || r.efforts.includes(requested)) return requested;
  const want = EFFORT_ORDER.indexOf(requested);
  return r.efforts.filter((e) => e !== "none").sort((a, b) =>
    Math.abs(EFFORT_ORDER.indexOf(a) - want) - Math.abs(EFFORT_ORDER.indexOf(b) - want) || EFFORT_ORDER.indexOf(b) - EFFORT_ORDER.indexOf(a))[0] || null;
}

/* ---------- chat ---------- */
// How the model is asked for JSON, best first: a strict JSON Schema, JSON mode with the schema in the prompt, or just the
// prompt. Open models often lack the first, or have only some providers that support it.
const MODES = ["schema", "json", "text"];
const modesFor = (info) => (!info ? MODES : info.structured ? MODES : info.json_mode ? ["json", "text"] : ["text"]);

/** The exact request body, so "View what gets sent" can show it too. */
export function buildRequest(messages, { model = DEFAULT_MODEL, effort = null, schema = null, maxTokens = 32000, info = null, mode = null } = {}) {
  mode = mode || modesFor(info)[0];
  if (mode !== "schema" && schema) {
    const [sys, ...rest] = messages;
    messages = [{ ...sys, content: `${sys.content}\n\nReply with one JSON object and nothing else (no prose, no code fences), matching this JSON Schema:\n${JSON.stringify(schema)}` }, ...rest];
  }
  // No temperature: newer Claude models reject sampling params; reasoning effort is the quality lever.
  const body = { model, messages, max_tokens: info?.max_out ? Math.min(maxTokens, info.max_out) : maxTokens };
  if (mode === "schema") body.response_format = { type: "json_schema", json_schema: { name: "result", strict: true, schema } };
  if (mode === "json") body.response_format = { type: "json_object" };
  const e = effortFor(effort, info);
  if (e) body.reasoning = { effort: e };
  const provider = {};
  if (mode !== "text") provider.require_parameters = true; // only providers that honour response_format
  if (denyTraining()) provider.data_collection = "deny";
  if (Object.keys(provider).length) body.provider = provider;
  body.usage = { include: true }; // the reply then says what the request cost
  return { body, mode, effort: e };
}

/** Pull the JSON object out of a reply: tolerates <think> blocks, code fences and prose around it. */
export function parseJSON(content) {
  let s = (content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no JSON object in the reply");
  return JSON.parse(s.slice(a, b + 1));
}

const unsupported = (status, msg) => [400, 404, 422].includes(status) && !/data.?polic|data_collection|privacy/i.test(msg)
  && /response_format|json_schema|structured|require_parameters|support|No endpoints found/i.test(msg);

export async function chat(messages, { model = DEFAULT_MODEL, effort = null, schema = null, maxTokens = 32000 } = {}) {
  if (!hasKey()) throw new Error("Connect OpenRouter first (Settings)");
  const info = await modelInfo(model).catch(() => null);
  const modes = schema ? modesFor(info) : ["json"];
  for (let i = 0; i < modes.length; i++) {
    const { body, mode, effort: used } = buildRequest(messages, { model, effort, schema, maxTokens, info, mode: modes[i] });
    const r = await net(`${BASE}/chat/completions`, { method: "POST", headers: headers(), body: JSON.stringify(body) }, "Recommendations");
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error?.message || msg; } catch {}
      if (unsupported(r.status, msg) && i < modes.length - 1) continue; // try the next, looser way of asking
      if (r.status === 401) throw new Error("OpenRouter rejected the key. Reconnect in Settings.");
      if (r.status === 402) throw new Error("Your OpenRouter account is out of credit.");
      if (r.status === 429) throw new Error(`${model} is rate-limited right now${info?.free ? " (free models allow only a few requests a minute)" : ""}. Try again shortly, or pick another model.`);
      if (/data.?polic|data_collection/i.test(msg) || (r.status === 404 && denyTraining() && /No endpoints/i.test(msg)))
        throw new Error(`No provider of ${model} promises not to store or train on your prompts. Pick another model, or turn off “Skip providers that may store or train on prompts” in Options.`);
      throw new Error(`OpenRouter ${r.status}: ${msg}`);
    }
    const data = JSON.parse(text);
    if (data.error) throw new Error(`OpenRouter: ${data.error.message || JSON.stringify(data.error)}`);
    const choice = data.choices?.[0];
    if (!choice) throw new Error(`${model} sent back no answer`);
    if (choice.finish_reason === "length") throw new Error("The model ran out of room before finishing; try a lower effort or fewer picks");
    return { content: choice.message?.content || "", served: data.model || model, mode, effort: used,
      cost: data.usage?.cost ?? null, tokens: data.usage ? { in: data.usage.prompt_tokens, out: data.usage.completion_tokens } : null };
  }
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
