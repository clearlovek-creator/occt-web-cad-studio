from __future__ import annotations

import asyncio
import json
import tempfile

from webcad_agent.adapters.fake_geometry import FakeGeometryAdapter
from webcad_agent.adapters.json_store import JsonStore
from webcad_agent.application.service import AgentApplication
from webcad_agent.domain.models import ActionEnvelope, RunStatus
from webcad_agent.evals.runner import EvalCase, run_cases
from webcad_agent.evals.model import run_model_evals
from webcad_agent.llm.protocol import ModelResponse
from webcad_agent.extensions.manager import ExtensionManager
from webcad_agent.extensions.manifest import ExtensionManifest
from webcad_agent.skills.registry import SkillRegistry
from webcad_agent.tools.registry import ToolRegistry


def test_v1_evals_seven_deterministic_scenarios() -> None:
    async def scenario_box() -> bool:
        with tempfile.TemporaryDirectory() as temp:
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=FakeGeometryAdapter())
            session = app.create_session(document_id="e1", gateway_origin="fake")
            result = await app.propose_box(session_id=session.session_id, width=10, depth=20, height=30, approve=True)
            return result["status"] == "completed" and result["verification"]["passed"]

    async def scenario_tube() -> bool:
        with tempfile.TemporaryDirectory() as temp:
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=FakeGeometryAdapter())
            session = app.create_session(document_id="e2", gateway_origin="fake")
            result = await app.propose_hollow_tube(session_id=session.session_id, outer_radius=10, inner_radius=5, height=20, approve=True)
            return result["status"] == "completed" and result["verification"]["passed"]

    async def scenario_approval_reopen() -> bool:
        with tempfile.TemporaryDirectory() as temp:
            path = f"{temp}/state.db"; geometry = FakeGeometryAdapter()
            first = AgentApplication(store=JsonStore(path), geometry=geometry)
            session = first.create_session(document_id="e3", gateway_origin="fake")
            pending = await first.propose_box(session_id=session.session_id, width=1, depth=1, height=1)
            reopened = AgentApplication(store=JsonStore(path), geometry=geometry)
            recovered = await reopened.recover_session(session.session_id)
            completed = await reopened.approve(pending["run"]["run_id"])
            return (pending["status"] == "approval_required" and recovered["run"]["status"] == "waiting_approval"
                    and completed["status"] == "completed")

    async def scenario_revision_conflict() -> bool:
        with tempfile.TemporaryDirectory() as temp:
            geometry = FakeGeometryAdapter(); app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=geometry)
            session = app.create_session(document_id="e4", gateway_origin="fake")
            pending = await app.propose_box(session_id=session.session_id, width=1, depth=1, height=1)
            external = ActionEnvelope(run_id="external", tool_name="primitive.box", document_id="e4",
                                      arguments={"width": 1, "depth": 1, "height": 1}, side_effect="write",
                                      risk_level="medium", expected_revision=0, idempotency_key="external",
                                      action_hash="external", reason="external")
            await geometry.execute(external)
            try:
                await app.approve(pending["run"]["run_id"])
            except ValueError:
                recovered = await app.recover_session(session.session_id)
                return recovered["run"]["status"] == "paused"
            return False

    async def scenario_batch_rollback() -> bool:
        geometry = FakeGeometryAdapter()
        actions = [
            ActionEnvelope(run_id="e5", tool_name="primitive.box", document_id="e5",
                           arguments={"width": 1, "depth": 1, "height": 1}, side_effect="write",
                           risk_level="medium", expected_revision=0, idempotency_key="e5-a",
                           action_hash="e5-a", reason="e5", step_id="box"),
            ActionEnvelope(run_id="e5", tool_name="boolean.cut", document_id="e5",
                           arguments={"inputs": {"targetBody": {"$ref": "box.body_id"}, "toolBody": "missing"}},
                           side_effect="write", risk_level="high", expected_revision=0, idempotency_key="e5-b",
                           action_hash="e5-b", reason="e5", step_id="cut"),
        ]
        results = await geometry.execute_batch(actions)
        return geometry.revision == 0 and geometry.bodies == {} and all(not item.success for item in results)

    async def scenario_compaction() -> bool:
        with tempfile.TemporaryDirectory() as temp:
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=FakeGeometryAdapter(), auto_compact_threshold=8)
            session = app.create_session(document_id="e6", gateway_origin="fake")
            for index in range(12):
                app.append_message(session_id=session.session_id, role="user", content=f"fact-{index}")
            return bool(app.store.list_compaction_checkpoints(session_id=session.session_id))

    async def scenario_extension_snapshot() -> bool:
        registry = ToolRegistry.discover(); snapshot = registry.snapshot()
        skill_registry = SkillRegistry.from_path("skills/create_box_verified.json")
        registry.assert_snapshot(snapshot)
        return (any(item.extension_id == "core" for item in snapshot.extensions)
                and skill_registry.get("example.geometry.create_box_verified") is not None
                and registry.version == snapshot.registry_version)

    async def run_all() -> list[bool]:
        cases = [
            EvalCase("E2E-1", "box verify", scenario_box),
            EvalCase("E2E-2", "tube batch", scenario_tube),
            EvalCase("E2E-3", "approval reopen", scenario_approval_reopen),
            EvalCase("E2E-4", "revision conflict", scenario_revision_conflict),
            EvalCase("E2E-5", "batch rollback path", scenario_batch_rollback),
            EvalCase("E2E-6", "long session compaction", scenario_compaction),
            EvalCase("E2E-7", "registry snapshot", scenario_extension_snapshot),
        ]
        results = await run_cases(cases)
        assert all(result.passed for result in results), results
        return [result.passed for result in results]

    assert asyncio.run(run_all()) == [True] * 7


def test_opt_in_model_eval_uses_structured_plan_and_redacts_endpoint() -> None:
    class FakeEndpointModel:
        def __init__(self, endpoint: str) -> None:
            self.endpoint = endpoint

        async def complete(self, *, context, **kwargs):
            run = context["run"]
            payload = {"run_id": run["run_id"], "document_id": run["document_id"], "goal": run["goal"],
                       "steps": [{"step_id": "box", "ordinal": 0, "tool_name": "core.geometry.create_box",
                                   "tool_version": "1", "arguments": {"width": 1, "depth": 2, "height": 3},
                                   "side_effect": "write", "risk_level": "medium", "verifier": "box_geometry"}]}
            return ModelResponse(model="eval-fake", content=json.dumps(payload))

        async def close(self) -> None:
            return None

    result = asyncio.run(run_model_evals(endpoint="https://model.example/v1?api_key=secret",
                                         model_factory=FakeEndpointModel))
    assert result["status"] == "passed"
    assert result["endpoint"] == "https://model.example/v1"
