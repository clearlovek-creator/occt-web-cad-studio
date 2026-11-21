from __future__ import annotations

import asyncio

from webcad_agent.adapters.fake_geometry import FakeGeometryAdapter
from webcad_agent.adapters.json_store import JsonStore
from webcad_agent.adapters.sqlite_store import SQLiteStore
from webcad_agent.adapters.sqlalchemy_store import SQLAlchemyStore
from webcad_agent.application.service import AgentApplication
from webcad_agent.context.compactor import ContextCompactor
from webcad_agent.domain.models import ActionEnvelope, AgentRun, RunStatus, SessionMessage
from webcad_agent.domain.state import transition
from webcad_agent.tools.registry import ToolRegistry
from webcad_agent.planning.planner import DeterministicPlanner, PlanValidationError
from webcad_agent.routing.router import IntentRouter
from webcad_agent.resolution.resolver import EntityResolver
from webcad_agent.react.loop import BoundedReAct, ReactBudget, ReactDecision
from webcad_agent.ui.deep_link import viewer_url
from webcad_agent.observability.logging import redact
from webcad_agent.verification.geometry import verify_translation
from webcad_agent.context.budget import fit_items
from webcad_agent.context.budget import ContextBudgetExceeded
from webcad_agent.domain.units import parse_angle, parse_length
from webcad_agent.testing.faults import FaultGeometryAdapter
from webcad_agent.skills.registry import SkillRegistry
from webcad_agent.extensions.manager import ExtensionManager
from webcad_agent.extensions.manifest import ExtensionManifest
from webcad_agent.llm.protocol import FakeModel, ModelResponse
from webcad_agent.planning.llm_planner import StructuredPlanner
from webcad_agent.policy_lease import DocumentLeaseManager
from webcad_agent.verification.spatial import aabb_relation, center_distance
from webcad_agent.ui.controller import TuiController
from webcad_agent.tools.validation import ToolInputError, validate_input
from webcad_agent.observability.otel import configure_telemetry, safe_attributes, span
from webcad_agent.react.langgraph_runtime import LangGraphReAct
from webcad_agent.observability.artifacts import ArtifactStore
from webcad_agent.observability.metrics import Metrics
from webcad_agent.nl import parse_command


def test_registry_contains_core_tools() -> None:
    registry = ToolRegistry.discover()
    assert registry.get("core.geometry.create_box") is not None
    assert registry.get("core.geometry.create_box").gateway_operation == "primitive.box"
    assert registry.get("core.boolean.cut") is not None
    snapshot = registry.snapshot()
    registry.assert_snapshot(snapshot)


def test_context_compaction_keeps_recent_messages() -> None:
    messages = [SessionMessage(session_id="s", role="user", content=f"m{i}") for i in range(5)]
    compacted = ContextCompactor(recent_limit=2).compact(messages)
    assert len(compacted.recent) == 2
    assert len(compacted.removed_message_ids) == 3
    assert "m0" in compacted.summary


def test_run_state_transition() -> None:
    run = AgentRun(session_id="s", document_id="d", goal="g")
    run = transition(run, RunStatus.RUNNING)
    assert run.status == RunStatus.RUNNING
    run = transition(run, RunStatus.COMPLETED)
    assert run.status == RunStatus.COMPLETED


def test_safe_create_box_requires_approval_then_verifies() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            store = JsonStore(f"{temp}/state.json")
            geometry = FakeGeometryAdapter()
            app = AgentApplication(store=store, geometry=geometry)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            proposed = await app.propose_box(session_id=session.session_id, width=2, depth=3, height=4)
            assert proposed["status"] == "approval_required"
            assert proposed["preview"]["preview"] is True
            assert geometry.revision == 0
            completed = await app.approve(proposed["run"]["run_id"])
            assert completed["status"] == "completed"
            assert completed["verification"]["passed"] is True
            assert geometry.revision == 1
            assert len(store.list_events(session_id=session.session_id)) >= 5

    asyncio.run(scenario())


def test_auto_approval_flag_still_records_approval() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            store = JsonStore(f"{temp}/state.json")
            app = AgentApplication(store=store, geometry=FakeGeometryAdapter())
            session = app.create_session(document_id="demo", gateway_origin="fake")
            completed = await app.propose_box(session_id=session.session_id, width=1, depth=1, height=1, approve=True)
            assert completed["status"] == "completed"
            assert store.get_approval_for_run(completed["run"]["run_id"]).decision == "approve"

    asyncio.run(scenario())


def test_session_compaction_reads_event_messages() -> None:
    with __import__("tempfile").TemporaryDirectory() as temp:
        store = JsonStore(f"{temp}/state.json")
        app = AgentApplication(store=store, geometry=FakeGeometryAdapter())
        session = app.create_session(document_id="demo", gateway_origin="fake")
        for index in range(10):
            app.append_message(session_id=session.session_id, role="user", content=f"message-{index}")
        result = app.compact_session(session.session_id)
        assert result["kept_messages"] == 8
        assert "message-0" in result["summary"]


