from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch

from backend.app.agents import AGENT_BACKEND_REGISTRY
from backend.app.config import get_models, load_config
from backend.app.manifest import build_model_manifest
from backend.app.tts_backends import TTS_BACKEND_REGISTRY


class ManifestCleanupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        load_config.cache_clear()

    @patch("backend.app.manifest.collect_model_stage_capabilities", return_value={"motions": [], "expressions": []})
    @patch("backend.app.manifest.get_model_dir", return_value=Path("/tmp/lunaria-missing-model"))
    def test_build_model_manifest_only_exposes_retained_chat_and_tts_options(self, _mock_model_dir, _mock_capabilities) -> None:
        manifest = build_model_manifest(get_models()[0])

        provider_types = {item["type"] for item in manifest["chat"]["providers"]}
        tts_provider_ids = [item["id"] for item in manifest["chat"]["tts"]["providers"]]
        openai_tts_provider = next(item for item in manifest["chat"]["tts"]["providers"] if item["id"] == "openai-compatible")
        openai_tts_field_keys = [field["key"] for field in openai_tts_provider["fields"]]

        self.assertEqual(provider_types, {"openclaw-channel", "openai-compatible"})
        self.assertEqual(tts_provider_ids, ["edge-tts", "openai-compatible", "gpt-sovits"])
        self.assertNotEqual(manifest["chat"]["defaultProviderId"], "gateway")
        self.assertEqual(openai_tts_field_keys[:3], ["baseUrl", "model", "voice"])

    def test_agent_backend_registry_does_not_include_gateway(self) -> None:
        self.assertNotIn("gateway", AGENT_BACKEND_REGISTRY)

    def test_tts_backend_registry_only_keeps_public_backends(self) -> None:
        self.assertEqual(set(TTS_BACKEND_REGISTRY), {"edge-tts", "gpt-sovits", "openai-compatible"})


if __name__ == "__main__":
    unittest.main()
