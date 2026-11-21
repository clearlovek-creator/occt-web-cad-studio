from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from modeling_agent.domain.models import ApprovalDecision


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RouteRequest(ApiModel):
    message: str = ""
    project_id: str | None = None
    user_id: str | None = None


class CreateRunRequest(ApiModel):
    client_run_id: str | None = Field(
        default=None,
        pattern=r"^py-run-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
    )
    project_id: str = "default"
    document_id: str = "default"
    user_id: str = "local-user"
    message: str = Field(default="", max_length=16000)
    template_id: str | None = None
    autonomy_level: Literal["supervised"] = "supervised"


class ModelingPlanRequest(ApiModel):
    run_id: str = "preview"
    goal_version: int = Field(default=1, ge=1)
    document_id: str = "default"
    template_id: str = "antenna.rectangular_patch_stack"
    goal: dict[str, Any] = Field(default_factory=dict)


class ResponseRequest(ApiModel):
    request_id: str
    response: Any
    expected_run_version: int | None = Field(default=None, ge=0)


class ApprovalDecisionRequest(ApiModel):
    decision: ApprovalDecision
    expected_run_version: int | None = Field(default=None, ge=0)


class ParameterChangeRequest(ApiModel):
    changes: dict[str, Any]
    expected_run_version: int | None = Field(default=None, ge=0)


class VersionRequest(ApiModel):
    expected_run_version: int | None = Field(default=None, ge=0)
