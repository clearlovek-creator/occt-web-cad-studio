from __future__ import annotations

import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

from modeling_agent.api.app import create_app
from modeling_agent.application.store import InMemoryRepository
from modeling_agent.adapters.persistence.json_repository import JsonRepository
from modeling_agent.adapters.persistence.sqlalchemy_repository import SqlAlchemyRepository
from modeling_agent.workflows.local import LocalWorkflowEngine


def request() -> dict:
    return {"client_run_id": "py-run-" + str(uuid4()), "project_id": "project-a",
            "document_id": "document-a", "user_id": "user-a", "message": "create an antenna",
            "template_id": None, "autonomy_level": "supervised"}


class ClientRunIdentityTests(unittest.TestCase):
    def test_creation_preserves_original_identity_and_request_for_both_engines(self) -> None:
        for mode in ("local", "langgraph"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                body = request()
                with TestClient(create_app(workflow_mode=mode, data_path=str(Path(directory)/"state.json"),
                                           checkpoint_path=str(Path(directory)/"checkpoints.bin"))) as client:
                    created = client.post("/api/v1/agent/runs", json=body)
                    self.assertEqual(created.status_code, 200, created.text)
                    self.assertEqual(created.json()["run_id"], body["client_run_id"])
                    self.assertEqual(created.json()["client_creation"], body)
                    original = client.get("/api/v1/agent/runs/" + body["client_run_id"],
                                          params={key: body[key] for key in ("project_id", "document_id", "user_id")})
                    self.assertEqual(original.status_code, 200)
                    self.assertEqual(original.json()["client_creation"], body)
                    self.assertEqual(original.json()["status"], "waiting_user")

    def test_duplicate_same_or_changed_request_never_reexecutes_the_bound_run(self) -> None:
        repository = InMemoryRepository()
        with TestClient(create_app(engine=LocalWorkflowEngine(repository=repository))) as client:
            body = request()
            self.assertEqual(client.post("/api/v1/agent/runs", json=body).status_code, 200)
            before = [event.model_dump(mode="json") for event in repository.list_events(body["client_run_id"])]
            for patch in ({}, {"message": "different"}, {"document_id": "foreign"}, {"user_id": "foreign"}):
                self.assertEqual(client.post("/api/v1/agent/runs", json={**body, **patch}).status_code, 409)
            self.assertEqual([event.model_dump(mode="json") for event in repository.list_events(body["client_run_id"])], before)
            self.assertEqual(len(repository.list_runs()), 1)
            self.assertEqual(len(repository.config_snapshots), 1)

    def test_scoped_get_refuses_foreign_project_document_and_user_before_returning_context(self) -> None:
        with TestClient(create_app()) as client:
            body = request()
            self.assertEqual(client.post("/api/v1/agent/runs", json=body).status_code, 200)
            for key in ("project_id", "document_id", "user_id"):
                response = client.get("/api/v1/agent/runs/" + body["client_run_id"], params={key: "foreign"})
                self.assertEqual(response.status_code, 409)
                self.assertNotIn("client_creation", response.json())
                self.assertNotIn("actions", response.json())

    def test_client_ids_and_message_budget_are_validated_before_creation(self) -> None:
        repository = InMemoryRepository()
        with TestClient(create_app(engine=LocalWorkflowEngine(repository=repository))) as client:
            for patch in ({"client_run_id": "../escape"}, {"client_run_id": "legacy-id"},
                          {"client_run_id": "py-run-" + "a"*36}, {"message": "x"*16001}):
                self.assertEqual(client.post("/api/v1/agent/runs", json={**request(), **patch}).status_code, 422)
            self.assertEqual(repository.list_runs(), [])

    def test_json_restart_finds_original_request_without_workflow_continuation(self) -> None:
        for mode in ("local", "langgraph"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                data = str(Path(directory)/"state.json")
                checkpoint = str(Path(directory)/"checkpoints.bin")
                body = request()
                with TestClient(create_app(workflow_mode=mode, data_path=data, checkpoint_path=checkpoint)) as first:
                    created = first.post("/api/v1/agent/runs", json=body).json()
                before = Path(data).read_bytes()
                with TestClient(create_app(workflow_mode=mode, data_path=data, checkpoint_path=checkpoint)) as second:
                    recovered = second.get("/api/v1/agent/runs/" + body["client_run_id"])
                    self.assertEqual(recovered.status_code, 200)
                    self.assertEqual(recovered.json()["client_creation"], body)
                    self.assertEqual(recovered.json()["run_version"], created["run_version"])
                    self.assertEqual(second.post("/api/v1/agent/runs", json=body).status_code, 409)
                self.assertEqual(Path(data).read_bytes(), before)

    def test_sql_restart_preserves_binding_without_a_database_schema_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            url = "sqlite:///" + str(Path(directory)/"state.sqlite")
            body = request()
            first = SqlAlchemyRepository(url, initialize=True)
            with TestClient(create_app(engine=LocalWorkflowEngine(repository=first))) as client:
                self.assertEqual(client.post("/api/v1/agent/runs", json=body).status_code, 200)
            second = SqlAlchemyRepository(url)
            with TestClient(create_app(engine=LocalWorkflowEngine(repository=second))) as client:
                recovered = client.get("/api/v1/agent/runs/" + body["client_run_id"])
                self.assertEqual(recovered.status_code, 200)
                self.assertEqual(recovered.json()["client_creation"], body)
                self.assertEqual(client.post("/api/v1/agent/runs", json=body).status_code, 409)
                self.assertEqual(len(second.list_runs()), 1)

    def test_concurrent_memory_creation_uses_existing_unique_run_key_as_execution_boundary(self) -> None:
        self._concurrent(InMemoryRepository())

    def test_concurrent_sql_creation_uses_existing_unique_run_key_as_execution_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self._concurrent(SqlAlchemyRepository("sqlite:///" + str(Path(directory)/"state.sqlite"), initialize=True))

    def _concurrent(self, repository) -> None:
        barrier = threading.Barrier(2)

        class ConcurrentEngine(LocalWorkflowEngine):
            def create_run(self, **kwargs):
                barrier.wait(timeout=5)
                return super().create_run(**kwargs)

        body = request()
        with TestClient(create_app(engine=ConcurrentEngine(repository=repository))) as client:
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(client.post, "/api/v1/agent/runs", json=body) for _ in range(2)]
                responses = [future.result(timeout=10) for future in futures]
            self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
            self.assertEqual(len(repository.list_runs()), 1)
            starts = [event for event in repository.list_events(body["client_run_id"])
                      if event.event_type.value == "run.started"]
            self.assertEqual(len(starts), 1)

    def test_missing_client_binding_fails_closed_but_legacy_runs_still_have_a_readable_status(self) -> None:
        repository = InMemoryRepository()
        with TestClient(create_app(engine=LocalWorkflowEngine(repository=repository))) as client:
            body = request()
            created = client.post("/api/v1/agent/runs", json=body).json()
            repository.config_snapshots.pop(created["config_snapshot_id"])
            self.assertEqual(client.get("/api/v1/agent/runs/" + body["client_run_id"]).status_code, 503)
            legacy = client.post("/api/v1/agent/runs", json={"message": "create an antenna"})
            self.assertEqual(legacy.status_code, 200)
            self.assertNotIn("client_creation", legacy.json())
            self.assertEqual(client.get("/api/v1/agent/runs/" + legacy.json()["run_id"]).status_code, 200)

    def test_unrelated_workflow_errors_are_not_mislabeled_as_duplicate_creation(self) -> None:
        class FailingEngine(LocalWorkflowEngine):
            def create_run(self, **kwargs):
                super().create_run(**kwargs)
                raise ValueError("unrelated workflow failure after registration")

        with TestClient(create_app(engine=FailingEngine()), raise_server_exceptions=False) as client:
            response = client.post("/api/v1/agent/runs", json=request())
            self.assertEqual(response.status_code, 500)
