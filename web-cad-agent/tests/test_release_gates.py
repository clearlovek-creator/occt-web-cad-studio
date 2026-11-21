from __future__ import annotations

import asyncio
import tempfile

from webcad_agent.adapters.fake_geometry import FakeGeometryAdapter
from webcad_agent.adapters.json_store import JsonStore
from webcad_agent.application.service import AgentApplication
from webcad_agent.routing.router import IntentRouter
from webcad_agent.tools.registry import ToolRegistry
from webcad_agent.extensions.contracts import validate_tool_contract


def test_release_gate_route_accuracy_and_open_tool_schema_rate() -> None:
    router = IntentRouter()
    cases = [
        ("/status", "control"), ("/compact", "control"),
        ("当前模型有哪些 Body", "read"), ("测量 body-1 的体积", "read"),
        ("create a sphere radius 5", "execute"), ("平移 body-1 dx 1 dy 0 dz 0", "execute"),
        ("cut body-1 body-2", "execute"), ("创建一个 10×20×30 mm 的长方体", "execute"),
    ]
    correct = sum(router.route(text).path == expected for text, expected in cases)
    assert correct / len(cases) >= 0.95
    registry = ToolRegistry.discover()
    assert all(item.output_schema.get("type") == "object" for item in registry.list())
    write_tools = [item for item in registry.list() if item.side_effect in {"write", "destructive"}]
    valid = sum(not validate_tool_contract(item) for item in write_tools)
    assert write_tools and valid / len(write_tools) >= 0.99


def test_release_gate_supervised_mode_has_zero_unapproved_writes() -> None:
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as temp:
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=FakeGeometryAdapter())
            session = app.create_session(document_id="demo", gateway_origin="fake")
            result = await app.propose_box(session_id=session.session_id, width=1, depth=1, height=1)
            assert result["status"] == "approval_required"
            approval = result["approval"]
            assert approval["document_id"] == "demo"
            assert approval["normalized_arguments"]["width"] == 1
            assert approval["parameter_sources"]["width"] == "user"
            assert approval["rollback"]["strategy"] == "document.undo"
            assert app.store.get_run(result["run"]["run_id"]).status.value == "waiting_approval"
            assert app.store.get_action(result["action"]["action_id"]).status.value == "approval_pending"
    asyncio.run(scenario())