def test_long_session_auto_compacts_without_deleting_messages() -> None:
    with __import__("tempfile").TemporaryDirectory() as temp:
        store = JsonStore(f"{temp}/state.json")
        app = AgentApplication(store=store, geometry=FakeGeometryAdapter(), auto_compact_threshold=8)
        session = app.create_session(document_id="demo", gateway_origin="fake")
        for index in range(9):
            app.append_message(session_id=session.session_id, role="user", content=f"fact-{index}")
        assert len(store.list_messages(session_id=session.session_id)) == 9
        assert "fact-0" in store.get_session(session.session_id).rolling_summary
        assert any(event.event_type.value == "context.compacted" for event in store.list_events(session_id=session.session_id))
        checkpoints = store.list_compaction_checkpoints(session_id=session.session_id)
        assert len(checkpoints) == 1 and checkpoints[0].through_message_id


def test_hollow_tube_plan_is_acyclic_and_references_results() -> None:
    registry = ToolRegistry.discover()
    run = AgentRun(session_id="s", document_id="d", goal="tube", document_revision=0)
    plan = DeterministicPlanner(registry).hollow_tube(run, outer_radius=10, inner_radius=7, height=20)
    assert len(plan.steps) == 3
    assert plan.steps[-1].arguments["inputs"]["targetBody"]["$ref"] == "outer-cylinder.body_id"
    assert plan.plan_hash


def test_plan_cycle_is_rejected() -> None:
    from webcad_agent.domain.models import AgentPlan, PlanStep, SideEffect, RiskLevel
    from webcad_agent.planning.planner import validate_plan
    registry = ToolRegistry.discover()
    plan = AgentPlan(run_id="r", document_id="d", goal="bad", steps=[
        PlanStep(step_id="a", ordinal=0, tool_name="core.geometry.create_box", tool_version="1",
                 side_effect=SideEffect.WRITE, risk_level=RiskLevel.MEDIUM, depends_on=["b"]),
        PlanStep(step_id="b", ordinal=1, tool_name="core.geometry.create_box", tool_version="1",
                 side_effect=SideEffect.WRITE, risk_level=RiskLevel.MEDIUM, depends_on=["a"]),
    ])
    try:
        validate_plan(plan, registry)
    except PlanValidationError as exc:
        assert exc.code == "PLAN_CYCLE"
    else:
        raise AssertionError("cycle should be rejected")


def test_hollow_tube_batch_requires_approval_and_verifies() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            store = JsonStore(f"{temp}/state.json")
            app = AgentApplication(store=store, geometry=FakeGeometryAdapter())
            session = app.create_session(document_id="demo", gateway_origin="fake")
            proposed = await app.propose_hollow_tube(session_id=session.session_id, outer_radius=10, inner_radius=7, height=20)
            assert proposed["status"] == "approval_required"
            result = await app.approve_plan(session_id=session.session_id, run_id=proposed["run"]["run_id"], plan_id=proposed["plan"]["plan_id"])
            assert result["status"] == "completed"
            assert result["verification"]["passed"] is True
            assert len(result["observations"]) == 3
    asyncio.run(scenario())


def test_single_cylinder_uses_geometry_verifier() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            geometry = FakeGeometryAdapter()
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=geometry)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            result = await app.propose_tool(
                session_id=session.session_id,
                tool_name="core.geometry.create_cylinder",
                arguments={"radius": 3, "height": 8},
                approve=True,
            )
            assert result["status"] == "completed"
            assert result["verification"]["passed"] is True
            assert result["verification"]["checks"][-1]["name"] == "volume"

    asyncio.run(scenario())


def test_natural_language_parser_covers_primitives_translation_and_missing_fields() -> None:
    box = parse_command("创建一个 100×80×50 mm 的长方体")
    assert box.complete and box.kind == "box" and box.arguments["width"] == 100
    cylinder = parse_command("create cylinder radius 4 cm height 20 mm")
    assert cylinder.complete and cylinder.kind == "cylinder" and cylinder.arguments["radius"] == 40
    translated = parse_command("平移 body-1 dx 10 dy -2 dz 5")
    assert translated.complete and translated.reference == "body-1" and translated.arguments["dy"] == -2
    boolean = parse_command("cut body-1 body-2")
    assert boolean.complete and boolean.kind == "cut" and boolean.arguments["toolBody"] == "body-2"
    incomplete = parse_command("创建一个半径 5 的圆柱")
    assert incomplete.kind == "cylinder" and incomplete.missing == ("height",)


def test_fake_geometry_executes_registered_primitive_family() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            geometry = FakeGeometryAdapter()
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=geometry)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            result = await app.propose_tool(session_id=session.session_id,
                                            tool_name="core.geometry.create_sphere",
                                            arguments={"radius": 5}, approve=True)
            assert result["status"] == "completed" and result["verification"]["passed"]
            assert result["measurement"]["volume"] > 0
    asyncio.run(scenario())


