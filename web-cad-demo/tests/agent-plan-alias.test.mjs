import assert from "node:assert/strict";
import { test } from "node:test";
import { validateModelingPlan } from "../gateway/llm/plan-validator.mjs";

test("normalizes model primitive.create output to a Box operation", () => {
  const plan = validateModelingPlan({
    summary: "Create a box",
    risk: "low",
    questions: [],
    steps: [{ operation: "body.create", inputs: {}, parameters: { width: 100, depth: 80, height: 50 }, explanation: "box" }],
  });
  assert.equal(plan.steps[0].operation, "primitive.box");
  assert.deepEqual(plan.steps[0].request.parameters, { width: 100, depth: 80, height: 50 });
});

test("rejects a Box plan before geometry execution when a required size is missing", () => {
  assert.throws(() => validateModelingPlan({
    summary: "Create a box",
    risk: "none",
    questions: [],
    steps: [{ operation: "primitive.box", inputs: {}, parameters: { depth: 80, height: 50 }, explanation: "box" }],
  }), /steps\[0\]\.parameters\.width is required/);
});