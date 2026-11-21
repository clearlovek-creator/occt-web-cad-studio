import assert from "node:assert/strict";
import {stopTestChild} from './helpers/stop-test-child.mjs';
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatewayPort = 8840;
const llmPort = 9912;
const api = `http://127.0.0.1:${gatewayPort}/api`;
const dataDir = path.join(os.tmpdir(), `occt-agent-gateway-${process.pid}-${Date.now()}`);
const planJson = JSON.stringify({ summary: "box from LLM", risk: "none", questions: [], steps: [{ operation: "primitive.box", inputs: {}, parameters: { width: "10 mm", depth: "20 mm", height: "30 mm" }, explanation: "box" }] });
const bodyCreatePlanJson = JSON.stringify({ summary: "box alias from LLM", risk: "none", questions: [], steps: [{ operation: "body.create", inputs: {}, parameters: { width: "11 mm", depth: "21 mm", height: "31 mm" }, explanation: "box alias" }] });
const deletePlanJson = JSON.stringify({ summary: "delete body", risk: "confirmation", questions: [], steps: [{ operation: { name: "body.delete", arguments: { bodyId: "Box5" } }, parameters: {}, explanation: "delete" }] });
const materialPlanJson = JSON.stringify({ summary: "assign material", risk: "none", questions: [], steps: [{ operation: "body.material", inputs: {}, parameters: { material: "FR4" }, explanation: "assign material" }] });
const staleDeletePlanJson = JSON.stringify({ summary: "delete stale body", risk: "confirmation", questions: [], steps: [{ operation: "body.delete", inputs: { bodyId: "body-11" }, parameters: {}, explanation: "delete stale body" }] });
let gateway;
let llm;
let lastLlmBody = "";
let retryLlmCalls = 0;
let atomicBatchCalls = 0;

before(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  llm = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      lastLlmBody = body;
      const payload = JSON.parse(body || "{}");
      const streaming = payload.stream === true;
      const call = (name, args) => ({ choices: [{ message: { reasoning_content: "mock reasoning", tool_calls: [{ id: `mock-${name}`, function: { name, arguments: JSON.stringify(args) } }] } }] });
      const finalText = { choices: [{ message: { content: "Agent loop completed." } }] };
      const multiCall = { choices: [{ message: { tool_calls: [{ id: "mock-batch-box-1", function: { name: "create_box", arguments: JSON.stringify({ width: "2 mm", depth: "2 mm", height: "2 mm" }) } }, { id: "mock-batch-box-2", function: { name: "create_box", arguments: JSON.stringify({ width: "3 mm", depth: "3 mm", height: "3 mm" }) } }] } }] };
      const toolArgs = body.includes("body alias") ? ["create_box", { width: "11 mm", depth: "21 mm", height: "31 mm" }]
        : body.includes("delete Box5") ? ["delete_body", { bodyId: "Box5" }]
          : body.includes("delete stale") ? ["delete_body", { bodyId: "body-11" }]
            : body.includes("agent confirm delete") ? ["delete_body", { bodyId: "body-1" }]
            : body.includes("assign material") ? ["assign_material", { bodyId: "body-5", material: "FR4" }]
              : body.includes("cad tool stream") ? ["create_box", { width: "13 mm", depth: "23 mm", height: "33 mm" }]
                : body.includes("cad tool box") ? ["create_box", { width: "12 mm", depth: "22 mm", height: "32 mm" }]
                                  : body.includes("agent loop invalid") && body.includes("Unknown CAD tool") ? ["create_box", { width: "14 mm", depth: "24 mm", height: "34 mm" }]
                                    : body.includes("agent loop invalid") ? ["unknown_tool", {}]
                                      : ["create_box", { width: "10 mm", depth: "20 mm", height: "30 mm" }];
      const sendTool = () => {
        if (body.includes("atomic batch")) {
          atomicBatchCalls += 1;
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(multiCall));
          return;
        }
        if (atomicBatchCalls > 0 && !body.includes("atomic batch")) {
          atomicBatchCalls = 0;
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(finalText));
          return;
        }
        if ((body.includes('"tool_call_id":"mock-create_box"') || body.includes('"tool_call_id":"mock-delete_body"') || body.includes('"tool_call_id":"mock-batch-box-1"') || body.includes('"tool_call_id":"mock-batch-box-2"')) && (!body.includes("agent loop invalid") || body.includes("14 mm"))) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(finalText));
          return;
        }
        if (body.includes("Current mode is PLAN") && body.includes("agent loop plan")) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(call("query_model", { kind: "geometry-tree", bodyId: null, featureId: null })));
          return;
        }
        const [name, args] = toolArgs;
        if (streaming) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`);
          response.end("data: [DONE]\n\n");        } else {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(call(name, args)));
        }
      };
      if (body.includes("retry transient") && retryLlmCalls++ === 0) { setTimeout(sendTool, 200); return; }
      sendTool();
    });
  });
  await new Promise((resolve) => llm.listen(llmPort, "127.0.0.1", resolve));  gateway = spawn(process.execPath, [path.join(root, "gateway", "server.mjs")], { cwd: root, env: { ...process.env, GEOMETRY_PORT: String(gatewayPort), GEOMETRY_DATA_DIR: dataDir, AGENT_ALLOW_PRIVATE_URL: "true", AGENT_REQUEST_TIMEOUT_MS: "100", AGENT_RETRY_ATTEMPTS: "2", AGENT_RETRY_DELAY_MS: "10" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("gateway startup timed out")), 10000); gateway.stdout.setEncoding("utf8"); gateway.stderr.setEncoding("utf8"); gateway.stdout.on("data", (chunk) => { if (chunk.includes("Geometry gateway ready")) { clearTimeout(timer); resolve(); } }); gateway.stderr.on("data", (chunk) => { if (chunk.includes("Error")) { clearTimeout(timer); reject(new Error(chunk)); } }); gateway.once("error", reject); });
});
after(async () => { await stopTestChild(gateway); llm?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
async function request(pathname, body, options = {}) {
  const response = await fetch(`${api}${pathname}`, { method: options.method || "POST", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, payload: await response.json() };
}

test("Gateway manages providers without returning API keys", async () => {
  const saved = await request("/agent/providers", { id: "mock", name: "Mock LLM", baseUrl: `http://127.0.0.1:${llmPort}`, model: "mock-model", protocol: "chat-completions", apiKey: "secret-key" });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.provider.apiKey, undefined);
  const tested = await request("/agent/providers/mock/test", {});
  assert.equal(tested.response.status, 200, JSON.stringify(tested.payload));
  const listed = await request("/agent/providers", undefined, { method: "GET" });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.payload.providers[0].apiKeyConfigured, true);
});

