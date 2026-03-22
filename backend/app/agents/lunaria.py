from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
import uuid

from ..services.mem0_service import get_mem0_service, load_prompt_markdown_sections
from .base import AgentBackend, ChatRequest, StreamEmitter
from .common import build_openai_headers, build_system_prompt, extract_text_from_message_content, log_chat_request, log_chat_response, truncate_for_log
from .lunaria_tools import DEFAULT_MEMORY_LIMIT, LunariaTool, get_lunaria_tools, normalize_memory_results, resolve_lunaria_memory_scope

MAX_TOOL_ROUNDS = 3


def _format_memory_system_prompt(results: list[dict]) -> str:
    if not results:
        return ""
    lines = ["Relevant memories:"]
    for item in results:
        text = str(item.get("memory") or item.get("text") or item.get("content") or "").strip()
        if not text:
            continue
        score = item.get("score")
        if score is None:
            lines.append(f"- {text}")
        else:
            lines.append(f"- {text} (score={score})")
    return "\n".join(lines) if len(lines) > 1 else ""


def _extract_tool_name(definition: dict) -> str:
    function = definition.get("function") or {}
    return str(function.get("name") or "").strip()


def _elapsed_ms(started_at: float) -> int:
    return max(0, int(round((time.perf_counter() - started_at) * 1000)))


def _log_lunaria_trace(provider: dict, request: ChatRequest, *, trace_id: str, event: str, **extra: object) -> None:
    payload = {
        "traceId": trace_id,
        "provider": provider.get("id") or provider.get("name") or "unknown",
        "agent": request.agent or "",
        "session": request.session_name or "",
        "event": event,
        **extra,
    }
    print(f"[lunaria.trace] {truncate_for_log(payload)}")


