import unittest

from modeling_agent.agents.react import BoundedReActAgent, ModelResponse, ReActBudget, ToolCall
from modeling_agent.capabilities.registry import CapabilityRegistry


class FakeModel:
    def __init__(self) -> None:
        self.calls = 0

    def complete(self, messages, tools):
        self.calls += 1
        if self.calls == 1:
            return ModelResponse(
                tool_calls=[ToolCall(name="calculate_patch_initial_dimensions", arguments={"frequency_hz": 2.45e9})]
            )
        return ModelResponse(
            text="已完成初始估算",
            structured_output={"width_m": 0.061, "depth_m": 0.061},
        )


class ReActTests(unittest.TestCase):
    def test_tool_loop_is_bounded_and_structured(self) -> None:
        agent = BoundedReActAgent(
            FakeModel(),
            CapabilityRegistry(),
            {"calculate_patch_initial_dimensions": lambda args: {"width_m": 0.061}},
            stage="theory",
            budget=ReActBudget(max_iterations=2, max_tool_calls=2),
        )
        result = agent.run({"goal": "2.45 GHz patch"})
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.tool_calls, 1)
        self.assertIsNotNone(result.structured_output)

    def test_unknown_or_over_budget_tool_stops(self) -> None:
        class LoopModel:
            def complete(self, messages, tools):
                return ModelResponse(tool_calls=[ToolCall(name="calculate_patch_initial_dimensions")])

        agent = BoundedReActAgent(
            LoopModel(),
            CapabilityRegistry(),
            {"calculate_patch_initial_dimensions": lambda args: {}},
            stage="theory",
            budget=ReActBudget(max_iterations=2, max_tool_calls=1),
        )
        result = agent.run({})
        self.assertEqual(result.status, "budget_exhausted")


if __name__ == "__main__":
    unittest.main()