test("Gateway normalizes body.create aliases before validation", async () => {
  const result = await request("/agent/plan", { providerId: "mock", prompt: "body alias", context: { revision: 0 } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.plan.steps[0].operation, "primitive.box");
  assert.deepEqual(result.payload.plan.steps[0].request.parameters, { width: "11 mm", depth: "21 mm", height: "31 mm" });
});

test("Gateway converts CAD tool calls into a validated modeling plan", async () => {
  const saved = await request("/agent/providers", { id: "mock-tools", name: "Mock CAD Tools", baseUrl: `http://127.0.0.1:${llmPort}`, model: "mock-model", protocol: "chat-completions", toolCalling: true, apiKey: "secret-key" });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  const result = await request("/agent/plan", { providerId: "mock-tools", prompt: "cad tool box", context: { revision: 0 } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.plan.steps[0].operation, "primitive.box");
  assert.deepEqual(result.payload.plan.steps[0].request.parameters, { width: "12 mm", depth: "22 mm", height: "32 mm" });
});

test("Gateway streams CAD tool calls into a validated plan", async () => {
  const response = await fetch(`${api}/agent/plan/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: "mock-tools", prompt: "cad tool stream", context: { revision: 0 } }) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.match(text, /event: plan/);
});

test("Gateway creates a validated plan and streams a validated plan", async () => {
  const result = await request("/agent/plan", { providerId: "mock", prompt: "create a box", context: { revision: 0 } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.plan.steps[0].operation, "primitive.box");
  const audit = await request("/agent/audit?documentId=default", undefined, { method: "GET" });
  assert.equal(audit.response.status, 200);
  assert.ok(audit.payload.events.some((event) => event.type === "agent.plan.generated" && event.providerId === "mock"));
  const streamResponse = await fetch(`${api}/agent/plan/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: "mock", prompt: "create a box" }) });
  const streamText = await streamResponse.text();
  assert.equal(streamResponse.status, 200);
  assert.match(streamText, /event: plan/);
  assert.match(streamText, /primitive.box/);
});

