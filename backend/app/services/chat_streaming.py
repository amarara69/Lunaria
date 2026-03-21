from __future__ import annotations

import asyncio
import contextlib
import json
import re
import uuid
from pathlib import Path

from fastapi.responses import StreamingResponse

from ..app_context import AppContext
from ..services.tts_service import TtsRequest, extract_tts_overrides
from ..utils import strip_stage_directives
from ..web.helpers import build_route_key, require_existing_session
from ..web.sse import format_sse


def _safe_audio_extension(content_type: str | None) -> str:
    ct = str(content_type or "").lower().split(";", 1)[0].strip()
    if ct in {"audio/mpeg", "audio/mp3"}:
        return ".mp3"
    if ct in {"audio/wav", "audio/x-wav"}:
        return ".wav"
    if ct in {"audio/flac"}:
        return ".flac"
    if ct in {"audio/ogg", "audio/opus", "audio/ogg; codecs=opus"}:
        return ".ogg"
    return ".bin"


def _parse_stage_directive_content(content: str) -> dict | None:
    parts = [p.strip() for p in str(content or "").split(":") if p.strip()]
    if not parts:
        return None
    head = (parts[0] or "").lower()
    if head in {"expression", "exp", "expr"} and len(parts) >= 2:
        return {"type": "expression", "name": ":".join(parts[1:]).strip()}
    if head in {"motion", "act"} and len(parts) >= 2:
        if len(parts) == 2:
            try:
                idx = int(float(parts[1]))
                return {"type": "motion", "group": "", "index": idx}
            except Exception:
                return {"type": "motion", "group": parts[1], "index": 0}
        group = parts[1]
        try:
            idx = int(float(parts[2]))
        except Exception:
            idx = 0
        return {"type": "motion", "group": group, "index": idx}
    return None


def _split_stream_segments(text: str, *, allow_soft_break: bool, soft_break_threshold: int, min_segment_chars: int) -> tuple[list[str], str]:
    source = str(text or "")
    segments: list[str] = []
    start = 0
    i = 0
    hard_breaks = "。！？!?\n.；;"
    soft_breaks = "，,：:"
    soft_break_threshold = max(1, int(soft_break_threshold or 20))
    min_segment_chars = max(1, int(min_segment_chars or 1))

    while i < len(source):
        ch = source[i]
        buffer_len = len(source[start : i + 1].strip())
        should_break_hard = ch in hard_breaks
        should_break_soft = bool(allow_soft_break) and (ch in soft_breaks) and buffer_len <= soft_break_threshold
        if should_break_hard or should_break_soft:
            end = i + 1
            same_break_set = hard_breaks if should_break_hard else soft_breaks
            while end < len(source) and source[end] in same_break_set:
                end += 1
            chunk = source[start:end].strip()
            if chunk and len(chunk) >= min_segment_chars:
                segments.append(chunk)
                start = end
            i = end
            continue
        i += 1
    return segments, source[start:]


