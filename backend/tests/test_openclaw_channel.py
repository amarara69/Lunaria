from __future__ import annotations

import asyncio
import json
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

from backend.app.agents.base import ChatRequest
from backend.app.agents.openclaw_channel import OpenClawChannelAgentBackend, _CHANNEL_LIVE2D_INIT_GUARD


class _FakeWebSocket:
    def __init__(self, frames: list[dict]):
        self.frames = list(frames)
        self.sent_payloads: list[dict] = []
        self.closed = False

    async def send(self, payload: str) -> None:
        self.sent_payloads.append(json.loads(payload))

    async def recv(self) -> str:
        if not self.frames:
            raise AssertionError("No more frames queued for fake websocket")
        return json.dumps(self.frames.pop(0))

    async def close(self) -> None:
        self.closed = True


class _FakeConnectAttempt:
    def __init__(self, *, ws: _FakeWebSocket | None = None, error: BaseException | None = None):
        self.ws = ws
        self.error = error

    async def __aenter__(self) -> _FakeWebSocket:
        if self.error is not None:
            raise self.error
        assert self.ws is not None
        return self.ws

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        if self.ws is not None:
            await self.ws.close()
        return False

    def __await__(self):
        async def _connect():
            if self.error is not None:
                raise self.error
            assert self.ws is not None
            return self.ws

        return _connect().__await__()


class OpenClawChannelAgentBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        _CHANNEL_LIVE2D_INIT_GUARD.clear()

    def test_run_channel_chat_retries_transient_connection_refusal(self) -> None:
        backend = OpenClawChannelAgentBackend(
            {
                "id": "live2d-channel",
                "type": "openclaw-channel",
                "name": "OpenClaw Channel",
                "bridgeUrl": "ws://127.0.0.1:18081",
                "agent": "main",
                "session": "live2d:direct:desktop-user",
            }
        )
        ws = _FakeWebSocket(
            [
                {
                    "type": "chat.final",
                    "reply": "连接恢复了",
                    "state": "final",
                }
            ]
        )
        connect_attempts: list[tuple[str, dict]] = []

        def fake_connect(url: str, **kwargs):
            connect_attempts.append((url, kwargs))
            if len(connect_attempts) == 1:
                return _FakeConnectAttempt(error=ConnectionRefusedError(111, "cannot connect"))
            return _FakeConnectAttempt(ws=ws)

        fake_websockets = types.SimpleNamespace(connect=fake_connect)

        async def run_test() -> tuple[dict, AsyncMock]:
            with patch.dict(sys.modules, {"websockets": fake_websockets}):
                with patch("backend.app.agents.openclaw_channel.asyncio.sleep", new_callable=AsyncMock) as sleep_mock:
                    result = await backend._run_channel_chat(ChatRequest(user_text="你好"), timeout_seconds=0.1)
            return result, sleep_mock

        result, sleep_mock = asyncio.run(run_test())

        self.assertEqual(result["reply"], "连接恢复了")
        self.assertEqual(len(connect_attempts), 2)
        self.assertTrue(ws.closed)
        self.assertGreaterEqual(sleep_mock.await_count, 1)


if __name__ == "__main__":
    unittest.main()
