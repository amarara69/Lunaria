from __future__ import annotations

from .openai_compatible import OpenAICompatibleTtsBackend


class GptSoVitsBackend(OpenAICompatibleTtsBackend):
    error_label = "gpt-sovits"
    default_model = "GSVI-v4"
    default_voice = "星穹铁道-中文-三月七"

    def _build_payload(self, text: str, tts: dict) -> dict:
        payload = super()._build_payload(text, tts)
        payload["model"] = str(tts.get("model") or tts.get("version") or self.default_model).strip() or self.default_model
        payload["voice"] = str(tts.get("voice") or tts.get("gptSovitsVoice") or self.default_voice).strip() or self.default_voice
        payload.setdefault("other_params", {})
        return payload