class SpeechStreamParser:
    def __init__(self):
        self.display_text = ""
        self.visible_buffer = ""
        self.in_directive = False
        self.directive_buffer = ""
        self.pending_directives: list[dict] = []

    def _flush_visible(self, *, allow_soft_break: bool, soft_break_threshold: int, min_segment_chars: int) -> list[dict]:
        units: list[dict] = []
        segments, remainder = _split_stream_segments(
            self.visible_buffer,
            allow_soft_break=allow_soft_break,
            soft_break_threshold=soft_break_threshold,
            min_segment_chars=min_segment_chars,
        )
        for seg in segments:
            units.append({"text": seg, "directives": [*self.pending_directives]})
            self.pending_directives.clear()

        if not segments and str(remainder or "").strip() == "" and self.pending_directives:
            units.append({"text": "", "directives": [*self.pending_directives]})
            self.pending_directives.clear()
            self.visible_buffer = ""
            return units

        self.visible_buffer = remainder
        return units

    def consume(self, chunk: str, *, allow_soft_break: bool, soft_break_threshold: int, min_segment_chars: int) -> tuple[list[dict], str]:
        source = str(chunk or "")
        units: list[dict] = []
        punct = "。！？!?\n.，,：:；;"
        for ch in source:
            if self.in_directive:
                if ch == "]":
                    boundary_text = str(self.visible_buffer or "").strip()
                    if boundary_text:
                        units.append({"text": boundary_text, "directives": [*self.pending_directives]})
                        self.pending_directives.clear()
                        self.visible_buffer = ""

                    directive = _parse_stage_directive_content(self.directive_buffer)
                    if directive:
                        self.pending_directives.append(directive)
                    else:
                        literal = f"[{self.directive_buffer}]"
                        self.display_text += literal
                        self.visible_buffer += literal

                    self.in_directive = False
                    self.directive_buffer = ""
                    units.extend(
                        self._flush_visible(
                            allow_soft_break=allow_soft_break,
                            soft_break_threshold=soft_break_threshold,
                            min_segment_chars=min_segment_chars,
                        )
                    )
                    continue

                self.directive_buffer += ch
                continue

            if ch == "[":
                self.in_directive = True
                self.directive_buffer = ""
                continue

            self.display_text += ch
            self.visible_buffer += ch
            if ch in punct:
                units.extend(
                    self._flush_visible(
                        allow_soft_break=allow_soft_break,
                        soft_break_threshold=soft_break_threshold,
                        min_segment_chars=min_segment_chars,
                    )
                )

        return units, self.display_text

    def finalize(self, *, allow_soft_break: bool, soft_break_threshold: int, min_segment_chars: int) -> tuple[list[dict], str]:
        units: list[dict] = []
        segments, remainder = _split_stream_segments(
            self.visible_buffer,
            allow_soft_break=allow_soft_break,
            soft_break_threshold=soft_break_threshold,
            min_segment_chars=min_segment_chars,
        )
        for seg in segments:
            units.append({"text": seg, "directives": [*self.pending_directives]})
            self.pending_directives.clear()

        trailing = str(remainder or "").strip()
        if trailing:
            units.append({"text": trailing, "directives": [*self.pending_directives]})
            self.pending_directives.clear()

        self.visible_buffer = ""
        if self.in_directive and self.directive_buffer:
            self.display_text += f"[{self.directive_buffer}"
        self.in_directive = False
        self.directive_buffer = ""
        return units, self.display_text


def _parse_full_speech_units(text: str, *, allow_soft_break: bool, soft_break_threshold: int, min_segment_chars: int) -> tuple[list[dict], str]:
    parser = SpeechStreamParser()
    units, visible = parser.consume(
        text,
        allow_soft_break=allow_soft_break,
        soft_break_threshold=soft_break_threshold,
        min_segment_chars=min_segment_chars,
    )
    trailing_units, visible = parser.finalize(
        allow_soft_break=allow_soft_break,
        soft_break_threshold=soft_break_threshold,
        min_segment_chars=min_segment_chars,
    )
    if trailing_units:
        units.extend(trailing_units)
    return units, visible


def _extract_partial_speech_from_json(raw: str) -> str | None:
    s = str(raw or "")
    key = '"speech"'
    k = s.find(key)
    if k < 0:
        return None
    colon = s.find(":", k + len(key))
    if colon < 0:
        return None
    i = colon + 1
    while i < len(s) and s[i] in " \t\r\n":
        i += 1
    if i >= len(s) or s[i] != '"':
        return None
    i += 1

    out_chars: list[str] = []
    esc = False
    while i < len(s):
        ch = s[i]
        if esc:
            if ch == "n":
                out_chars.append("\n")
            elif ch == "r":
                out_chars.append("\r")
            elif ch == "t":
                out_chars.append("\t")
            elif ch in {'"', "\\", "/"}:
                out_chars.append(ch)
            elif ch == "u":
                if i + 4 < len(s):
                    hexpart = s[i + 1 : i + 5]
                    try:
                        out_chars.append(chr(int(hexpart, 16)))
                        i += 4
                    except Exception:
                        out_chars.append("u")
                else:
                    break
            else:
                out_chars.append(ch)
            esc = False
            i += 1
            continue

        if ch == "\\":
            esc = True
            i += 1
            continue
        if ch == '"':
            break
        out_chars.append(ch)
        i += 1

    return "".join(out_chars)


