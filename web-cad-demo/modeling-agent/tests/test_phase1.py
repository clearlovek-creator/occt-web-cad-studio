import unittest
import json
import tempfile
from pathlib import Path

from modeling_agent.adapters.geometry import FakeGeometryAdapter
from modeling_agent.adapters.persistence.json_repository import JsonRepository
from modeling_agent.application.store import InMemoryRepository
from modeling_agent.context.engine import ContextEngine
from modeling_agent.domain.models import ApprovalDecision, RunStatus
from modeling_agent.execution.service import ExecutionService
from modeling_agent.capabilities.registry import CapabilityRegistry
from modeling_agent.workflows.local import LocalWorkflowEngine
from modeling_agent.workflows.router import InputRouter


class PhaseOneTests(unittest.TestCase):
    def test_input_router_keeps_ambiguous_active_run_safe(self) -> None:
        engine = LocalWorkflowEngine()
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="创建一个 2.45 GHz 的贴片天线",
        )
        decision = InputRouter().route("继续", [run, run.model_copy(update={"id": "run-2"})])
        self.assertEqual(decision.route.value, "clarify_route")

    def test_run_pauses_for_missing_antenna_type_and_resumes(self) -> None:
        engine = LocalWorkflowEngine()
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="创建一个 2.45 GHz 的天线",
        )
        self.assertEqual(run.status, RunStatus.WAITING_USER)
        self.assertIsNotNone(run.waiting_request_id)
        resumed = engine.respond(run.id, run.waiting_request_id or "", "矩形贴片，基板 1.6 mm")
        self.assertEqual(resumed.status, RunStatus.WAITING_APPROVAL)

    def test_invalid_user_response_creates_a_new_elicitation(self) -> None:
        engine = LocalWorkflowEngine()
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="创建 2.45 GHz 天线",
        )
        invalid = engine.respond(
            run.id,
            run.waiting_request_id or "",
            {"antenna_type": "rectangular_patch", "center_frequency_hz": -1},
        )
        self.assertEqual(invalid.status, RunStatus.WAITING_USER)
        self.assertEqual(invalid.last_error["code"], "INVALID_USER_RESPONSE")
        self.assertIsNotNone(invalid.waiting_request_id)
        self.assertNotEqual(invalid.waiting_request_id, run.waiting_request_id)

    def test_safe_boundary_pause_and_resume_preserves_pending_question(self) -> None:
        engine = LocalWorkflowEngine()
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="创建 2.45 GHz 天线",
        )
        paused = engine.pause(run.id, expected_run_version=run.run_version)
        self.assertEqual(paused.status, RunStatus.PAUSED)
        self.assertEqual(paused.waiting_request_id, run.waiting_request_id)
        resumed = engine.resume(paused.id, expected_run_version=paused.run_version)
        self.assertEqual(resumed.status, RunStatus.WAITING_USER)
        self.assertEqual(resumed.waiting_request_id, run.waiting_request_id)

    def test_approval_and_idempotent_geometry_write(self) -> None:
        engine = LocalWorkflowEngine()
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="创建一个 2.45 GHz 的矩形贴片天线，基板 1.6 mm",
        )
        self.assertEqual(run.status, RunStatus.WAITING_APPROVAL)
        approval_id = run.waiting_approval_id
        self.assertIsNotNone(approval_id)
        completed = engine.decide_approval(run.id, approval_id or "", ApprovalDecision.APPROVE)
        self.assertEqual(completed.status, RunStatus.COMPLETED)
        self.assertEqual(engine.geometry.current_revision("d"), 1)
        action = next(item for item in engine.repository.actions.values() if item.run_id == run.id)
        observation = engine.execution.execute(action.action_id)
        self.assertTrue(observation.success)
        self.assertEqual(engine.geometry.current_revision("d"), 1)

    def test_parameter_change_creates_new_approved_action_and_revision(self) -> None:
        engine = LocalWorkflowEngine()
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="create 2.45 GHz rectangular patch antenna, substrate 1.6 mm",
        )
        run = engine.decide_approval(run.id, run.waiting_approval_id or "", ApprovalDecision.APPROVE)
        self.assertEqual(run.status, RunStatus.COMPLETED)
        changed = engine.change_parameters(run.id, {"width_m": 0.04})
        self.assertEqual(changed.status, RunStatus.WAITING_APPROVAL)
        actions = [item for item in engine.repository.actions.values() if item.run_id == run.id]
        self.assertEqual(len(actions), 2)
        self.assertEqual(actions[-1].arguments["width_m"], 0.04)
        completed = engine.decide_approval(run.id, changed.waiting_approval_id or "", ApprovalDecision.APPROVE)
        self.assertEqual(completed.status, RunStatus.COMPLETED)
        self.assertEqual(engine.geometry.current_revision("d"), 2)

    def test_revision_conflict_blocks_write(self) -> None:
        repository = InMemoryRepository()
        geometry = FakeGeometryAdapter()
        execution = ExecutionService(repository, CapabilityRegistry(), geometry)
        run = LocalWorkflowEngine(repository=repository, geometry=geometry)
        created = run.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="创建一个 2.45 GHz 的矩形贴片天线，基板 1.6 mm",
        )
        action = next(item for item in repository.actions.values() if item.run_id == created.id)
        approval = execution.request_approval(action)
        execution.decide_approval(approval.approval_id, ApprovalDecision.APPROVE)
        geometry.documents["d"]["revision"] = 99
        with self.assertRaisesRegex(RuntimeError, "REVISION_CONFLICT"):
            execution.execute(action.action_id)

    def test_context_is_node_scoped_and_tracks_revision(self) -> None:
        engine = LocalWorkflowEngine()
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="创建一个 2.45 GHz 的矩形贴片天线，基板 1.6 mm",
        )
        context = ContextEngine(engine.repository, engine.registry).build(
            run_id=run.id,
            node_name="theory",
        )
        self.assertEqual(context.node_name, "theory")
        self.assertTrue(all(tool["side_effect"] != "write" for tool in context.available_tools))
        self.assertEqual(context.freshness["document_revision"], 0)
    def test_context_engine_enforces_serialized_character_budget(self) -> None:
        engine = LocalWorkflowEngine()
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="创建 2.45 GHz 矩形贴片天线，基板 FR-4，厚度 1.6 mm",
        )
        context = ContextEngine(engine.repository, engine.registry).build(
            run_id=run.id,
            node_name="theory",
            budget=__import__("modeling_agent.context.engine", fromlist=["ContextBudget"]).ContextBudget(max_chars=1800),
            knowledge=[{"text": "x" * 500} for _ in range(10)],
        )
        self.assertLessEqual(len(json.dumps(context.model_dump(mode="json"), ensure_ascii=False)), 1800)
        self.assertEqual(context.node_name, "theory")

    def test_json_repository_survives_process_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "agent-state.json"
            first = LocalWorkflowEngine(repository=JsonRepository(path))
            run = first.create_run(
                project_id="p",
                document_id="d",
                user_id="u",
                message="创建一个 2.45 GHz 的天线",
            )
            self.assertEqual(run.status, RunStatus.WAITING_USER)
            second = LocalWorkflowEngine(repository=JsonRepository(path))
            recovered = second.repository.get_run(run.id)
            self.assertEqual(recovered.status, RunStatus.WAITING_USER)
            self.assertEqual(
                second.repository.get_config_snapshot(recovered.config_snapshot_id).graph_version,
                "phase1-local-1",
            )
            self.assertEqual(recovered.waiting_request_id, run.waiting_request_id)


if __name__ == "__main__":
    unittest.main()
