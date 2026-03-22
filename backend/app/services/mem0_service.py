from __future__ import annotations

import json
import threading
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PROMPT_MARKDOWN_ROOT = Path.home() / ".lunaria"
MANDATORY_PROMPT_MARKDOWN_FILES = ("AGENTS.md", "IDENTITY.md")
_MEM0_SERVICE_CACHE: dict[str, "Mem0Service"] = {}
_MEM0_SERVICE_LOCK = threading.Lock()


def _normalize_rel_markdown_path(raw: str) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or len(path.parts) != 1:
        raise RuntimeError(f"Prompt markdown file must be a single filename under ~/.lunaria, got: {value}")
    return path.name


def parse_prompt_markdown_files(raw: object) -> list[str]:
    text = str(raw or "")
    items: list[str] = []
    for chunk in text.replace(",", "\n").splitlines():
        item = _normalize_rel_markdown_path(chunk)
        if item:
            items.append(item)
    seen: set[str] = set()
    ordered: list[str] = []
    for item in [*MANDATORY_PROMPT_MARKDOWN_FILES, *items]:
        if item in seen:
            continue
        seen.add(item)
        ordered.append(item)
    return ordered


def resolve_prompt_markdown_root() -> Path:
    return Path.home() / ".lunaria"


def load_prompt_markdown_sections(provider_config: dict, *, prompt_root: Path | None = None) -> list[str]:
    root = Path(prompt_root or resolve_prompt_markdown_root())
    sections: list[str] = []
    for rel_name in parse_prompt_markdown_files(provider_config.get("promptMarkdownFiles")):
        path = root / rel_name
        if not path.exists():
            raise RuntimeError(f"Prompt markdown file not found under {root}: {rel_name}")
        sections.append(f"# {rel_name}\n\n{path.read_text(encoding='utf-8').strip()}")
    return sections


def build_mem0_oss_config(provider_config: dict) -> dict:
    base_url = str(provider_config.get("baseUrl") or "").rstrip("/")
    api_key = str(provider_config.get("apiKey") or "")
    model = str(provider_config.get("model") or "gpt-5.4").strip() or "gpt-5.4"
    embedding_base_url = str(provider_config.get("embeddingBaseUrl") or base_url).rstrip("/")
    embedding_api_key = str(provider_config.get("embeddingApiKey") or provider_config.get("apiKey") or "")
    embedding_model = str(provider_config.get("embeddingModel") or "text-embedding-3-small").strip() or "text-embedding-3-small"
    chroma_path = str(provider_config.get("memoryChromaPath") or "data/mem0/chroma").strip() or "data/mem0/chroma"

    return {
        "vector_store": {
            "provider": "chroma",
            "config": {
                "path": chroma_path,
                "collection_name": "lunaria_mem0",
            },
        },
        "embedder": {
            "provider": "openai",
            "config": {
                "api_key": embedding_api_key,
                "openai_base_url": embedding_base_url,
                "model": embedding_model,
            },
        },
        "llm": {
            "provider": "openai",
            "config": {
                "api_key": api_key,
                "openai_base_url": base_url,
                "model": model,
                "temperature": 0.0,
            },
        },
        "history_db_path": str((REPO_ROOT / "data" / "mem0" / "history.sqlite3").resolve()),
    }


class Mem0Service:
    def __init__(self, provider_config: dict):
        self.provider_config = dict(provider_config)
        self._memory = None

    def _get_memory(self):
        if self._memory is None:
            try:
                from mem0 import Memory
            except ModuleNotFoundError as exc:
                raise RuntimeError("Python package 'mem0ai' is missing. Install the backend dependencies or run inside the updated nix-shell.") from exc
            history_db_path = Path(build_mem0_oss_config(self.provider_config)["history_db_path"])
            history_db_path.parent.mkdir(parents=True, exist_ok=True)
            chroma_path = Path(str(self.provider_config.get("memoryChromaPath") or "data/mem0/chroma"))
            if not chroma_path.is_absolute():
                chroma_path = REPO_ROOT / chroma_path
            chroma_path.mkdir(parents=True, exist_ok=True)
            self._memory = Memory.from_config(build_mem0_oss_config(self.provider_config))
        return self._memory

    def search(
        self,
        *,
        query: str,
        user_id: str,
        agent_id: str,
        run_id: str,
        limit: int = 5,
        scope: str = "agent",
    ):
        kwargs = {
            "query": str(query or "").strip(),
            "limit": max(1, min(int(limit or 5), 10)),
            "user_id": user_id,
        }
        if scope in {"agent", "session"} and agent_id:
            kwargs["agent_id"] = agent_id
        if scope == "session" and run_id:
            kwargs["run_id"] = run_id
        result = self._get_memory().search(**kwargs)
        response_payload = {
            "provider": self.provider_config.get("id") or self.provider_config.get("name") or "unknown",
            "query": kwargs["query"],
            "limit": kwargs["limit"],
            "scope": scope,
        }
        if isinstance(result, dict):
            response_payload["results"] = result.get("results") or result.get("memories") or []
        else:
            response_payload["results"] = result
        return result

    def add_exchange(
        self,
        *,
        user_text: str,
        assistant_text: str,
        user_id: str,
        agent_id: str,
        run_id: str,
    ) -> None:
        messages = [
            {"role": "user", "content": str(user_text or "")},
            {"role": "assistant", "content": str(assistant_text or "")},
        ]
        kwargs = {
            "messages": messages,
            "user_id": user_id,
            "infer": False,
        }
        if agent_id:
            kwargs["agent_id"] = agent_id
        if run_id:
            kwargs["run_id"] = run_id
        self._get_memory().add(**kwargs)


def get_mem0_service(provider_config: dict) -> Mem0Service:
    cache_key = json.dumps(
        {
            "baseUrl": provider_config.get("baseUrl") or "",
            "apiKey": provider_config.get("apiKey") or "",
            "model": provider_config.get("model") or "",
            "embeddingBaseUrl": provider_config.get("embeddingBaseUrl") or "",
            "embeddingApiKey": provider_config.get("embeddingApiKey") or "",
            "embeddingModel": provider_config.get("embeddingModel") or "",
            "memoryChromaPath": provider_config.get("memoryChromaPath") or "",
        },
        sort_keys=True,
    )
    with _MEM0_SERVICE_LOCK:
        service = _MEM0_SERVICE_CACHE.get(cache_key)
        if service is None:
            service = Mem0Service(provider_config)
            _MEM0_SERVICE_CACHE[cache_key] = service
        return service
