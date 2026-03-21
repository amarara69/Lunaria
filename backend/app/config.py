from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = ROOT / 'frontend' / 'public'
DATA_DIR = ROOT / 'data'
UPLOADS_DIR = DATA_DIR / 'uploads'
CONFIG_PATH = ROOT / 'config.json'
LOCAL_CONFIG_PATH = ROOT / 'config.local.json'
DOTENV_PATH = ROOT / '.env'
DOTENV_LOCAL_PATH = ROOT / '.env.local'
PATCHED_MODEL_JSON = 'patched.model3.json'


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def _deep_merge(base: dict, override: dict) -> dict:
    merged = dict(base)
    for key, value in (override or {}).items():
        if isinstance(merged.get(key), dict) and isinstance(value, dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _parse_dotenv_value(value: str) -> str:
    stripped = value.strip()
    if len(stripped) >= 2 and stripped[0] == stripped[-1] and stripped[0] in {'\"', "'"}:
        return stripped[1:-1]
    return stripped


def _load_dotenv_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding='utf-8').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        if not key:
            continue
        os.environ.setdefault(key, _parse_dotenv_value(value))


def _apply_provider_env_overrides(config: dict) -> None:
    chat = config.get('chat') or {}
    providers = chat.get('providers') or []
    for provider in providers:
        provider_id = str(provider.get('id') or '').strip()
        if not provider_id:
            continue
        env_key_prefix = provider_id.upper().replace('-', '_')
        for field in ('token', 'apiKey', 'baseUrl', 'wsUrl', 'bridgeUrl', 'model', 'agent', 'session'):
            env_name = f'LUNARIA_CHAT_PROVIDER_{env_key_prefix}_{field.upper()}'
            if env_name in os.environ:
                provider[field] = os.environ[env_name]


def _apply_tts_env_overrides(config: dict) -> None:
    tts = ((config.get('chat') or {}).get('tts') or {})
    providers = tts.get('providers') or {}
    for provider_id, provider in providers.items():
        env_key_prefix = str(provider_id).upper().replace('-', '_')
        for field in (
            'apiKey',
            'baseUrl',
            'characterName',
            'model',
            'pitch',
            'predefinedCharacterName',
            'rate',
            'responseFormat',
            'speed',
            'timeoutSeconds',
            'voice',
            'volume',
            'workflowPath',
        ):
            env_name = f'LUNARIA_TTS_PROVIDER_{env_key_prefix}_{field.upper()}'
            if env_name in os.environ:
                provider[field] = os.environ[env_name]


def _apply_scalar_env_overrides(config: dict) -> None:
    server = config.setdefault('server', {})
    cors = config.setdefault('cors', {})
    chat = config.setdefault('chat', {})
    if 'LUNARIA_SERVER_HOST' in os.environ:
        server['host'] = os.environ['LUNARIA_SERVER_HOST']
    if 'LUNARIA_SERVER_PORT' in os.environ:
        server['port'] = int(os.environ['LUNARIA_SERVER_PORT'])
    if 'LUNARIA_CHAT_DEFAULT_PROVIDER_ID' in os.environ:
        chat['defaultProviderId'] = os.environ['LUNARIA_CHAT_DEFAULT_PROVIDER_ID']
    if 'LUNARIA_CORS_ORIGIN_REGEX' in os.environ:
        cors['originRegex'] = os.environ['LUNARIA_CORS_ORIGIN_REGEX']
    if 'LUNARIA_CORS_ORIGINS' in os.environ:
        cors['origins'] = [item.strip() for item in os.environ['LUNARIA_CORS_ORIGINS'].split(',') if item.strip()]


def _resolve_config_paths() -> tuple[Path, Path | None]:
    base = Path(os.environ.get('LUNARIA_CONFIG_PATH') or CONFIG_PATH).expanduser()
    local_raw = os.environ.get('LUNARIA_CONFIG_LOCAL_PATH')
    local = Path(local_raw).expanduser() if local_raw else LOCAL_CONFIG_PATH
    return base, local if local.exists() else None


@lru_cache(maxsize=1)
def load_config() -> dict:
    _load_dotenv_file(DOTENV_PATH)
    _load_dotenv_file(DOTENV_LOCAL_PATH)
    base_path, local_path = _resolve_config_paths()
    if not base_path.exists():
        raise FileNotFoundError(f'missing config file: {base_path}')
    config = _read_json(base_path)
    if local_path:
        config = _deep_merge(config, _read_json(local_path))
    _apply_scalar_env_overrides(config)
    _apply_provider_env_overrides(config)
    _apply_tts_env_overrides(config)
    return config


def get_config_paths() -> tuple[Path, Path | None]:
    return _resolve_config_paths()


def get_server_config() -> dict:
    return (load_config().get('server') or {})


def get_cors_config() -> dict:
    return (load_config().get('cors') or {})


def get_chat_config() -> dict:
    return (load_config().get('chat') or {})


def get_live2d_config() -> dict:
    return (load_config().get('live2d') or {})


def get_chat_providers() -> list[dict]:
    providers = get_chat_config().get('providers') or []
    if not providers:
        raise RuntimeError('Lunaria config has no chat providers configured')
    return providers


def get_tts_config() -> dict:
    return (get_chat_config().get('tts') or {})


def get_tts_provider_config(provider_id: str | None = None) -> dict:
    tts = get_tts_config()
    provider = str(provider_id or tts.get('provider') or 'edge-tts').strip()
    providers = tts.get('providers') or {}
    resolved = dict(tts)
    resolved['provider'] = provider
    if provider in providers:
        resolved.update(dict(providers[provider] or {}))
    return resolved


def get_chat_provider_map() -> dict[str, dict]:
    return {str(provider['id']): provider for provider in get_chat_providers()}


def get_chat_provider(provider_id: str | None = None) -> dict:
    chat_config = get_chat_config()
    resolved = provider_id or chat_config.get('defaultProviderId')
    provider_map = get_chat_provider_map()
    if resolved not in provider_map:
        raise FileNotFoundError(f'unknown chat provider id: {resolved}')
    return provider_map[resolved]


def get_models() -> list[dict]:
    models = load_config().get('models') or []
    if not models:
        raise RuntimeError('Lunaria config has no models configured')
    return models


def get_model_map() -> dict[str, dict]:
    return {str(model['id']): model for model in get_models()}


def get_default_model_id() -> str:
    return str(get_models()[0]['id'])


def get_model_or_raise(model_id: str | None) -> dict:
    model_map = get_model_map()
    resolved = model_id or get_default_model_id()
    if resolved not in model_map:
        raise FileNotFoundError(f'unknown model id: {resolved}')
    return model_map[resolved]


def get_model_dir(model_config: dict) -> Path:
    return Path(model_config['dir']).expanduser()
