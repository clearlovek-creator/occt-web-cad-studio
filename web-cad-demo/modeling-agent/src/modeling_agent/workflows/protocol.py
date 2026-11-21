from __future__ import annotations

from typing import Any, Protocol

from modeling_agent.domain.models import AgentRun, ApprovalDecision


class WorkflowEngine(Protocol):
    """Stable application boundary used by FastAPI and other front ends.

    The concrete implementation may be the deterministic local engine or a
    durable LangGraph engine. Callers do not need to know which one is active.
    """

    def create_run(
        self,
        *,
        project_id: str,
        document_id: str,
        user_id: str,
        message: str,
        template_id: str | None = None,
        autonomy_level: str = "supervised",
        client_creation: dict[str, Any] | None = None,
    ) -> AgentRun: ...

    def respond(
        self, run_id: str, request_id: str, response: Any, *, expected_run_version: int | None = None
    ) -> AgentRun: ...

    def get_status(self, run_id: str) -> AgentRun: ...

    def decide_approval(
        self, run_id: str, approval_id: str, decision: ApprovalDecision, *, expected_run_version: int | None = None
    ) -> AgentRun: ...

    def cancel(self, run_id: str, *, expected_run_version: int | None = None) -> AgentRun: ...

    def pause(self, run_id: str, *, expected_run_version: int | None = None) -> AgentRun: ...

    def resume(self, run_id: str, *, expected_run_version: int | None = None) -> AgentRun: ...

    def change_parameters(
        self, run_id: str, changes: dict[str, Any], *, expected_run_version: int | None = None
    ) -> AgentRun: ...