def test_application_prompt_boundary_routes_natural_language_and_persists_missing_input() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=FakeGeometryAdapter())
            session = app.create_session(document_id="demo", gateway_origin="fake")
            completed = await app.handle_prompt(session_id=session.session_id,
                                                text="create sphere radius 5", approve=True)
            assert completed["status"] == "completed"
            missing = await app.handle_prompt(session_id=session.session_id, text="创建一个半径 5 的圆柱")
            assert missing["status"] == "needs_clarification"
            request = app.store.get_elicitation(missing["request"]["request_id"])
            assert request is not None and request.fields == ["height"]
            resumed = await app.answer_input_and_continue(request_id=request.request_id,
                                                          answer={"height": 10}, approve=True)
            assert resumed["status"] == "completed" and resumed["resumed_request_id"] == request.request_id
    asyncio.run(scenario())


def test_sqlite_store_reopens_sessions_and_events() -> None:
    with __import__("tempfile").TemporaryDirectory() as temp:
        path = f"{temp}/agent.db"
        store = SQLiteStore(path)
        app = AgentApplication(store=store, geometry=FakeGeometryAdapter())
        session = app.create_session(document_id="demo", gateway_origin="fake")
        app.append_message(session_id=session.session_id, role="user", content="keep this fact")
        store.close()
        reopened = SQLiteStore(path)
        assert reopened.get_session(session.session_id).document_id == "demo"
        assert len(reopened.list_events(session_id=session.session_id)) == 3
        assert reopened.list_messages(session_id=session.session_id)[0].content == "keep this fact"
        reopened.close()


def test_sqlalchemy_store_reopens_the_same_repository_contract() -> None:
    with __import__("tempfile").TemporaryDirectory() as temp:
        path = f"{temp}/agent.db"
        store = SQLAlchemyStore(path)
        app = AgentApplication(store=store, geometry=FakeGeometryAdapter())
        session = app.create_session(document_id="demo", gateway_origin="fake")
        app.append_message(session_id=session.session_id, role="user", content="sqlalchemy")
        store.close()
        reopened = SQLAlchemyStore(path)
        assert reopened.get_session(session.session_id).document_id == "demo"
        assert reopened.list_messages(session_id=session.session_id)[0].content == "sqlalchemy"
        assert len(reopened.list_events(session_id=session.session_id)) == 3
        reopened.close()


def test_run_persists_immutable_config_snapshot() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            store = SQLAlchemyStore(f"{temp}/agent.db")
            app = AgentApplication(store=store, geometry=FakeGeometryAdapter())
            session = app.create_session(document_id="demo", gateway_origin="fake")
            run = await app.start_run(session_id=session.session_id, goal="inspect", mode="readonly")
            assert run.config_snapshot_id
            snapshot = store.get_config_snapshot(run.config_snapshot_id)
            assert snapshot is not None and snapshot.mode == "readonly" and snapshot.policy_version == "policy-v1"
            store.close()
    asyncio.run(scenario())


def test_router_and_entity_resolver_do_not_guess() -> None:
    router = IntentRouter()
    assert router.route("/undo").path == "control"
    assert router.route("当前模型有哪些 Body").path == "read"
    assert router.route("创建一个盒子").path == "execute"
    summary = {"revision": 4, "bodies": [{"id": "body-1", "label": "plate"}, {"id": "body-2", "label": "plate"}]}
    result = EntityResolver().resolve("plate", summary=summary, revision=4)
    assert result.status == "ambiguous" and len(result.candidates) == 2


def test_bounded_react_stops_at_tool_budget() -> None:
    async def scenario() -> None:
        calls = 0
        async def decide(trace): return ReactDecision(kind="act", tool_name="read", arguments={})
        async def act(tool, args):
            nonlocal calls; calls += 1; return {"ok": True}
        async def observe(value): return value
        async def verify(value): return False
        result = await BoundedReAct(decide=decide, act=act, observe=observe, verify=verify,
                                    allowed_tools={"read"}, budget=ReactBudget(max_steps=5, max_tool_calls=2)).run({})
        assert result.status == "stopped" and result.stop_reason == "tool_budget" and calls == 2
    asyncio.run(scenario())


def test_waiting_plan_survives_reopen_and_revision_change_pauses_it() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            store = SQLiteStore(f"{temp}/agent.db")
            geometry = FakeGeometryAdapter()
            app = AgentApplication(store=store, geometry=geometry)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            proposed = await app.propose_hollow_tube(session_id=session.session_id, outer_radius=5, inner_radius=3, height=10)
            assert proposed["status"] == "approval_required"
            reopened = AgentApplication(store=SQLiteStore(f"{temp}/agent.db"), geometry=geometry)
            recovered = await reopened.recover_session(session.session_id)
            assert recovered["run"]["status"] == "waiting_approval"
            # External mutation changes the authoritative revision before approval.
            external = ActionEnvelope(run_id="external", tool_name="primitive.box", document_id="demo",
                                      arguments={"width": 1, "depth": 1, "height": 1}, side_effect="write",
                                      risk_level="medium", expected_revision=0, idempotency_key="external",
                                      action_hash="external", reason="external")
            await geometry.execute(external)
            recovered = await reopened.recover_session(session.session_id)
            assert recovered["run"]["status"] == "paused"
            assert recovered["run"]["last_error"]["code"] == "REVISION_CHANGED"
            store.close(); reopened.store.close()
    asyncio.run(scenario())


