from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class Mem0ServiceSupportTests(unittest.TestCase):
    def test_load_prompt_markdown_sections_reads_from_home_lunaria_by_default(self) -> None:
        from backend.app.services.mem0_service import load_prompt_markdown_sections

        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            prompt_root = home / ".lunaria"
            prompt_root.mkdir(parents=True, exist_ok=True)
            (prompt_root / "AGENTS.md").write_text("# Agents\nagent rules", encoding="utf-8")
            (prompt_root / "IDENTITY.md").write_text("# Identify\nidentity rules", encoding="utf-8")

            with patch("backend.app.services.mem0_service.Path.home", return_value=home):
                sections = load_prompt_markdown_sections({})

        self.assertEqual(
            sections,
            [
                "# AGENTS.md\n\n# Agents\nagent rules",
                "# IDENTITY.md\n\n# Identify\nidentity rules",
            ],
        )

    def test_load_prompt_markdown_sections_requires_mandatory_files_and_appends_configured_files(self) -> None:
        from backend.app.services.mem0_service import load_prompt_markdown_sections

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "AGENTS.md").write_text("# Agents\nagent rules", encoding="utf-8")
            (root / "IDENTITY.md").write_text("# Identify\nidentity rules", encoding="utf-8")
            (root / "ROLE.md").write_text("# Role\nextra role rules", encoding="utf-8")

            sections = load_prompt_markdown_sections(
                {
                    "promptMarkdownFiles": "ROLE.md, AGENTS.md",
                },
                prompt_root=root,
            )

        self.assertEqual(
            sections,
            [
                "# AGENTS.md\n\n# Agents\nagent rules",
                "# IDENTITY.md\n\n# Identify\nidentity rules",
                "# ROLE.md\n\n# Role\nextra role rules",
            ],
        )

    def test_load_prompt_markdown_sections_rejects_missing_mandatory_files(self) -> None:
        from backend.app.services.mem0_service import load_prompt_markdown_sections

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "AGENTS.md").write_text("# Agents\nagent rules", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "IDENTITY.md"):
                load_prompt_markdown_sections({}, prompt_root=root)

    def test_build_mem0_oss_config_uses_local_chroma_and_separate_embedding_settings(self) -> None:
        from backend.app.services.mem0_service import build_mem0_oss_config

        config = build_mem0_oss_config(
            {
                "baseUrl": "http://127.0.0.1:8317/v1",
                "apiKey": "chat-key",
                "model": "gpt-5.4",
                "embeddingBaseUrl": "http://127.0.0.1:11434/v1",
                "embeddingApiKey": "embed-key",
                "embeddingModel": "text-embedding-3-small",
                "memoryChromaPath": "data/mem0/chroma",
            }
        )

        self.assertEqual(config["vector_store"]["provider"], "chroma")
        self.assertEqual(config["vector_store"]["config"]["path"], "data/mem0/chroma")
        self.assertEqual(config["embedder"]["provider"], "openai")
        self.assertEqual(config["embedder"]["config"]["api_key"], "embed-key")
        self.assertEqual(config["embedder"]["config"]["openai_base_url"], "http://127.0.0.1:11434/v1")
        self.assertEqual(config["llm"]["provider"], "openai")
        self.assertEqual(config["llm"]["config"]["api_key"], "chat-key")
        self.assertEqual(config["llm"]["config"]["openai_base_url"], "http://127.0.0.1:8317/v1")

    def test_add_exchange_passes_infer_false_to_mem0(self) -> None:
        from backend.app.services.mem0_service import Mem0Service

        class _FakeMemory:
            def __init__(self):
                self.calls = []

            def add(self, **kwargs):
                self.calls.append(kwargs)
                return {"results": []}

        fake_memory = _FakeMemory()
        service = Mem0Service({"id": "lunaria-main"})

        with patch.object(service, "_get_memory", return_value=fake_memory):
            service.add_exchange(
                user_text="我喜欢乌龙茶。",
                assistant_text="记住了。",
                user_id="desktop-user",
                agent_id="main",
                run_id="live2d:direct:desktop-user",
            )

        self.assertEqual(fake_memory.calls[0]["messages"][0]["content"], "我喜欢乌龙茶。")
        self.assertIs(fake_memory.calls[0]["infer"], False)


if __name__ == "__main__":
    unittest.main()
