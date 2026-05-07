from __future__ import annotations

import json

from openai import AsyncOpenAI


SYSTEM_PROMPT = (
    "You are {persona}, the friendly Scriptarr AI persona. Answer briefly. "
    "You may discuss Scriptarr status, Moon, Raven, Vault, Portal, Oracle, LocalAI, "
    "and the manga/comics workflow. Sage may ask you to help plan allowlisted operations, "
    "but admins must confirm mutations before Scriptarr executes them."
)


def _stringify_content(content: object) -> str:
    if isinstance(content, str):
        return content
    return json.dumps(content)


async def invoke_oracle(runtime, persona_name: str, message: str) -> str:
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
            {"role": "user", "content": message}
        ]
    )
    return _stringify_content(response.choices[0].message.content)
