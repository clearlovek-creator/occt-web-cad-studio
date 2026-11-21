import unittest

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from modeling_agent.adapters.geometry import FakeGeometryAdapter
from modeling_agent.application.store import InMemoryRepository
from modeling_agent.agents.planner import PlannerValidationError, StructuredPlanner, compile_planner_dag
from modeling_agent.agents.react import ModelResponse
from modeling_agent.capabilities.registry import CapabilityRegistry
from modeling_agent.domain.models import AgentRun, new_id
from modeling_agent.workflows.langgraph_adapter import LangGraphRuntime, build_langgraph


class FakePlannerModel:
    def __init__(self, payload):
        self.payload = payload

    def complete(self, messages, tools):
        return ModelResponse(structured_output=self.payload)


def valid_payload():
    return {
        "summary": "Build the patch geometry in dependency order.",
        "assumptions": ["Dimensions come from the theory stage."],
        "tasks": [
            {
                "task_id": "substrate",
                "title": "Create substrate",
                "tool_name": "geometry.create_box",
                "arguments": {"document_id": "d", "width_m": 0.05, "depth_m": 0.04, "height_m": 0.0016},
                "reason": "Create the dielectric volume.",
                "success_criteria": [{"name": "body_exists", "operator": "eq", "target": True}],
                "approval_group": "patch_stack",
            },
            {
                "task_id": "patch",
                "title": "Create patch conductor",
                "tool_name": "geometry.create_box",
                "arguments": {"document_id": "d", "width_m": 0.037, "depth_m": 0.029, "height_m": 0.000035, "z_m": 0.0016},
                "depends_on": ["substrate"],
                "reason": "Place the conductor above the substrate.",
                "success_criteria": [{"name": "body_exists", "operator": "eq", "target": True}],
                "approval_group": "patch_stack",
            },
        ],
        "approval_groups": [{"group_id": "patch_stack", "summary": "Approve the complete patch stack."}],
    }


class StructuredPlannerTests(unittest.TestCase):
    def test_planner_validates_and_compiles_dependency_order(self):
        planner = StructuredPlanner(FakePlannerModel(valid_payload()), CapabilityRegistry())
        dag = planner.plan({"goal": {"antenna_type": "rectangular_patch"}})
        plan = compile_planner_dag(dag, run_id="run-1", goal_version=1)
        self.assertEqual([task.task_id for task in dag.tasks], ["substrate", "patch"])
        self.assertEqual([action["task_id"] for action in plan.actions], ["substrate", "patch"])
        self.assertEqual(plan.approval_groups[0]["group_id"], "patch_stack")

    def test_planner_rejects_cycles(self):
        payload = valid_payload()
        payload["tasks"][0]["depends_on"] = ["patch"]
        with self.assertRaises(PlannerValidationError):
            StructuredPlanner(FakePlannerModel(payload), CapabilityRegistry()).plan({})

    def test_planner_rejects_unknown_tools(self):
        payload = valid_payload()
        payload["tasks"][0]["tool_name"] = "geometry.magic_tool"
        with self.assertRaises(PlannerValidationError):
            StructuredPlanner(FakePlannerModel(payload), CapabilityRegistry()).plan({})

    def test_llm_dag_runs_as_one_approval_group(self):
        repository = InMemoryRepository()
        run = AgentRun(
            id="planner-run-1",
            project_id="p",
            document_id="d",
            user_id="u",
            config_snapshot_id=new_id("config"),
        )
        repository.create_run(run)
        runtime = LangGraphRuntime.create(
            repository,
            FakeGeometryAdapter(),
            planner_model=FakePlannerModel(valid_payload()),
        )
        graph = build_langgraph(InMemorySaver(), runtime=runtime)
        config = {"configurable": {"thread_id": run.id}}
        initial = graph.invoke(
            {
                "run_id": run.id,
                "user_message": "create a patch",
                "structured_goal": {"antenna_type": "rectangular_patch", "center_frequency_hz": 2.45e9},
            },
            config=config,
        )
        self.assertTrue(initial.get("__interrupt__"))
        final = graph.invoke(Command(resume="approve"), config=config)
        self.assertEqual(final["status"], "completed")
        self.assertEqual(runtime.geometry.current_revision("d"), 2)
        self.assertEqual(len(repository.list_actions(run.id)), 2)

    def test_missing_planner_fails_in_planning_stage(self):
        repository = InMemoryRepository()
        run = AgentRun(
            id="planner-missing-run",
            project_id="p",
            document_id="d",
            user_id="u",
            config_snapshot_id=new_id("config"),
        )
        repository.create_run(run)
        runtime = LangGraphRuntime.create(repository, FakeGeometryAdapter())
        graph = build_langgraph(InMemorySaver(), runtime=runtime)
        result = graph.invoke(
            {
                "run_id": run.id,
                "user_message": "Create a 2.45 GHz patch antenna",
                "structured_goal": {"antenna_type": "rectangular_patch", "center_frequency_hz": 2.45e9},
            },
            config={"configurable": {"thread_id": run.id}},
        )
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["current_stage"], "planning")
        self.assertEqual(result["error"]["code"], "PLANNER_REQUIRED")
        persisted = repository.get_run(run.id)
        self.assertEqual(persisted.current_stage.value, "planning")
        self.assertEqual(len(repository.list_actions(run.id)), 0)


if __name__ == "__main__":
    unittest.main()
