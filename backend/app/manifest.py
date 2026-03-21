from __future__ import annotations

import json

from .config import PATCHED_MODEL_JSON, get_chat_config, get_chat_providers, get_live2d_config, get_model_dir, get_model_or_raise, get_models, get_tts_config
from .tts_backends import TTS_BACKEND_REGISTRY


CHAT_PROVIDER_FIELD_SCHEMAS = {
    'openclaw-channel': [
        {'key': 'bridgeUrl', 'label': 'Bridge URL', 'input': 'text', 'placeholder': 'ws://127.0.0.1:18790', 'defaultValue': 'ws://127.0.0.1:18790'},
        {'key': 'agent', 'label': 'Agent', 'input': 'text', 'placeholder': 'main', 'defaultValue': 'main'},
        {'key': 'session', 'label': 'Session', 'input': 'text', 'placeholder': 'main', 'defaultValue': 'main'},
    ],
    'openai-compatible': [
        {'key': 'baseUrl', 'label': 'Base URL', 'input': 'text', 'placeholder': 'http://127.0.0.1:8317/v1', 'defaultValue': ''},
        {'key': 'model', 'label': 'Provider Model', 'input': 'text', 'placeholder': 'gpt-5.4', 'defaultValue': 'gpt-5.4'},
    ],
}

OPENAI_TTS_FIELD_SCHEMA = [
    {'key': 'baseUrl', 'label': 'Base URL', 'input': 'text', 'placeholder': 'http://127.0.0.1:8001', 'defaultValue': ''},
    {'key': 'model', 'label': 'TTS Model', 'input': 'text', 'placeholder': 'tts-1', 'defaultValue': 'tts-1'},
    {'key': 'voice', 'label': 'Voice', 'input': 'text', 'placeholder': 'alloy', 'defaultValue': 'alloy'},
    {'key': 'responseFormat', 'label': 'Response Format', 'input': 'text', 'placeholder': 'wav', 'defaultValue': 'wav'},
    {'key': 'speed', 'label': 'Speed', 'input': 'text', 'placeholder': '1.0', 'defaultValue': '1.0'},
    {'key': 'apiKey', 'label': 'API Key', 'input': 'password', 'placeholder': '', 'defaultValue': ''},
]

TTS_PROVIDER_FIELD_SCHEMAS = {
    'edge-tts': [
        {'key': 'voice', 'label': 'Voice', 'input': 'text', 'placeholder': 'zh-CN-XiaoxiaoNeural', 'defaultValue': 'zh-CN-XiaoxiaoNeural'},
        {'key': 'rate', 'label': 'Rate', 'input': 'text', 'placeholder': '+0%', 'defaultValue': '+0%'},
        {'key': 'pitch', 'label': 'Pitch', 'input': 'text', 'placeholder': '+0Hz', 'defaultValue': '+0Hz'},
        {'key': 'volume', 'label': 'Volume', 'input': 'text', 'placeholder': '+0%', 'defaultValue': '+0%'},
    ],
    'openai-compatible': OPENAI_TTS_FIELD_SCHEMA,
    'gpt-sovits': OPENAI_TTS_FIELD_SCHEMA,
}

TTS_PROVIDER_NAMES = {
    'edge-tts': 'Edge TTS',
    'openai-compatible': 'OpenAI-Compatible TTS',
    'gpt-sovits': 'GPT-SoVITS',
}


def collect_model_stage_capabilities(model_config: dict) -> dict:
    model = build_patched_model_json(model_config)
    file_refs = model.get('FileReferences', {})
    motions = []
    model_dir = get_model_dir(model_config)
    for group_name, group_items in file_refs.get('Motions', {}).items():
        for index, item in enumerate(group_items):
            relative_path = item.get('File', '')
            duration = 0.0
            if relative_path:
                try:
                    motion_json = json.loads((model_dir / relative_path).read_text(encoding='utf-8'))
                    duration = float((motion_json.get('Meta') or {}).get('Duration') or 0)
                except FileNotFoundError:
                    duration = 0.0
            file_stem = relative_path.rsplit('/', 1)[-1].rsplit('.', 1)[0] if relative_path else ''
            motions.append({
                'group': group_name,
                'index': index,
                'file': relative_path,
                'label': f'{group_name}:{file_stem or index}',
                'duration': duration,
                'name': file_stem or '',
            })
    expressions = []
    for index, item in enumerate(file_refs.get('Expressions', [])):
        expressions.append({'name': item.get('Name', f'expression-{index}'), 'file': item.get('File', ''), 'index': index})
    return {'motions': motions, 'expressions': expressions}


