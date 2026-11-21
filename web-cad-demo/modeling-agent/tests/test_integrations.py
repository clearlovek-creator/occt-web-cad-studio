import unittest
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from modeling_agent.adapters.persistence.sqlalchemy_models import Base
from modeling_agent.adapters.persistence.sqlalchemy_repository import SqlAlchemyRepository
from modeling_agent.adapters.geometry import FakeGeometryAdapter
from modeling_agent.application.store import InMemoryRepository
from modeling_agent.adapters.persistence.json_repository import JsonRepository
from modeling_agent.api.app import create_app
from modeling_agent.domain.models import AgentRun, ErrorClass, Observation, new_id
from modeling_agent.agents.react import ModelResponse, ToolCall
from modeling_agent.workflows.engine import LangGraphWorkflowEngine
from modeling_agent.workflows.langgraph_adapter import LangGraphRuntime, build_langgraph


class IntegrationTests(unittest.TestCase):
    def test_langgraph_api_can_select_patch_stack_template(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = create_app(
                data_path=str(root / "state.json"),
                workflow_mode="langgraph",
                checkpoint_path=str(root / "checkpoints.bin"),
            )
            client = TestClient(app)
            created = client.post(
                "/api/v1/agent/runs",
                json={
                    "project_id": "p",
                    "document_id": "d",
                    "user_id": "u",
                    "template_id": "antenna.rectangular_patch_stack",
                    "message": "create 2.45 GHz antenna",
                },
            ).json()
            waiting = client.post(
                f"/api/v1/agent/runs/{created['id']}/responses",
                json={
                    "request_id": created["waiting_request_id"],
                    "response": {"antenna_type": "rectangular_patch", "substrate_material": "FR-4", "substrate_thickness_m": 0.0016},
                },
            ).json()
            first = client.post(
                f"/api/v1/agent/runs/{created['id']}/approvals/{waiting['waiting_approval_id']}/decision",
                json={"decision": "approve"},
            ).json()
            self.assertEqual(first["status"], "completed")
            self.assertEqual(first["document_revision"], 2)
            client.close()

    def test_langgraph_patch_stack_executes_each_action_with_revision_chain(self) -> None:
        repository = InMemoryRepository()
        geometry = FakeGeometryAdapter()
        run = AgentRun(
            id="template-run-1",
            project_id="p",
            document_id="d",
            user_id="u",
            config_snapshot_id=new_id("config"),
        )
        repository.create_run(run)
        graph = build_langgraph(
            InMemorySaver(),
            runtime=LangGraphRuntime.create(repository, geometry),
        )
        config = {"configurable": {"thread_id": "template-run-1"}}
        initial = graph.invoke(
            {
                "run_id": run.id,
                "template_id": "antenna.rectangular_patch_stack",
                "structured_goal": {
                    "antenna_type": "rectangular_patch",
                    "center_frequency_hz": 2.45e9,
                    "substrate_material": "FR-4",
                    "substrate_thickness_m": 0.0016,
                },
            },
            config=config,
        )
        self.assertTrue(initial.get("__interrupt__"))
        final = graph.invoke(Command(resume="approve"), config=config)
        self.assertEqual(final["status"], "completed")
        self.assertEqual(geometry.current_revision("d"), 2)
        self.assertEqual([item.expected_document_revision for item in repository.list_actions(run.id)], [0, 1])
        self.assertEqual(final["next_action_index"], 2)

    def test_parameterized_modeling_plan_preview_is_side_effect_free(self) -> None:
        client = TestClient(create_app())
        response = client.post(
            "/api/v1/agent/modeling/plan",
            json={
                "run_id": "preview-run",
                "document_id": "preview-doc",
                "goal": {
                    "original_request": "2.45 GHz patch",
                    "antenna_type": "rectangular_patch",
                    "center_frequency_hz": 2.45e9,
                    "substrate_material": "FR-4",
                    "substrate_thickness_m": 0.0016,
                },
            },
        )
        self.assertEqual(response.status_code, 200)
        plan = response.json()
        self.assertEqual(plan["template_id"], "antenna.rectangular_patch_stack")
        self.assertEqual(len(plan["actions"]), 2)
        self.assertEqual(plan["actions"][0]["role"], "substrate")
        self.assertEqual(plan["actions"][1]["role"], "patch_conductor")
        client.close()

    def test_langgraph_run_records_its_graph_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            service = LangGraphWorkflowEngine(
                repository=JsonRepository(root / "state.json"),
                geometry=FakeGeometryAdapter(),
                checkpoint_path=root / "checkpoints.bin",
            )
            run = service.create_run(
                project_id="p",
                document_id="d",
                user_id="u",
                message="create 2.45 GHz antenna",
            )
            self.assertEqual(run.graph_version, "phase1-langgraph-1")
            self.assertEqual(
                service.repository.get_config_snapshot(run.config_snapshot_id).graph_version,
                run.graph_version,
            )
            service.close()

    def test_sqlalchemy_and_json_checkpoint_resume_after_service_reconstruction(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_url = f"sqlite:///{root / 'agent.db'}"
            first_repo = SqlAlchemyRepository(database_url, initialize=True)
            first_service = LangGraphWorkflowEngine(
                repository=first_repo,
                geometry=FakeGeometryAdapter(),
                checkpoint_path=root / "checkpoints.bin",
            )
            run = first_service.create_run(
                project_id="p",
                document_id="d",
                user_id="u",
                message="create 2.45 GHz antenna",
            )
            first_repo.close()
            second_repo = SqlAlchemyRepository(database_url)
            second_service = LangGraphWorkflowEngine(
                repository=second_repo,
                geometry=FakeGeometryAdapter(),
                checkpoint_path=root / "checkpoints.bin",
            )
            waiting = second_service.respond(run.id, run.waiting_request_id or "", {"antenna_type": "rectangular_patch"})
            self.assertEqual(waiting.status.value, "waiting_approval")
            self.assertIsNotNone(waiting.waiting_approval_id)
            second_repo.close()

    def test_sqlalchemy_repository_survives_process_reconstruction(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_url = f"sqlite:///{Path(directory) / 'agent.db'}"
            first_repo = SqlAlchemyRepository(database_url, initialize=True)
            geometry = FakeGeometryAdapter()
            first = __import__("modeling_agent.workflows.local", fromlist=["LocalWorkflowEngine"]).LocalWorkflowEngine(
                repository=first_repo,
                geometry=geometry,
            )
            run = first.create_run(
                project_id="p",
                document_id="d",
                user_id="u",
                message="create 2.45 GHz rectangular patch antenna, substrate 1.6 mm",
            )
            first_repo.close()
            second_repo = SqlAlchemyRepository(database_url)
            recovered_run = second_repo.get_run(run.id)
            self.assertEqual(recovered_run.status.value, "waiting_approval")
            self.assertEqual(second_repo.get_config_snapshot(recovered_run.config_snapshot_id).graph_version, "phase1-local-1")
            self.assertEqual(len(second_repo.list_events(run.id)), 9)
            self.assertEqual(len(second_repo.list_actions(run.id)), 1)
            self.assertEqual(len(second_repo.list_approvals(run.id)), 1)
            second_repo.close()

    def test_langgraph_parameter_change_replans_and_reapproves(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = create_app(
                data_path=str(root / "state.json"),
                workflow_mode="langgraph",
                checkpoint_path=str(root / "checkpoints.bin"),
            )
            client = TestClient(app)
            created = client.post(
                "/api/v1/agent/runs",
                json={"project_id": "p", "document_id": "d", "user_id": "u", "message": "create 2.45 GHz antenna"},
            ).json()
            waiting = client.post(
                f"/api/v1/agent/runs/{created['id']}/responses",
                json={"request_id": created["waiting_request_id"], "response": {"antenna_type": "rectangular_patch"}},
            ).json()
            completed = client.post(
                f"/api/v1/agent/runs/{created['id']}/approvals/{waiting['waiting_approval_id']}/decision",
                json={"decision": "approve"},
            ).json()
            self.assertEqual(completed["status"], "completed")
            changed = client.post(
                f"/api/v1/agent/runs/{created['id']}/parameters",
                json={"changes": {"width_m": 0.04}},
            )
            self.assertEqual(changed.status_code, 200)
            pending = changed.json()
            self.assertEqual(pending["status"], "waiting_approval")
            second = client.post(
                f"/api/v1/agent/runs/{created['id']}/approvals/{pending['waiting_approval_id']}/decision",
                json={"decision": "approve"},
            )
            self.assertEqual(second.status_code, 200)
            self.assertEqual(second.json()["status"], "completed")
            self.assertEqual(second.json()["document_revision"], 2)
            client.close()

    def test_input_route_endpoint_is_project_and_user_scoped(self) -> None:
        client = TestClient(create_app())
        created = client.post(
            "/api/v1/agent/runs",
            json={
                "project_id": "route-project",
                "document_id": "d",
                "user_id": "route-user",
                "message": "create 2.45 GHz antenna",
            },
        ).json()
        decision = client.post(
            "/api/v1/agent/route",
            json={"project_id": "route-project", "user_id": "route-user", "message": "cancel"},
        )
        self.assertEqual(decision.status_code, 200)
        self.assertEqual(decision.json()["route"], "cancel_run")
        self.assertEqual(decision.json()["target_run_id"], created["id"])
        status = client.get(f"/api/v1/agent/runs/{created['id']}")
        self.assertEqual(status.status_code, 200)
        self.assertIn("progress", status.json())
        self.assertIn("pending_input", status.json())
        self.assertIn("pending_approval", status.json())
        self.assertIn("events_url", status.json())
        ambiguous = client.post(
            "/api/v1/agent/route",
            json={"project_id": "other-project", "user_id": "route-user", "message": "cancel"},
        )
        self.assertEqual(ambiguous.json()["route"], "clarify_route")
        unscoped = client.post(
            "/api/v1/agent/route",
            json={"message": "cancel"},
        )
        self.assertEqual(unscoped.json()["route"], "clarify_route")
        self.assertIn("routing_scope_required", unscoped.json()["reason_codes"])
        client.close()

    def test_late_approval_is_rejected_by_run_version(self) -> None:
        client = TestClient(create_app())
        created = client.post(
            "/api/v1/agent/runs",
            json={"project_id": "version-p", "document_id": "d", "user_id": "u", "message": "create 2.45 GHz antenna"},
        ).json()
        resumed = client.post(
            f"/api/v1/agent/runs/{created['id']}/responses",
            json={
                "request_id": created["waiting_request_id"],
                "response": {"antenna_type": "rectangular_patch"},
                "expected_run_version": created["run_version"],
            },
        ).json()
        stale = client.post(
            f"/api/v1/agent/runs/{created['id']}/approvals/{resumed['waiting_approval_id']}/decision",
            json={"decision": "approve", "expected_run_version": created["run_version"]},
        )
        self.assertEqual(stale.status_code, 409)
        completed = client.post(
            f"/api/v1/agent/runs/{created['id']}/approvals/{resumed['waiting_approval_id']}/decision",
            json={"decision": "approve", "expected_run_version": resumed["run_version"]},
        )
        self.assertEqual(completed.status_code, 200)
        client.close()

    def test_langgraph_safe_pause_survives_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first_repo = SqlAlchemyRepository(f"sqlite:///{root / 'agent.db'}", initialize=True)
            first = LangGraphWorkflowEngine(
                repository=first_repo,
                geometry=FakeGeometryAdapter(),
                checkpoint_database_url=f"sqlite:///{root / 'agent.db'}",
            )
            run = first.create_run(
                project_id="p", document_id="d", user_id="u", message="create 2.45 GHz antenna"
            )
            paused = first.pause(run.id, expected_run_version=run.run_version)
            self.assertEqual(paused.status.value, "paused")
            first.close(); first_repo.close()

            second_repo = SqlAlchemyRepository(f"sqlite:///{root / 'agent.db'}")
            second = LangGraphWorkflowEngine(
                repository=second_repo,
                geometry=FakeGeometryAdapter(),
                checkpoint_database_url=f"sqlite:///{root / 'agent.db'}",
            )
            recovered = second_repo.get_run(run.id)
            self.assertEqual(recovered.status.value, "paused")
            resumed = second.resume(run.id, expected_run_version=recovered.run_version)
            self.assertEqual(resumed.status.value, "waiting_user")
            second.close(); second_repo.close()

    def test_langgraph_api_survives_engine_and_graph_reconstruction(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = create_app(
                data_path=str(root / "state.json"),
                workflow_mode="langgraph",
                checkpoint_path=str(root / "checkpoints.bin"),
            )
            client = TestClient(app)
            created = client.post(
                "/api/v1/agent/runs",
                json={
                    "project_id": "p",
                    "document_id": "d",
                    "user_id": "u",
                    "message": "create 2.45 GHz antenna",
                },
            ).json()
            response = client.post(
                f"/api/v1/agent/runs/{created['id']}/responses",
                json={
                    "request_id": created["waiting_request_id"],
                    "response": {"antenna_type": "rectangular_patch", "substrate_thickness_m": 0.0016},
                },
            )
            self.assertEqual(response.status_code, 200)
            waiting = response.json()
            self.assertEqual(waiting["status"], "waiting_approval")
            approved = client.post(
                f"/api/v1/agent/runs/{created['id']}/approvals/{waiting['waiting_approval_id']}/decision",
                json={"decision": "approve"},
            )
            self.assertEqual(approved.status_code, 200)
            self.assertEqual(approved.json()["status"], "completed")
            self.assertEqual(approved.json()["document_revision"], 1)
            client.close()

    def test_rejected_approval_replans_with_a_new_action_and_approval(self) -> None:
        repository = InMemoryRepository()
        geometry = FakeGeometryAdapter()
        run = AgentRun(
            id="runtime-replan-1",
            project_id="project-1",
            document_id="document-replan-1",
            user_id="user-1",
            config_snapshot_id=new_id("config"),
        )
        repository.create_run(run)
        graph = build_langgraph(InMemorySaver(), runtime=LangGraphRuntime.create(repository, geometry))
        config = {"configurable": {"thread_id": "runtime-replan-1"}}
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
        rejected = graph.invoke(Command(resume="reject"), config=config)
        self.assertEqual(rejected["__interrupt__"][0].value["reason_code"], "approval_rejected")
        replanned = graph.invoke(Command(resume={"width_m": 0.04}), config=config)
        self.assertTrue(replanned.get("__interrupt__"))
        self.assertEqual(len(repository.list_actions(run.id)), 2)
        self.assertEqual(repository.list_actions(run.id)[-1].arguments["width_m"], 0.04)

    def test_runtime_graph_recovers_transient_write_before_verification(self) -> None:
        class FlakyGeometry(FakeGeometryAdapter):
            def __init__(self) -> None:
                super().__init__()
                self.calls = 0

            def execute(self, action):
                self.calls += 1
                if self.calls == 1:
                    return Observation(
                        action_id=action.action_id,
                        success=False,
                        before_revision=0,
                        error_code="TIMEOUT",
                        error_class=ErrorClass.TOOL_TRANSIENT,
                    )
                return super().execute(action)

        repository = InMemoryRepository()
        geometry = FlakyGeometry()
        run = AgentRun(
            id="runtime-recovery-1",
            project_id="project-1",
            document_id="document-recovery-1",
            user_id="user-1",
            config_snapshot_id=new_id("config"),
        )
        repository.create_run(run)
        runtime = LangGraphRuntime.create(repository, geometry)
        graph = build_langgraph(InMemorySaver(), runtime=runtime)
        config = {"configurable": {"thread_id": "runtime-recovery-1"}}
        graph.invoke(
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
        final = graph.invoke(Command(resume="approve"), config=config)
        self.assertEqual(final["status"], "completed")
        self.assertEqual(geometry.calls, 2)
        self.assertEqual(geometry.current_revision("document-recovery-1"), 1)

    def test_runtime_graph_can_inject_bounded_theory_react(self) -> None:
        class TheoryModel:
            def __init__(self) -> None:
                self.calls = 0

            def complete(self, messages, tools):
                self.calls += 1
                if self.calls == 1:
                    return ModelResponse(
                        tool_calls=[
                            ToolCall(
                                name="calculate_patch_initial_dimensions",
                                arguments={
                                    "frequency_hz": 2.45e9,
                                    "substrate_material": "FR-4",
                                    "substrate_thickness_m": 0.0016,
                                },
                            )
                        ]
                    )
                return ModelResponse(
                    structured_output={
                        "method": "react_test_closed_form",
                        "derived_parameters": [
                            {"name": "width", "value_m": 0.0375},
                            {"name": "length", "value_m": 0.0291},
                        ],
                        "confidence": 0.7,
                    }
                )

        repository = InMemoryRepository()
        geometry = FakeGeometryAdapter()
        run = AgentRun(
            id="runtime-react-1",
            project_id="project-1",
            document_id="document-react-1",
            user_id="user-1",
            config_snapshot_id=new_id("config"),
        )
        repository.create_run(run)
        model = TheoryModel()
        runtime = LangGraphRuntime.create(repository, geometry, theory_model=model)
        graph = build_langgraph(InMemorySaver(), runtime=runtime)
        config = {"configurable": {"thread_id": "runtime-react-1"}}
        initial = graph.invoke(
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
        self.assertTrue(initial.get("__interrupt__"))
        self.assertEqual(model.calls, 2)
        checkpoint = graph.get_state(config).values
        self.assertEqual(checkpoint["react_result"]["status"], "completed")
        self.assertEqual(checkpoint["react_result"]["tool_calls"], 1)
        self.assertEqual(len(repository.list_actions(run.id)), 1)

    def test_runtime_graph_executes_real_fake_geometry_after_approval(self) -> None:
        repository = InMemoryRepository()
        geometry = FakeGeometryAdapter()
        run = AgentRun(
            id="runtime-run-1",
            project_id="project-1",
            document_id="document-1",
            user_id="user-1",
            config_snapshot_id=new_id("config"),
        )
        repository.create_run(run)
        runtime = LangGraphRuntime.create(repository, geometry)
        graph = build_langgraph(InMemorySaver(), runtime=runtime)
        config = {"configurable": {"thread_id": "runtime-graph-1"}}
        initial = graph.invoke(
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
        self.assertTrue(initial.get("__interrupt__"))
        self.assertEqual(len(repository.actions), 1)
        self.assertEqual(len(repository.approvals), 1)
        resumed = graph.invoke(Command(resume="approve"), config=config)
        self.assertEqual(resumed["status"], "completed")
        self.assertTrue(resumed["last_verification"]["passed"])
        self.assertEqual(geometry.current_revision("document-1"), 1)
        self.assertEqual(repository.get_run(run.id).status.value, "completed")

    def test_langgraph_pauses_for_approval_and_resumes(self) -> None:
        graph = build_langgraph(InMemorySaver())
        config = {"configurable": {"thread_id": "integration-approval"}}
        initial = graph.invoke(
            {
                "run_id": "run-1",
                "structured_goal": {
                    "antenna_type": "rectangular_patch",
                    "center_frequency_hz": 2.45e9,
                },
            },
            config=config,
        )
        self.assertTrue(initial.get("__interrupt__"))
        resumed = graph.invoke(Command(resume="approve"), config=config)
        self.assertEqual(resumed["status"], "completed")
        self.assertTrue(resumed["last_verification"]["passed"])

    def test_sqlalchemy_checkpoint_reconstructs_graph_after_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            url = f"sqlite:///{Path(directory) / 'agent.db'}"
            first_repo = SqlAlchemyRepository(url, initialize=True)
            geometry = FakeGeometryAdapter()
            first = LangGraphWorkflowEngine(
                repository=first_repo,
                geometry=geometry,
                checkpoint_database_url=url,
            )
            run = first.create_run(
                project_id="p",
                document_id="checkpoint-doc",
                user_id="u",
                message="create 2.45 GHz antenna",
            )
            first.close()
            first_repo.close()

            second_repo = SqlAlchemyRepository(url)
            second = LangGraphWorkflowEngine(
                repository=second_repo,
                geometry=geometry,
                checkpoint_database_url=url,
            )
            recovered = second_repo.get_run(run.id)
            self.assertEqual(recovered.status.value, "waiting_user")
            self.assertIsNotNone(recovered.waiting_request_id)
            resumed = second.respond(run.id, recovered.waiting_request_id or "", {"antenna_type": "rectangular_patch"})
            self.assertEqual(resumed.status.value, "waiting_approval")
            self.assertIsNotNone(resumed.waiting_approval_id)
            second.close()
            second_repo.close()

    def test_sqlalchemy_schema_contains_phase_one_tables(self) -> None:
        self.assertTrue(
            {
                "agent_runs",
                "agent_goals",
                "agent_events",
                "agent_actions",
                "agent_approvals",
            }.issubset(Base.metadata.tables)
        )

    def test_fastapi_run_and_sse_endpoints(self) -> None:
        client = TestClient(create_app())
        response = client.post(
            "/api/v1/agent/runs",
            json={
                "project_id": "p",
                "document_id": "d",
                "user_id": "u",
                "message": "创建一个 2.45 GHz 的矩形贴片天线，基板 1.6 mm",
            },
        )
        self.assertEqual(response.status_code, 200)
        run_id = response.json()["id"]
        events = client.get(f"/api/v1/agent/runs/{run_id}/events")
        self.assertEqual(events.status_code, 200)
        self.assertIn("text/event-stream", events.headers["content-type"])
        self.assertIn("run.created", events.text)
        resumed = client.get(
            f"/api/v1/agent/runs/{run_id}/events",
            headers={"Last-Event-ID": "1"},
        )
        self.assertEqual(resumed.status_code, 200)
        self.assertNotIn("id: 1\n", resumed.text)
        invalid = client.get(
            f"/api/v1/agent/runs/{run_id}/events",
            headers={"Last-Event-ID": "not-a-number"},
        )
        self.assertEqual(invalid.status_code, 400)
        client.close()


if __name__ == "__main__":
    unittest.main()
