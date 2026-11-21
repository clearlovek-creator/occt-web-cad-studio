from __future__ import annotations

from typing import Any

from ..adapters.fake_geometry import FakeGeometryAdapter
from ..domain.models import ActionEnvelope, Observation


class FaultGeometryAdapter(FakeGeometryAdapter):
    """Deterministic fault injector for transport/outcome/revision tests."""

    def __init__(self, *args, fail_code: str | None = None, timeout_after_mutation: bool = False,
                 revision_bump_before_execute: bool = False, network_timeout: bool = False,
                 worker_crash: bool = False, corrupt_response: bool = False, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.fail_code = fail_code
        self.timeout_after_mutation = timeout_after_mutation
        self.revision_bump_before_execute = revision_bump_before_execute
        self.network_timeout = network_timeout
        self.worker_crash = worker_crash
        self.corrupt_response = corrupt_response

    async def execute(self, action: ActionEnvelope) -> Observation:
        if self.network_timeout:
            self.network_timeout = False
            raise TimeoutError("injected gateway transport timeout")
        if self.worker_crash:
            self.worker_crash = False
            raise ConnectionError("injected geometry worker crash")
        if self.revision_bump_before_execute:
            self.revision += 1
            self.revision_bump_before_execute = False
        observation = await super().execute(action)
        if self.timeout_after_mutation and observation.success:
            return Observation(action_id=action.action_id, success=False, error_code="GATEWAY_OUTCOME_UNKNOWN",
                               result={"outcome": "unknown", "committed": True}, before_revision=observation.before_revision,
                               after_revision=observation.after_revision)
        if self.fail_code:
            return Observation(action_id=action.action_id, success=False, error_code=self.fail_code,
                               result={"fault": self.fail_code})
        if self.corrupt_response and observation.success:
            return Observation(action_id=action.action_id, success=True,
                               result={"bodyId": "corrupted", "revision": "not-an-integer"},
                               before_revision=observation.before_revision,
                               after_revision=observation.after_revision)
        return observation
