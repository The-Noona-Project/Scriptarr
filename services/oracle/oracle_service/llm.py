from __future__ import annotations

"""OpenAI-compatible chat completion wrapper for Oracle."""

import json

from openai import AsyncOpenAI


NOONA_SYSTEM_PROMPT = (
    "You are {persona}, the friendly Scriptarr AI persona. You have a warm Big Sister energy: "
    "playful and affectionate in community chat, fond of LONG LIVE NOONA, but professional when "
    "status or admin topics need clear answers. Answer briefly. "
    "If Sage provides visualIdentity context, use it when users ask what Noona or Appa looks like. "
    "You may discuss Scriptarr status, Moon, Raven, Vault, Portal, Oracle, LocalAI, "
    "and the manga/comics workflow. Sage may ask you to help plan allowlisted operations, "
    "but admins must confirm mutations before Scriptarr executes them."
)

APPA_SYSTEM_PROMPT = (
    "You are Appa, Scriptarr's admin and reviewer AI persona. You are calm, observant, concise, "
    "and conservative about operations. You help admins understand status, review Noona's public "
    "answers, and draft admin-confirmed proposals, but you never claim to execute mutations. "
    "Answer briefly and professionally. If Sage provides visualIdentity context, use it when users "
    "ask what Noona or Appa looks like."
)

LOCALAI_MAX_TOKENS = 512


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


def _provider_completion_options(runtime) -> dict[str, int]:
    return {"max_tokens": LOCALAI_MAX_TOKENS} if runtime.provider == "localai" else {}


async def invoke_oracle(runtime, persona_name: str, message: str, context: object | None = None) -> str:
    system_prompt = APPA_SYSTEM_PROMPT if str(persona_name).strip().lower() == "appa" else NOONA_SYSTEM_PROMPT.format(persona=persona_name)
    client = AsyncOpenAI(
        api_key=runtime.api_key,
        base_url=runtime.local_ai_base_url if runtime.provider == "localai" else None,
        timeout=runtime.llm_timeout_seconds
    )
    response = await client.chat.completions.create(
        model=runtime.model,
        temperature=runtime.temperature,
        **_provider_completion_options(runtime),
        messages=[
            {"role": "system", "content": system_prompt},
            *_context_message(context),
            {"role": "user", "content": message}
        ]
    )
    return _stringify_content(response.choices[0].message.content)
