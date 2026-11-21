import assert from "node:assert/strict";
import { test } from "node:test";
import { describeProviderError } from "../gateway/llm/openai-compatible-client.mjs";

test("describes unreachable LLM providers with the endpoint and recovery hint", () => {
  const error = describeProviderError(new TypeError("fetch failed"), "https://api.deepseek.com/v1/chat/completions");
  assert.match(error.message, /api\.deepseek\.com\/v1\/chat\/completions/);
  assert.match(error.message, /网络|代理|防火墙/);
});
