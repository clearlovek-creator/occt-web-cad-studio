import unittest
import json

import httpx

from modeling_agent.adapters.http_geometry import HttpGeometryAdapter
from modeling_agent.domain.models import ActionRequest, RiskLevel, SideEffect
from modeling_agent.execution.service import canonical_hash


class HttpGeometryAdapterTests(unittest.TestCase):
    def test_idempotent_write_retries_a_transient_transport_error(self) -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise httpx.ReadTimeout("simulated timeout", request=request)
            body = request.read().decode("utf-8")
            if "document.summary" in body:
                return httpx.Response(200, json={"ok": True, "revision": 0})
            return httpx.Response(200, json={"ok": True, "revision": 1, "result": {"body": {"body_id": "body-1"}}})

        adapter = HttpGeometryAdapter("http://gateway.test", retry_attempts=2)
        adapter.client.close()
        adapter.client = httpx.Client(base_url="http://gateway.test", transport=httpx.MockTransport(handler))
        arguments = {"document_id": "doc-1", "width_m": 0.1, "depth_m": 0.1, "height_m": 0.0016}
        action = ActionRequest(
            action_id="act-retry",
            run_id="run-retry",
            tool_name="geometry.create_box",
            arguments=arguments,
            side_effect=SideEffect.WRITE,
            risk_level=RiskLevel.MEDIUM,
            expected_document_revision=0,
            idempotency_key="run-retry:key",
            reason="retry test",
            action_hash=canonical_hash("geometry.create_box", arguments),
        )
        observation = adapter.execute(action)
        self.assertTrue(observation.success)
        self.assertEqual(attempts, 2)
        adapter.close()

    def test_gateway_protocol_mapping(self) -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.path == "/api/commands":
                body = request.read().decode("utf-8")
                if "document.summary" in body:
                    return httpx.Response(200, json={"ok": True, "revision": 3})
                return httpx.Response(200, json={"ok": True, "revision": 4, "result": {"body": {"body_id": "body-1"}}})
            return httpx.Response(404)

        adapter = HttpGeometryAdapter("http://gateway.test")
        adapter.client.close()
        adapter.client = httpx.Client(
            base_url="http://gateway.test",
            transport=httpx.MockTransport(handler),
        )
        self.assertEqual(adapter.current_revision("doc-1"), 3)
        arguments = {
            "document_id": "doc-1",
            "width_m": 0.1,
            "depth_m": 0.1,
            "height_m": 0.0016,
        }
        action = ActionRequest(
            action_id="act-1",
            run_id="run-1",
            tool_name="geometry.create_box",
            arguments=arguments,
            side_effect=SideEffect.WRITE,
            risk_level=RiskLevel.MEDIUM,
            expected_document_revision=3,
            idempotency_key="run-1:key",
            reason="test",
            action_hash=canonical_hash("geometry.create_box", arguments),
        )
        observation = adapter.execute(action)
        self.assertTrue(observation.success)
        self.assertEqual(observation.after_revision, 4)
        self.assertEqual(len(requests), 2)
        adapter.close()

    def test_gateway_undo_mapping_is_revision_aware(self) -> None:
        requests: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.read().decode("utf-8"))
            requests.append(payload)
            return httpx.Response(200, json={"ok": True, "revision": 0, "bodyCount": 0})

        adapter = HttpGeometryAdapter("http://gateway.test")
        adapter.client.close()
        adapter.client = httpx.Client(base_url="http://gateway.test", transport=httpx.MockTransport(handler))
        result = adapter.undo("doc-undo", 1, "rollback-key")
        self.assertTrue(result.success)
        self.assertEqual(result.before_revision, 1)
        self.assertEqual(result.after_revision, 0)
        self.assertEqual(requests[0]["operation"], "document.undo")
        self.assertEqual(requests[0]["options"]["idempotencyKey"], "rollback-key")
        adapter.close()


if __name__ == "__main__":
    unittest.main()
