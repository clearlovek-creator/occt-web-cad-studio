import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";
import { ProviderStore, assertProviderUrl, selectProvider } from "../gateway/llm/provider-config.mjs";
import { requestModelingPlan, streamModelingPlan, requestCadToolTurn } from "../gateway/llm/openai-compatible-client.mjs";
import { validateModelingPlan } from "../gateway/llm/plan-validator.mjs";
import { toolCallsToModelingPlan } from "../gateway/llm/cad-tools.mjs";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-agent-provider-"));
const boxArgs = { width: "10 mm", depth: "20 mm", height: "30 mm" };
const toolMessage = { choices: [{ message: { tool_calls: [{ function: { name: "create_box", arguments: JSON.stringify(boxArgs) } }] } }] };
const responsesToolMessage = { output: [{ type: "function_call", name: "create_box", arguments: JSON.stringify(boxArgs) }] };
let servers = [];
after(() => { servers.forEach((server) => server.close()); fs.rmSync(dataDir, { recursive: true, force: true }); });

async function listen(server, port) { await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)); servers.push(server); }

test("ProviderStore encrypts API keys and forces CAD Tool Calling", () => {
  const store = new ProviderStore(dataDir);
  store.save({ id: "mock", name: "Mock", baseUrl: "http://127.0.0.1:9911", model: "mock-model", protocol: "auto", toolCalling: false, apiKey: "secret-api-key" });
  assert.equal(store.list()[0].apiKeyConfigured, true);
  assert.equal(store.list()[0].toolCalling, true);
  assert.equal(store.list()[0].apiKey, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(dataDir, "agent-providers.enc"), "utf8"), /secret-api-key/);
  assert.throws(() => assertProviderUrl("http://127.0.0.1:9911"), /Private provider URLs/);
  assert.doesNotThrow(() => assertProviderUrl("http://127.0.0.1:9911", { allowPrivate: true }));
});

test("falls back to curl when Node HTTPS is blocked by the firewall", async () => {
  const originalFetch = globalThis.fetch;
  const originalTransport = process.env.AGENT_HTTP_TRANSPORT;
  const originalCurlPath = process.env.AGENT_CURL_PATH;
  const curlPath = path.join(dataDir, "fake-curl.cmd");
  fs.writeFileSync(curlPath, "@echo off\r\necho {\"choices\":[{\"message\":{\"tool_calls\":[{\"function\":{\"name\":\"create_box\",\"arguments\":\"{\\\"width\\\":\\\"1 mm\\\",\\\"depth\\\":\\\"1 mm\\\",\\\"height\\\":\\\"1 mm\\\"}\"}}]}}]}\r\necho __OCCT_HTTP_STATUS__:200\r\n", "utf8");
  globalThis.fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "EACCES" } }); };
  process.env.AGENT_HTTP_TRANSPORT = "auto";
  process.env.AGENT_CURL_PATH = curlPath;
  try {
    const result = await requestCadToolTurn({ baseUrl: "https://api.example.test", apiKey: "key", model: "mock", protocol: "chat-completions", toolCalling: true }, "create box", "system", { timeoutMs: 2000 });
    assert.equal(result.toolCalls[0].name, "create_box");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTransport === undefined) delete process.env.AGENT_HTTP_TRANSPORT; else process.env.AGENT_HTTP_TRANSPORT = originalTransport;
    if (originalCurlPath === undefined) delete process.env.AGENT_CURL_PATH; else process.env.AGENT_CURL_PATH = originalCurlPath;
    fs.rmSync(curlPath, { force: true });
  }
});
test("OpenAI-compatible Responses, Chat Completions and SSE use CAD tools only", async () => {
  process.env.AGENT_ALLOW_PRIVATE_URL = "true";
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body || "{}");
      assert.ok(Array.isArray(payload.tools));
      assert.equal(Object.prototype.hasOwnProperty.call(payload, "tool_choice"), false);
      const streaming = payload.stream === true;
      if (streaming) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const event = { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "create_box", arguments: JSON.stringify(boxArgs) } }] } }] };
        response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end("data: [DONE]\n\n");
      } else {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(request.url === "/v1/responses" ? responsesToolMessage : toolMessage));
      }
    });
  });
  await listen(server, 9911);
  const config = { baseUrl: "http://127.0.0.1:9911", apiKey: "key", model: "mock", protocol: "auto", toolCalling: true };
  const responses = await requestModelingPlan(config, "create box", "system", { timeoutMs: 2000 });
  assert.equal(responses.protocol, "responses");
  assert.equal(responses.plan.toolCalls[0].name, "create_box");
  const chat = await requestModelingPlan({ ...config, protocol: "chat-completions" }, "create box", "system", { timeoutMs: 2000 });
  assert.equal(chat.plan.toolCalls[0].name, "create_box");
  const streamed = await streamModelingPlan({ ...config, protocol: "chat-completions" }, "create box", "system", { timeoutMs: 2000 });
  assert.equal(streamed.plan.toolCalls[0].name, "create_box");
});

