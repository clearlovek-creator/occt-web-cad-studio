import os
import unittest
import tempfile
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

from modeling_agent.adapters.http_geometry import HttpGeometryAdapter
from modeling_agent.domain.models import ActionRequest, RiskLevel, SideEffect
from modeling_agent.execution.service import canonical_hash
from modeling_agent.api.app import create_app
from modeling_agent.adapters.persistence.json_repository import JsonRepository
from modeling_agent.agents.react import ModelResponse
from modeling_agent.workflows.engine import LangGraphWorkflowEngine


class SingleBoxPlanner:
    """Deterministic structured planner; never call a paid provider in smoke tests."""
    def __init__(self, document_id):
        self.document_id = document_id

    def complete(self, messages, tools):
        return ModelResponse(structured_output={
            "summary": "Create the single test solid.", "assumptions": [],
            "tasks": [{"task_id": "box", "title": "Create one test box",
                       "tool_name": "geometry.create_box",
                       "arguments": {"document_id": self.document_id,
                                     "width_m": 0.05, "depth_m": 0.04, "height_m": 0.0016},
                       "reason": "Verify one scoped native write.",
                       "success_criteria": [{"name": "body_exists", "operator": "eq", "target": True}]}],
            "approval_groups": [],
        })


@unittest.skipUnless(
    os.getenv("MODEL_AGENT_LIVE_GATEWAY"),
    "set MODEL_AGENT_LIVE_GATEWAY=1 to run against a live Gateway",
)
class LiveGatewaySmokeTests(unittest.TestCase):
    def test_langgraph_patch_stack_executes_two_real_gateway_solids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            document_id = f"agent-live-stack-{uuid4().hex}"
            app = create_app(
                data_path=str(root / "state.json"),
                gateway_url=os.getenv("MODEL_AGENT_GATEWAY_URL", "http://127.0.0.1:8788"),
                workflow_mode="langgraph",
                checkpoint_path=str(root / "checkpoints.bin"),
            )
            client = TestClient(app)
            created = client.post(
                "/api/v1/agent/runs",
                json={
                    "project_id": "live-project",
                    "document_id": document_id,
                    "user_id": "live-user",
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
            # The current stack template grants one approval to its action
            # group; a second approval request would target no pending action.
            self.assertEqual(first["status"], "completed")
            self.assertEqual(first["document_revision"], 2)
            completed = client.get(f"/api/v1/agent/runs/{created['id']}").json()
            self.assertEqual(len(completed["actions"]), 2)
            self.assertTrue(all(action["status"] == "succeeded" for action in completed["actions"]))
            adapter = HttpGeometryAdapter(os.getenv("MODEL_AGENT_GATEWAY_URL", "http://127.0.0.1:8788"))
            try:
                self.assertEqual(adapter.summary(document_id)["bodyCount"], 2)
            finally:
                adapter.close()
            client.close()

    def test_langgraph_api_executes_real_gateway_write(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            document_id = f"agent-live-graph-{uuid4().hex}"
            geometry = HttpGeometryAdapter(os.getenv("MODEL_AGENT_GATEWAY_URL", "http://127.0.0.1:8788"))
            engine = LangGraphWorkflowEngine(
                repository=JsonRepository(root / "state.json"), geometry=geometry,
                checkpoint_path=str(root / "checkpoints.bin"),
                planner_model=SingleBoxPlanner(document_id),
            )
            app = create_app(engine=engine)
            client = TestClient(app)
            created = client.post(
                "/api/v1/agent/runs",
                json={
                    "project_id": "live-project",
                    "document_id": document_id,
                    "user_id": "live-user",
                    "message": "create 2.45 GHz antenna",
                },
            ).json()
            waiting = client.post(
                f"/api/v1/agent/runs/{created['id']}/responses",
                json={
                    "request_id": created["waiting_request_id"],
                    "response": {
                        "antenna_type": "rectangular_patch",
                        "substrate_material": "FR-4",
                        "substrate_thickness_m": 0.0016,
                    },
                },
            ).json()
            completed = client.post(
                f"/api/v1/agent/runs/{created['id']}/approvals/{waiting['waiting_approval_id']}/decision",
                json={"decision": "approve"},
            )
            self.assertEqual(completed.status_code, 200)
            self.assertEqual(completed.json()["status"], "completed")
            self.assertEqual(completed.json()["document_revision"], 1)
            client.close()
            geometry.close()

    def test_create_observe_verify_loop(self) -> None:
        gateway_url = os.getenv("MODEL_AGENT_GATEWAY_URL", "http://127.0.0.1:8788")
        document_id = f"agent-live-test-{uuid4().hex}"
        adapter = HttpGeometryAdapter(gateway_url)
        try:
            before = adapter.current_revision(document_id)
            arguments = {
                "document_id": document_id,
                "width_m": 0.061,
                "depth_m": 0.061,
                "height_m": 0.0016,
            }
            action = ActionRequest(
                action_id="live-action-1",
                run_id="live-run-1",
                tool_name="geometry.create_box",
                arguments=arguments,
                side_effect=SideEffect.WRITE,
                risk_level=RiskLevel.MEDIUM,
                expected_document_revision=before,
                idempotency_key=f"{document_id}:box-1",
                reason="live Gateway smoke test",
                action_hash=canonical_hash("geometry.create_box", arguments),
            )
            observation = adapter.execute(action)
            after = adapter.current_revision(document_id)
            self.assertTrue(observation.success)
            self.assertEqual(observation.before_revision, before)
            self.assertEqual(observation.after_revision, after)
            self.assertGreater(after, before)
        finally:
            adapter.close()


if __name__ == "__main__":
    unittest.main()
