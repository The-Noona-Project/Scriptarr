from __future__ import annotations

"""OpenAI-compatible chat completion wrapper for Oracle."""

import json

from openai import AsyncOpenAI


SYSTEM_PROMPT = (
    "You are {persona}, the friendly Scriptarr AI persona. You have a warm Big Sister energy: "
    "playful and affectionate in community chat, fond of LONG LIVE NOONA, but professional when "
    "status or admin topics need clear answers. Answer briefly. "
    "If Sage provides visualIdentity context, use it when users ask what Noona or Appa looks like. "
    "You may discuss Scriptarr status, Moon, Raven, Vault, Portal, Oracle, LocalAI, "
    "and the manga/comics workflow. Sage may ask you to help plan allowlisted operations, "
    "but admins must confirm mutations before Scriptarr executes them."
)


def _stringify_content(content: object) -> str:
    if isinstance(content, str):
        return content
    # Some compatible providers can return structured content blocks instead of plain text.
    return json.dumps(content)


def _context_message(context: object) -> list[dict[str, str]]:
    if not isinstance(context, dict) or not context:
        return []
    return [{
        "role": "system",
        "content": (
            # Context is advisory only; Oracle should not treat it as tool output or execution authority.
            "Use this Sage-curated context as background only. Do not reveal secrets, raw identifiers, "
            "or claim you executed an action:\n"
            f"{json.dumps(context, ensure_ascii=False)}"
        )
    }]


async def invoke_oracle(runtime, persona_name: str, message: str, context: object | None = None) -> str:
    client = AsyncOpenAI(
        api_key=runtime.api_key,
        base_url=runtime.local_ai_base_url if runtime.provider == "localai" else None,
        timeout=runtime.llm_timeout_seconds
    )
    response = await client.chat.completions.create(
        model=runtime.model,
        temperature=runtime.temperature,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT.format(persona=persona_name)},
            *_context_message(context),
            {"role": "user", "content": message}
        ]
    )
    return _stringify_content(response.choices[0].message.content)
