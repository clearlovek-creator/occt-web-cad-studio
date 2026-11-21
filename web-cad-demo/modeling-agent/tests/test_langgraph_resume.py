import unittest
import tempfile
from pathlib import Path

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from modeling_agent.adapters.persistence.json_checkpoint import JsonCheckpointSaver
from modeling_agent.workflows.langgraph_adapter import build_langgraph


class LangGraphResumeTests(unittest.TestCase):
    def test_json_checkpoint_survives_graph_reconstruction(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "graph-checkpoint.bin"
            config = {"configurable": {"thread_id": "durable-graph"}}
            first = build_langgraph(JsonCheckpointSaver(path))
            initial = first.invoke(
                {"run_id": "durable-run", "structured_goal": {}},
                config=config,
            )
            self.assertTrue(initial.get("__interrupt__"))
            second = build_langgraph(JsonCheckpointSaver(path))
            resumed = second.invoke(
                Command(resume={"antenna_type": "rectangular_patch", "center_frequency_hz": 2.45e9}),
                config=config,
            )
            self.assertTrue(resumed.get("__interrupt__"))
            self.assertEqual(resumed["current_stage"], "policy")

    def test_invalid_elicitation_response_pauses_for_correction(self) -> None:
        graph = build_langgraph(InMemorySaver())
        config = {"configurable": {"thread_id": "invalid-elicitation"}}
        initial = graph.invoke(
            {"run_id": "run-invalid", "structured_goal": {}, "user_message": "create antenna"},
            config=config,
        )
        self.assertTrue(initial.get("__interrupt__"))
        resumed = graph.invoke(
            Command(resume={"antenna_type": "rectangular_patch", "center_frequency_hz": -1}),
            config=config,
        )
        self.assertTrue(resumed.get("__interrupt__"))
        value = resumed["__interrupt__"][0].value
        self.assertEqual(value["reason_code"], "invalid_response")

    def test_elicitation_resume_merges_user_response(self) -> None:
        graph = build_langgraph(InMemorySaver())
        config = {"configurable": {"thread_id": "integration-elicitation"}}
        initial = graph.invoke(
            {"run_id": "run-2", "structured_goal": {}},
            config=config,
        )
        self.assertTrue(initial.get("__interrupt__"))
        resumed = graph.invoke(
            Command(
                resume={
                    "antenna_type": "rectangular_patch",
                    "center_frequency_hz": 2.45e9,
                }
            ),
            config=config,
        )
        self.assertTrue(resumed.get("__interrupt__"))
        self.assertEqual(resumed["current_stage"], "policy")


if __name__ == "__main__":
    unittest.main()
