import tempfile
import unittest
from pathlib import Path

from modeling_agent.application.store import InMemoryRepository
from modeling_agent.domain.models import AgentRun, ApprovalDecision, EventType, RunStatus, new_id
from modeling_agent.adapters.persistence.sqlalchemy import initialize_schema
from modeling_agent.adapters.geometry import FakeGeometryAdapter
from modeling_agent.adapters.persistence.json_repository import JsonRepository
from modeling_agent.workflows.engine import LangGraphWorkflowEngine
from modeling_agent.adapters.persistence.sqlalchemy_repository import SqlAlchemyRepository


class EventCausalityTests(unittest.TestCase):
    def _run(self) -> AgentRun:
        return AgentRun(
            id=new_id("run"),
            project_id="p",
            document_id="d",
            user_id="u",
            config_snapshot_id=new_id("config"),
        )

    def test_memory_events_form_a_causal_chain(self) -> None:
        repository = InMemoryRepository()
        run = self._run()
        repository.create_run(run)
        first = repository.append_event(run.id, EventType.RUN_STARTED, {})
        second = repository.append_event(run.id, EventType.STAGE_ENTERED, {"stage": "requirements"})
        self.assertIsNone(repository.list_events(run.id)[0].causation_id)
        self.assertEqual(first.event_id, second.causation_id)

    def test_langgraph_records_observation_event_for_completed_write(self) -> None:
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
                message="create 2.45 GHz rectangular patch antenna",
                template_id="antenna.rectangular_patch_stack",
            )
            if run.waiting_request_id:
                run = service.respond(
                    run.id,
                    run.waiting_request_id,
                    {"antenna_type": "rectangular_patch", "center_frequency_hz": 2.45e9},
                    expected_run_version=run.run_version,
                )
            run = service.decide_approval(
                run.id,
                run.waiting_approval_id or "",
                ApprovalDecision.APPROVE,
                expected_run_version=run.run_version,
            )
            events = service.repository.list_events(run.id)
            observations = [item for item in events if item.event_type == EventType.OBSERVATION_RECORDED]
            self.assertEqual(run.status, RunStatus.COMPLETED)
            self.assertTrue(observations)
            self.assertTrue(observations[-1].payload.get("success"))

    def test_sql_events_form_a_causal_chain(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "events.db"
            url = f"sqlite:///{database.as_posix()}"
            initialize_schema(url)
            repository = SqlAlchemyRepository(url)
            run = self._run()
            repository.create_run(run)
            first = repository.append_event(run.id, EventType.RUN_STARTED, {})
            second = repository.append_event(run.id, EventType.STAGE_ENTERED, {"stage": "requirements"})
            events = repository.list_events(run.id)
            self.assertIsNone(events[0].causation_id)
            self.assertEqual(first.event_id, second.causation_id)
            repository.close()


if __name__ == "__main__":
    unittest.main()
