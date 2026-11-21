import tempfile
import unittest
from pathlib import Path

from modeling_agent.adapters.persistence.sqlalchemy_checkpoint import SqlAlchemyCheckpointSaver
from modeling_agent.workflows.langgraph_adapter import build_langgraph


class SqlAlchemyCheckpointTests(unittest.TestCase):
    def test_checkpoints_are_isolated_per_thread_after_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_url = f"sqlite:///{Path(directory) / 'checkpoints.db'}"
            first = SqlAlchemyCheckpointSaver(database_url, initialize=True)
            graph = build_langgraph(first)
            for thread_id in ("run-a", "run-b"):
                result = graph.invoke(
                    {
                        "run_id": thread_id,
                        "user_message": "create 2.45 GHz antenna",
                        "structured_goal": {},
                    },
                    config={"configurable": {"thread_id": thread_id}},
                )
                self.assertTrue(result.get("__interrupt__"))
            first.close()

            second = SqlAlchemyCheckpointSaver(database_url)
            for thread_id in ("run-a", "run-b"):
                checkpoint = second.get_tuple({"configurable": {"thread_id": thread_id}})
                self.assertIsNotNone(checkpoint)
                assert checkpoint is not None
                self.assertEqual(checkpoint.config["configurable"]["thread_id"], thread_id)
            second.close()


if __name__ == "__main__":
    unittest.main()
