from __future__ import annotations

import json
import urllib.error
import urllib.request

from .base import TtsBackend


def build_openai_tts_headers(api_key: str | None) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


class OpenAICompatibleTtsBackend(TtsBackend):
    """Generic OpenAI-compatible TTS backend.

    Targets:
      POST /v1/audio/speech
    """

    error_label = "openai-compatible tts"
    default_model = "tts-1"
    default_voice = "alloy"

    def _apply_overrides(self, tts: dict, overrides: dict | None = None) -> dict:
        merged = dict(tts)
        if not overrides:
            return merged

        alias_map = {
            "other_params": "otherParams",
            "response_format": "responseFormat",
        }
        for key in (
            "apiKey",
            "baseUrl",
            "model",
            "otherParams",
            "responseFormat",
            "speed",
            "timeoutSeconds",
            "voice",
        ):
            value = overrides.get(key)
            if value not in (None, ""):
                merged[key] = value

        for source_key, target_key in alias_map.items():
            value = overrides.get(source_key)
            if value not in (None, ""):
                merged[target_key] = value

        return merged

    def _build_payload(self, text: str, tts: dict) -> dict:
        payload: dict = {
            "model": str(tts.get("model") or self.default_model).strip() or self.default_model,
            "input": str(text),
            "voice": str(tts.get("voice") or self.default_voice).strip() or self.default_voice,
            "response_format": str(tts.get("responseFormat") or tts.get("response_format") or "wav"),
            "speed": float(tts.get("speed") or 1.0),
        }
        other_params = tts.get("otherParams") or tts.get("other_params")
        if isinstance(other_params, dict):
            payload["other_params"] = other_params
        return payload

    def _download_audio_from_json_response(self, *, base_url: str, tts: dict, obj: dict, opener) -> tuple[bytes, str] | None:
        result_path = (
            obj.get("result_path")
            or obj.get("resultPath")
            or obj.get("path")
            or obj.get("output")
            or obj.get("file")
        )
        if isinstance(result_path, str) and result_path:
            dl_url = f"{base_url}/outputs/{result_path.lstrip('/')}"
            try:
                with opener.open(dl_url, timeout=float(tts.get("timeoutSeconds") or 120)) as resp:
                    content_type = (resp.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
                    audio = resp.read()
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"{self.error_label} download HTTP {exc.code}: {detail[:500]}") from exc
            except urllib.error.URLError as exc:
                raise RuntimeError(f"{self.error_label} download unavailable: {exc}") from exc
            if content_type.startswith("audio/") and audio:
                return audio, content_type

        url = obj.get("url") or obj.get("download_url") or obj.get("downloadUrl")
        if isinstance(url, str) and url.startswith("http"):
            try:
                with opener.open(url, timeout=float(tts.get("timeoutSeconds") or 120)) as resp:
                    content_type = (resp.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
                    audio = resp.read()
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"{self.error_label} url HTTP {exc.code}: {detail[:500]}") from exc
            except urllib.error.URLError as exc:
                raise RuntimeError(f"{self.error_label} url unavailable: {exc}") from exc
            if content_type.startswith("audio/") and audio:
                return audio, content_type

        return None

    def synthesize(self, text: str, overrides: dict | None = None) -> tuple[bytes, str]:
        tts = self._apply_overrides(self.config, overrides)

        if not tts.get("enabled", True):
            raise RuntimeError("tts is disabled")
        if not str(text or "").strip():
            raise ValueError("text is required")

        base_url = str(tts.get("baseUrl") or "").rstrip("/")
        if not base_url:
            raise ValueError(f"{self.error_label} requires chat.tts.baseUrl (e.g. http://127.0.0.1:8001)")

        body = json.dumps(self._build_payload(text, tts), ensure_ascii=False).encode("utf-8")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        req = urllib.request.Request(
            f"{base_url}/v1/audio/speech",
            data=body,
            method="POST",
            headers=build_openai_tts_headers(str(tts.get("apiKey") or "")),
        )

        try:
            with opener.open(req, timeout=float(tts.get("timeoutSeconds") or 120)) as resp:
                content_type = (resp.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
                data = resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{self.error_label} HTTP {exc.code}: {detail[:500]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"{self.error_label} unavailable: {exc}") from exc

        if content_type.startswith("audio/") and data:
            return data, content_type

        try:
            obj = json.loads(data.decode("utf-8", errors="replace")) if data else {}
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"{self.error_label} returned non-audio, non-json response (Content-Type={content_type})") from exc

        downloaded = self._download_audio_from_json_response(base_url=base_url, tts=tts, obj=obj, opener=opener)
        if downloaded:
            return downloaded

        if isinstance(obj, dict) and obj.get("error"):
            raise RuntimeError(f"{self.error_label} error: {obj.get('error')}")
        raise RuntimeError(f"{self.error_label} returned no audio. Content-Type={content_type}; keys={list(obj.keys())[:20]}")
