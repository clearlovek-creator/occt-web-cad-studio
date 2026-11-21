import unittest
import time

from fastapi.testclient import TestClient

from modeling_agent.domain.models import AgentRun, new_id, utc_now
from datetime import timedelta
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command
from modeling_agent.workflows.langgraph_adapter import LangGraphRuntime, build_langgraph

from modeling_agent.adapters.geometry import FakeGeometryAdapter
from modeling_agent.application.store import InMemoryRepository
from modeling_agent.api.app import create_app
from modeling_agent.domain.models import ApprovalDecision, RunStatus
from modeling_agent.execution.service import ExecutionService
from modeling_agent.capabilities.registry import CapabilityRegistry, ToolDefinition
from modeling_agent.domain.models import RiskLevel, SideEffect
from modeling_agent.workflows.local import LocalWorkflowEngine


class CancellationAndStreamingTests(unittest.TestCase):
    def test_execution_rechecks_cancellation_before_geometry_write(self) -> None:
        repository = InMemoryRepository()
        geometry = FakeGeometryAdapter()
        service = ExecutionService(
            repository,
            CapabilityRegistry(),
            geometry,
            cancel_checker=lambda _run_id: True,
        )
        engine = LocalWorkflowEngine(repository=repository, geometry=geometry)
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="create 2.45 GHz rectangular patch antenna, substrate 1.6 mm",
        )
        action = repository.list_actions(run.id)[0]
        approval = service.request_approval(action)
        service.decide_approval(approval.approval_id, ApprovalDecision.APPROVE)
        observation = service.execute(action.action_id)
        self.assertFalse(observation.success)
        self.assertEqual(observation.error_code, "RUN_CANCELLED")
        self.assertEqual(geometry.current_revision("d"), 0)

    def test_run_references_a_persisted_config_snapshot(self) -> None:
        engine = LocalWorkflowEngine()
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="create 2.45 GHz antenna",
        )
        snapshot = engine.repository.get_config_snapshot(run.config_snapshot_id)
        self.assertEqual(snapshot.graph_version, "phase1-local-1")
        self.assertEqual(snapshot.tool_registry_version, engine.registry.version)
        self.assertEqual(snapshot.settings["workflow_engine"], "local")

    def test_slow_success_is_marked_result_unknown_instead_of_retried_blindly(self) -> None:
        class SlowGeometry(FakeGeometryAdapter):
            def execute(self, action):
                time.sleep(0.01)
                return super().execute(action)

        tool = ToolDefinition(
            name="geometry.create_box",
            version="1",
            description="box",
            side_effect=SideEffect.WRITE,
            risk_level=RiskLevel.MEDIUM,
            input_schema={
                "type": "object",
                "required": ["document_id", "width_m", "depth_m", "height_m"],
                "properties": {
                    "document_id": {"type": "string"},
                    "width_m": {"type": "number", "minimum": 1e-9, "maximum": 10.0},
                    "depth_m": {"type": "number", "minimum": 1e-9, "maximum": 10.0},
                    "height_m": {"type": "number", "minimum": 1e-9, "maximum": 10.0},
                },
            },
            output_schema={"type": "object"},
            allowed_stages=frozenset({"execution"}),
            timeout_seconds=0.001,
        )
        repository = InMemoryRepository()
        geometry = SlowGeometry()
        service = ExecutionService(repository, CapabilityRegistry([tool]), geometry)
        run = AgentRun(id="timeout-run", project_id="p", document_id="d", user_id="u", config_snapshot_id="cfg")
        repository.create_run(run)
        action = service.propose(
            run,
            tool_name="geometry.create_box",
            arguments={"document_id": "d", "width_m": 0.1, "depth_m": 0.1, "height_m": 0.001},
            reason="timeout",
            success_criteria=[],
        )
        approval = service.request_approval(action)
        service.decide_approval(approval.approval_id, ApprovalDecision.APPROVE)
        observation = service.execute(action.action_id)
        self.assertFalse(observation.success)
        self.assertEqual(observation.error_code, "TOOL_TIMEOUT_RESULT_UNKNOWN")
        self.assertEqual(geometry.current_revision("d"), 1)

    def test_graph_queries_unknown_write_status_before_failing(self) -> None:
        class SlowGeometry(FakeGeometryAdapter):
            def execute(self, action):
                time.sleep(0.01)
                return super().execute(action)

        tool = ToolDefinition(
            name="geometry.create_box",
            version="1",
            description="box",
            side_effect=SideEffect.WRITE,
            risk_level=RiskLevel.MEDIUM,
            input_schema={
                "type": "object",
                "required": ["document_id", "width_m", "depth_m", "height_m"],
                "properties": {
                    "document_id": {"type": "string"},
                    "width_m": {"type": "number", "minimum": 1e-9, "maximum": 10.0},
                    "depth_m": {"type": "number", "minimum": 1e-9, "maximum": 10.0},
                    "height_m": {"type": "number", "minimum": 1e-9, "maximum": 10.0},
                },
            },
            output_schema={"type": "object"},
            allowed_stages=frozenset({"execution"}),
            timeout_seconds=0.001,
        )
        repository = InMemoryRepository()
        geometry = SlowGeometry()
        run = AgentRun(
            id="unknown-write-run",
            project_id="p",
            document_id="d",
            user_id="u",
            config_snapshot_id="cfg",
            status=RunStatus.RUNNING,
        )
        repository.create_run(run)
        registry = CapabilityRegistry([tool])
        runtime = LangGraphRuntime.create(repository, geometry, registry=registry)
        graph = build_langgraph(InMemorySaver(), runtime=runtime)
        config = {"configurable": {"thread_id": run.id}}
        initial = graph.invoke(
            {
                "run_id": run.id,
                "project_id": "p",
                "document_id": "d",
                "structured_goal": {
                    "original_request": "2.45 GHz patch",
                    "antenna_type": "rectangular_patch",
                    "center_frequency_hz": 2.45e9,
                },
                "goal_version": 1,
            },
            config=config,
        )
        self.assertTrue(initial.get("__interrupt__"))
        final = graph.invoke(Command(resume="approve"), config=config)
        self.assertEqual(final["status"], "failed")
        self.assertEqual(final["error"]["code"], "ACTION_STATUS_UNKNOWN")
        self.assertEqual(geometry.current_revision("d"), 1)

    def test_action_schema_rejects_missing_or_invalid_box_dimensions(self) -> None:
        repository = InMemoryRepository()
        service = ExecutionService(repository, CapabilityRegistry(), FakeGeometryAdapter())
        run = AgentRun(
            id="schema-run",
            project_id="p",
            document_id="d",
            user_id="u",
            config_snapshot_id="cfg",
        )
        repository.create_run(run)
        with self.assertRaises(ValueError):
            service.propose(
                run,
                tool_name="geometry.create_box",
                arguments={"document_id": "d", "width_m": 0},
                reason="invalid",
                success_criteria=[],
            )

    def test_expired_approval_is_replaced_with_a_new_approval(self) -> None:
        repository = InMemoryRepository()
        geometry = FakeGeometryAdapter()
        run = AgentRun(
            id="expiry-run",
            project_id="p",
            document_id="d",
            user_id="u",
            config_snapshot_id=new_id("cfg"),
        )
        repository.create_run(run)
        graph = build_langgraph(InMemorySaver(), runtime=LangGraphRuntime.create(repository, geometry))
        config = {"configurable": {"thread_id": run.id}}
        first = graph.invoke(
            {
                "run_id": run.id,
                "structured_goal": {"antenna_type": "rectangular_patch", "center_frequency_hz": 2.45e9},
            },
            config=config,
        )
        old_approval_id = first["__interrupt__"][0].value["approval_id"]
        old_approval = repository.get_approval(old_approval_id)
        old_approval.expires_at = utc_now() - timedelta(seconds=1)
        repository.save_approval(old_approval)
        second = graph.invoke(Command(resume="approve"), config=config)
        self.assertTrue(second.get("__interrupt__"))
        new_approval_id = second["__interrupt__"][0].value["approval_id"]
        self.assertNotEqual(new_approval_id, old_approval_id)
        final = graph.invoke(Command(resume="approve"), config=config)
        self.assertEqual(final["status"], "completed")

    def test_revision_conflict_refreshes_and_requires_new_approval(self) -> None:
        repository = InMemoryRepository()
        geometry = FakeGeometryAdapter()
        run = AgentRun(
            id="revision-run",
            project_id="p",
            document_id="d",
            user_id="u",
            config_snapshot_id=new_id("cfg"),
        )
        repository.create_run(run)
        graph = build_langgraph(
            InMemorySaver(),
            runtime=LangGraphRuntime.create(repository, geometry),
        )
        config = {"configurable": {"thread_id": run.id}}
        first = graph.invoke(
            {
                "run_id": run.id,
                "structured_goal": {
                    "antenna_type": "rectangular_patch",
                    "center_frequency_hz": 2.45e9,
                    "substrate_thickness_m": 0.0016,
                },
            },
            config=config,
        )
        self.assertTrue(first.get("__interrupt__"))
        geometry.documents["d"] = {"revision": 5, "bodies": []}
        refreshed = graph.invoke(Command(resume="approve"), config=config)
        self.assertTrue(refreshed.get("__interrupt__"))
        self.assertEqual(len(repository.list_actions(run.id)), 2)
        self.assertEqual(repository.list_actions(run.id)[-1].expected_document_revision, 5)
        completed = graph.invoke(Command(resume="approve"), config=config)
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(geometry.current_revision("d"), 6)

    def test_cancel_clears_pending_interaction(self) -> None:
        engine = LocalWorkflowEngine()
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="create 2.45 GHz antenna",
        )
        self.assertEqual(run.status, RunStatus.WAITING_USER)
        cancelled = engine.cancel(run.id)
        self.assertEqual(cancelled.status, RunStatus.CANCELLED)
        self.assertIsNone(cancelled.waiting_request_id)
        self.assertIsNone(cancelled.waiting_approval_id)

    def test_sse_follow_mode_replays_and_closes_after_terminal_run(self) -> None:
        client = TestClient(create_app())
        created = client.post(
            "/api/v1/agent/runs",
            json={
                "project_id": "p",
                "document_id": "d",
                "user_id": "u",
                "message": "create 2.45 GHz rectangular patch antenna, substrate 1.6 mm",
            },
        ).json()
        stream = client.get(
            f"/api/v1/agent/runs/{created['id']}/events?follow=true&wait_seconds=1"
        )
        self.assertEqual(stream.status_code, 200)
        self.assertIn("run.created", stream.text)
        self.assertIn("approval.requested", stream.text)
        client.close()


if __name__ == "__main__":
    unittest.main()