def test_viewer_link_and_log_redaction() -> None:
    assert viewer_url(document_id="demo", revision=3, body_id="body-1").endswith("documentId=demo&revision=3&bodyId=body-1")
    assert redact({"api_key": "secret", "nested": {"content": "hidden"}})["api_key"] == "[REDACTED]"
    result = verify_translation(action_id="a", before={"bounds": {"min": [0, 0, 0], "max": [2, 2, 2]}},
                                after={"bounds": {"min": [3, -2, 1], "max": [5, 0, 3]}}, delta=[3, -2, 1])
    assert result.passed
    selected, used = fit_items([{"name": "a", "description": "x" * 100}, {"name": "b", "description": "y" * 100}], budget=200)
    assert len(selected) == 2 and used <= 200


def test_approval_hash_cannot_be_reused_after_action_change() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            store = JsonStore(f"{temp}/state.json"); geometry = FakeGeometryAdapter(); app = AgentApplication(store=store, geometry=geometry)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            proposed = await app.propose_box(session_id=session.session_id, width=2, depth=2, height=2)
            action = store.get_action(proposed["action"]["action_id"])
            store.save_action(action.model_copy(update={"arguments": {"width": 99, "depth": 2, "height": 2}}))
            try:
                await app.approve(proposed["run"]["run_id"])
            except ValueError as exc:
                assert "hash" in str(exc).lower() or "changed" in str(exc).lower()
            else:
                raise AssertionError("stale approval should be rejected")
    asyncio.run(scenario())


def test_fake_batch_rolls_back_on_second_step_failure() -> None:
    async def scenario() -> None:
        geometry = FakeGeometryAdapter()
        actions = [
            ActionEnvelope(run_id="r", tool_name="primitive.box", document_id="d", arguments={"width": 2, "depth": 2, "height": 2}, side_effect="write", risk_level="medium", expected_revision=0, idempotency_key="a", action_hash="a", reason="a", step_id="a"),
            ActionEnvelope(run_id="r", tool_name="boolean.cut", document_id="d", arguments={"inputs": {"targetBody": {"$ref": "a.body_id"}, "toolBody": "missing"}}, side_effect="write", risk_level="high", expected_revision=0, idempotency_key="b", action_hash="b", reason="b", step_id="b"),
        ]
        observations = await geometry.execute_batch(actions)
        assert all(not item.success for item in observations)
        assert geometry.revision == 0 and geometry.bodies == {}
    asyncio.run(scenario())


def test_fault_adapter_can_model_outcome_unknown() -> None:
    async def scenario() -> None:
        geometry = FaultGeometryAdapter(timeout_after_mutation=True)
        action = ActionEnvelope(run_id="r", tool_name="primitive.box", document_id="d", arguments={"width": 1, "depth": 1, "height": 1}, side_effect="write", risk_level="medium", expected_revision=0, idempotency_key="x", action_hash="x", reason="x")
        observation = await geometry.execute(action)
        assert not observation.success and observation.error_code == "GATEWAY_OUTCOME_UNKNOWN"
        assert geometry.revision == 1
    asyncio.run(scenario())


def test_declarative_skill_is_loadable_without_executing_code() -> None:
    registry = SkillRegistry.from_path("skills/create_box_verified.json")
    assert registry.get("example.geometry.create_box_verified").tool_names[0] == "core.geometry.create_box"


def test_extension_enable_disable_state_is_explicit_and_durable() -> None:
    with __import__("tempfile").TemporaryDirectory() as temp:
        path = f"{temp}/extensions.json"
        manifest = ExtensionManifest(extension_id="acme.test", version="1", provider="acme", trusted=False)
        manager = ExtensionManager(trusted_ids={"acme.test"}, state_path=path)
        manager.enable(manifest)
        reopened = ExtensionManager(state_path=path)
        assert reopened.enabled_ids == {"acme.test"}
        reopened.disable("acme.test")
        assert ExtensionManager(state_path=path).enabled_ids == set()


def test_extension_manifest_compatibility_and_namespace_are_enforced() -> None:
    manager = ExtensionManager(trusted_ids={"acme.test"})
    with __import__("pytest").raises(ValueError, match="requires Agent"):
        manager.validate_manifest(ExtensionManifest(extension_id="acme.test", version="1", provider="acme",
                                                    min_agent_version="9.0.0"))
    with __import__("pytest").raises(ValueError, match="core"):
        manager.validate_manifest(ExtensionManifest(extension_id="acme.test", version="1", provider="acme",
                                                    tools=["core.geometry.create_box"]))


