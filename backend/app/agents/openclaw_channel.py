from __future__ import annotations

import asyncio
import base64
import json
import re
import threading
import time
import uuid
from collections.abc import Callable

from .base import AgentBackend, ChatAttachment, ChatRequest, StreamEmitter
from .common import LIVE2D_INIT_VERSION, build_live2d_init_message, build_system_prompt, log_chat_request, log_chat_response

# Cross-request guard: `create_agent_backend()` returns a fresh backend instance per HTTP call.
# We keep the init guard at module level, keyed by (bridgeUrl, sessionKey, modelId).
_CHANNEL_LIVE2D_INIT_GUARD: set[str] = set()
_BRIDGE_CONNECT_RETRY_DELAYS = (0.25, 0.5, 1.0)


def _is_retryable_bridge_connect_error(exc: BaseException) -> bool:
    if isinstance(exc, (TimeoutError, ConnectionRefusedError)):
        return True
    if isinstance(exc, OSError):
        if exc.errno in {61, 111, 10061}:
            return True
        message = str(exc).lower()
        return 'connect call failed' in message or 'cannot connect' in message or 'connection refused' in message
    return False


async def _open_bridge_connection(bridge_url: str, **connect_kwargs):
    try:
        import websockets
    except ModuleNotFoundError as exc:
        raise RuntimeError("Python package 'websockets' is missing from the nix-shell environment.") from exc

    last_exc: BaseException | None = None
    attempts = len(_BRIDGE_CONNECT_RETRY_DELAYS) + 1
    connect_options = dict(connect_kwargs)
    connect_options.setdefault('open_timeout', 3.0)
    for attempt_index in range(attempts):
        try:
            return await websockets.connect(bridge_url, **connect_options)
        except Exception as exc:  # noqa: BLE001
            if not _is_retryable_bridge_connect_error(exc) or attempt_index >= attempts - 1:
                if _is_retryable_bridge_connect_error(exc):
                    raise RuntimeError(
                        f'Unable to connect to OpenClaw Live2D bridge at {bridge_url} after {attempts} attempts: {exc}'
                    ) from exc
                raise
            last_exc = exc
            await asyncio.sleep(_BRIDGE_CONNECT_RETRY_DELAYS[attempt_index])
    if last_exc is not None:
        raise RuntimeError(f'Unable to connect to OpenClaw Live2D bridge at {bridge_url}: {last_exc}') from last_exc
    raise RuntimeError(f'Unable to connect to OpenClaw Live2D bridge at {bridge_url}')


def _normalize_base64_payload(data: str) -> str:
    value = str(data or '').strip()
    if value.startswith('data:') and ',' in value:
        value = value.split(',', 1)[1]
    value = re.sub(r'\s+', '', value)
    return value


def _prepare_bridge_attachments(attachments: list[ChatAttachment]) -> list[dict]:
    result: list[dict] = []
    for att in attachments:
        if att.type == 'url':
            result.append({
                'kind': 'image',
                'url': att.data,
                'mimeType': att.media_type or 'image/png',
            })
        elif att.type == 'base64':
            normalized = _normalize_base64_payload(att.data)
            try:
                base64.b64decode(normalized, validate=True)
            except Exception as exc:
                preview = normalized[:48]
                raise RuntimeError(f'Invalid base64 image payload for live2d channel: prefix={preview!r}, len={len(normalized)}') from exc
            result.append({
                'kind': 'image',
                'content': normalized,
                'mimeType': att.media_type or 'image/png',
            })
    return result


_PUSH_CALLBACK: Callable[[dict], None] | None = None
_PUSH_THREADS: dict[str, threading.Thread] = {}
_PUSH_STOPS: dict[str, threading.Event] = {}


def set_push_callback(callback: Callable[[dict], None] | None) -> None:
    global _PUSH_CALLBACK
    _PUSH_CALLBACK = callback


def _emit_push_message(frame: dict) -> None:
    callback = _PUSH_CALLBACK
    if callback is not None:
        callback(frame)


def _listener_id(provider_config: dict) -> str:
    provider_id = str(provider_config.get('id') or '').strip()
    bridge_url = str(provider_config.get('bridgeUrl') or 'ws://127.0.0.1:18790').strip()
    return provider_id or bridge_url


def ensure_bridge_listener(provider_config: dict) -> None:
    provider_type = str(provider_config.get('type') or '').strip()
    if provider_type != 'openclaw-channel':
        return
    listener_id = _listener_id(provider_config)
    existing = _PUSH_THREADS.get(listener_id)
    if existing and existing.is_alive():
        return
    stop_event = threading.Event()
    _PUSH_STOPS[listener_id] = stop_event
    thread = threading.Thread(
        target=_run_bridge_listener_forever,
        args=(dict(provider_config), stop_event),
        daemon=True,
        name=f'openclaw-channel-push:{listener_id}',
    )
    _PUSH_THREADS[listener_id] = thread
    thread.start()


def stop_bridge_listener() -> None:
    for stop_event in _PUSH_STOPS.values():
        stop_event.set()
    _PUSH_STOPS.clear()
    _PUSH_THREADS.clear()


def _run_bridge_listener_forever(provider_config: dict, stop_event: threading.Event) -> None:
    while not stop_event.is_set():
        try:
            asyncio.run(_bridge_listener_loop(provider_config, stop_event))
        except Exception as exc:
            print(f'[OpenClawChannel] push listener error: {exc}')
        if not stop_event.wait(3.0):
            continue
        break