def build_patched_model_json(model_config: dict) -> dict:
    model_dir = get_model_dir(model_config)
    model_path = model_dir / str(model_config['modelJson'])
    data = json.loads(model_path.read_text(encoding='utf-8'))
    motions = data.setdefault('FileReferences', {}).setdefault('Motions', {})
    for source_name, target_name in (model_config.get('motionAliases') or {}).items():
        aliased = motions.pop(source_name, None)
        if aliased:
            motions.setdefault(target_name, aliased)
    return data


def _resolve_fields(schema: list[dict], *, defaults: dict | None = None, values: dict | None = None) -> list[dict]:
    fields = []
    for field in schema:
        key = field['key']
        value = (defaults or {}).get(key)
        if value is None:
            value = (values or {}).get(key)
        field_def = dict(field)
        field_def['value'] = value if value is not None else field.get('defaultValue', '')
        fields.append(field_def)
    return fields


def _resolve_provider_fields(provider: dict, chat_defaults: dict) -> list[dict]:
    schema = CHAT_PROVIDER_FIELD_SCHEMAS.get(str(provider.get('type') or '').strip(), [])
    defaults = chat_defaults.get(str(provider.get('id') or '')) or {}
    return _resolve_fields(schema, defaults=defaults, values=provider)


def build_tts_provider_manifest(provider_id: str, provider_config: dict) -> dict:
    fields = _resolve_fields(TTS_PROVIDER_FIELD_SCHEMAS.get(provider_id, []), values=provider_config)
    item = {
        'id': provider_id,
        'name': TTS_PROVIDER_NAMES.get(provider_id, provider_id),
        'fields': fields,
        'editableFields': [field['key'] for field in fields],
    }
    for field in fields:
        item[field['key']] = field.get('value', '')
    return item


def build_provider_manifest(provider: dict, chat_defaults: dict) -> dict:
    provider_id = str(provider['id'])
    provider_type = provider.get('type') or 'unknown'
    fields = _resolve_provider_fields(provider, chat_defaults)
    item = {
        'id': provider_id,
        'type': provider_type,
        'name': provider.get('name') or provider_id,
        'fields': fields,
        'editableFields': [field['key'] for field in fields],
    }
    for field in fields:
        item[field['key']] = field.get('value', '')
    return item


def build_model_manifest(model_config: dict) -> dict:
    capabilities = collect_model_stage_capabilities(model_config)
    motions = capabilities['motions']
    expressions = capabilities['expressions']

    chat_defaults = model_config.get('chatDefaults') or {}
    providers = [build_provider_manifest(provider, chat_defaults) for provider in get_chat_providers()]
    chat_config = get_chat_config()
    tts_config = get_tts_config()

    tts_providers = []
    providers_map = tts_config.get('providers') or {}
    for provider_id in TTS_BACKEND_REGISTRY:
        if provider_id in providers_map:
            tts_providers.append(build_tts_provider_manifest(provider_id, dict(providers_map.get(provider_id) or {})))

    model_live2d = model_config.get('live2d') or {}
    model_focus_center = model_live2d.get('focusCenter') or {}

    return {
        'id': model_config['id'],
        'name': model_config.get('name') or model_config['id'],
        'modelJson': f"/models/{model_config['id']}/{PATCHED_MODEL_JSON}",
        'root': str(get_model_dir(model_config)),
        'exists': get_model_dir(model_config).exists(),
        'live2d': {
            'focusCenter': model_focus_center,
        },
        'motions': motions,
        'expressions': expressions,
        'quickActions': model_config.get('quickActions') or [],
        'persistentToggles': model_config.get('persistentToggles') or {},
        'lipSyncParamId': model_config.get('lipSyncParamId') or 'ParamMouthOpenY',
        'chat': {
            'enabled': True,
            'defaultProviderId': chat_config.get('defaultProviderId') or providers[0]['id'],
            'providers': providers,
            'note': chat_config.get('note') or '可手动选择 OpenClaw Channel bridge，或任意 OpenAI-compatible API。',
            'tts': {
                'enabled': bool(tts_config.get('enabled', True)),
                'provider': str(tts_config.get('provider') or 'edge-tts'),
                'pushProvider': str(tts_config.get('pushProvider') or tts_config.get('provider') or 'edge-tts'),
                'softBreakMaxChars': int(tts_config.get('softBreakMaxChars') or 20),
                'minSegmentChars': int(tts_config.get('minSegmentChars') or 1),
                'providers': tts_providers,
            },
        },
    }


def build_app_manifest(selected_model_id: str | None = None) -> dict:
    models = get_models()
    selected = get_model_or_raise(selected_model_id)
    live2d_config = get_live2d_config()
    return {
        'selectedModelId': selected['id'],
        'models': [{'id': model['id'], 'name': model.get('name') or model['id']} for model in models],
        'model': build_model_manifest(selected),
        'live2d': {
            'focusCenter': (live2d_config.get('focusCenter') or {}),
        },
    }
