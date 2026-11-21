from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class AgentSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WEBCAD_AGENT_", env_file=".env", extra="ignore")
    gateway_url: str = "http://127.0.0.1:8788"
    state_path: Path = Path(".data/agent.db")
    log_path: Path = Path(".data/agent-events.jsonl")
    mode: str = "supervised"
    default_document: str = "web-cad-demo"
    model_name: str = "none"
    max_context_tokens: int = 8000
