from __future__ import annotations

import asyncio
import json

import httpx

from webcad_agent.adapters.gateway import HttpGeometryAdapter
from webcad_agent.domain.models import ActionEnvelope, RiskLevel, SideEffect
from webcad_agent.llm.http_model import HttpJsonModel


def test_http_adapter_maps_action_and_caches_idempotency() -> None:
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True, "result": {"bodyId": "body-1", "revision": 2}})

    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://gateway")
        adapter = HttpGeometryAdapter("http://gateway", client=client)
        action = ActionEnvelope(run_id="run-1", tool_name="primitive.box", document_id="doc-1",
                                arguments={"width": 1, "depth": 2, "height": 3}, side_effect=SideEffect.WRITE,
                                risk_level=RiskLevel.MEDIUM, expected_revision=1, idempotency_key="key-1",
                                action_hash="hash-1", reason="test")
        first = await adapter.execute(action)
        second = await adapter.execute(action)
        await client.aclose()
        assert first.success and second.success
        assert len(calls) == 1
        assert calls[0]["operation"] == "primitive.box"

    asyncio.run(scenario())


def test_http_adapter_omits_unknown_base_revision() -> None:
    requests: list[dict] = []
    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True, "revision": 0})
    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://gateway")
        adapter = HttpGeometryAdapter("http://gateway", client=client)
        action = ActionEnvelope(run_id="r", tool_name="primitive.box", document_id="d", arguments={"width": 1, "depth": 1, "height": 1}, side_effect=SideEffect.WRITE, risk_level=RiskLevel.MEDIUM, idempotency_key="k", action_hash="h", reason="test")
        await adapter.preview(action)
        await client.aclose()
        assert "baseRevision" not in requests[0]

    asyncio.run(scenario())


def test_http_adapter_separates_flat_entity_inputs_from_parameters() -> None:
    requests: list[dict] = []
    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True, "result": {"bodyId": "body-1", "revision": 2}})
    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://gateway")
        adapter = HttpGeometryAdapter("http://gateway", client=client)
        action = ActionEnvelope(run_id="r", tool_name="transform.translate", document_id="d",
                                arguments={"bodyId": "body-1", "dx": 1, "dy": 2, "dz": 3},
                                side_effect=SideEffect.WRITE, risk_level=RiskLevel.MEDIUM,
                                idempotency_key="k", action_hash="h", reason="test")
        await adapter.execute(action)
        await client.aclose()
        assert requests[0]["inputs"] == {"bodyId": "body-1"}
        assert requests[0]["parameters"] == {"dx": 1, "dy": 2, "dz": 3}
    asyncio.run(scenario())


def test_http_adapter_reads_spatial_model_query() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/agent/model/query"
        assert request.url.params["kind"] == "body"
        return httpx.Response(200, json={"ok": True, "query": {"revision": 3, "spatial": {"status": "complete"}}})
    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://gateway")
        adapter = HttpGeometryAdapter("http://gateway", client=client)
        result = await adapter.model_query("d", kind="body", body_id="body-1")
        await client.aclose()
        assert result["query"]["spatial"]["status"] == "complete"
    asyncio.run(scenario())


def test_http_adapter_reads_exact_geometry_relation() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload["operation"] == "geometry.relation"
        assert payload["inputs"] == {"bodyA": "body-1", "bodyB": "body-2"}
        assert payload["parameters"]["tolerance"] == 1e-6
        return httpx.Response(200, json={"ok": True, "bodyA": "body-1", "bodyB": "body-2",
                                         "distance": 2.0, "tolerance": 1e-6, "relation": "disjoint",
                                         "commonVolume": 0.0, "source": "occt-brep", "exact": True})

    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://gateway")
        adapter = HttpGeometryAdapter("http://gateway", client=client)
        result = await adapter.relation("d", "body-1", "body-2")
        await client.aclose()
        assert result["source"] == "occt-brep" and result["exact"] is True

    asyncio.run(scenario())


def test_http_adapter_retries_bounded_read_only_requests() -> None:
    calls = 0
    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls < 3:
            return httpx.Response(503, json={"ok": False, "code": "TEMPORARY"})
        return httpx.Response(200, json={"ok": True, "revision": 4})
    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://gateway")
        adapter = HttpGeometryAdapter("http://gateway", client=client)
        result = await adapter.summary("d")
        await client.aclose()
        assert result["revision"] == 4 and calls == 3
    asyncio.run(scenario())


def test_http_adapter_batch_preserves_step_refs_and_observations() -> None:
    batches: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        batches.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True, "revision": 3, "results": [
            {"ok": True, "bodyId": "body-1", "revision": 1},
            {"ok": True, "bodyId": "body-2", "revision": 2},
        ]})

    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://gateway")
        adapter = HttpGeometryAdapter("http://gateway", client=client)
        actions = [
            ActionEnvelope(run_id="r", tool_name="primitive.cylinder", document_id="d", arguments={"radius": 2, "height": 3}, side_effect=SideEffect.WRITE, risk_level=RiskLevel.MEDIUM, expected_revision=0, idempotency_key="a", action_hash="a", reason="a", step_id="outer"),
            ActionEnvelope(run_id="r", tool_name="boolean.cut", document_id="d", arguments={"targetBody": {"$ref": "outer.body_id"}, "toolBody": "body-2"}, side_effect=SideEffect.WRITE, risk_level=RiskLevel.HIGH, expected_revision=0, idempotency_key="b", action_hash="b", reason="b", step_id="cut"),
        ]
        observations = await adapter.execute_batch(actions)
        await client.aclose()
        assert len(observations) == 2 and all(item.success for item in observations)
        assert batches[0]["steps"][0]["stepId"] == "outer"
        assert batches[0]["steps"][1]["inputs"]["targetBody"]["$ref"] == "outer.body_id"

    asyncio.run(scenario())


def test_provider_neutral_http_model_adapter() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"model": "test", "content": "{\"ok\":true}", "request_id": "req-1"})
    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        model = HttpJsonModel("http://model", client=client)
        response = await model.complete(system="s", user="u", response_schema={"type": "object"}, context={})
        await client.aclose()
        assert response.model == "test" and response.content == '{"ok":true}'
    asyncio.run(scenario())
