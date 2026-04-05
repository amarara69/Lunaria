from __future__ import annotations

from contextlib import asynccontextmanager

import asyncio

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .agents.openclaw_channel import ensure_bridge_listener, set_push_callback, stop_bridge_listener
from .app_context import create_app_context
from .config import FRONTEND_DIR, UPLOADS_DIR, get_chat_providers
from .routes import create_assets_router, create_chat_router, create_events_router, create_runtime_router, create_sessions_router
from .utils import log_push_debug
from .web.helpers import build_allowed_origins, build_push_route_key, build_session_label


def create_app() -> FastAPI:
    context = create_app_context(uploads_dir=UPLOADS_DIR)

    def handle_push_message(payload: dict) -> None:
        session_id = str(payload.get('sessionId') or '').strip()
        log_push_debug(
            'persist.begin',
            session_id=session_id,
            route_key=payload.get('routeKey'),
            session_name=payload.get('sessionName'),
            role=payload.get('role'),
            source=payload.get('source'),
            text=payload.get('text'),
            attachments=payload.get('attachments') or [],
        )
        if not session_id:
            route_key = str(payload.get('routeKey') or '').strip()
            if route_key:
                session = context.session_store.find_or_create_by_route(route_key, name=str(payload.get('sessionName') or '').strip() or None)
            else:
                session = context.session_store.get_or_create_default()
            session_id = session.id
            log_push_debug('persist.session.resolved', session_id=session_id, route_key=route_key, session_name=payload.get('sessionName'))
        message = context.message_store.create_message(
            session_id=session_id,
            role=str(payload.get('role') or 'assistant'),
            text=str(payload.get('text') or ''),
            attachments=list(payload.get('attachments') or []),
            source=str(payload.get('source') or 'push'),
            meta=str(payload.get('meta') or ''),
        )
        log_push_debug(
            'persist.stored',
            session_id=session_id,
            message_id=message.get('id'),
            source=message.get('source'),
            text=message.get('text'),
            attachments=message.get('attachments') or [],
        )
        context.events_bus.publish_threadsafe('message.created', {'message': message})
        log_push_debug('persist.published', session_id=session_id, message_id=message.get('id'), event_type='message.created')

    context.push_service.on_message = handle_push_message

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        context.session_store.ensure_schema()
        context.message_store.ensure_schema()
        context.events_bus.store.ensure_schema()
        context.events_bus.bind_loop(asyncio.get_running_loop())

        def push_callback(frame: dict) -> None:
            frame = dict(frame or {})
            frame['routeKey'] = build_push_route_key(frame)
            frame['sessionName'] = build_session_label(frame)
            log_push_debug(
                'callback.received',
                frame_type=frame.get('type'),
                provider_id=frame.get('providerId'),
                route_key=frame.get('routeKey'),
                session_name=frame.get('sessionName'),
                text=frame.get('text') or frame.get('reply'),
                attachments=frame.get('attachments') or [],
            )
            context.push_service.enqueue(frame)

        set_push_callback(push_callback)
        try:
            for provider in get_chat_providers():
                if str(provider.get('type') or '').strip() == 'openclaw-channel':
                    ensure_bridge_listener(provider)
        except Exception as exc:  # noqa: BLE001
            print(f'[OpenClawChannel] push listener not started: {exc}')

        try:
            yield
        finally:
            stop_bridge_listener()

    app = FastAPI(
        title='Lunaria',
        version='0.8',
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )

    allowed_origins, allow_origin_regex = build_allowed_origins()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_origin_regex=allow_origin_regex,
        allow_credentials=False,
        allow_methods=['*'],
        allow_headers=['*'],
        max_age=86400,
    )

    app.include_router(create_runtime_router(context))
    app.include_router(create_sessions_router(context))
    app.include_router(create_events_router(context))
    app.include_router(create_chat_router(context))
    app.include_router(create_assets_router())

    app.mount('/uploads', StaticFiles(directory=str(context.uploads_dir), html=False), name='uploads')
    app.mount('/', StaticFiles(directory=str(FRONTEND_DIR), html=False), name='frontend')
    return app