def _try_parse_structured_reply(text: str) -> dict | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    candidates: list[str] = [raw]

    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, flags=re.IGNORECASE)
    if fenced and fenced.group(1):
        candidates.append(fenced.group(1).strip())

    brace = re.search(r"\{[\s\S]*\}\s*$", raw)
    if brace and brace.group(0):
        candidates.append(brace.group(0).strip())

    for cand in candidates:
        try:
            parsed = json.loads(cand)
        except Exception:
            continue
        if not isinstance(parsed, dict):
            continue
        speech = parsed.get("speech")
        actions = parsed.get("actions")
        if isinstance(speech, str) or isinstance(actions, list):
            return parsed
    return None


class ChatStreamingService:
    def __init__(self, context: AppContext):
        self.context = context

    def create_response(self, body: dict) -> StreamingResponse:
        return StreamingResponse(
            self._stream(body),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
            },
        )

    async def _stream(self, body: dict):
        session_store = self.context.session_store
        chat_service = self.context.chat_service
        events_bus = self.context.events_bus
        tts_service = self.context.tts_service
        uploads_dir = self.context.uploads_dir

        resolved = chat_service.resolve_request(body)
        session_id = require_existing_session(session_store, str(body.get("sessionId") or "").strip())
        requested_route_key = build_route_key(
            provider_id=str(resolved.provider.get("id") or ""),
            agent=resolved.agent,
            session_name=resolved.session_name,
        )
        session_store.bind_route(session_id, requested_route_key)
        session_store.set_current_session_id(session_id)

        yield format_sse(
            {
                "seq": 0,
                "type": "start",
                "ts": 0,
                "payload": {
                    "ok": True,
                    "provider": resolved.provider.get("id"),
                    "providerLabel": resolved.provider.get("name"),
                    "agent": resolved.agent,
                    "session": resolved.session_name,
                },
            },
            event_name="start",
            include_id=False,
        )

        v2_raw = ""
        speech_raw = ""
        speech_parser = SpeechStreamParser()
        submitted_units = 0
        pending_units: list[dict] = []

        try:
            from ..config import get_tts_config

            chat_tts_cfg = get_tts_config() or {}
        except Exception:
            chat_tts_cfg = {}

        soft_break_threshold = int(chat_tts_cfg.get("softBreakMaxChars") or 20)
        min_segment_chars = int(chat_tts_cfg.get("minSegmentChars") or 1)
        want_tts = bool(body.get("ttsEnabled", True))
        tts_provider_override = str(body.get("ttsProvider") or "").strip() or None
        tts_overrides = extract_tts_overrides(body)
        tts_unit_q: asyncio.Queue[dict] = asyncio.Queue(maxsize=200)
        tts_sse_q: asyncio.Queue[str] = asyncio.Queue(maxsize=200)
        tts_worker_task: asyncio.Task | None = None

        async def stop_tts_worker(force_cancel: bool = False) -> None:
            nonlocal tts_worker_task
            if not tts_worker_task:
                return
            if tts_worker_task.done():
                with contextlib.suppress(Exception):
                    await tts_worker_task
                return
            if force_cancel:
                tts_worker_task.cancel()
            else:
                with contextlib.suppress(Exception):
                    await tts_unit_q.put({"_type": "_stop"})
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await tts_worker_task

        async def tts_worker() -> None:
            nonlocal submitted_units
            while True:
                unit = await tts_unit_q.get()
                if unit.get("_type") == "_stop":
                    break
                text = str(unit.get("text") or "")
                directives = unit.get("directives") or []
                if not text and not directives:
                    continue

                if not text:
                    await tts_sse_q.put(
                        format_sse(
                            {
                                "seq": 0,
                                "type": "timeline",
                                "ts": 0,
                                "payload": {"unit": {"i": submitted_units, "text": "", "directives": directives, "audioUrl": "", "audioMs": 0}},
                            },
                            event_name="timeline",
                            include_id=False,
                        )
                    )
                    submitted_units += 1
                    continue

                try:
                    audio_bytes, content_type = await tts_service.synthesize(
                        req=TtsRequest(
                            text=text,
                            mode="chat",
                            provider_override=tts_provider_override,
                            overrides=tts_overrides,
                        )
                    )
                    ext = _safe_audio_extension(content_type)
                    fname = f"chat_{uuid.uuid4().hex}{ext}"
                    (uploads_dir / fname).write_bytes(audio_bytes)
                    audio_url = f"/uploads/{fname}"
                    await tts_sse_q.put(
                        format_sse(
                            {
                                "seq": 0,
                                "type": "timeline",
                                "ts": 0,
                                "payload": {
                                    "unit": {
                                        "i": submitted_units,
                                        "text": text,
                                        "directives": directives,
                                        "audioUrl": audio_url,
                                        "audioMs": 0,
                                        "contentType": content_type,
                                    }
                                },
                            },
                            event_name="timeline",
                            include_id=False,
                        )
                    )
                except Exception as exc:  # noqa: BLE001
                    await tts_sse_q.put(
                        format_sse(
                            {
                                "seq": 0,
                                "type": "timeline",
                                "ts": 0,
                                "payload": {
                                    "unit": {
                                        "i": submitted_units,
                                        "text": text,
                                        "directives": directives,
                                        "audioUrl": "",
                                        "audioMs": 0,
                                        "error": str(exc),
                                    }
                                },
                            },
                            event_name="timeline",
                            include_id=False,
                        )
                    )
                finally:
                    submitted_units += 1

        if want_tts:
            tts_worker_task = asyncio.create_task(tts_worker())

        try:
            loop = asyncio.get_running_loop()
            delta_q: asyncio.Queue[dict] = asyncio.Queue(maxsize=200)
            result_fut: asyncio.Future[dict] = loop.create_future()

            def put_delta(payload: dict) -> None:
                with contextlib.suppress(Exception):
                    delta_q.put_nowait(payload)

            def set_result(result: dict) -> None:
                with contextlib.suppress(Exception):
                    if not result_fut.done():
                        result_fut.set_result(result)

            def set_exception(exc: BaseException) -> None:
                with contextlib.suppress(Exception):
                    if not result_fut.done():
                        result_fut.set_exception(exc)

            def emit(payload: dict) -> None:
                try:
                    loop.call_soon_threadsafe(put_delta, payload)
                except Exception:
                    pass

            def run_provider_blocking() -> None:
                try:
                    result = chat_service.run_chat_stream(resolved, emit)
                    loop.call_soon_threadsafe(set_result, result)
                except Exception as exc:  # noqa: BLE001
                    loop.call_soon_threadsafe(set_exception, exc)

            loop.run_in_executor(None, run_provider_blocking)

            while True:
                if result_fut.done() and delta_q.empty():
                    break
                try:
                    payload = await asyncio.wait_for(delta_q.get(), timeout=0.25)
                except TimeoutError:
                    continue

                delta_text = str(payload.get("delta") or "")
                if not delta_text:
                    continue
                v2_raw += delta_text

                extracted = _extract_partial_speech_from_json(v2_raw)
                if extracted is None:
                    continue

                if not extracted.startswith(speech_raw):
                    speech_raw = extracted
                    speech_parser = SpeechStreamParser()
                    pending_units = []
                    submitted_units = 0
                    units, visible = speech_parser.consume(
                        extracted,
                        allow_soft_break=True,
                        soft_break_threshold=soft_break_threshold,
                        min_segment_chars=min_segment_chars,
                    )
                else:
                    new_part = extracted[len(speech_raw) :]
                    speech_raw = extracted
                    units, visible = speech_parser.consume(
                        new_part,
                        allow_soft_break=True,
                        soft_break_threshold=soft_break_threshold,
                        min_segment_chars=min_segment_chars,
                    )

                yield format_sse(
                    {"seq": 0, "type": "chunk", "ts": 0, "payload": {"kind": "text", "visibleText": visible, "rawText": speech_raw}},
                    event_name="chunk",
                    include_id=False,
                )

                if units:
                    pending_units.extend(units)

                if want_tts and pending_units:
                    while pending_units:
                        await tts_unit_q.put(pending_units.pop(0))

                if want_tts:
                    while True:
                        try:
                            frame = tts_sse_q.get_nowait()
                        except Exception:
                            break
                        yield frame

            result = await result_fut
        except asyncio.CancelledError:
            await stop_tts_worker(force_cancel=True)
            return
        except Exception as exc:  # noqa: BLE001
            await stop_tts_worker(force_cancel=True)
            yield format_sse(
                {"seq": 0, "type": "error", "ts": 0, "payload": {"error": str(exc)}},
                event_name="error",
                include_id=False,
            )
            return

        assistant_raw = str(result.get("reply") or "")
        structured_final = _try_parse_structured_reply(assistant_raw)
        if structured_final and isinstance(structured_final.get("speech"), str):
            final_speech_source = str(structured_final.get("speech") or "")
            assistant_visible = strip_stage_directives(final_speech_source)
            assistant_actions = structured_final.get("actions") if isinstance(structured_final.get("actions"), list) else []
        else:
            final_speech_source = assistant_raw
            assistant_visible = strip_stage_directives(assistant_raw)
            assistant_actions = []

        final_units, _ = speech_parser.finalize(
            allow_soft_break=True,
            soft_break_threshold=soft_break_threshold,
            min_segment_chars=min_segment_chars,
        )
        if final_units:
            pending_units.extend(final_units)

        if not speech_raw.strip():
            fallback_units, fallback_visible = _parse_full_speech_units(
                final_speech_source,
                allow_soft_break=True,
                soft_break_threshold=soft_break_threshold,
                min_segment_chars=min_segment_chars,
            )
            if fallback_units:
                pending_units.extend(fallback_units)
            elif assistant_visible.strip():
                pending_units.append({"text": assistant_visible.strip(), "directives": []})

            if fallback_visible.strip():
                yield format_sse(
                    {
                        "seq": 0,
                        "type": "chunk",
                        "ts": 0,
                        "payload": {
                            "kind": "text",
                            "visibleText": fallback_visible,
                            "rawText": final_speech_source,
                        },
                    },
                    event_name="chunk",
                    include_id=False,
                )

        if want_tts and pending_units:
            while pending_units:
                await tts_unit_q.put(pending_units.pop(0))

        if want_tts:
            await stop_tts_worker(force_cancel=False)
            while True:
                try:
                    frame = tts_sse_q.get_nowait()
                except Exception:
                    break
                yield frame

        chat_service.persist_user_message(
            session_id=session_id,
            history_text=resolved.history_text,
            attachments=resolved.attachments,
            source=resolved.message_source,
        )

        persisted = chat_service.persist_assistant_message(
            session_id=session_id,
            reply=assistant_visible,
            raw_reply=assistant_raw,
            images=result.get("images") or [],
            meta=resolved.assistant_meta,
            source=resolved.message_source,
        )
        await events_bus.publish("message.created", {"message": persisted})

        if assistant_actions:
            yield format_sse(
                {
                    "seq": 0,
                    "type": "action",
                    "ts": 0,
                    "payload": {"actions": assistant_actions},
                },
                event_name="action",
                include_id=False,
            )

        yield format_sse(
            {
                "seq": 0,
                "type": "final",
                "ts": 0,
                "payload": {
                    "ok": True,
                    "messageId": persisted.get("id", ""),
                    "userText": resolved.history_text,
                    "reply": assistant_visible,
                    "rawReply": assistant_raw,
                    "actions": assistant_actions,
                    "tts": {"enabled": want_tts},
                    "provider": result.get("provider"),
                    "providerLabel": result.get("providerLabel", resolved.provider.get("name") or resolved.provider.get("id") or ""),
                    "model": result.get("model"),
                    "usage": result.get("usage", {}),
                    "agent": result.get("agent", resolved.agent),
                    "session": result.get("session", resolved.session_name),
                    "sessionKey": result.get("sessionKey", f"agent:{resolved.agent}:{resolved.session_name}" if resolved.agent and resolved.session_name else ""),
                    "state": result.get("state", "final"),
                    "images": result.get("images", []),
                },
            },
            event_name="final",
            include_id=False,
        )
        final_route_key = build_route_key(
            provider_id=str(result.get("provider") or resolved.provider.get("id") or ""),
            session_key=str(result.get("sessionKey") or ""),
            agent=str(result.get("agent") or resolved.agent or ""),
            session_name=str(result.get("session") or resolved.session_name or ""),
        )
        session_store.bind_route(session_id, final_route_key)
