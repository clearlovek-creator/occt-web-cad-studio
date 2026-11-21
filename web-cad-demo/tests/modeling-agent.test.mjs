import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {renderPiPanel,legacyPiAlias} from './helpers/render-pi-panel.mjs';
import {validatePiCommand} from '../gateway/pi-rpc-runtime.mjs';

const agentSource = await readFile(new URL("../app/modeling/modeling-agent.ts", import.meta.url), "utf8");
const controllerSource = await readFile(new URL("../app/modeling/modeling-controller.ts", import.meta.url), "utf8");
const panelSource = await readFile(new URL("../app/ModelingAgentPanel.tsx", import.meta.url), "utf8");
const demoSource = await readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8");

test("Local rule parser is explicitly disabled", () => {
  assert.match(agentSource, /Local rule parsing is disabled/);
  assert.doesNotMatch(controllerSource, /createModelingPlan/);
  assert.doesNotMatch(panelSource, /modelingController\.plan/);
  assert.doesNotMatch(panelSource, /LOCAL/);
});

test("Compatibility controller retains its explicit legacy plan API without enabling local parsing", () => {
  assert.match(controllerSource, /agentPlan/);
  assert.match(controllerSource, /agentMode/);
  assert.match(controllerSource, /Plan 模式为只读模式/);
  assert.doesNotMatch(controllerSource, /createModelingPlan/);
  assert.doesNotMatch(controllerSource, /plan\(prompt/);
  assert.match(controllerSource, /clearPlan/);
  assert.match(controllerSource, /confirmPlan/);
  assert.match(controllerSource, /executePlan/);
  assert.match(controllerSource, /maxAttempts = 3/);
  assert.match(controllerSource, /agentRetryDelayMs/);
  assert.match(controllerSource, /planExecution/);
  assert.match(controllerSource, /document\.undo/);
});

test("the active assistant renders native Pi controls, no Plan/Edit or local parser fallback", async () => {
  const html=await renderPiPanel();
  assert.match(html,/data-testid="pi-agent-panel"/);assert.match(html,/PI RPC/);assert.match(html,/CAD MCP/);assert.match(html,/aria-label="发送给 Pi Agent"[^>]*disabled/);
  assert.doesNotMatch(html,/agent-plan-mode|agent-edit-mode|agent-plan-table|确认执行|切换到本地/);assert.match(demoSource,/PiModelingAgentPanel/);
});

test("the historical panel name resolves to the sole native Pi implementation", async () => {
  assert.equal(await legacyPiAlias(),true);const html=await renderPiPanel();for(const label of ['压缩','历史','新会话','设置'])assert.ok(html.includes('>'+label+'</button>'),label);
});
test("executes multi-step plan and rolls back completed steps on failure", () => {
  const script = "import { ModelingController } from \"./app/modeling/modeling-controller.ts\"; const calls = []; const fetchImpl = async (_url, options) => { const request = JSON.parse(options.body); calls.push(request); const payload = request.operation === \"primitive.box\" ? { ok: true, revision: 1 } : request.operation === \"primitive.sphere\" ? { ok: false, code: \"INVALID_PARAMETER\", error: \"sphere failed\" } : { ok: true, revision: 0 }; return new Response(JSON.stringify(payload), { status: payload.ok ? 200 : 400, headers: { \"Content-Type\": \"application/json\" } }); }; const controller = new ModelingController({ documentId: \"agent_runtime\", fetchImpl }); const plan = { planId: \"plan-1\", prompt: \"two steps\", allowed: true, status: \"ready\", questions: [], steps: [{ id: \"step-1\", operation: \"primitive.box\", request: { operation: \"primitive.box\", parameters: { width: 1, depth: 1, height: 1 } }, status: \"ready\", selection: \"none\", risk: \"none\", explanation: \"box\" }, { id: \"step-2\", operation: \"primitive.sphere\", request: { operation: \"primitive.sphere\", parameters: { radius: 1 } }, status: \"ready\", selection: \"none\", risk: \"none\", explanation: \"sphere\" }] }; try { await controller.executePlan(plan, \"commit\"); } catch {} console.log(JSON.stringify({ operations: calls.map((item) => item.operation), bases: calls.map((item) => item.baseRevision ?? null), execution: controller.getSnapshot().planExecution }));";
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  const result = JSON.parse(output);
  assert.deepEqual(result.operations, ["primitive.box", "primitive.sphere", "document.undo"]);
  assert.deepEqual(result.bases, [null, 1, null]);
  assert.equal(result.execution.status, "failed");
  assert.equal(result.execution.stepIndex, 1);
});

test("cancels a planned execution without sending a command", () => {
  const script = "import { ModelingController } from './app/modeling/modeling-controller.ts'; const controller = new ModelingController({ documentId: 'cancel_runtime', fetchImpl: async () => { throw new Error('command should not run'); } }); const plan = { planId: 'cancel-plan', prompt: 'cancel', allowed: true, status: 'ready', questions: [], steps: [{ id: 'step-1', operation: 'primitive.box', request: { operation: 'primitive.box', parameters: { width: 1, depth: 1, height: 1 } }, status: 'ready', selection: 'none', risk: 'none', explanation: 'box' }] }; await controller.executePlan(plan, 'cancel'); console.log(JSON.stringify(controller.getSnapshot()));";
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  const state = JSON.parse(output);
  assert.equal(state.planExecution.status, "cancelled");
  assert.equal(state.busy, false);
});

test("increments plan execution attempts when retrying", () => {
  const script = "import { ModelingController } from './app/modeling/modeling-controller.ts'; let calls = 0; const fetchImpl = async (_url, options) => { calls += 1; const request = JSON.parse(options.body); const payload = calls === 1 ? { ok: false, code: 'BUILD_FAILED', error: 'retry me' } : { ok: true, revision: 1, operation: request.operation }; return new Response(JSON.stringify(payload), { status: payload.ok ? 200 : 400, headers: { 'Content-Type': 'application/json' } }); }; const controller = new ModelingController({ documentId: 'retry_runtime', fetchImpl }); const plan = { planId: 'retry-plan', prompt: 'retry', allowed: true, status: 'ready', questions: [], steps: [{ id: 'step-1', operation: 'primitive.box', request: { operation: 'primitive.box', parameters: { width: 1, depth: 1, height: 1 } }, status: 'ready', selection: 'none', risk: 'none', explanation: 'box' }] }; try { await controller.executePlan(plan, 'commit'); } catch {} await controller.executePlan(plan, 'commit'); console.log(JSON.stringify(controller.getSnapshot().planExecution));";
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  const execution = JSON.parse(output);
  assert.equal(execution.status, "completed");
  assert.equal(execution.attempts, 2);
});

test("marks every step as preview without committing through the controller", () => {
  const script = "import { ModelingController } from './app/modeling/modeling-controller.ts'; const calls = []; const fetchImpl = async (_url, options) => { const request = JSON.parse(options.body); calls.push(request); const payload = { ok: true, revision: 0, preview: { state: 'preview' } }; return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }); }; const controller = new ModelingController({ documentId: 'preview_runtime', fetchImpl }); const plan = { planId: 'preview-plan', prompt: 'preview', allowed: true, status: 'ready', questions: [], steps: [{ id: 'step-1', operation: 'primitive.box', request: { operation: 'primitive.box', parameters: { width: 1, depth: 1, height: 1 } }, status: 'ready', selection: 'none', risk: 'none', explanation: 'box' }, { id: 'step-2', operation: 'primitive.sphere', request: { operation: 'primitive.sphere', parameters: { radius: 1 } }, status: 'ready', selection: 'none', risk: 'none', explanation: 'sphere' }] }; await controller.executePlan(plan, 'preview'); console.log(JSON.stringify({ previews: calls.map((item) => item.options.preview), execution: controller.getSnapshot().planExecution }));";
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  const result = JSON.parse(output);
  assert.deepEqual(result.previews, [true, true]);
  assert.equal(result.execution.status, "completed");
});

test("Plan mode blocks geometry commit", () => {
  const script = "import { ModelingController } from './app/modeling/modeling-controller.ts'; const controller = new ModelingController({ fetchImpl: async () => { throw new Error('geometry command must not run'); } }); const plan = { planId: 'plan-gate', prompt: 'gate', allowed: true, status: 'ready', questions: [], steps: [{ id: 'step-1', operation: 'primitive.box', request: { operation: 'primitive.box', parameters: { width: 1, depth: 1, height: 1 } }, status: 'ready', selection: 'none', risk: 'none', explanation: 'box' }] }; try { await controller.executePlan(plan, 'commit', 'plan'); } catch (error) { console.log(error.message); }";
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.match(output, /Plan 模式为只读模式/);
});

test("native history, compaction and fresh sessions use the declared Pi RPC contract", () => {
  for(const type of ['get_messages','get_entries','new_session','compact','abort'])assert.deepEqual(validatePiCommand({type}),{type});
  assert.throws(()=>validatePiCommand({type:'compact',operation:'primitive.box'}),/Unexpected field/);
});
test("Python Agent approval flows through ModelingController", () => {
  const script = String.raw`import { ModelingController } from "./app/modeling/modeling-controller.ts";
const waitingUser = { run_id: "r1", document_id: "d1", status: "waiting_user", run_version: 1, document_revision: 0, waiting_request_id: "q1", pending_input: { request_id: "q1", question: "请补充参数" } };
const waitingApproval = { run_id: "r1", document_id: "d1", status: "waiting_approval", run_version: 2, document_revision: 0, waiting_approval_id: "ap1", pending_action: { action_id: "a1", tool_name: "geometry.create_box", arguments: { width: 1, depth: 1, height: 1 }, expected_document_revision: 0 }, pending_approval: { approval_id: "ap1", summary: "将创建盒体" } };
const completed = { run_id: "r1", document_id: "d1", status: "completed", run_version: 3, document_revision: 1, latest_observation: { success: true, after_revision: 1, result: { operation: "primitive.box", bodyId: "body-1" } } };
let phase = 0, creation;
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
const scoped = value => ({...value,run_id:creation.client_run_id,project_id:creation.project_id,user_id:creation.user_id,client_creation:creation});
const fetchImpl = async (url, options = {}) => { const path = new URL(url).pathname; if (options.method === "POST" && path.endsWith("/runs")) { phase = 0; creation=JSON.parse(options.body); return json(scoped(waitingUser)); } if (path.endsWith("/responses")) { phase = 1; return json(scoped(waitingApproval)); } if (path.includes("/approvals/")) { phase = 2; return json(scoped(completed)); } if (options.method === "GET") return json(scoped(phase === 0 ? waitingUser : phase === 1 ? waitingApproval : completed)); throw new Error("unexpected request"); };
const controller = new ModelingController({ documentId: "d1", agentBackend: "python", agentApiRoot: "http://python.test/api/v1/agent", fetchImpl });
const first = await controller.streamAgentRun("create", {}, undefined, false);
const second = await controller.streamAgentRun("rectangular_patch 2.45GHz", {}, undefined, false);
const third = await controller.streamAgentRun("execute", {}, undefined, true);
console.log(JSON.stringify({ statuses: [first.status, second.status, third.status], executed: third.executed, operation: third.result?.operation, planOperation: second.plan?.steps?.[0]?.operation }));`;
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  const result = JSON.parse(output);
  assert.deepEqual(result.statuses, ["needs-input", "waiting-approval", "completed"]);
  assert.equal(result.executed, true);
  assert.equal(result.operation, "primitive.box");
  assert.equal(result.planOperation, "primitive.box");
});

test("Python Agent conversation and pending Run survive controller recreation", () => {
  const script = String.raw`import { ModelingController } from "./app/modeling/modeling-controller.ts";
const values = new Map();
globalThis.window = { localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) } };
const waitingUser = { run_id: "r2", document_id: "d2", status: "waiting_user", run_version: 1, document_revision: 0, waiting_request_id: "q2", pending_input: { request_id: "q2", question: "What antenna?" } };
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
let creation;
const scoped = () => ({...waitingUser,run_id:creation.client_run_id,project_id:creation.project_id,user_id:creation.user_id,client_creation:creation});
const fetchImpl = async (url, options = {}) => { const path = new URL(url).pathname; if (options.method === "POST" && path.endsWith("/runs")) { creation=JSON.parse(options.body); return json(scoped()); } if (options.method === "GET") return json(scoped()); throw new Error("unexpected request"); };
const first = new ModelingController({ documentId: "d2", agentBackend: "python", agentApiRoot: "http://python.test/api/v1/agent", fetchImpl });
await first.loadAgentConversation();
await first.appendAgentMessage({ role: "user", content: "create an antenna" });
await first.persistAgentConversationState({ planId: "p2", prompt: "create", source: "python-langgraph", providerId: "python-langgraph", model: "LangGraph", protocol: "python-api", allowed: true, status: "needs-input", steps: [], questions: [], summary: "What antenna?" }, "create an antenna");
await first.streamAgentRun("create", {}, undefined, false);
const second = new ModelingController({ documentId: "d2", agentBackend: "python", agentApiRoot: "http://python.test/api/v1/agent", fetchImpl });
const restored = await second.loadAgentConversation();
console.log(JSON.stringify({ messages: restored?.messages.length, plan: restored?.activePlan?.planId, pending: restored?.pendingPrompt, run: second.getSnapshot().agentConversation?.id }));`;
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  const result = JSON.parse(output);
  assert.equal(result.messages, 1);
  assert.equal(result.plan, "p2");
  assert.equal(result.pending, "create an antenna");
  assert.equal(result.run, "python-conversation-d2");
});