test("Tool Calling sends structured conversation history to Chat Completions", async () => {
  let captured = null;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      captured = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(toolMessage));
    });
  });
  await listen(server, 9915);
  await requestCadToolTurn({ baseUrl: "http://127.0.0.1:9915", apiKey: "key", model: "mock", protocol: "chat-completions", toolCalling: true }, "", "system", {
    timeoutMs: 2000,
    omitPrompt: true,
    history: [
      { role: "tool", content: "orphaned result", toolCallId: "missing-call", toolName: "create_box" },
      { role: "user", content: "create a box" },
      { role: "assistant", content: "", toolCallId: "call-1", toolName: "create_box", toolArguments: boxArgs },
      { role: "tool", content: JSON.stringify({ ok: true, revision: 1 }), toolCallId: "call-1", toolName: "create_box" },
    ],
  });
  assert.deepEqual(captured.messages.slice(1).map((message) => message.role), ["user", "assistant", "tool"]);
  assert.equal(captured.messages[2].tool_calls[0].function.name, "create_box");
  assert.equal(captured.messages[3].tool_call_id, "call-1");
  await requestCadToolTurn({ baseUrl: "http://127.0.0.1:9915", apiKey: "key", model: "mock", protocol: "chat-completions", toolCalling: true }, "", "system", {
    timeoutMs: 2000,
    omitPrompt: true,
    history: [{ role: "assistant", content: "unfinished tool call", toolCallId: "unfinished", toolName: "create_box", toolArguments: boxArgs }],
  });
  const unfinished = captured.messages.find((message) => message.content === "unfinished tool call");
  assert.equal(Object.prototype.hasOwnProperty.call(unfinished, "tool_calls"), false);
  assert.equal(captured.messages.some((message) => message.role === "tool"), false);
  await requestCadToolTurn({ baseUrl: "http://127.0.0.1:9915", apiKey: "key", model: "mock", protocol: "chat-completions", toolCalling: true }, "", "system", {
    timeoutMs: 2000,
    omitPrompt: true,
    history: [
      { role: "assistant", content: "first", toolCallId: "call-1", toolName: "create_box", toolArguments: boxArgs },
      { role: "assistant", content: "second", toolCallId: "call-2", toolName: "create_box", toolArguments: boxArgs },
      { role: "tool", content: "result-1", toolCallId: "call-1", toolName: "create_box" },
      { role: "tool", content: "result-2", toolCallId: "call-2", toolName: "create_box" },
    ],
  });
  assert.deepEqual(captured.messages.slice(1).map((message) => message.role), ["assistant", "tool", "tool"]);
  assert.equal(captured.messages[1].tool_calls.length, 2);
  assert.equal(captured.messages[2].tool_call_id, "call-1");
  assert.equal(captured.messages[3].tool_call_id, "call-2");
});
test("Preserves DeepSeek reasoning_content across Tool Calling turns", async () => {
  let captured = null;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      captured = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { reasoning_content: "model internal reasoning", tool_calls: [{ id: "call-reasoning", function: { name: "create_box", arguments: JSON.stringify(boxArgs) } }] } }] }));
    });
  });
  await listen(server, 0);
  const port = server.address().port;
  const result = await requestCadToolTurn({ baseUrl: "http://127.0.0.1:" + port, apiKey: "key", model: "mock", protocol: "chat-completions", toolCalling: true }, "", "system", {
    timeoutMs: 2000,
    omitPrompt: true,
    history: [
      { role: "user", content: "create a box" },
      { role: "assistant", content: "Tool call: create_box", toolCallId: "call-reasoning", toolName: "create_box", toolArguments: boxArgs, reasoningContent: "model internal reasoning" },
      { role: "tool", content: JSON.stringify({ ok: true, revision: 1 }), toolCallId: "call-reasoning", toolName: "create_box" },
    ],
  });
  assert.equal(result.toolCalls[0].reasoningContent, "model internal reasoning");
  const assistant = captured.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.reasoning_content, "model internal reasoning");
});
test("CAD Tool plans execute Boolean operations without confirmation", () => {
  const plan = toolCallsToModelingPlan([{ name: "boolean_cut", arguments: { targetBody: "body-7", toolBody: "body-9" } }]);
  assert.equal(plan.risk, "none");
  assert.equal(plan.steps[0].risk, "none");
});

