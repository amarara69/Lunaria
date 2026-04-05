from __future__ import annotations

import os
from collections.abc import Mapping, Sequence


_TRUE_VALUES = {"1", "true", "yes", "on", "debug"}


def is_push_debug_enabled() -> bool:
    value = str(os.getenv("LUNARIA_DEBUG_PUSH") or "").strip().lower()
    return value in _TRUE_VALUES


def _truncate(value: str, limit: int = 160) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return f"{text[: limit - 3]}..."


def _format_field(key: str, value) -> str | None:
    if value is None:
        return None
    if key in {"text", "reply", "delta"}:
        preview = _truncate(str(value))
        return f"{key}_preview={preview!r}"
    if key in {"attachments", "media"} and isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return f"{key}={len(value)}"
    if isinstance(value, Mapping):
        keys = ",".join(sorted(str(item) for item in value.keys()))
        return f"{key}_keys={_truncate(keys)!r}"
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        return f"{key}={_truncate(text)}"
    return f"{key}={value}"


def log_push_debug(stage: str, /, **fields) -> None:
    if not is_push_debug_enabled():
        return
    rendered = []
    for key, value in fields.items():
        formatted = _format_field(str(key), value)
        if formatted:
            rendered.append(formatted)
    suffix = f": {'; '.join(rendered)}" if rendered else ""
    print(f"[push.debug] {stage}{suffix}")
