from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from backend.app.utils.push_debug import log_push_debug


class PushDebugTests(unittest.TestCase):
    def test_log_push_debug_is_silent_when_env_is_disabled(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with patch("builtins.print") as print_mock:
                log_push_debug("listener.frame", frame_type="push.message", text="hello")

        print_mock.assert_not_called()

    def test_log_push_debug_prints_sanitized_fields_when_env_is_enabled(self) -> None:
        with patch.dict(os.environ, {"LUNARIA_DEBUG_PUSH": "1"}, clear=True):
            with patch("builtins.print") as print_mock:
                log_push_debug(
                    "listener.frame",
                    frame_type="push.message",
                    text="hello proactive push",
                    attachments=[{"kind": "image"}, {"kind": "audio"}],
                    route_key="live2d-channel|agent:main|session:main",
                )

        print_mock.assert_called_once()
        message = print_mock.call_args.args[0]
        self.assertIn("[push.debug] listener.frame", message)
        self.assertIn("frame_type=push.message", message)
        self.assertIn("text_preview='hello proactive push'", message)
        self.assertIn("attachments=2", message)
        self.assertIn("route_key=live2d-channel|agent:main|session:main", message)


if __name__ == "__main__":
    unittest.main()