def test_structured_planner_revalidates_model_output() -> None:
    async def scenario() -> None:
        registry = ToolRegistry.discover(); run = AgentRun(run_id="run-1", session_id="s", document_id="d", goal="box")
        model = FakeModel([{"run_id": "run-1", "document_id": "d", "goal": "box", "steps": [{
            "step_id": "box", "ordinal": 0, "tool_name": "core.geometry.create_box", "tool_version": "1",
            "arguments": {"width": 1, "depth": 2, "height": 3}, "side_effect": "write", "risk_level": "medium", "verifier": "box_geometry"
        }]}])
        plan = await StructuredPlanner(model, registry).plan(run=run, user_goal="box", context={})
        assert plan.plan_hash and model.calls == 1
    asyncio.run(scenario())


def test_application_can_use_provider_neutral_model_for_unknown_prompt() -> None:
    class DynamicPlanModel:
        def __init__(self) -> None:
            self.calls = 0
            self.last_context = None

        async def complete(self, *, system, user, response_schema, context):
            self.calls += 1; self.last_context = context
            run = context["run"]
            payload = {"run_id": run["run_id"], "document_id": run["document_id"], "goal": run["goal"],
                       "steps": [{"step_id": "box", "ordinal": 0, "tool_name": "core.geometry.create_box",
                                   "tool_version": "1", "arguments": {"width": 1, "depth": 2, "height": 3},
                                   "side_effect": "write", "risk_level": "medium", "verifier": "box_geometry"}]}
            return ModelResponse(model="dynamic", content=__import__("json").dumps(payload))

    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            model = DynamicPlanModel()
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=FakeGeometryAdapter(), model=model)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            result = await app.handle_prompt(session_id=session.session_id, text="create a custom solid", approve=True)
            assert result["status"] == "completed" and model.calls == 1
            assert any(item["name"] == "core.geometry.create_box" for item in model.last_context["allowed_tools"])
    asyncio.run(scenario())


def test_document_lease_is_only_a_coordination_guard() -> None:
    leases = DocumentLeaseManager(); leases.acquire("d", "run-1")
    try:
        leases.acquire("d", "run-2")
    except RuntimeError:
        pass
    else:
        raise AssertionError("a second active owner must be rejected")
    leases.assert_owner("d", "run-1"); leases.release("d", "run-1")


def test_file_backed_document_lease_blocks_another_process_manager() -> None:
    with __import__("tempfile").TemporaryDirectory() as temp:
        first = DocumentLeaseManager(temp)
        second = DocumentLeaseManager(temp)
        first.acquire("gateway:doc", "run-1")
        with __import__("pytest").raises(RuntimeError, match="another process"):
            second.acquire("gateway:doc", "run-2")
        second.acquire("gateway:other", "run-2")
        first.release("gateway:doc", "run-1")


def test_application_holds_document_lease_while_write_approval_is_pending() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            store = JsonStore(f"{temp}/state.json"); app = AgentApplication(store=store, geometry=FakeGeometryAdapter())
            session = app.create_session(document_id="demo", gateway_origin="fake")
            first = await app.propose_box(session_id=session.session_id, width=1, depth=1, height=1)
            assert first["status"] == "approval_required"
            second = await app.propose_box(session_id=session.session_id, width=2, depth=2, height=2)
            assert second["status"] == "failed" and second["run"]["last_error"]["code"] == "LEASE_UNAVAILABLE"
            app.reject_run(session_id=session.session_id, run_id=first["run"]["run_id"])
    asyncio.run(scenario())


def test_ambiguous_entity_creates_resumable_elicitation_request() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            geometry = FakeGeometryAdapter(); store = JsonStore(f"{temp}/state.json")
            app = AgentApplication(store=store, geometry=geometry)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            first = await app.propose_box(session_id=session.session_id, width=1, depth=1, height=1, approve=True)
            second = await app.propose_box(session_id=session.session_id, width=2, depth=2, height=2, approve=True)
            result = await app.propose_translate(session_id=session.session_id, reference="body", dx=1, dy=0, dz=0)
            assert result["status"] == "needs_clarification"
            request = store.get_elicitation(result["request"]["request_id"])
            assert request and store.get_run(result["run"]["run_id"]).status == RunStatus.WAITING_USER
            answered = app.answer_input(request_id=request.request_id, answer={"reference": first["body_id"]})
            assert answered.status == "answered"
    asyncio.run(scenario())