test("Gateway retries a transient upstream timeout once", async () => {
  retryLlmCalls = 0;
  const result = await request("/agent/plan", { providerId: "mock", prompt: "retry transient", context: { revision: 0 } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(retryLlmCalls, 2);
});
test("Gateway persists Agent conversations and exposes a compact model query", async () => {
  const documentId = "agent_query_document";
  const created = await request("/agent/conversations", { documentId, title: "几何查询会话" });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const conversationId = created.payload.conversation.id;
  const appended = await request(`/agent/conversations/${conversationId}/messages`, { documentId, message: { role: "user", content: "查询当前几何树", revision: 0, entityRefs: [{ kind: "body", id: "body-1", label: "Box1" }] } });
  assert.equal(appended.response.status, 201, JSON.stringify(appended.payload));
  assert.equal(appended.payload.conversation.messages.length, 1);
  const loaded = await request(`/agent/conversations/${conversationId}?documentId=${documentId}`, undefined, { method: "GET" });
  assert.equal(loaded.payload.conversation.messages[0].entityRefs[0].id, "body-1");
  const activePlan = { planId: "plan-persisted", prompt: "create a box", allowed: true, status: "needs-input", steps: [], questions: [{ questionId: "question-1", fieldPath: "parameters.width", prompt: "width?" }] };
  const savedState = await request(`/agent/conversations/${conversationId}/state`, { documentId, activePlan, pendingPrompt: "create a box" });
  assert.equal(savedState.response.status, 200, JSON.stringify(savedState.payload));
  assert.equal(savedState.payload.conversation.activePlan.planId, "plan-persisted");
  assert.equal(savedState.payload.conversation.pendingPrompt, "create a box");
  const restored = await request(`/agent/conversations/${conversationId}?documentId=${documentId}`, undefined, { method: "GET" });
  assert.equal(restored.payload.conversation.activePlan.status, "needs-input");
  assert.equal(restored.payload.conversation.pendingPrompt, "create a box");
  const deleted = await request(`/agent/conversations/${conversationId}?documentId=${documentId}`, undefined, { method: "DELETE" });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
  const listedAfterDelete = await request(`/agent/conversations?documentId=${documentId}`, undefined, { method: "GET" });
  assert.equal(listedAfterDelete.payload.conversations.some((item) => item.id === conversationId), false);
  const createdBody = await request("/commands", { operation: "primitive.box", documentId, parameters: { width: 10, depth: 20, height: 30 } });
  assert.equal(createdBody.response.status, 200, JSON.stringify(createdBody.payload));
  const query = await request("/agent/model/query", { documentId, kind: "geometry-tree" });
  assert.equal(query.response.status, 200, JSON.stringify(query.payload));
  assert.equal(query.payload.query.project.bodyCount, 1);
  assert.equal(query.payload.query.bodies[0].featureIds.length, 1);
  assert.equal(query.payload.query.bodies[0].positions, undefined);
  assert.deepEqual(query.payload.query.bodies[0].spatial.bounds, { min: [0, 0, 0], max: [10, 20, 30] });
  assert.deepEqual(query.payload.query.bodies[0].spatial.center, [5, 10, 15]);
  assert.deepEqual(query.payload.query.bodies[0].spatial.size, [10, 20, 30]);
  assert.deepEqual([...query.payload.query.bodies[0].spatial.obb.halfSizes].sort((a, b) => a - b), [5, 10, 15]);
  assert.ok(["occt-brep-obb", "occt-legacy-obb", "aabb-derived"].includes(query.payload.query.bodies[0].spatial.obb.source));
  assert.equal(query.payload.query.bodies[0].spatial.obb.exact, query.payload.query.bodies[0].spatial.obb.source === "occt-exact");
  assert.deepEqual(query.payload.query.spatial.bounds, { min: [0, 0, 0], max: [10, 20, 30] });
  assert.equal(query.payload.query.spatial.coordinateSystemId, "global");
  assert.equal(query.payload.query.spatial.status, "complete");
  assert.equal(query.payload.query.spatial.units, "mm");
  assert.equal(query.payload.query.spatial.totalBodyCount, 1);
  assert.deepEqual(query.payload.query.spatial.failedBodyIds, []);
});
test("Gateway injects the current model spatial summary into Agent context", async () => {
  const documentId = "agent_spatial_context_document";
  const createdBody = await request("/commands", { operation: "primitive.box", documentId, parameters: { width: 12, depth: 18, height: 5 } });
  assert.equal(createdBody.response.status, 200, JSON.stringify(createdBody.payload));
  const planned = await request("/agent/plan", { providerId: "mock", documentId, prompt: "inspect spatial context", context: { mode: "plan" } });
  assert.equal(planned.response.status, 200, JSON.stringify(planned.payload));
  const systemPrompt = JSON.parse(lastLlmBody).messages[0].content;
  assert.match(systemPrompt, /"coordinateSystemId":"global"/);
  assert.match(systemPrompt, /"size":\[12,18,5\]/);
  assert.match(systemPrompt, /"center":\[6,9,2\.5\]/);
});
test("query_model reports compact Body relations and scopes Body measurements", async () => {
  const documentId = "agent_spatial_relations_document";
  const first = await request("/commands", { operation: "primitive.box", documentId, parameters: { width: 10, depth: 10, height: 10 } });
  const second = await request("/commands", { operation: "primitive.box", documentId, parameters: { width: 2, depth: 2, height: 2 } });
  const translated = await request("/commands", {
    operation: "transform.translate",
    documentId,
    baseRevision: second.payload.revision,
    inputs: { bodyId: second.payload.bodyId },
    parameters: { dx: 15, dy: 0, dz: 0 },
  });
  assert.equal(translated.response.status, 200, JSON.stringify(translated.payload));
  const tree = await request("/agent/model/query", { documentId, kind: "geometry-tree" });
  assert.equal(tree.response.status, 200, JSON.stringify(tree.payload));
  assert.equal(tree.payload.query.spatial.status, "complete");
  assert.equal(tree.payload.query.spatial.totalBodyCount, 2);
  const relation = tree.payload.query.spatial.relations.find((item) =>
    new Set([item.bodyA, item.bodyB]).has(first.payload.bodyId)
      && new Set([item.bodyA, item.bodyB]).has(second.payload.bodyId));
  assert.equal(relation.relation, "separated");
  assert.equal(relation.gap, 5);
  assert.equal(relation.distance, 5);
  assert.equal(relation.source, "aabb");
  assert.equal(relation.exact, false);
  const body = await request("/agent/model/query", { documentId, kind: "body", bodyId: second.payload.bodyId });
  assert.equal(body.response.status, 200, JSON.stringify(body.payload));
  assert.equal(body.payload.query.spatial.scope, "body");
  assert.equal(body.payload.query.spatial.totalBodyCount, 1);
  assert.equal(body.payload.query.spatial.measuredBodyCount, 1);
  assert.deepEqual(body.payload.query.body.spatial.bounds, { min: [15, 0, 0], max: [17, 2, 2] });
});

test("Agent context includes Body Face and Edge selection spatial summaries", async () => {
  const documentId = "agent_selection_spatial_document";
  const createdBody = await request("/commands", { operation: "primitive.box", documentId, parameters: { width: 10, depth: 20, height: 30 } });
  assert.equal(createdBody.response.status, 200, JSON.stringify(createdBody.payload));
  const faceId = createdBody.payload.triangleFaceIds[0];
  const edgeId = createdBody.payload.edges[0].edgeId;
  const planned = await request("/agent/plan", {
    providerId: "mock",
    documentId,
    prompt: "inspect selected geometry spatial context",
    context: {
      mode: "plan",
      selections: [
        { kind: "body", bodyId: createdBody.payload.bodyId },
        { kind: "face", bodyId: createdBody.payload.bodyId, topologyId: faceId },
        { kind: "edge", bodyId: createdBody.payload.bodyId, topologyId: edgeId },
      ],
    },
  });
  assert.equal(planned.response.status, 200, JSON.stringify(planned.payload));
  const systemPrompt = JSON.parse(lastLlmBody).messages[0].content;
  const match = systemPrompt.match(/Current selection spatial: (.+)\.\nCurrent model query:/);
  assert.ok(match, systemPrompt);
  const selections = JSON.parse(match[1]);
  assert.deepEqual(selections.map((item) => item.kind), ["body", "face", "edge"]);
  assert.ok(selections.every((item) => item.status === "complete"));
  assert.deepEqual(selections[0].spatial.size, [10, 20, 30]);
  assert.equal(selections[1].spatial.normal.length, 3);
  assert.equal(selections[1].spatial.bounds.min.length, 3);
  assert.equal(selections[2].spatial.direction.length, 3);
  assert.equal(selections[2].spatial.endpoints.length, 2);
});
test("Gateway injects recent conversation context into planning", async () => {
  const documentId = "agent_context_document";
  const created = await request("/agent/conversations", { documentId, title: "上下文" });
  await request(`/agent/conversations/${created.payload.conversation.id}/messages`, { documentId, message: { role: "user", content: "我刚刚创建了 Box1" } });
  const planned = await request("/agent/plan", { providerId: "mock", conversationId: created.payload.conversation.id, documentId, prompt: "继续修改它", context: { revision: 1 } });
  assert.equal(planned.response.status, 200, JSON.stringify(planned.payload));
  assert.match(lastLlmBody, /我刚刚创建了 Box1/);
});

test("Gateway hydrates tool-style body deletion plans from the model context", async () => {
  const documentId = "agent_delete_document";
  const planned = await request("/agent/plan", { providerId: "mock", documentId, prompt: "delete Box5", context: { revision: 3, model: { bodies: [{ bodyId: "body-5", name: "Box5" }] } } });
  assert.equal(planned.response.status, 200, JSON.stringify(planned.payload));
  assert.equal(planned.payload.plan.steps[0].operation, "body.delete");
  assert.equal(planned.payload.plan.steps[0].request.inputs.bodyId, "body-5");
  assert.equal(planned.payload.plan.status, "ready");
});
test("Gateway normalizes body material plans and resolves their target", async () => {
  const documentId = "agent_material_document";
  const planned = await request("/agent/plan", { providerId: "mock", documentId, prompt: "assign material to Box5", context: { revision: 3, model: { bodies: [{ bodyId: "body-5", name: "Box5" }] } } });
  assert.equal(planned.response.status, 200, JSON.stringify(planned.payload));
  assert.equal(planned.payload.plan.steps[0].operation, "body.update");
  assert.equal(planned.payload.plan.steps[0].request.inputs.bodyId, "body-5");
  assert.equal(planned.payload.plan.steps[0].request.parameters.material, "FR4");
});
test("Gateway turns stale Body references into clarification questions", async () => {
  const planned = await request("/agent/plan", { providerId: "mock", documentId: "agent_stale_body", prompt: "delete stale body", context: { revision: 6, model: { bodies: [{ bodyId: "body-5", name: "Box5" }] } } });
  assert.equal(planned.response.status, 200, JSON.stringify(planned.payload));
  assert.equal(planned.payload.plan.status, "needs-input");
  assert.match(planned.payload.plan.questions[0].prompt, /已不存在/);
});
test("Gateway stream normalizes body.material without returning a validation error", async () => {
  const response = await fetch(`${api}/agent/plan/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: "mock", prompt: "assign material", context: { revision: 3, mode: "plan", model: { bodies: [{ bodyId: "body-5", name: "Box5" }] } } }) });
  const streamText = await response.text();
  assert.equal(response.status, 200);
  assert.match(streamText, /event: plan/);
  assert.match(streamText, /body\.update/);
  assert.doesNotMatch(streamText, /Operation is not allowed: body\.material/);
});
test("Gateway marks Plan mode as read-only in model context", async () => {
  const result = await request("/agent/plan", { providerId: "mock", prompt: "设计一个盒子", context: { revision: 0, mode: "plan" } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.match(lastLlmBody, /Current mode is PLAN/);
  assert.match(lastLlmBody, /body\.update/);
});
test("Agent run executes Tool Calls in an outer loop and persists tool results", async () => {
  const documentId = "agent_loop_document";
  const created = await request("/agent/conversations", { documentId, title: "Agent loop" });
  const conversationId = created.payload.conversation.id;
  const response = await fetch(`${api}/agent/run/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: "mock-tools", documentId, conversationId, prompt: "agent loop create box", context: { revision: 0, mode: "edit" } }) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.match(text, /event: tool-call/);
  assert.match(text, /event: tool-result/);
  assert.match(text, /event: run/);
  const runId = text.match(/"runId":"([^"]+)"/)?.[1];
  assert.ok(runId);
  const persistedRun = await request(`/agent/runs/${runId}`, undefined, { method: "GET" });
  assert.equal(persistedRun.response.status, 200, JSON.stringify(persistedRun.payload));
  assert.equal(persistedRun.payload.run.status, "completed");
  const view = await request("/agent/model/query", { documentId, kind: "geometry-tree" });
  assert.equal(view.payload.query.project.bodyCount, 1);
  const loaded = await request(`/agent/conversations/${conversationId}?documentId=${documentId}`, undefined, { method: "GET" });
  assert.ok(loaded.payload.conversation.messages.some((message) => message.role === "tool" && message.toolName === "create_box"));
  assert.ok(loaded.payload.conversation.messages.some((message) => message.role === "assistant" && message.reasoningContent === "mock reasoning"));
  assert.match(lastLlmBody, /reasoning_content/);
});

