import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("modeling command contract centralizes request identity and revision fields", async () => {
  const source = await readFile(new URL("../app/modeling/command-contract.ts", import.meta.url), "utf8");
  assert.match(source, /protocolVersion/);
  assert.match(source, /requestId/);
  assert.match(source, /baseRevision/);
  assert.match(source, /idempotencyKey/);
  assert.match(source, /normalizeCommandRequest/);
});

test("ModelingController owns command transport and interaction state", async () => {
  const source = await readFile(new URL("../app/modeling/modeling-controller.ts", import.meta.url), "utf8");
  assert.match(source, /class ModelingController/);
  assert.match(source, /pendingOperation/);
  assert.match(source, /currentBodyId/);
  assert.match(source, /operationWindow/);
  assert.match(source, /busy/);
  assert.match(source, /setSelection/);
  assert.match(source, /setActiveOperation/);
  assert.match(source, /adoptModel/);
  assert.match(source, /ModelingCommandError/);
  assert.match(source, /\/commands/);
});

test("all modeling panels share the runtime command bus", async () => {
  const runtime = await readFile(new URL("../app/modeling/runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /new ModelingController/);
  const panelPaths = ["AdvancedModelingPanel.tsx", "AdvancedBooleanPanel.tsx", "SweepModelingPanel.tsx", "LoftModelingPanel.tsx", "DirectModelingPanel.tsx", "BooleanPanel.tsx", "FeatureHistoryControls.tsx", "AdvancedProjectDataPanel.tsx", "ProjectDataPanel.tsx", "ModelMetadataPanels.tsx", "StepExchangePanel.tsx"];
  for (const path of panelPaths) {
    const source = await readFile(new URL("../app/" + path, import.meta.url), "utf8");
    if (path === "StepExchangePanel.tsx") {
      assert.match(source, /onImport/);
      assert.match(source, /onExport/);
      assert.doesNotMatch(source, /fetch\(/);
    } else if (path === "ModelMetadataPanels.tsx") {
      assert.match(source, /export \{BodyAppearancePanel\} from '.\/workbench\/BodyAppearancePanel'/);
      const appearance = await readFile(new URL("../app/workbench/BodyAppearancePanel.tsx", import.meta.url), "utf8");
      assert.match(appearance, /onSave\(baseline\.bodyId,evaluation\.changes\)/);
      assert.doesNotMatch(appearance, /fetch\(/);
      assert.match(source, /onUpdateBody\(body\.bodyId/);
      assert.doesNotMatch(source, /fetch\(/);
    } else {
      const scoped=["AdvancedModelingPanel.tsx","AdvancedBooleanPanel.tsx","SweepModelingPanel.tsx","LoftModelingPanel.tsx","FeatureHistoryControls.tsx","AdvancedProjectDataPanel.tsx"].includes(path);
      assert.match(source, scoped?/useEditorCommands/:/executeModelingCommand/);
      assert.doesNotMatch(source, /API_ROOT.*\/commands/);
      assert.doesNotMatch(source,/fetch\(/);
    }
  }
  const scope=await readFile(new URL("../app/modeling/CommandEditScope.tsx",import.meta.url),"utf8"),session=await readFile(new URL("../app/modeling/command-edit-session.ts",import.meta.url),"utf8");
  assert.match(scope,/session\?\.execute \|\| executeModelingCommand/);assert.match(session,/this\.controller\.execute<T>/);assert.match(session,/baseStateToken:this\.baseline\.stateToken/);
});

test("CadDemo routes command operations through ModelingController", async () => {
  const [source, registry] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /modelingController\.execute/);
  assert.match(source, /modelingController\.adoptModel/);
  assert.match(source, /modelingController\.setSelection/);
  assert.match(registry, /CAD_COMMAND_METADATA/);
  assert.match(registry, /CAD_WORKER_OPERATION_MAP/);
  assert.match(registry, /CAD_SAFE_WORKER_OPERATIONS/);
  assert.match(registry, /supportsPreview/);
  assert.match(registry, /document\.undo/);
});
test("normalizes every command envelope with empty inputs and parameters", () => {
  const script = "import { normalizeCommandRequest } from './app/modeling/command-contract.ts'; console.log(JSON.stringify(normalizeCommandRequest({ operation: 'document.summary' }, 'doc')));";
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  const request = JSON.parse(output);
  assert.equal(request.protocolVersion, 1);
  assert.equal(request.documentId, "doc");
  assert.match(request.requestId, /^cad-/);
  assert.deepEqual(request.inputs, {});
  assert.deepEqual(request.parameters, {});
});

test("STEP exchange panel submits intent instead of opening a transport", async () => {
  const source = await readFile(new URL("../app/StepExchangePanel.tsx", import.meta.url), "utf8");
  assert.match(source, /onImport/);
  assert.match(source, /onExport/);
  assert.doesNotMatch(source, /fetch\(/);
});

test("Provider management stays separate from the native Pi conversation", async () => {
  const [controller, settings] = await Promise.all([
    readFile(new URL("../app/modeling/modeling-controller.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/AgentProviderSettingsPanel.tsx", import.meta.url), "utf8"),
  ]);
  const {renderPiPanel}=await import('./helpers/render-pi-panel.mjs');const panel=await renderPiPanel();
  assert.match(controller, /loadAgentProviders/);
  assert.match(controller, /saveAgentProvider/);
  assert.match(controller, /generateAgentPlan/);
  assert.match(controller, /streamAgentRun/);
  assert.doesNotMatch(panel, /<AgentProviderSettingsPanel/);
  assert.match(panel, /pi-agent-panel/);
  assert.match(settings, /Base URL/);
  assert.match(settings, /API Key/);
  assert.match(settings, /testAgentProvider/);
  assert.match(panel, />设置<\/button>/);assert.doesNotMatch(panel,/API Key|Base URL/);
});


test("conversation deletion and project exchange are exposed", async () => {
  const [controller, panel] = await Promise.all([
    readFile(new URL("../app/modeling/modeling-controller.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/StepExchangePanel.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(controller, /deleteAgentConversation/);
  assert.match(controller, /saveProject/);
  assert.match(controller, /openProject/);
  assert.match(panel, /onProjectSave/);
  assert.match(panel, /onProjectOpen/);
});

test("native mutation tools require viewport reconciliation while observation tools do not", async () => {
  const {piToolNeedsReconcile}=await import('../app/modeling/pi-messages.ts');
  for(const name of ['primitive__box','body__delete','material__set','variable__set','boolean__cut'])assert.equal(piToolNeedsReconcile(name),true);
  for(const name of ['','query_model','measure_geometry'])assert.equal(piToolNeedsReconcile(name),false);
});