def test_generic_allowlisted_tool_uses_common_policy_and_verifier() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            store = JsonStore(f"{temp}/state.json"); app = AgentApplication(store=store, geometry=FakeGeometryAdapter())
            session = app.create_session(document_id="demo", gateway_origin="fake")
            proposed = await app.propose_tool(session_id=session.session_id, tool_name="core.geometry.create_box",
                                               arguments={"width": 1, "depth": 2, "height": 3})
            assert proposed["status"] == "approval_required"
            result = await app.approve(proposed["run"]["run_id"])
            assert result["status"] == "completed" and result["verification"]["passed"]
    asyncio.run(scenario())


def test_spatial_verifiers_are_deterministic() -> None:
    first = {"bounds": {"min": [0, 0, 0], "max": [10, 10, 10]}}
    second = {"bounds": {"min": [20, 0, 0], "max": [30, 10, 10]}}
    assert center_distance(first, second) == 20
    assert aabb_relation(first, second) == "disjoint"
    assert aabb_relation(first, {"bounds": {"min": [2, 2, 2], "max": [4, 4, 4]}}) == "contains"


def test_read_model_views_cover_document_metadata_kinds() -> None:
    async def scenario() -> None:
        geometry = FakeGeometryAdapter()
        for kind, key in (("variables", "variables"), ("coordinates", "coordinateSystems"),
                           ("materials", "materials"), ("history", "history"),
                           ("properties", "properties"), ("property-types", "propertyTypes")):
            result = await geometry.model_query("demo", kind=kind)
            assert result["query"]["revision"] == 0 and key in result["query"]
    asyncio.run(scenario())


def test_history_control_checks_revision_and_releases_lease() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            geometry = FakeGeometryAdapter()
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=geometry)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            created = await app.propose_box(session_id=session.session_id, width=1, depth=1, height=1, approve=True)
            assert created["status"] == "completed"
            result = await app.history(session_id=session.session_id, direction="undo")
            assert result["direction"] == "undo" and geometry.bodies == {}
            app.leases.acquire("fake:demo", "other")
            app.leases.release("fake:demo", "other")
    asyncio.run(scenario())


def test_recovery_pauses_when_registry_snapshot_changes() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            store = JsonStore(f"{temp}/state.json"); geometry = FakeGeometryAdapter(); app = AgentApplication(store=store, geometry=geometry)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            run = await app.start_run(session_id=session.session_id, goal="pending")
            run.status = RunStatus.PAUSED; run.registry_version = "old-registry"; store.save_run(run)
            recovered = await app.recover_session(session.session_id)
            assert recovered["run"]["last_error"]["code"] == "REGISTRY_CHANGED"
    asyncio.run(scenario())


def test_tui_controller_consumes_events_without_store_access() -> None:
    from webcad_agent.domain.models import AgentEvent, EventType
    controller = TuiController()
    event = AgentEvent(session_id="s", sequence_number=1, event_type=EventType.MESSAGE_APPENDED,
                       actor="agent", correlation_id="s", payload={"message": {"content": "hello"}})
    snapshot = controller.consume(event)
    assert snapshot.last_sequence == 1 and snapshot.conversation == ["hello"]
    for width, height in ((80, 24), (120, 36)):
        rendered = controller.render_snapshot(width=width, height=height)
        assert len(rendered.splitlines()) == height
        assert all(len(line) == width for line in rendered.splitlines())


def test_context_pack_contains_bounded_observations_and_sources() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            store = JsonStore(f"{temp}/state.json"); app = AgentApplication(store=store, geometry=FakeGeometryAdapter())
            session = app.create_session(document_id="demo", gateway_origin="fake")
            run = await app.start_run(session_id=session.session_id, goal="inspect")
            app._emit(session.session_id, __import__("webcad_agent.domain.models", fromlist=["EventType"]).EventType.OBSERVATION_RECORDED,
                      run_id=run.run_id, payload={"value": 1})
            context = await app.build_context(run_id=run.run_id, user_input="inspect")
            assert context.observations == [{"value": 1}] and context.freshness["registry_version"] == app.registry.version
            assert any(item["name"] == "core.geometry.create_box_verified" for item in context.available_skills)
    asyncio.run(scenario())


def test_context_budget_fails_closed_when_mandatory_context_does_not_fit() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=FakeGeometryAdapter())
            session = app.create_session(document_id="demo", gateway_origin="fake")
            run = await app.start_run(session_id=session.session_id, goal="x" * 500)
            try:
                await app.build_context(run_id=run.run_id, user_input="y" * 500,
                                        requirements=__import__("webcad_agent.domain.models", fromlist=["ContextRequirements"]).ContextRequirements(
                                            include_goal=True, token_budget=20))
            except ContextBudgetExceeded:
                return
            raise AssertionError("mandatory context must not be silently truncated")
    asyncio.run(scenario())