class LunariaAgentBackend(AgentBackend):
    def _build_user_content(self, request: ChatRequest) -> str | list[dict]:
        if not request.attachments:
            return request.user_text

        content: list[dict] = [{"type": "text", "text": request.user_text}]
        for attachment in request.attachments:
            content.append(attachment.to_openai_content())
        return content

    def _memory_scope(self, request: ChatRequest) -> tuple[str, str, str]:
        return resolve_lunaria_memory_scope(self.provider_config, request)

    def _get_tools(self) -> list[LunariaTool]:
        return get_lunaria_tools(self.provider_config)

    def _build_tool_registry(self) -> tuple[list[dict], dict[str, LunariaTool]]:
        definitions: list[dict] = []
        registry: dict[str, LunariaTool] = {}
        for tool in self._get_tools():
            definition = tool.definition()
            name = _extract_tool_name(definition)
            if not name:
                raise RuntimeError("Lunaria tool definition is missing a function name")
            if name in registry:
                raise RuntimeError(f"Duplicate Lunaria tool name: {name}")
            definitions.append(definition)
            registry[name] = tool
        return definitions, registry

    def _build_messages(self, request: ChatRequest, *, trace_id: str) -> list[dict]:
        system_prompt = build_system_prompt(request)
        user_id, agent_id, run_id = self._memory_scope(request)
        mem0_service = get_mem0_service(self.provider_config)
        markdown_sections = load_prompt_markdown_sections(self.provider_config)
        memory_results = normalize_memory_results(
            mem0_service.search(
                query=request.user_text,
                user_id=user_id,
                agent_id=agent_id,
                run_id=run_id,
                limit=DEFAULT_MEMORY_LIMIT,
                scope="agent",
            )
        )
        memory_prompt = _format_memory_system_prompt(memory_results)
        extra_prompts = [
            *markdown_sections,
            *[str(item).strip() for item in (request.extra_system_prompts or []) if str(item).strip()],
        ]
        if memory_prompt:
            extra_prompts.append(memory_prompt)

        messages = [{"role": "system", "content": system_prompt}]
        messages.extend({"role": "system", "content": prompt} for prompt in extra_prompts if prompt)
        messages.extend(dict(item) for item in (request.prior_messages or []) if isinstance(item, dict) and item.get("role"))
        messages.append({"role": "user", "content": self._build_user_content(request)})
        return messages

    def _build_payload(self, messages: list[dict], *, tool_definitions: list[dict]) -> dict:
        payload = {
            "model": self.provider_config.get("model") or "gpt-5.4",
            "messages": messages,
            "temperature": 0.7,
        }
        if tool_definitions:
            payload["tools"] = tool_definitions
            payload["tool_choice"] = "auto"
        return payload

    def _perform_completion(self, messages: list[dict], *, tool_definitions: list[dict]) -> dict:
        body = json.dumps(self._build_payload(messages, tool_definitions=tool_definitions), ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            f"{str(self.provider_config.get('baseUrl') or '').rstrip('/')}/chat/completions",
            data=body,
            method="POST",
            headers=build_openai_headers(str(self.provider_config.get("apiKey") or "")),
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"chat backend HTTP {exc.code}: {detail[:500]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"chat backend unavailable: {exc}") from exc
        return json.loads(raw.decode("utf-8"))

    def _execute_tool_call(
        self,
        *,
        tool_call: dict,
        request: ChatRequest,
        tools_by_name: dict[str, LunariaTool],
        trace_id: str,
        round_index: int,
    ) -> dict:
        function = tool_call.get("function") or {}
        name = str(function.get("name") or "").strip()
        started_at = time.perf_counter()
        tool = tools_by_name.get(name)
        if tool is None:
            result = {"error": f"Unknown tool: {name}"}
            _log_lunaria_trace(
                self.provider_config,
                request,
                trace_id=trace_id,
                event="tool.call",
                round=round_index,
                tool=name,
                elapsedMs=_elapsed_ms(started_at),
                ok=False,
            )
            return result

        try:
            arguments = json.loads(function.get("arguments") or "{}")
        except json.JSONDecodeError:
            result = {"error": f"Invalid JSON arguments for {name}"}
            _log_lunaria_trace(
                self.provider_config,
                request,
                trace_id=trace_id,
                event="tool.call",
                round=round_index,
                tool=name,
                elapsedMs=_elapsed_ms(started_at),
                ok=False,
            )
            return result

        try:
            result = tool.invoke(arguments=arguments, request=request)
        except Exception as exc:  # noqa: BLE001
            result = {"error": str(exc)}

        _log_lunaria_trace(
            self.provider_config,
            request,
            trace_id=trace_id,
            event="tool.call",
            round=round_index,
            tool=name,
            elapsedMs=_elapsed_ms(started_at),
            ok="error" not in result,
        )
        return result

    def _run_chat_loop(self, request: ChatRequest) -> tuple[dict, str]:
        trace_id = uuid.uuid4().hex[:8]
        total_started_at = time.perf_counter()
        messages = self._build_messages(request, trace_id=trace_id)
        tool_definitions, tools_by_name = self._build_tool_registry()
        final_data: dict = {}
        final_text = ""
        llm_round_count = 0
        tool_call_count = 0

        for _round in range(MAX_TOOL_ROUNDS + 1):
            llm_started_at = time.perf_counter()
            data = self._perform_completion(messages, tool_definitions=tool_definitions)
            final_data = data or final_data
            choices = data.get("choices") or []
            if not choices:
                raise RuntimeError("chat backend returned no choices")
            message = choices[0].get("message") or {}
            tool_calls = message.get("tool_calls") or []
            text = extract_text_from_message_content(message.get("content"))
            llm_round_count += 1
            tool_call_count += len(tool_calls)
            _log_lunaria_trace(
                self.provider_config,
                request,
                trace_id=trace_id,
                event="llm.round",
                round=_round,
                elapsedMs=_elapsed_ms(llm_started_at),
                toolCallCount=len(tool_calls),
                hasContent=bool(text),
            )
            if not tool_calls:
                final_text = text or "……我刚刚没组织出可显示的回复。"
                break

            messages.append(
                {
                    "role": "assistant",
                    "content": message.get("content") or "",
                    "tool_calls": tool_calls,
                }
            )
            for tool_call in tool_calls:
                tool_result = self._execute_tool_call(
                    tool_call=tool_call,
                    request=request,
                    tools_by_name=tools_by_name,
                    trace_id=trace_id,
                    round_index=_round,
                )
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": str(tool_call.get("id") or ""),
                        "content": json.dumps(tool_result, ensure_ascii=False),
                    }
                )
        else:
            raise RuntimeError(f"lunaria tool loop exceeded {MAX_TOOL_ROUNDS} rounds")

        if final_text:
            user_id, agent_id, run_id = self._memory_scope(request)
            write_started_at = time.perf_counter()
            get_mem0_service(self.provider_config).add_exchange(
                user_text=request.user_text,
                assistant_text=final_text,
                user_id=user_id,
                agent_id=agent_id,
                run_id=run_id,
            )
            _log_lunaria_trace(
                self.provider_config,
                request,
                trace_id=trace_id,
                event="memory.write",
                elapsedMs=_elapsed_ms(write_started_at),
            )
        _log_lunaria_trace(
            self.provider_config,
            request,
            trace_id=trace_id,
            event="request.complete",
            totalMs=_elapsed_ms(total_started_at),
            llmRoundCount=llm_round_count,
            toolCallCount=tool_call_count,
        )
        return final_data, final_text

    def _result_payload(self, *, data: dict, text: str, request: ChatRequest) -> dict:
        return {
            "reply": text,
            "provider": self.provider_config.get("id") or "lunaria",
            "providerLabel": self.provider_config.get("name") or "Lunaria",
            "model": data.get("model") or (self.provider_config.get("model") or "gpt-5.4"),
            "usage": data.get("usage") or {},
            "agent": request.agent or "",
            "session": request.session_name or "",
            "sessionKey": f"agent:{request.agent}:{request.session_name}" if request.agent and request.session_name else "",
            "state": "final",
        }

    def send_chat(self, request: ChatRequest) -> dict:
        data, text = self._run_chat_loop(request)
        log_chat_response(self.provider_config, reply=text, state="final", streamed=False)
        return self._result_payload(data=data, text=text, request=request)

    def stream_chat(self, request: ChatRequest, emit: StreamEmitter) -> dict:
        data, text = self._run_chat_loop(request)
        emit({"type": "delta", "delta": text, "reply": text})
        log_chat_response(self.provider_config, reply=text, state="final", streamed=True)
        return self._result_payload(data=data, text=text, request=request)