test("LLM plan validator rejects unsafe operations", () => {
  assert.throws(() => validateModelingPlan({ summary: "bad", risk: "none", questions: [], steps: [{ operation: "shell.exec", inputs: {}, parameters: {}, explanation: "bad" }] }), /not allowed/);
  const plan = validateModelingPlan({ summary: "cut", risk: "none", questions: [], steps: [{ operation: "boolean.cut", inputs: {}, parameters: {}, explanation: "cut" }] });
  assert.equal(plan.status, "ready");
});

test("LLM plan validator accepts tool-style operation objects", () => {
  const plan = validateModelingPlan({ summary: "delete selected body", risk: "confirmation", questions: [], steps: [{ operation: { name: "body.delete", arguments: { bodyId: "body-5" } }, parameters: {}, explanation: "delete" }] });
  assert.equal(plan.steps[0].operation, "body.delete");
  assert.equal(plan.steps[0].request.inputs.bodyId, "body-5");
  assert.equal(plan.status, "ready");
});

test("selects an enabled Provider by explicit id, default id and priority", () => {
  const providers = [
    { id: "low", enabled: true, priority: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "high", enabled: true, priority: 8, updatedAt: "2026-01-02T00:00:00.000Z" },
    { id: "off", enabled: false, priority: 100, updatedAt: "2026-01-03T00:00:00.000Z" },
  ];
  assert.equal(selectProvider(providers, { providerId: "low" }).id, "low");
  assert.equal(selectProvider(providers, { defaultProviderId: "low" }).id, "low");
  assert.equal(selectProvider(providers).id, "high");
});

test("rejects prose and retries Tool Calling without switching to JSON or local parsing", async () => {
  let calls = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => { calls += 1; response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ choices: [{ message: { content: "好的，我看到当前模型了。" } }] })); });
  });
  await listen(server, 9913);
  await assert.rejects(() => requestModelingPlan({ baseUrl: "http://127.0.0.1:9913", apiKey: "key", model: "mock", protocol: "chat-completions", toolCalling: true }, "create box", "system", { timeoutMs: 2000 }), /no CAD tool calls/);
  assert.equal(calls, 2);
});

test("parses and converts a CAD tool call", async () => {
  const server = http.createServer((request, response) => { request.resume(); request.on("end", () => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(toolMessage)); }); });
  await listen(server, 9914);
  const result = await requestModelingPlan({ baseUrl: "http://127.0.0.1:9914", apiKey: "key", model: "mock", protocol: "chat-completions", toolCalling: true }, "create box", "system", { timeoutMs: 2000 });
  assert.equal(result.plan.toolCalls[0].name, "create_box");
});
test("Provider health opens after transient failures and recovers half-open", async () => {
  const { ProviderHealthRegistry, ProviderCircuitOpenError } = await import("../gateway/llm/provider-health.mjs");
  const registry = new ProviderHealthRegistry({ failureThreshold: 2, cooldownMs: 20 });
  const provider = { id: "unstable" };
  registry.failure(provider, new Error("fetch failed"));
  registry.failure(provider, new Error("timeout"));
  assert.equal(registry.snapshot("unstable").status, "open");
  assert.throws(() => registry.assertAvailable(provider), (error) => error instanceof ProviderCircuitOpenError);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(registry.choose([provider])?.id, "unstable");
  registry.assertAvailable(provider);
  registry.success(provider);
  assert.equal(registry.snapshot("unstable").status, "closed");
});

test("Provider health ignores deterministic protocol errors", async () => {
  const { ProviderHealthRegistry } = await import("../gateway/llm/provider-health.mjs");
  const registry = new ProviderHealthRegistry({ failureThreshold: 1, cooldownMs: 10 });
  const provider = { id: "protocol" };
  registry.failure(provider, new Error("LLM returned invalid JSON"));
  assert.equal(registry.snapshot("protocol").status, "closed");
});
test("LLM request body stays within the history budget", async () => {
  let bytes = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      bytes = Buffer.byteLength(body, "utf8");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(toolMessage));
    });
  });
  await listen(server, 0);
  const port = server.address().port;
  await requestCadToolTurn({ baseUrl: "http://127.0.0.1:" + port, apiKey: "key", model: "mock", protocol: "chat-completions", toolCalling: true }, "", "system", {
    timeoutMs: 2000,
    omitPrompt: true,
    history: Array.from({ length: 240 }, (_, index) => ({ role: "user", content: "long context " + index + " " + "x".repeat(6000) })),
  });
  assert.ok(bytes < 512_000, "request body exceeded the configured budget");
});
