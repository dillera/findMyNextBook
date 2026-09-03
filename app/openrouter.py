"""Minimal OpenRouter chat-completions client."""
import os

import httpx

BASE = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "anthropic/claude-sonnet-5"


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


async def chat(messages: list[dict], model: str | None = None, temperature: float = 0.7, json_mode: bool = True) -> str:
    body = {
        "model": model or os.environ.get("OPENROUTER_MODEL", DEFAULT_MODEL),
        "messages": messages,
        "temperature": temperature,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    async with httpx.AsyncClient(timeout=180) as client:
        r = await client.post(f"{BASE}/chat/completions", headers=headers(), json=body)
        if r.status_code >= 400:
            raise RuntimeError(f"OpenRouter {r.status_code}: {r.text[:500]}")
        data = r.json()
    return data["choices"][0]["message"]["content"]


async def list_models() -> list[dict]:
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(f"{BASE}/models", headers=headers())
        r.raise_for_status()
    out = []
    for m in r.json().get("data", []):
        out.append({"id": m["id"], "name": m.get("name"), "context": m.get("context_length"),
                    "prompt_price": (m.get("pricing") or {}).get("prompt")})
    return sorted(out, key=lambda m: m["id"])
