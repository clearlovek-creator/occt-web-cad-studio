import json
import unittest

import httpx

from modeling_agent.adapters.llm import OpenAICompatibleModel


class OpenAICompatibleModelTests(unittest.TestCase):
    def test_maps_tool_call_and_structured_json_response(self) -> None:
        requests: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(json.loads(request.read().decode("utf-8")))
            if len(requests) == 1:
                return httpx.Response(
                    200,
                    json={
                        "choices": [
                            {
                                "message": {
                                    "role": "assistant",
                                    "tool_calls": [
                                        {
                                            "id": "call-1",
                                            "type": "function",
                                            "function": {"name": "calculate", "arguments": '{"x": 1}'},
                                        }
                                    ],
                                }
                            }
                        ]
                    },
                )
            return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": true}'}}]})

        model = OpenAICompatibleModel("http://model.test/v1", api_key="secret", model="test")
        model.client.close()
        model.client = httpx.Client(base_url="http://model.test/v1", transport=httpx.MockTransport(handler))
        first = model.complete([{"role": "user", "content": {"goal": "x"}}], [{"name": "calculate"}])
        second = model.complete(
            [
                {"role": "user", "content": {"goal": "x"}},
                {"role": "assistant", "content": "", "tool_calls": [{"id": "call-1", "name": "calculate", "arguments": {"x": 1}}]},
                {"role": "tool", "name": "calculate", "tool_call_id": "call-1", "content": {"value": 2}},
            ],
            [],
        )
        self.assertEqual(first.tool_calls[0].id, "call-1")
        self.assertEqual(first.tool_calls[0].arguments, {"x": 1})
        self.assertEqual(second.structured_output, {"ok": True})
        self.assertEqual(requests[0]["tools"][0]["type"], "function")
        model.close()

    def test_retries_transient_model_timeout(self) -> None:
        model = OpenAICompatibleModel("http://model.test/v1", api_key=None, model="test", retry_attempts=2, retry_backoff_seconds=0)
        request = httpx.Request("POST", "http://model.test/v1/chat/completions")
        response = httpx.Response(
            200,
            request=request,
            json={"choices": [{"message": {"content": '{"ok": true}'}}]},
        )
        calls = {"count": 0}

        def post(*args, **kwargs):
            calls["count"] += 1
            if calls["count"] == 1:
                raise httpx.ReadTimeout("simulated timeout", request=request)
            return response

        model.client.post = post  # type: ignore[method-assign]
        result = model.complete([], [])
        self.assertEqual(calls["count"], 2)
        self.assertEqual(result.structured_output, {"ok": True})


if __name__ == "__main__":
    unittest.main()
