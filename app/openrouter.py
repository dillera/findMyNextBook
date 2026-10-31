"""Minimal OpenRouter chat-completions client."""
import os
import time

import httpx

BASE = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "anthropic/claude-sonnet-5"
EFFORTS = ("low", "medium", "high", "xhigh")

_models_cache: tuple[float, list[dict]] | None = None


def api_key() -> str:
    k = os.environ.get("OPENROUTER_API_KEY")
    if not k:
        raise RuntimeError("OPENROUTER_API_KEY is not set (put it in .env)")
    return k


def headers() -> dict:
    return {
        "Authorization": f"Bearer {api_key()}",
        "HTTP-Referer": "http://localhost:8765",
        "X-Title": "findMyNextBook",
        "Content-Type": "application/json",
    }


async def chat(messages: list[dict], model: str | None = None, effort: str | None = None,
               schema: dict | None = None, max_tokens: int = 32000) -> tuple[str, str]:
    """Returns (content, model that actually answered). They differ for routers such as typesafe/jev-router."""
    # No temperature: Opus 4.7+, Sonnet 5 and Fable reject sampling params; reasoning effort is the quality lever.
    body = {
        "model": model or os.environ.get("OPENROUTER_MODEL", DEFAULT_MODEL),
        "messages": messages,
        "max_tokens": max_tokens,
    }
    if effort in EFFORTS:
        body["reasoning"] = {"effort": effort}
    if schema:
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": "result", "strict": True, "schema": schema}}
    else:
        body["response_format"] = {"type": "json_object"}
    # Fable / Opus at high effort over a large profile can take several minutes
    async with httpx.AsyncClient(timeout=900) as client:
        r = await client.post(f"{BASE}/chat/completions", headers=headers(), json=body)
        if r.status_code >= 400:
            raise RuntimeError(f"OpenRouter {r.status_code}: {r.text[:500]}")
        data = r.json()
    if "error" in data:
        raise RuntimeError(f"OpenRouter: {data['error']}")
    choice = data["choices"][0]
    if choice.get("finish_reason") == "length":
        raise RuntimeError("Model hit max_tokens before finishing; try a lower effort or fewer recommendations")
    return choice["message"]["content"] or "", data.get("model") or body["model"]


async def list_models(provider: str | None = None) -> list[dict]:
    """OpenRouter's catalog (public endpoint, cached 1h). provider='anthropic' → Claude models, newest first."""
    global _models_cache
    if not _models_cache or time.time() - _models_cache[0] > 3600:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(f"{BASE}/models")
            r.raise_for_status()
        _models_cache = (time.time(), r.json().get("data", []))
    out = []
    for m in _models_cache[1]:
        if provider and not m["id"].startswith(provider + "/"):
            continue
        if m["id"].endswith(":batch"):  # async batch variants can't answer an interactive request
            continue
        pricing = m.get("pricing") or {}
        params = m.get("supported_parameters") or []
        out.append({"id": m["id"], "name": m.get("name"), "context": m.get("context_length"), "created": m.get("created"),
                    "prompt_price": _per_million(pricing.get("prompt")), "completion_price": _per_million(pricing.get("completion")),
                    "effort": "reasoning_effort" in params})
    if provider:
        return sorted(out, key=lambda m: m["created"] or 0, reverse=True)
    return sorted(out, key=lambda m: m["id"])


def _per_million(p) -> float | None:
    try:
        return round(float(p) * 1_000_000, 2)
    except (TypeError, ValueError):
        return None
