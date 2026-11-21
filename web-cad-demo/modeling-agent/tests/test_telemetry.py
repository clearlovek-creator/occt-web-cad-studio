import unittest

from modeling_agent.telemetry import agent_span, metrics_snapshot


class TelemetryTests(unittest.TestCase):
    def test_spans_record_duration_without_leaking_sensitive_attributes(self) -> None:
        with agent_span(
            "test.node",
            {"run_id": "secret-run", "project_id": "secret-project", "node_name": "theory"},
        ):
            pass
        items = [item for item in metrics_snapshot() if item["name"] == "test.node"]
        self.assertTrue(items)
        self.assertEqual(items[-1]["attributes"], {"node_name": "theory"})
        self.assertGreaterEqual(items[-1]["duration_ms_sum"], 0)


if __name__ == "__main__":
    unittest.main()
