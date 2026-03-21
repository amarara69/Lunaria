from __future__ import annotations

import unittest

from backend.app.services.tts_service import extract_tts_overrides


class TtsOverrideExtractionTests(unittest.TestCase):
    def test_extract_tts_overrides_prefers_nested_payload_for_stream_requests(self) -> None:
        self.assertEqual(
            extract_tts_overrides(
                {
                    "baseUrl": "http://chat.example/v1",
                    "model": "chat-model",
                    "ttsOverrides": {
                        "baseUrl": "http://127.0.0.1:8001/v1",
                        "model": "tts-1",
                        "voice": "alloy",
                    },
                }
            ),
            {
                "baseUrl": "http://127.0.0.1:8001/v1",
                "model": "tts-1",
                "voice": "alloy",
            },
        )

    def test_extract_tts_overrides_can_read_root_fields_for_direct_tts_requests(self) -> None:
        self.assertEqual(
            extract_tts_overrides(
                {
                    "text": "你好呀",
                    "provider": "openai-compatible",
                    "baseUrl": "http://127.0.0.1:8001/v1",
                    "model": "tts-1",
                    "voice": "alloy",
                    "speed": 0.5,
                },
                include_root_fields=True,
            ),
            {
                "baseUrl": "http://127.0.0.1:8001/v1",
                "model": "tts-1",
                "voice": "alloy",
                "speed": 0.5,
            },
        )


if __name__ == "__main__":
    unittest.main()