def test_context_builder_honors_declared_views_and_pending_interaction() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            store = JsonStore(f"{temp}/state.json"); geometry = FakeGeometryAdapter()
            app = AgentApplication(store=store, geometry=geometry)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            run = await app.start_run(session_id=session.session_id, goal="wait")
            run.waiting_reason = "need-radius"; run.status = RunStatus.WAITING_USER; store.save_run(run)
            context = await app.build_context(
                run_id=run.run_id, user_input="continue", node_name="resolver",
                requirements=__import__("webcad_agent.domain.models", fromlist=["ContextRequirements"]).ContextRequirements(
                    include_goal=True, include_pending_interaction=True, document_views=["summary", "view", "properties"],
                    entity_refs=["body-1"], token_budget=2000))
            assert set(context.document) == {"summary", "view", "properties"}
            assert context.pending_interaction["reason"] == "need-radius"
            assert context.entity_refs == [{"ref": "body-1"}]
    asyncio.run(scenario())


def test_units_are_normalized_to_gateway_mm_and_degrees() -> None:
    assert parse_length("2 cm") == 20
    assert parse_length("1 in") == 25.4
    assert abs(parse_angle("3.141592653589793 rad") - 180) < 1e-9


def test_application_pauses_instead_of_blind_retry_on_unknown_outcome() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            geometry = FaultGeometryAdapter(timeout_after_mutation=True)
            store = JsonStore(f"{temp}/state.json"); app = AgentApplication(store=store, geometry=geometry)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            proposed = await app.propose_box(session_id=session.session_id, width=1, depth=1, height=1)
            result = await app.approve(proposed["run"]["run_id"])
            assert result["status"] == "outcome_unknown" and result["run"]["status"] == "paused"
    asyncio.run(scenario())


def test_translate_uses_before_after_center_verifier() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            store = JsonStore(f"{temp}/state.json"); geometry = FakeGeometryAdapter(); app = AgentApplication(store=store, geometry=geometry)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            box = await app.propose_box(session_id=session.session_id, width=2, depth=2, height=2, approve=True)
            translated = await app.propose_translate(session_id=session.session_id, reference=box["body_id"], dx=4, dy=-2, dz=1)
            assert translated["status"] == "approval_required"
            result = await app.approve(translated["run"]["run_id"])
            assert result["status"] == "completed" and result["verification"]["passed"]
    asyncio.run(scenario())


def test_tool_schema_is_enforced_before_any_gateway_call() -> None:
    schema = {"type": "object", "required": ["width"],
              "properties": {"width": {"type": "number", "exclusiveMinimum": 0}}}
    validate_input(schema, {"width": 1})
    for value in ({}, {"width": 0}, {"width": "1"}):
        try:
            validate_input(schema, value)
        except ToolInputError:
            pass
        else:
            raise AssertionError("invalid Tool input must be rejected")
    union = {"type": ["number", "string"]}
    validate_input(union, 1.0); validate_input(union, "10 mm")
    try:
        validate_input(union, True)
    except ToolInputError:
        pass
    else:
        raise AssertionError("boolean must not satisfy a number/string union")


def test_telemetry_span_is_safe_without_optional_dependency() -> None:
    with span("test", attributes={"run_id": "r"}):
        value = 1
    assert value == 1


def test_artifact_store_is_bounded_and_hashes_payloads() -> None:
    with __import__("tempfile").TemporaryDirectory() as temp:
        store = ArtifactStore(temp, max_bytes=1024)
        artifact = store.save(run_id="run-1", data=b"{}", name="gateway.json")
        assert artifact.size_bytes == 2 and artifact.sha256
        try:
            store.save(run_id="run-1", data=b"x" * 1025)
        except ValueError:
            pass
        else:
            raise AssertionError("oversized artifacts must be rejected")


def test_metrics_snapshot_is_structured() -> None:
    metrics = Metrics(); metrics.inc("run.completed"); metrics.observe("run.seconds", 1.5)
    snapshot = metrics.snapshot()
    assert snapshot["counters"]["run.completed"] == 1
    assert snapshot["timings"]["run.seconds"]["average"] == 1.5


def test_langgraph_react_runtime_is_bounded_and_checkpointed() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            checkpoint_path = __import__("pathlib").Path(temp) / "react.checkpoint"
            calls = 0
            async def decide(trace):
                return ReactDecision(kind="act", tool_name="read", arguments={})
            async def act(tool, args):
                nonlocal calls
                calls += 1
                return {"ok": True}
            async def observe(value):
                return value
            async def verify(value):
                return True
            runtime = LangGraphReAct(decide=decide, act=act, observe=observe, verify=verify,
                                     allowed_tools={"read"}, budget=ReactBudget(max_steps=2, max_tool_calls=2),
                                     checkpoint_path=checkpoint_path)
            result = await runtime.run({"goal": "inspect"}, thread_id="thread-1")
            from webcad_agent.react.langgraph_runtime import DurableMemorySaver
            reloaded = DurableMemorySaver(checkpoint_path)
            assert result["status"] == "completed" and calls == 1 and checkpoint_path.exists()
            assert reloaded.get_tuple({"configurable": {"thread_id": "thread-1"}}) is not None
    asyncio.run(scenario())


