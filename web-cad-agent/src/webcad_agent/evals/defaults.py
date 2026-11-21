from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from typing import Any

from ..adapters.fake_geometry import FakeGeometryAdapter
from ..adapters.json_store import JsonStore
from ..application.service import AgentApplication
from ..domain.models import ActionEnvelope
from ..skills.registry import SkillRegistry
from ..tools.registry import ToolRegistry
from .runner import EvalCase, EvalResult, run_cases


def default_cases() -> list[EvalCase]:
    """Return the deterministic, offline V1 acceptance scenarios."""
    async def box() -> bool:
        with tempfile.TemporaryDirectory() as temp:
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=FakeGeometryAdapter())
            session = app.create_session(document_id="eval-box", gateway_origin="fake")
            result = await app.propose_box(session_id=session.session_id, width=10, depth=20, height=30, approve=True)
            return result["status"] == "completed" and result["verification"]["passed"]

    async def tube() -> bool:
        with tempfile.TemporaryDirectory() as temp:
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=FakeGeometryAdapter())
            session = app.create_session(document_id="eval-tube", gateway_origin="fake")
            result = await app.propose_hollow_tube(session_id=session.session_id, outer_radius=10, inner_radius=5, height=20, approve=True)
            return result["status"] == "completed" and result["verification"]["passed"]

    async def approval_reopen() -> bool:
        with tempfile.TemporaryDirectory() as temp:
            geometry = FakeGeometryAdapter(); path = f"{temp}/state.json"
            first = AgentApplication(store=JsonStore(path), geometry=geometry)
            session = first.create_session(document_id="eval-reopen", gateway_origin="fake")
            pending = await first.propose_box(session_id=session.session_id, width=1, depth=1, height=1)
            reopened = AgentApplication(store=JsonStore(path), geometry=geometry)
            recovered = await reopened.recover_session(session.session_id)
            completed = await reopened.approve(pending["run"]["run_id"])
            return pending["status"] == "approval_required" and recovered["run"]["status"] == "waiting_approval" and completed["status"] == "completed"

    async def revision_conflict() -> bool:
        with tempfile.TemporaryDirectory() as temp:
            geometry = FakeGeometryAdapter(); app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=geometry)
            session = app.create_session(document_id="eval-revision", gateway_origin="fake")
            pending = await app.propose_box(session_id=session.session_id, width=1, depth=1, height=1)
            await geometry.execute(ActionEnvelope(run_id="external", tool_name="primitive.box", document_id="eval-revision",
                                                  arguments={"width": 1, "depth": 1, "height": 1}, side_effect="write", risk_level="medium",
                                                  expected_revision=0, idempotency_key="external", action_hash="external", reason="external"))
            try:
                await app.approve(pending["run"]["run_id"])
            except ValueError:
                return (await app.recover_session(session.session_id))["run"]["status"] == "paused"
            return False

    async def batch_rollback() -> bool:
        geometry = FakeGeometryAdapter()
        actions = [
            ActionEnvelope(run_id="eval-batch", tool_name="primitive.box", document_id="eval-batch", arguments={"width": 1, "depth": 1, "height": 1},
                           side_effect="write", risk_level="medium", expected_revision=0, idempotency_key="batch-a", action_hash="batch-a", reason="eval", step_id="box"),
            ActionEnvelope(run_id="eval-batch", tool_name="boolean.cut", document_id="eval-batch", arguments={"inputs": {"targetBody": {"$ref": "box.body_id"}, "toolBody": "missing"}},
                           side_effect="write", risk_level="high", expected_revision=0, idempotency_key="batch-b", action_hash="batch-b", reason="eval", step_id="cut"),
        ]
        result = await geometry.execute_batch(actions)
        return geometry.revision == 0 and not geometry.bodies and all(not item.success for item in result)

    async def compaction() -> bool:
        with tempfile.TemporaryDirectory() as temp:
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=FakeGeometryAdapter(), auto_compact_threshold=8)
            session = app.create_session(document_id="eval-context", gateway_origin="fake")
            for index in range(12): app.append_message(session_id=session.session_id, role="user", content=f"fact-{index}")
            return bool(app.store.list_compaction_checkpoints(session_id=session.session_id))

    async def registry_snapshot() -> bool:
        registry = ToolRegistry.discover(); snapshot = registry.snapshot()
        skill_path = Path(__file__).parents[1] / "assets" / "skills" / "create_box_verified.json"
        skills = SkillRegistry.from_path(skill_path)
        return any(item.extension_id == "core" for item in snapshot.extensions) and skills.get("example.geometry.create_box_verified") is not None and registry.version == snapshot.registry_version

    return [
        EvalCase("E2E-1", "box verify", box), EvalCase("E2E-2", "tube batch", tube),
        EvalCase("E2E-3", "approval reopen", approval_reopen), EvalCase("E2E-4", "revision conflict", revision_conflict),
        EvalCase("E2E-5", "batch rollback", batch_rollback), EvalCase("E2E-6", "context compaction", compaction),
        EvalCase("E2E-7", "registry snapshot", registry_snapshot),
    ]


async def run_default_evals(*, repetitions: int = 1) -> dict[str, Any]:
    repetitions = max(1, int(repetitions))
    rounds: list[list[EvalResult]] = []
    for _ in range(repetitions):
        rounds.append(await run_cases(default_cases()))
    failures = [result for round_results in rounds for result in round_results if not result.passed]
    return {"status": "passed" if not failures else "failed", "repetitions": repetitions,
            "cases": len(default_cases()), "failures": [result.__dict__ for result in failures]}


def run_default_evals_sync(*, repetitions: int = 1) -> dict[str, Any]:
    return asyncio.run(run_default_evals(repetitions=repetitions))
