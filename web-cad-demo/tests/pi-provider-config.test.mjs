import assert from "node:assert/strict";
import test from "node:test";
import { buildPiProviderConfig } from "../gateway/pi-provider-config.mjs";

test("existing OpenAI-compatible settings map to Pi models without writing API keys into models.json", () => {
  const { models, environment } = buildPiProviderConfig([{ id: "deepseek-main", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-v4-flash", protocol: "chat-completions", apiKey: "secret-value", enabled: true }]);
  const text = JSON.stringify(models);
  assert.equal(models.providers["deepseek-main"].baseUrl, "https://api.deepseek.com/v1");
  assert.equal(models.providers["deepseek-main"].api, "openai-completions");
  assert.equal(models.providers["deepseek-main"].models[0].id, "deepseek-v4-flash");
  assert.equal(text.includes("secret-value"), false);
  assert.deepEqual(environment, { PI_CAD_PROVIDER_DEEPSEEK_MAIN_API_KEY: "secret-value" });
});

test("Pi provider config skips disabled or incomplete endpoints and maps Responses protocol", () => {
  const result = buildPiProviderConfig([
    { id: "off", name: "Disabled", baseUrl: "https://example.com/v1", model: "model", enabled: false },
    { id: "missing", name: "No model", baseUrl: "https://example.com/v1", enabled: true },
    { id: "resp", name: "Responses", baseUrl: "https://example.com/v1/responses", model: "m1", protocol: "responses", apiKey: "k", enabled: true },
  ]);
  assert.deepEqual(Object.keys(result.models.providers), ["resp"]);
  assert.equal(result.models.providers.resp.api, "openai-responses");
  assert.equal(result.models.providers.resp.models[0].baseUrl, "https://example.com/v1");
});
