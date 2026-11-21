from __future__ import annotations

import os

from modeling_agent.api.app import create_app


app = create_app(
    data_path=os.getenv("MODEL_AGENT_DATA_PATH"),
    gateway_url=os.getenv("MODEL_AGENT_GATEWAY_URL"),
    workflow_mode=os.getenv("MODEL_AGENT_WORKFLOW_ENGINE", "local"),
    checkpoint_path=os.getenv("MODEL_AGENT_CHECKPOINT_PATH", ".data/langgraph-checkpoints.bin"),
    database_url=os.getenv("MODEL_AGENT_DATABASE_URL"),
    llm_base_url=os.getenv("MODEL_AGENT_LLM_BASE_URL"),
    llm_api_key=os.getenv("MODEL_AGENT_LLM_API_KEY"),
    llm_model=os.getenv("MODEL_AGENT_LLM_MODEL"),
)