async def _bridge_listener_loop(provider_config: dict, stop_event: threading.Event) -> None:
    bridge_url = str(provider_config.get('bridgeUrl') or 'ws://127.0.0.1:18790').strip()
    sender_id = str(provider_config.get('senderId') or 'desktop-user')
    sender_name = str(provider_config.get('senderName') or 'Live2D User')
    ws = await _open_bridge_connection(bridge_url, ping_interval=20, ping_timeout=20)
    try:
        await ws.send(json.dumps({
            'type': 'bridge.register',
            'target': sender_id,
            'senderId': sender_id,
            'senderName': sender_name,
            'providerId': str(provider_config.get('id') or '').strip(),
            'ts': time.time(),
        }))
        while not stop_event.is_set():
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=30)
            except TimeoutError:
                await ws.send(json.dumps({'type': 'ping', 'ts': time.time()}))
                continue
            frame = json.loads(raw)
            ftype = str(frame.get('type') or '')
            if ftype == 'push.message':
                frame['providerId'] = str(provider_config.get('id') or frame.get('providerId') or 'live2d-channel').strip()
                _emit_push_message(frame)
            elif ftype in {'pong', 'bridge.registered'}:
                continue
    finally:
        await ws.close()


class OpenClawChannelAgentBackend(AgentBackend):
    async def _run_channel_chat(
        self,
        request: ChatRequest,
        emit: StreamEmitter | None = None,
        timeout_seconds: float = 120.0,
    ) -> dict:
        agent = request.agent or str(self.provider_config.get('agent') or 'main')
        session_name = request.session_name or str(self.provider_config.get('session') or 'main')
        bridge_url = str(self.provider_config.get('bridgeUrl') or 'ws://127.0.0.1:18790').strip()
        sender_id = str(self.provider_config.get('senderId') or 'desktop-user')
        sender_name = str(self.provider_config.get('senderName') or 'Live2D User')
        attachments = _prepare_bridge_attachments(request.attachments)
        request_id = str(uuid.uuid4())
        system_prompt = build_system_prompt(request)
        log_chat_request(self.provider_config, request, system_prompt)
        if attachments:
            print(f"[OpenClawChannel] Sending {len(attachments)} attachment(s): {[{'kind': a.get('kind'), 'mimeType': a.get('mimeType'), 'hasContent': bool(a.get('content')), 'hasUrl': bool(a.get('url')), 'contentLen': len(a.get('content') or ''), 'contentPrefix': (a.get('content') or '')[:24]} for a in attachments]}")

        ws = await _open_bridge_connection(bridge_url)
        try:
            # The OpenClaw channel bridge does not provide a real system-prompt slot.
            # We therefore send a one-shot init message once per (bridgeUrl, sessionKey, modelId)
            # and combine it with the first user message.
            model_id = ((request.model_config or {}).get('id') or '').strip()
            session_key = f'agent:{agent}:{session_name}'
            guard_key = f"{bridge_url}|{session_key}|model:{model_id}|init:v{LIVE2D_INIT_VERSION}"

            text = request.user_text
            if guard_key not in _CHANNEL_LIVE2D_INIT_GUARD:
                _CHANNEL_LIVE2D_INIT_GUARD.add(guard_key)
                init_message = build_live2d_init_message(request)
                text = f"{init_message}\n\n[[USER_MESSAGE]]\n{request.user_text}"

            await ws.send(json.dumps({
                'type': 'chat.request',
                'requestId': request_id,
                'text': text,
                'attachments': attachments,
                'agent': agent,
                'session': session_name,
                'sessionKey': session_key,
                'senderId': sender_id,
                'senderName': sender_name,
                'conversationLabel': session_name,
            }))

            accumulated_text = ''
            final_media: list[dict] = []
            final_state = 'final'

            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=timeout_seconds)
                frame = json.loads(raw)
                if frame.get('requestId') not in {None, request_id}:
                    continue

                ftype = frame.get('type')
                if ftype == 'chat.delta':
                    delta = str(frame.get('delta') or '')
                    reply = str(frame.get('reply') or accumulated_text + delta)
                    accumulated_text = reply
                    if emit and delta:
                        emit({
                            'type': 'delta',
                            'delta': delta,
                            'reply': accumulated_text,
                            'state': 'streaming',
                        })
                elif ftype == 'chat.media':
                    media = frame.get('media') or {}
                    if isinstance(media, dict):
                        final_media.append(media)
                elif ftype == 'chat.final':
                    accumulated_text = str(frame.get('reply') or accumulated_text)
                    more_media = frame.get('media') or []
                    if isinstance(more_media, list):
                        final_media = more_media
                    final_state = str(frame.get('state') or 'final')
                    break
                elif ftype == 'chat.error':
                    raise RuntimeError(str(frame.get('error') or 'live2d channel bridge error'))
                else:
                    continue
        finally:
            await ws.close()

        reply = accumulated_text.strip() or '……我刚刚没有拿到可显示的回复。'
        images = [m for m in final_media if isinstance(m, dict) and m.get('type') == 'image' and m.get('url')]
        audio = [m for m in final_media if isinstance(m, dict) and m.get('type') == 'audio' and m.get('url')]
        log_chat_response(self.provider_config, reply=reply, state=final_state, streamed=emit is not None)
        return {
            'reply': reply,
            'images': images,
            'audio': audio,
            'provider': self.provider_config.get('id') or 'live2d-channel',
            'providerLabel': self.provider_config.get('name') or 'OpenClaw Live2D Channel',
            'model': 'channel-bridge',
            'usage': {},
            'agent': agent,
            'session': session_name,
            'sessionKey': f'agent:{agent}:{session_name}',
            'state': final_state,
        }

    def send_chat(self, request: ChatRequest) -> dict:
        return asyncio.run(self._run_channel_chat(request))

    def stream_chat(self, request: ChatRequest, emit: StreamEmitter) -> dict:
        return asyncio.run(self._run_channel_chat(request, emit=emit))
