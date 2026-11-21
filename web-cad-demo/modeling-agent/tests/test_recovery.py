import unittest

from modeling_agent.domain.models import ErrorClass
from modeling_agent.workflows.recovery import RecoveryRoute, RecoveryRouter


class RecoveryRouterTests(unittest.TestCase):
    def test_unknown_write_result_queries_status_before_retry(self) -> None:
        decision = RecoveryRouter().decide(ErrorClass.TOOL_TRANSIENT, result_unknown=True)
        self.assertEqual(decision.route, RecoveryRoute.QUERY_ACTION_STATUS)

    def test_revision_conflict_refreshes_world_model(self) -> None:
        decision = RecoveryRouter().decide(ErrorClass.REVISION_CONFLICT)
        self.assertEqual(decision.route, RecoveryRoute.REFRESH_WORLD_MODEL)

    def test_transient_budget_escalates(self) -> None:
        decision = RecoveryRouter().decide(ErrorClass.TOOL_TRANSIENT, retry_count=2)
        self.assertEqual(decision.route, RecoveryRoute.ESCALATE_TO_HUMAN)


if __name__ == "__main__":
    unittest.main()
