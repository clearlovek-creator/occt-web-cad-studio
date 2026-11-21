import assert from "node:assert/strict";
import test from "node:test";
import { validateModelingPlan } from "../gateway/llm/plan-validator.mjs";


test("Agent plan validator accepts project data mutations with typed contracts", () => {
  const plan = validateModelingPlan({
    summary: "project data",
    risk: "confirmation",
    questions: [],
    steps: [
      { operation: "variable.set", inputs: {}, parameters: { name: "substrateWidth", type: "length", expression: "40 mm" }, explanation: "variable" },
      { operation: "material.set", inputs: {}, parameters: { name: "FR4", category: "dielectric", relativePermittivity: 4.4, conductivity: 0 }, explanation: "material" },
      { operation: "material.property.set", inputs: {}, parameters: { materialName: "FR4", key: "lossTangent", type: "double", value: 0.001 }, explanation: "material property" },
      { operation: "property.set", inputs: { kind: "face", bodyId: "body-1", topologyId: "face-1" }, parameters: { key: "mesh.priority", type: "int", value: 3 }, explanation: "object property" },
      { operation: "coordinate.set", inputs: {}, parameters: { id: "local1", name: "Local1", kind: "cartesian", origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] }, explanation: "coordinate" },
    ],
  });
  assert.deepEqual(plan.steps.map((step) => step.operation), ["variable.set", "material.set", "material.property.set", "property.set", "coordinate.set"]);
  assert.equal(plan.status, "ready");
});

test("Agent plan validator rejects incomplete face property targets", () => {
  assert.throws(() => validateModelingPlan({ summary: "bad", risk: "none", questions: [], steps: [{ operation: "property.set", inputs: { kind: "face", bodyId: "body-1" }, parameters: { key: "x", type: "double", value: 1 }, explanation: "bad" }] }), /topologyId is required/);
});

test("Local planner is disabled", async () => {
  const agent = await import("../app/modeling/modeling-agent.ts");
  assert.throws(() => agent.createModelingPlan("create box 10x20x30"), /Local rule parsing is disabled/);
});

test("Model plan questions have unique identifiers", () => {
  const plan = validateModelingPlan({ summary: "questions", risk: "none", questions: ["请补充尺寸", "请补充选择"], steps: [] });
  assert.equal(new Set(plan.questions.map((question) => question.questionId)).size, 2);
});

test("Agent resolver maps Body names and rejects stale topology references", async () => {
  const { resolveAgentPlan } = await import("../gateway/llm/agent-resolver.mjs");
  const plan = validateModelingPlan({
    summary: "property",
    risk: "none",
    questions: [],
    steps: [{
      operation: "property.set",
      inputs: { kind: "face", bodyId: "Housing", topologyId: "face-1-99" },
      parameters: { key: "mesh.priority", type: "int", value: 2 },
      explanation: "face property",
    }],
  });
  const resolved = resolveAgentPlan(plan, {
    revision: 4,
    model: {
      bodies: [{ bodyId: "body-1", name: "Housing", topology: { topologyRevision: 4, faceIds: ["face-1-1"], edgeIds: [] } }],
    },
  }, "set a face property on Housing");
  assert.equal(resolved.steps[0].request.inputs.bodyId, "body-1");
  assert.equal(resolved.status, "needs-input");
  assert.equal(resolved.resolver.errors[0].code, "TOPOLOGY_NOT_FOUND");
});

test("Agent resolver prevents Boolean self-targeting", async () => {
  const { resolveAgentPlan } = await import("../gateway/llm/agent-resolver.mjs");
  const plan = validateModelingPlan({
    summary: "cut",
    risk: "confirmation",
    questions: [],
    steps: [{ operation: "boolean.cut", inputs: { targetBody: "A", toolBody: "A" }, parameters: {}, explanation: "cut" }],
  });
  const resolved = resolveAgentPlan(plan, { model: { bodies: [{ bodyId: "body-1", name: "A" }] } });
  assert.equal(resolved.status, "needs-input");
  assert.equal(resolved.resolver.errors[0].code, "BOOLEAN_BODIES_MUST_DIFFER");
});
