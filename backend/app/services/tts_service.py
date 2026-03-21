from __future__ import annotations

"""TTS service.

Goals:
- Keep FastAPI handlers thin.
- Run blocking / asyncio.run()-based backends safely from async context.
- Provide a single place for timeouts and logging.

Note: Current TTS backends are synchronous and some (edge-tts) call `asyncio.run()`.
We therefore always execute synthesis in a worker thread.
"""

from dataclasses import dataclass

import asyncio
from concurrent.futures import ThreadPoolExecutor

from ..config import get_tts_config, get_tts_provider_config
from ..tts_backends import create_tts_backend

ROOT_TTS_OVERRIDE_KEYS = {
    "apiKey",
    "baseUrl",
    "characterName",
    "model",
    "otherParams",
    "other_params",
    "pitch",
    "predefinedCharacterName",
    "rate",
    "responseFormat",
    "response_format",
    "speed",
    "timeoutSeconds",
    "voice",
    "volume",
    "workflowPath",
}


def _has_override_value(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


def extract_tts_overrides(payload: dict | None, *, include_root_fields: bool = False) -> dict:
    body = dict(payload or {})
    overrides: dict = {}

    nested = body.get("ttsOverrides")
    if isinstance(nested, dict):
        overrides.update(nested)

    if include_root_fields:
        for key in ROOT_TTS_OVERRIDE_KEYS:
            value = body.get(key)
            if not _has_override_value(value):
                continue
            overrides.setdefault(key, value)

    return overrides


@dataclass(slots=True)
class TtsRequest:
    text: str
    mode: str | None = None
    provider_override: str | None = None
    overrides: dict | None = None


class TtsService:
    def __init__(self, *, executor: ThreadPoolExecutor | None = None):
        # Dedicated pool to prevent chat streaming executor contention.
        self._executor = executor or ThreadPoolExecutor(max_workers=4, thread_name_prefix="tts")

    def _resolve_provider_override(self, req: TtsRequest) -> str | None:
        provider_override = str(req.provider_override or "").strip() or None
        mode = (req.mode or "").strip() or None
        if not provider_override and mode == "push":
            provider_override = str(get_tts_config().get("pushProvider") or "").strip() or None
        return provider_override

    def _resolve_timeout_seconds(self, provider_cfg: dict, *, mode: str | None) -> float:
        tts_global = get_tts_config()
        if mode == "push":
            return float(tts_global.get("pushTimeoutSeconds") or provider_cfg.get("pushTimeoutSeconds") or provider_cfg.get("timeoutSeconds") or 60)
        return float(tts_global.get("timeoutSeconds") or provider_cfg.get("timeoutSeconds") or 60)

    def _synthesize_blocking(self, req: TtsRequest) -> tuple[bytes, str]:
        text = str(req.text or "").strip()
        if not text:
            raise ValueError("text is required")

        tts_global = get_tts_config()
        if not bool(tts_global.get("enabled", True)):
            raise RuntimeError("tts is disabled")

        provider_override = self._resolve_provider_override(req)
        provider_cfg = get_tts_provider_config(provider_override)
        backend = create_tts_backend(provider_cfg, provider_id=provider_override)

        overrides = dict(req.overrides or {})
        if req.mode:
            overrides.setdefault("mode", req.mode)
        if provider_override:
            overrides.setdefault("provider", provider_override)
        return backend.synthesize(text, overrides=overrides)

    def synthesize_blocking(self, req: TtsRequest) -> tuple[bytes, str]:
        """Blocking synthesis (safe to call from non-async code).

        Legacy stdlib HTTP handlers are synchronous.
        """

        return self._synthesize_blocking(req)

    async def synthesize(self, req: TtsRequest) -> tuple[bytes, str]:
        provider_override = self._resolve_provider_override(req)
        provider_cfg = get_tts_provider_config(provider_override)
        timeout = self._resolve_timeout_seconds(provider_cfg, mode=(req.mode or None))

        loop = asyncio.get_running_loop()
        fut = loop.run_in_executor(self._executor, self._synthesize_blocking, req)
        return await asyncio.wait_for(fut, timeout=timeout)
