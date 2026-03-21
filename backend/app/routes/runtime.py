from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from ..api_models import CreateSessionBody
from ..app_context import AppContext
from ..manifest import build_app_manifest
from ..services.tts_service import TtsRequest, extract_tts_overrides


def create_runtime_router(context: AppContext) -> APIRouter:
    router = APIRouter()

    @router.get('/api/health')
    async def health() -> dict:
        return {'ok': True}

    @router.get('/api/model')
    async def model(model: str | None = None) -> dict:
        return build_app_manifest(model)

    @router.post('/api/tts')
    async def tts(body: dict):
        text = str(body.get('text') or '').strip()
        mode = str(body.get('mode') or '').strip() or None
        provider_override = str(body.get('provider') or body.get('ttsProvider') or '').strip() or None
        audio_bytes, content_type = await context.tts_service.synthesize(
            req=TtsRequest(
                text=text,
                mode=mode,
                provider_override=provider_override,
                overrides=extract_tts_overrides(body, include_root_fields=True),
            )
        )
        return StreamingResponse(iter([audio_bytes]), media_type=content_type, headers={'Cache-Control': 'no-store'})

    return router
