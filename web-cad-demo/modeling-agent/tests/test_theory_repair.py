import tempfile
import unittest
from pathlib import Path

from modeling_agent.adapters.geometry import FakeGeometryAdapter
from modeling_agent.adapters.persistence.json_repository import JsonRepository
from modeling_agent.agents.react import ModelResponse
from modeling_agent.workflows.engine import LangGraphWorkflowEngine


class RepairModel:
    def __init__(self) -> None:
        self.calls = 0

    def complete(self, messages, tools):
        self.calls += 1
        if self.calls == 1:
            return ModelResponse(structured_output={'invalid': True})
        return ModelResponse(
            structured_output={
                'method': 'test-repair',
                'confidence': 0.8,
                'derived_parameters': [
                    {'name': 'width', 'value_m': 0.06},
                    {'name': 'length', 'value_m': 0.05},
                ],
            }
        )


class TheoryRepairTests(unittest.TestCase):
    def test_invalid_theory_schema_is_repaired_with_a_two_attempt_bound(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = RepairModel()
            service = LangGraphWorkflowEngine(
                repository=JsonRepository(root / 'state.json'),
                geometry=FakeGeometryAdapter(),
                checkpoint_path=root / 'checkpoints.bin',
                theory_model=model,
            )
            run = service.create_run(
                project_id='p',
                document_id='d',
                user_id='u',
                message='create 2.45 GHz rectangular patch antenna',
                template_id='antenna.rectangular_patch_stack',
            )
            self.assertEqual(model.calls, 2)
            self.assertEqual(run.status.value, 'waiting_approval')


if __name__ == '__main__':
    unittest.main()
