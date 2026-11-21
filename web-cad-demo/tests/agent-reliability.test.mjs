import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentRunStore } from "../gateway/agent-run-store.mjs";
import { confirmationFingerprint, sameConfirmationFingerprint } from "../gateway/llm/agent-confirmation.mjs";
import { CAD_TOOL_DEFINITIONS, validateCadToolContract } from "../gateway/llm/cad-tools.mjs";
import { CAD_TOOL_OPERATION_MAP } from "../gateway/llm/command-catalog.mjs";

test("confirmation fingerprint binds plan, revision, tool and entities", () => {
  const call = { name: "delete_body", arguments: { bodyId: "body-1" } };
  const first = confirmationFingerprint({ planId: "plan-1", revision: 4, call });
  assert.equal(first, confirmationFingerprint({ planId: "plan-1", revision: 4, call: { ...call, arguments: { bodyId: "body-1" } } }));
  assert.notEqual(first, confirmationFingerprint({ planId: "plan-1", revision: 5, call }));
  assert.notEqual(first, confirmationFingerprint({ planId: "plan-1", revision: 4, call: { ...call, arguments: { bodyId: "body-2" } } }));
  assert.equal(sameConfirmationFingerprint(first, first), true);
});

test("CAD Tool definitions and operation contracts stay in one-to-one sync", () => {
  assert.equal(validateCadToolContract(), true);
  assert.deepEqual(new Set(CAD_TOOL_DEFINITIONS.map((item) => item.name)), new Set(Object.keys(CAD_TOOL_OPERATION_MAP)));
});

test("Agent run ledger survives reload and records terminal state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-agent-runs-"));
  try {
    const first = new AgentRunStore(dir);
    first.begin({ runId: "run-1", documentId: "doc-1", providerId: "mock" });
    first.appendEvent("run-1", { type: "start" });
    first.update("run-1", { status: "completed", turns: 2, toolCount: 1 });
    const second = new AgentRunStore(dir);
    const run = second.get("run-1");
    assert.equal(run.status, "completed");
    assert.equal(run.turns, 2);
    assert.equal(run.events.length, 1);
    assert.equal(second.list("doc-1").length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
