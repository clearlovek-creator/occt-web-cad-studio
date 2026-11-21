import unittest

from modeling_agent.context.engine import ContextBudget, ContextBudgetExceeded, ContextEngine, ContextScopeError, ContextStaleError
from modeling_agent.domain.models import AgentRun, RunStatus
from modeling_agent.workflows.local import LocalWorkflowEngine
from modeling_agent.workflows.router import InputRouter


class RoutingAndContextTests(unittest.TestCase):
    def test_change_route_with_multiple_active_runs_requires_clarification(self) -> None:
        engine = LocalWorkflowEngine()
        run = AgentRun(
            id="run-a",
            project_id="p",
            document_id="d",
            user_id="u",
            config_snapshot_id="cfg",
            status=RunStatus.WAITING_USER,
        )
        other = run.model_copy(update={"id": "run-b"})
        decision = InputRouter().route("把频率改成 5.8 GHz", [run, other])
        self.assertEqual(decision.route.value, "clarify_route")
        self.assertIn("multiple_active_runs", decision.reason_codes)
        self.assertEqual(decision.candidate_routes, ["change_active_goal", "continue_active_run"])

    def test_context_becomes_stale_after_goal_or_document_revision_changes(self) -> None:
        engine = LocalWorkflowEngine()
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="create 2.45 GHz rectangular patch antenna, substrate 1.6 mm",
        )
        context_engine = ContextEngine(engine.repository, engine.registry)
        pack = context_engine.build(run_id=run.id, node_name="theory")
        self.assertTrue(context_engine.is_fresh(pack, node_name="theory"))

        changed = engine.repository.get_run(run.id)
        changed.current_stage = changed.current_stage
        engine.repository.update_run(changed)
        self.assertFalse(context_engine.is_fresh(pack, node_name="theory"))
        pack = context_engine.build(run_id=run.id, node_name="theory")

        changed = engine.repository.get_run(run.id)
        changed.goal_version += 1
        changed.document_revision = 3
        engine.repository.update_run(changed)
        self.assertFalse(context_engine.is_fresh(pack, node_name="theory"))
        with self.assertRaises(ContextStaleError):
            context_engine.require_fresh(pack, node_name="theory")

    def test_context_budget_failure_is_explicit_when_safety_fields_cannot_fit(self) -> None:
        engine = LocalWorkflowEngine()
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="create 2.45 GHz rectangular patch antenna, substrate 1.6 mm",
        )
        with self.assertRaises(ContextBudgetExceeded):
            ContextEngine(engine.repository, engine.registry).build(
                run_id=run.id,
                node_name="theory",
                budget=ContextBudget(max_chars=100),
            )

    def test_context_rejects_cross_project_world_or_knowledge(self) -> None:
        engine = LocalWorkflowEngine()
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="create 2.45 GHz rectangular patch antenna, substrate 1.6 mm",
        )
        context_engine = ContextEngine(engine.repository, engine.registry)
        with self.assertRaises(ContextScopeError):
            context_engine.build(run_id=run.id, node_name="theory", world_model={"project_id": "other"})
        with self.assertRaises(ContextScopeError):
            context_engine.build(run_id=run.id, node_name="theory", knowledge=[{"document_id": "other"}])
        with self.assertRaises(ContextScopeError):
            context_engine.build(
                run_id=run.id,
                node_name="execution",
                plan=[{"tool_name": "geometry.create_box", "arguments": {"document_id": "other"}}],
            )

    def test_context_build_uses_authoritative_revision_over_caller_snapshot(self) -> None:
        engine = LocalWorkflowEngine()
        run = engine.create_run(
            project_id="p",
            document_id="d",
            user_id="u",
            message="create 2.45 GHz rectangular patch antenna, substrate 1.6 mm",
        )
        current = engine.repository.get_run(run.id)
        current.document_revision = 4
        engine.repository.update_run(current)
        pack = ContextEngine(engine.repository, engine.registry).build(
            run_id=run.id,
            node_name="verification",
            world_model={"document_revision": 0, "objects": 1},
        )
        self.assertEqual(pack.world_model_summary["document_revision"], 4)
        self.assertEqual(pack.sources[0].source_id, f"run:{run.id}")


if __name__ == "__main__":
    unittest.main()