test("Agent Plan mode never executes mutation tools", async () => {
  const documentId = "agent_loop_plan_document";
  const created = await request("/agent/conversations", { documentId, title: "Plan loop" });
  const response = await fetch(`${api}/agent/run/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: "mock-tools", documentId, conversationId: created.payload.conversation.id, prompt: "agent loop plan", context: { revision: 0, mode: "plan" } }) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const view = await request("/agent/model/query", { documentId, kind: "geometry-tree" });
  assert.equal(view.payload.query.project.bodyCount, 0);
});test("Agent loop feeds invalid Tool Calls back to the model for correction", async () => {
  const documentId = "agent_loop_recovery_document";
  const created = await request("/agent/conversations", { documentId, title: "Agent recovery" });
  const response = await fetch(`${api}/agent/run/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: "mock-tools", documentId, conversationId: created.payload.conversation.id, prompt: "agent loop invalid", context: { revision: 0, mode: "edit" } }) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.match(text, /unknown_tool/);
  assert.match(text, /14 mm/);
  const view = await request("/agent/model/query", { documentId, kind: "geometry-tree" });
  assert.equal(view.payload.query.project.bodyCount, 1);
});test("Agent deletes a Body without an extra confirmation step", async () => {
  const documentId = "agent_confirmation_document";
  const createdBody = await request("/commands", { operation: "primitive.box", documentId, parameters: { width: 10, depth: 10, height: 10 } });
  assert.equal(createdBody.response.status, 200, JSON.stringify(createdBody.payload));
  const conversation = await request("/agent/conversations", { documentId, title: "Confirmation" });
  const conversationId = conversation.payload.conversation.id;
  const pendingResponse = await fetch(`${api}/agent/run/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: "mock-tools", documentId, conversationId, prompt: "agent confirm delete", context: { revision: createdBody.payload.revision, mode: "edit" } }) });
  const pendingText = await pendingResponse.text();
  assert.equal(pendingResponse.status, 200, pendingText);
  assert.match(pendingText, /"status":"completed"/);
  assert.match(pendingText, /"status":"executed"/);
  const view = await request("/agent/model/query", { documentId, kind: "geometry-tree" });
  assert.equal(view.payload.query.project.bodyCount, 0);
});
test("Gateway exposes manual Agent context compaction", async () => {
  const documentId = "agent_compact_document";
  const created = await request("/agent/conversations", { documentId, title: "Context compact" });
  const conversationId = created.payload.conversation.id;
  for (let index = 0; index < 10; index += 1) await request(`/agent/conversations/${conversationId}/messages`, { documentId, message: { role: "user", content: `context turn ${index}` } });
  const compacted = await request(`/agent/conversations/${conversationId}/compact`, { documentId });
  assert.equal(compacted.response.status, 200, JSON.stringify(compacted.payload));
  assert.equal(compacted.payload.context.compacted, true);
  assert.equal(compacted.payload.context.recentCount, 8);
  assert.equal(compacted.payload.conversation.contextSummary.turns, 2);
});
test("Agent commits a multi-tool turn atomically", async () => {
  const response = await fetch(api + "/agent/run/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: "mock-tools", documentId: "agent_atomic_batch", prompt: "atomic batch", context: { revision: 0, mode: "edit" } }) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const summary = await request("/commands", { operation: "document.summary", documentId: "agent_atomic_batch" });
  assert.equal(summary.response.status, 200);
  assert.equal(summary.payload.bodyCount, 2);
});

test("Agent metrics expose audit aggregates and provider health", async () => {
  const result = await request("/agent/metrics?documentId=agent_compact_document", undefined, { method: "GET" });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.ok(result.payload.metrics);
  assert.ok(Object.prototype.hasOwnProperty.call(result.payload.metrics, "failureRate"));
  assert.ok(Array.isArray(result.payload.metrics.providers));
});
