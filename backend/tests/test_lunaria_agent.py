from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from backend.app.agents.base import ChatRequest
from backend.app.agents.lunaria import LunariaAgentBackend


class _FakeResponse:
    def __init__(self, payload: dict):
        self.payload = payload
        self.headers = {"Content-Type": "application/json"}

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False


class _FakeMem0Service:
    def __init__(self):
        self.search_calls: list[dict] = []
        self.add_calls: list[dict] = []

    def search(self, *, query: str, user_id: str, agent_id: str, run_id: str, limit: int, scope: str):
        self.search_calls.append(
            {
                "query": query,
                "user_id": user_id,
                "agent_id": agent_id,
                "run_id": run_id,
                "limit": limit,
                "scope": scope,
            }
        )
        return {
            "results": [
                {"memory": "The user likes oolong tea.", "score": 0.91},
            ]
        }

    def add_exchange(self, *, user_text: str, assistant_text: str, user_id: str, agent_id: str, run_id: str):
        self.add_calls.append(
            {
                "user_text": user_text,
                "assistant_text": assistant_text,
                "user_id": user_id,
                "agent_id": agent_id,
                "run_id": run_id,
            }
        )


class LunariaAgentBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = LunariaAgentBackend(
            {
                "id": "lunaria-main",
                "type": "lunaria",
                "name": "Lunaria",
                "baseUrl": "http://127.0.0.1:8317/v1",
                "apiKey": "",
                "model": "gpt-5.4",
                "embeddingBaseUrl": "http://127.0.0.1:11434/v1",
                "embeddingApiKey": "",
                "embeddingModel": "text-embedding-3-small",
                "userId": "alice",
                "promptMarkdownFiles": "ROLE.md",
                "memoryChromaPath": "data/mem0/chroma",
            }
        )

    def test_send_chat_injects_markdown_memories_and_history_before_current_user_message(self) -> None:
        requests: list[dict] = []
        fake_mem0 = _FakeMem0Service()

        def fake_urlopen(req, timeout=120):
            requests.append(json.loads(req.data.decode("utf-8")))
            return _FakeResponse(
                {
                    "model": "gpt-5.4",
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": "当然记得，你喜欢乌龙茶。",
                            }
                        }
                    ],
                }
            )

        with patch("backend.app.agents.lunaria.get_mem0_service", return_value=fake_mem0):
            with patch(
                "backend.app.agents.lunaria.load_prompt_markdown_sections",
                return_value=[
                    "# AGENTS.md\n\nagent rules",
                    "# IDENTITY.md\n\nidentity rules",
                    "# ROLE.md\n\nrole rules",
                ],
            ):
                with patch("backend.app.agents.lunaria.urllib.request.urlopen", side_effect=fake_urlopen):
                    result = self.backend.send_chat(
                        ChatRequest(
                            user_text="我刚刚说过我喜欢喝什么茶？",
                            agent="main",
                            session_name="desktop",
                            prior_messages=[
                                {"role": "user", "content": "我喜欢喝乌龙茶。"},
                                {"role": "assistant", "content": "记住了。"},
                            ],
                            context={"runId": "agent:main:desktop"},
                        )
                    )

        self.assertEqual(result["reply"], "当然记得，你喜欢乌龙茶。")
        self.assertEqual(len(requests), 1)
        sent_messages = requests[0]["messages"]
        self.assertEqual(sent_messages[1]["content"], "# AGENTS.md\n\nagent rules")
        self.assertEqual(sent_messages[2]["content"], "# IDENTITY.md\n\nidentity rules")
        self.assertEqual(sent_messages[3]["content"], "# ROLE.md\n\nrole rules")
        self.assertIn("oolong tea", sent_messages[4]["content"].lower())
        self.assertEqual(sent_messages[5]["content"], "我喜欢喝乌龙茶。")
        self.assertEqual(sent_messages[6]["content"], "记住了。")
        self.assertEqual(sent_messages[7]["content"], "我刚刚说过我喜欢喝什么茶？")
        self.assertEqual(fake_mem0.search_calls[0]["scope"], "agent")
        self.assertEqual(fake_mem0.add_calls[0]["assistant_text"], "当然记得，你喜欢乌龙茶。")

    def test_send_chat_executes_search_memory_tool_calls_before_returning_final_reply(self) -> None:
        requests: list[dict] = []
        fake_mem0 = _FakeMem0Service()
        responses = [
            {
                "model": "gpt-5.4",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {
                                        "name": "search_memory",
                                        "arguments": json.dumps(
                                            {
                                                "query": "用户喜欢什么茶",
                                                "scope": "session",
                                                "limit": 3,
                                            }
                                        ),
                                    },
                                }
                            ],
                        }
                    }
                ],
            },
            {
                "model": "gpt-5.4",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "你在这个会话里提过你喜欢乌龙茶。",
                        }
                    }
                ],
            },
        ]

        def fake_urlopen(req, timeout=120):
            requests.append(json.loads(req.data.decode("utf-8")))
            return _FakeResponse(responses[len(requests) - 1])

        with patch("backend.app.agents.lunaria.get_mem0_service", return_value=fake_mem0):
            with patch("backend.app.agents.lunaria_tools.get_mem0_service", return_value=fake_mem0):
                with patch("backend.app.agents.lunaria.load_prompt_markdown_sections", return_value=[]):
                    with patch("backend.app.agents.lunaria.urllib.request.urlopen", side_effect=fake_urlopen):
                        result = self.backend.send_chat(
                            ChatRequest(
                                user_text="我喜欢什么茶？",
                                agent="main",
                                session_name="desktop",
                                context={"runId": "agent:main:desktop"},
                            )
                        )

        self.assertEqual(result["reply"], "你在这个会话里提过你喜欢乌龙茶。")
        self.assertEqual(len(requests), 2)
        self.assertIn("tools", requests[0])
        followup_messages = requests[1]["messages"]
        self.assertEqual(followup_messages[-2]["role"], "assistant")
        self.assertEqual(followup_messages[-1]["role"], "tool")
        self.assertIn("oolong tea", followup_messages[-1]["content"].lower())
        self.assertEqual(fake_mem0.search_calls[-1]["scope"], "session")

    def test_send_chat_executes_registered_tools_through_generic_lunaria_tool_interface(self) -> None:
        requests: list[dict] = []
        fake_mem0 = _FakeMem0Service()
        invoked: list[dict] = []

        class _EchoTool:
            def definition(self) -> dict:
                return {
                    "type": "function",
                    "function": {
                        "name": "echo_context",
                        "description": "Echo test payload.",
                        "parameters": {
                            "type": "object",
                            "properties": {"value": {"type": "string"}},
                            "required": ["value"],
                            "additionalProperties": False,
                        },
                    },
                }

            def invoke(self, *, arguments: dict, request: ChatRequest) -> dict:
                invoked.append({"arguments": arguments, "context": dict(request.context)})
                return {
                    "echo": arguments.get("value"),
                    "runId": request.context.get("runId"),
                }

        responses = [
            {
                "model": "gpt-5.4",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_custom",
                                    "type": "function",
                                    "function": {
                                        "name": "echo_context",
                                        "arguments": json.dumps({"value": "hello"}),
                                    },
                                }
                            ],
                        }
                    }
                ],
            },
            {
                "model": "gpt-5.4",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "自定义工具已经执行。",
                        }
                    }
                ],
            },
        ]

        def fake_urlopen(req, timeout=120):
            requests.append(json.loads(req.data.decode("utf-8")))
            return _FakeResponse(responses[len(requests) - 1])

        with patch("backend.app.agents.lunaria.get_mem0_service", return_value=fake_mem0):
            with patch("backend.app.agents.lunaria.load_prompt_markdown_sections", return_value=[]):
                with patch.object(self.backend, "_get_tools", return_value=[_EchoTool()]):
                    with patch("backend.app.agents.lunaria.urllib.request.urlopen", side_effect=fake_urlopen):
                        result = self.backend.send_chat(
                            ChatRequest(
                                user_text="试一下自定义工具",
                                agent="main",
                                session_name="desktop",
                                context={"runId": "agent:main:desktop"},
                            )
                        )

        self.assertEqual(result["reply"], "自定义工具已经执行。")
        self.assertEqual(requests[0]["tools"][0]["function"]["name"], "echo_context")
        self.assertEqual(invoked, [{"arguments": {"value": "hello"}, "context": {"runId": "agent:main:desktop"}}])
        self.assertIn('"echo": "hello"', requests[1]["messages"][-1]["content"])
        self.assertIn('"runId": "agent:main:desktop"', requests[1]["messages"][-1]["content"])

    def test_send_chat_logs_phase_timings_for_markdown_memory_llm_tools_and_writeback(self) -> None:
        fake_mem0 = _FakeMem0Service()
        responses = [
            {
                "model": "gpt-5.4",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {
                                        "name": "search_memory",
                                        "arguments": json.dumps({"query": "用户喜欢什么茶"}),
                                    },
                                }
                            ],
                        }
                    }
                ],
            },
            {
                "model": "gpt-5.4",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "你喜欢乌龙茶。",
                        }
                    }
                ],
            },
        ]
        request_count = 0

        def fake_urlopen(req, timeout=120):
            nonlocal request_count
            response = responses[request_count]
            request_count += 1
            return _FakeResponse(response)

        with patch("backend.app.agents.lunaria.get_mem0_service", return_value=fake_mem0):
            with patch("backend.app.agents.lunaria_tools.get_mem0_service", return_value=fake_mem0):
                with patch("backend.app.agents.lunaria.load_prompt_markdown_sections", return_value=[]):
                    with patch("backend.app.agents.lunaria.urllib.request.urlopen", side_effect=fake_urlopen):
                        with patch("builtins.print") as mock_print:
                            self.backend.send_chat(
                                ChatRequest(
                                    user_text="我喜欢什么茶？",
                                    agent="main",
                                    session_name="desktop",
                                    context={"runId": "agent:main:desktop"},
                                )
                            )

        trace_payloads = []
        for call in mock_print.call_args_list:
            text = call.args[0]
            if isinstance(text, str) and text.startswith("[lunaria.trace] "):
                trace_payloads.append(json.loads(text.split("] ", 1)[1]))

        events = {item["event"] for item in trace_payloads}
        self.assertTrue(
            {
                "prompt.markdown",
                "memory.search",
                "llm.round",
                "tool.call",
                "memory.write",
                "request.complete",
            }.issubset(events)
        )
        self.assertTrue(trace_payloads)
        self.assertEqual({item["traceId"] for item in trace_payloads}.__len__(), 1)
        self.assertTrue(all(item["provider"] == "lunaria-main" for item in trace_payloads))


if __name__ == "__main__":
    unittest.main()
