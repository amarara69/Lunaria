from __future__ import annotations

"""Push runtime service.

The OpenClaw live2d-channel bridge listener can deliver push frames (e.g.
`push.message`) from a background thread. The legacy backend used a global
unbounded Queue.

This service provides:
- bounded queue (backpressure / drop policy)
- single worker thread
- optional push-TTS synthesis (delegated to TtsService)
- hooks to publish events / persist messages (to be wired in incrementally)
"""

import queue
import threading
from dataclasses import dataclass

from ..config import get_tts_config
from ..utils import log_push_debug
from .tts_service import TtsRequest, TtsService


@dataclass(slots=True)
class PushConfig:
    queue_maxsize: int = 200
    drop_policy: str = "drop_oldest"  # drop_oldest | drop_new


class PushService:
    def __init__(self, *, config: PushConfig | None = None, tts: TtsService | None = None):
        self.config = config or PushConfig()
        self._queue: queue.Queue[dict] = queue.Queue(maxsize=int(self.config.queue_maxsize))
        self._worker: threading.Thread | None = None
        self.tts = tts or TtsService()

        # Optional hooks (wired by FastAPI app).
        self.on_message: callable | None = None

    def start(self) -> None:
        if self._worker and self._worker.is_alive():
            return

        def _run() -> None:
            while True:
                frame = self._queue.get()
                try:
                    if frame is None:
                        continue
                    self._handle_frame(frame)
                except Exception as exc:  # noqa: BLE001
                    print(f"[PushService] worker error: {exc}")

        self._worker = threading.Thread(target=_run, daemon=True, name="push-worker")
        self._worker.start()

    def enqueue(self, frame: dict) -> None:
        self.start()
        log_push_debug(
            "queue.enqueue",
            frame_type=frame.get("type"),
            queue_size=self._queue.qsize(),
            route_key=frame.get("routeKey"),
            session_key=frame.get("sessionKey"),
            text=frame.get("text") or frame.get("reply"),
            attachments=frame.get("attachments") or [],
        )
        try:
            self._queue.put_nowait(frame)
        except queue.Full:
            log_push_debug("queue.full", drop_policy=self.config.drop_policy, queue_size=self._queue.qsize())
            if self.config.drop_policy == "drop_new":
                return
            # drop_oldest: remove one and try again
            try:
                _ = self._queue.get_nowait()
            except Exception:
                return
            try:
                self._queue.put_nowait(frame)
            except Exception:
                return

    # --- legacy-compatible frame handling (incrementally wired) ---

    def _handle_frame(self, frame: dict) -> None:
        ftype = str(frame.get("type") or "")
        log_push_debug(
            "queue.handle",
            frame_type=ftype,
            route_key=frame.get("routeKey"),
            session_name=frame.get("sessionName"),
            text=frame.get("text") or frame.get("reply"),
            attachments=frame.get("attachments") or [],
        )
        if ftype != "push.message":
            return
        text = str(frame.get("text") or frame.get("reply") or "").strip()
        role = str(frame.get("role") or "assistant").strip() or "assistant"
        meta = str(frame.get("meta") or "OpenClaw Agent").strip() or "OpenClaw Agent"
        if not text and not (frame.get("attachments") or []):
            return

        # Synthesis is optional: if it fails we still persist the message.
        audio_bytes: bytes | None = None
        content_type: str | None = None
        if bool(get_tts_config().get("generatePushAudio", False)):
            try:
                audio_bytes, content_type = self.tts.synthesize_blocking(
                    TtsRequest(text=text, mode="push", provider_override=None, overrides={"mode": "push"})
                )
                log_push_debug("queue.tts.generated", content_type=content_type, audio_bytes=len(audio_bytes or b""))
            except Exception as exc:  # noqa: BLE001
                print(f"[PushService] push tts failed: {exc}")
                log_push_debug("queue.tts.failed", error=repr(exc))

        # Convert frame attachments into message attachment format.
        attachments: list[dict] = []
        for item in frame.get("attachments") or []:
            if not isinstance(item, dict):
                continue
            kind = str(item.get("kind") or "file")
            mime_type = str(item.get("mimeType") or item.get("mime_type") or "application/octet-stream").strip()
            payload = str(item.get("data") or "").strip()
            if payload:
                attachments.append({
                    "fileId": "",
                    "kind": kind,
                    "mimeType": mime_type,
                    "data": payload,
                    "filename": str(item.get("filename") or "").strip(),
                    "size": int(item.get("size") or 0),
                })
            elif item.get("url"):
                attachments.append({
                    "fileId": "",
                    "kind": kind,
                    "mimeType": mime_type,
                    "url": str(item.get("url") or "").strip(),
                    "filename": str(item.get("filename") or "").strip(),
                    "size": int(item.get("size") or 0),
                })

        if audio_bytes:
            import base64

            attachments.append({
                "fileId": "",
                "kind": "audio",
                "mimeType": content_type or "audio/mpeg",
                "data": base64.b64encode(audio_bytes).decode("ascii"),
                "filename": "push_tts_audio",
                "size": len(audio_bytes),
            })

        payload = {
            "role": role,
            "text": text,
            "attachments": attachments,
            "source": "push",
            "meta": meta,
            "routeKey": str(frame.get("routeKey") or "").strip(),
            "sessionName": str(frame.get("sessionName") or "").strip(),
        }
        log_push_debug(
            "queue.payload.ready",
            role=role,
            meta=meta,
            route_key=payload.get("routeKey"),
            session_name=payload.get("sessionName"),
            text=text,
            attachments=attachments,
        )
        if self.on_message:
            try:
                self.on_message(payload)
            except Exception as exc:  # noqa: BLE001
                print(f"[PushService] on_message hook failed: {exc}")
                log_push_debug("queue.payload.failed", error=repr(exc))