def test_action_hash_includes_success_criteria() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            store = JsonStore(f"{temp}/state.json")
            app = AgentApplication(store=store, geometry=FakeGeometryAdapter())
            session = app.create_session(document_id="demo", gateway_origin="fake")
            proposed = await app.propose_box(session_id=session.session_id, width=2, depth=2, height=2)
            action = store.get_action(proposed["action"]["action_id"])
            assert action.action_hash != __import__("webcad_agent.adapters.gateway", fromlist=["canonical_hash"]).canonical_hash({
                "run_id": action.run_id, "document_id": action.document_id, "tool": action.tool_name,
                "version": action.tool_version, "arguments": action.arguments,
                "expected_revision": action.expected_revision})
    asyncio.run(scenario())


def test_metadata_and_pattern_tools_use_explicit_ack_verification() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            geometry = FakeGeometryAdapter()
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=geometry)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            material = await app.propose_tool(
                session_id=session.session_id,
                tool_name="core.project.set_material",
                arguments={"name": "FR4", "category": "dielectric", "relativePermittivity": 4.3},
                approve=True,
            )
            assert material["status"] == "completed" and material["verification"]["passed"]
            assert geometry.materials["FR4"]["category"] == "dielectric"
            box = await app.propose_box(session_id=session.session_id, width=1, depth=1, height=1, approve=True)
            pattern = await app.propose_tool(
                session_id=session.session_id,
                tool_name="core.pattern.linear",
                arguments={"bodyId": box["body_id"], "count": 2, "spacing": "10 mm",
                           "directionX": 1, "directionY": 0, "directionZ": 0},
                approve=True,
            )
            assert pattern["status"] == "completed" and pattern["verification"]["passed"]
            assert app.registry.get("core.pattern.linear").parameter_units["spacing"] == "mm"
    asyncio.run(scenario())


def test_relation_tool_verifies_explicit_provenance() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            geometry = FakeGeometryAdapter()
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=geometry)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            first = await app.propose_box(session_id=session.session_id, width=1, depth=1, height=1, x=0, approve=True)
            second = await app.propose_box(session_id=session.session_id, width=1, depth=1, height=1, x=3, approve=True)
            result = await app.relation(session_id=session.session_id, body_a=first["body_id"],
                                        body_b=second["body_id"], tolerance=1e-6)
            assert result["status"] == "completed" and result["verification"]["passed"]
            assert result["relation"]["source"] == "aabb-derived"
    asyncio.run(scenario())


def test_natural_language_covers_detail_pattern_and_material_tools() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            geometry = FakeGeometryAdapter()
            app = AgentApplication(store=JsonStore(f"{temp}/state.json"), geometry=geometry)
            session = app.create_session(document_id="demo", gateway_origin="fake")
            box = await app.propose_box(session_id=session.session_id, width=2, depth=2, height=2, approve=True)
            fillet = await app.handle_prompt(session_id=session.session_id, text=f"fillet {box['body_id']} edge-1 radius 0.5 mm", approve=True)
            assert fillet["status"] == "completed" and fillet["verification"]["passed"]
            pattern = await app.handle_prompt(session_id=session.session_id, text=f"linear pattern {box['body_id']} count 2 spacing 5 mm", approve=True)
            assert pattern["status"] == "completed" and pattern["verification"]["passed"]
            material = await app.handle_prompt(session_id=session.session_id, text="set material Copper", approve=True)
            assert material["status"] == "completed" and material["verification"]["passed"]
    asyncio.run(scenario())


def test_otel_configuration_and_attribute_redaction() -> None:
    assert safe_attributes({"token": "secret", "run_id": "run-1", "count": 2}) == {
        "token": "[REDACTED]", "run_id": "run-1", "count": 2}
    result = configure_telemetry(exporter="none")
    assert result == {"enabled": False, "exporter": "none"}


def test_fault_adapter_covers_transport_worker_and_corrupt_response() -> None:
    async def scenario() -> None:
        with __import__("tempfile").TemporaryDirectory() as temp:
            from webcad_agent.testing.faults import FaultGeometryAdapter
            action = ActionEnvelope(run_id="fault", tool_name="primitive.box", document_id="d",
                                    arguments={"width": 1, "depth": 1, "height": 1}, side_effect="write",
                                    risk_level="medium", expected_revision=0, idempotency_key="fault-1",
                                    action_hash="fault-1", reason="fault")
            for kwargs, expected in [({"network_timeout": True}, TimeoutError),
                                     ({"worker_crash": True}, ConnectionError)]:
                adapter = FaultGeometryAdapter(**kwargs)
                try:
                    await adapter.execute(action)
                except expected:
                    pass
                else:
                    raise AssertionError("fault injector did not raise the requested transport error")
            corrupt = FaultGeometryAdapter(corrupt_response=True)
            result = await corrupt.execute(action)
            assert result.success and result.result["bodyId"] == "corrupted"
    asyncio.run(scenario())
